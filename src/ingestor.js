const WebSocket = require("ws");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { ProxyAgent, fetch: proxyFetch } = require("undici");
const { HttpsProxyAgent } = require("https-proxy-agent");

dayjs.extend(utc);
dayjs.extend(timezone);

const {
  PROXY_URL,
  LOGIN_URL,
  LOGIN_USERNAME,
  LOGIN_PASSWORD,
  LOGIN_LANG,
  LOGIN_CLIENT,
  LOGIN_TIMEOUT_MS,
  WS_SOURCE_URL,
  WS_HANDSHAKE_TIMEOUT_MS,
  WS_PING_INTERVAL_MS,
  WS_ACTIVITY_TIMEOUT_MS,
  WS_DATA_SILENCE_RECONNECT_MS,
  AUTH_REJECT_GRACE_MS,
  DEVICE_TZ,
  ACTION_AUTH,
  ACTION_DEVICE_DATA,
} = require("./config");
const {
  stats,
  ingest,
  enqueueRecord,
  incrementTraffic,
} = require("./state");

const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;
const proxyWsAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;

let cachedAuth = null;
let consecutiveFailures = 0;

async function login() {
  const httpFetch = PROXY_URL ? proxyFetch : fetch;
  const res = await httpFetch(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    dispatcher: proxyDispatcher,
    body: JSON.stringify({
      username: LOGIN_USERNAME,
      password: LOGIN_PASSWORD,
      lang: LOGIN_LANG,
      client: LOGIN_CLIENT,
    }),
  });

  if (!res.ok) throw new Error(`Login HTTP ${res.status}`);

  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new Error("Login response is not valid JSON");
  }
  if (data.status !== 10000) {
    throw new Error(`Login failed: [${data.status}] ${data.msg}`);
  }
  const token = data.data?.token;
  const pid = data.data?.pid;
  if (!token || !pid) {
    throw new Error("Missing token or pid in successful login response.");
  }
  console.log("🔑 Login successful, token and pid acquired.");
  return { token, pid };
}

async function getAuthCredentials() {
  if (!cachedAuth) {
    cachedAuth = await login();
  }
  return cachedAuth;
}

function getReconnectDelayMs() {
  const base = Math.min(
    3000 * 2 ** Math.max(consecutiveFailures - 1, 0),
    120000,
  );
  // Apply +/-20% jitter to avoid synchronized reconnect storms after upstream outages.
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function parseDeviceMessage(payload, receivedAt) {
  if (
    payload.deviceID === undefined ||
    payload.deviceID === null ||
    payload.deviceID === ""
  ) {
    return null;
  }
  // Reject missing dtu explicitly because dayjs.tz(undefined) defaults to the current time, producing a false 0ms delay.
  if (
    payload.dtu === undefined ||
    payload.dtu === null ||
    payload.dtu === ""
  ) {
    return null;
  }

  let dtuEpoch;
  try {
    dtuEpoch = dayjs.tz(payload.dtu, DEVICE_TZ).valueOf();
  } catch (_) {
    return null;
  }
  if (!Number.isFinite(dtuEpoch)) return null;

  return {
    deviceId: String(payload.deviceID),
    deviceName: payload.ext?.deviceName || null,
    nodeId: payload.nodeID ?? null,
    dtu: new Date(dtuEpoch),
    receivedAt: new Date(receivedAt),
    delayMs: receivedAt - dtuEpoch,
  };
}

function handleMessage(raw, ws, connectionState) {
  const receivedAt = Date.now();
  ingest.lastMessageAt = receivedAt;

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_) {
    stats.invalid++;
    return;
  }
  if (!msg || typeof msg !== "object") {
    stats.invalid++;
    return;
  }

  incrementTraffic(msg.action);

  if (msg.action !== ACTION_DEVICE_DATA) {
    if (msg.action === ACTION_AUTH) {
      if (msg.status === "success") {
        connectionState.authOk = true;
      } else if (msg.status) {
        console.log(
          "⚠️ WebSocket authentication rejected; clearing token and re-authenticating.",
        );
        ingest.lastError = `auth rejected: ${msg.status}`;
        cachedAuth = null;
        // Upstream auth responses may use non-standard status strings even when telemetry still flows.
        setTimeout(() => {
          if (!connectionState.gotData) ws.terminate();
        }, AUTH_REJECT_GRACE_MS);
      }
    }
    return;
  }

  ingest.lastDataAt = receivedAt;
  connectionState.gotData = true;
  if (!msg.payload) return;

  const record = parseDeviceMessage(msg.payload, receivedAt);
  if (!record) {
    stats.invalid++;
    return;
  }
  enqueueRecord(record);
}

async function connectWebSocket() {
  ingest.wsState = "connecting";

  let auth;
  try {
    auth = await getAuthCredentials();
  } catch (err) {
    consecutiveFailures++;
    ingest.wsState = "disconnected";
    ingest.lastError = `login failed: ${err.message}`;
    const delay = getReconnectDelayMs();
    console.error(
      `❌ Login failed: ${err.message}. Retrying in ${Math.round(delay / 1000)}s...`,
    );
    setTimeout(startIngestor, delay);
    return;
  }

  const ws = new WebSocket(WS_SOURCE_URL, {
    handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
    agent: proxyWsAgent,
  });
  const connectionState = { gotData: false, authOk: false };
  let lastActivityAt = Date.now();
  let heartbeatTimer = null;

  ws.on("open", () => {
    console.log("✅ Connected to WebSocket, sending authentication...");
    ingest.wsState = "connected";
    ingest.connectedAt = Date.now();
    lastActivityAt = Date.now();

    ws.send(
      JSON.stringify({
        action: ACTION_AUTH,
        payload: {
          username: LOGIN_USERNAME,
          pid: auth.pid,
          token: auth.token,
        },
      }),
    );

    heartbeatTimer = setInterval(() => {
      const now = Date.now();

      if (now - lastActivityAt > WS_ACTIVITY_TIMEOUT_MS) {
        console.error(
          `⚠️ No WebSocket activity for ${Math.round((now - lastActivityAt) / 1000)}s; terminating connection.`,
        );
        ingest.lastError = "watchdog: connection unresponsive";
        ws.terminate();
        return;
      }

      if (WS_DATA_SILENCE_RECONNECT_MS > 0) {
        const lastDataOrConnect = Math.max(
          ingest.connectedAt || 0,
          ingest.lastDataAt || 0,
        );
        if (now - lastDataOrConnect > WS_DATA_SILENCE_RECONNECT_MS) {
          console.error(
            `⚠️ No data received for ${Math.round((now - lastDataOrConnect) / 1000)}s on active connection; reconnecting.`,
          );
          ingest.lastError = "watchdog: data stream stalled";
          ws.terminate();
          return;
        }
      }

      try {
        ws.ping();
      } catch (_) {}
    }, WS_PING_INTERVAL_MS);
  });

  ws.on("pong", () => {
    lastActivityAt = Date.now();
  });

  ws.on("message", (raw) => {
    lastActivityAt = Date.now();
    try {
      handleMessage(raw, ws, connectionState);
    } catch (err) {
      stats.invalid++;
      console.error("❌ Failed to process WebSocket message:", err.message);
    }
  });

  ws.on("close", (code) => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    ingest.wsState = "disconnected";
    ingest.lastCloseAt = Date.now();
    ingest.reconnects++;

    if (connectionState.gotData || connectionState.authOk) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      // Force re-login after two consecutive failed handshakes in case the cached token expired silently.
      if (consecutiveFailures >= 2) cachedAuth = null;
    }

    const delay = getReconnectDelayMs();
    console.log(
      `⚠️ WebSocket disconnected (code ${code}), reconnecting in ${Math.round(delay / 1000)}s...`,
    );
    setTimeout(startIngestor, delay);
  });

  ws.on("error", (err) => {
    ingest.lastError = `ws error: ${err.message}`;
    console.error("WS error:", err.message);
  });
}

function startIngestor() {
  connectWebSocket().catch((err) => {
    console.error("❌ connectWebSocket error:", err.message);
    ingest.wsState = "disconnected";
    ingest.lastError = `connect error: ${err.message}`;
    consecutiveFailures++;
    setTimeout(startIngestor, getReconnectDelayMs());
  });
}

module.exports = { startIngestor };
