require("dotenv").config();
const WebSocket = require("ws");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezone);

const express = require("express");
const { Pool } = require("pg");

const { ProxyAgent, fetch: proxyFetch } = require("undici");
const { HttpsProxyAgent } = require("https-proxy-agent");

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || "";
const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;
const proxyWsAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;

// ============ KONFIGURASI ============
const DEVICE_TZ = "Asia/Jakarta";
const ACTION_AUTH = "80000";
const ACTION_DEVICE_DATA = "80003";

const FLUSH_INTERVAL_MS = 1000;
const TRAFFIC_FLUSH_INTERVAL_MS = 10000;
const STATS_LOG_INTERVAL_MS = 60000;
const MAX_BUFFER_RECORDS = 50000;
const INSERT_CHUNK_SIZE = 5000; // 6 param/baris = 30.000, di bawah batas Postgres (65.535)

// --- Watchdog & health ---
const LOGIN_TIMEOUT_MS = 10000;
const WS_HANDSHAKE_TIMEOUT_MS = 10000;
const WS_PING_INTERVAL_MS = 15000;
// Tanpa pesan APAPUN dan tanpa pong selama ini -> koneksi dianggap mati (kelipatan 3x interval ping)
const WS_ACTIVITY_TIMEOUT_MS =
  Number(process.env.WS_ACTIVITY_TIMEOUT_MS) || 45000;
// Jika > 0: reconnect paksa bila tidak ada pesan DATA (80003) selama ini. 0 = hanya dilaporkan, tidak memutus.
const WS_DATA_SILENCE_RECONNECT_MS =
  Number(process.env.WS_DATA_SILENCE_RECONNECT_MS) || 0;
// Setelah auth ditolak, beri waktu ini; kalau tetap tak ada data, putus dan login ulang
const AUTH_REJECT_GRACE_MS = 10000;
// Batas "tidak ada data" di /api/health. Default sama dengan batas ONLINE di halaman Staleness.
const HEALTH_DATA_STALE_MS = Number(process.env.HEALTH_DATA_STALE_MS) || 120000;

// Dua pool terpisah: query berat dashboard tidak boleh menghabiskan koneksi milik writer.
// Total koneksi per instance = 11, pastikan di bawah max_connections Postgres.
const writerPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
});
const apiPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});
for (const [name, p] of [
  ["writer", writerPool],
  ["api", apiPool],
]) {
  p.on("error", (e) =>
    console.error(`❌ [pool ${name}] error koneksi idle:`, e.message),
  );
}

// ============ PENJAGA PROSES ============
process.on("unhandledRejection", (reason) => {
  console.error(
    "❌ unhandledRejection:",
    reason instanceof Error ? reason.stack : reason,
  );
});
// Keluar dan biarkan supervisor (Docker/K8s/pm2) menyalakan ulang.
// Hapus process.exit jika tidak ada auto-restart.
process.on("uncaughtException", (err) => {
  console.error("💥 uncaughtException:", err.stack || err);
  process.exit(1);
});

// ============ STATE & STATISTIK ============
let buffer = [];
let trafficCounter = {};
const trafficCumulative = {};
const stats = { written: 0, invalid: 0, rejected: 0, dropped: 0 };

// Status penerimaan data, dibaca oleh /api/health
const ingest = {
  wsState: "connecting", // connecting | connected | disconnected
  connectedAt: null,
  lastMessageAt: null,
  lastDataAt: null,
  lastCloseAt: null,
  lastError: null,
  reconnects: 0,
  lastFlushOkAt: null,
  lastFlushErrorAt: null,
  lastFlushError: null,
};

function incrementTraffic(action) {
  const key = action == null ? "unknown" : String(action).slice(0, 32);
  trafficCounter[key] = (trafficCounter[key] || 0) + 1;
  trafficCumulative[key] = (trafficCumulative[key] || 0) + 1;
}

setInterval(() => {
  console.log(
    `📊 1 menit: tersimpan=${stats.written} invalid=${stats.invalid} ditolak-DB=${stats.rejected} dibuang=${stats.dropped} buffer=${buffer.length}`,
  );
  stats.written = stats.invalid = stats.rejected = stats.dropped = 0;
}, STATS_LOG_INTERVAL_MS);

// ============ BUFFER ============
function enforceBufferLimit() {
  if (buffer.length <= MAX_BUFFER_RECORDS) return;
  const excess =
    buffer.length - MAX_BUFFER_RECORDS + Math.floor(MAX_BUFFER_RECORDS * 0.1);
  buffer.splice(0, excess);
  stats.dropped += excess;
}

function enqueue(record) {
  buffer.push(record);
  enforceBufferLimit();
}

function requeue(records) {
  buffer = records.concat(buffer);
  enforceBufferLimit();
}

// ============ BAGIAN 0: LOGIN UNTUK DAPAT TOKEN & PID ============
let cachedAuth = null;

async function login() {
  const res = await (PROXY_URL ? proxyFetch : fetch)(process.env.LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    dispatcher: proxyDispatcher,
    body: JSON.stringify({
      username: process.env.LOGIN_USERNAME,
      password: process.env.LOGIN_PASSWORD,
      lang: process.env.LOGIN_LANG || "0",
      client: process.env.LOGIN_CLIENT || "2",
    }),
  });

  if (!res.ok) throw new Error(`Login HTTP ${res.status}`);

  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new Error("Respons login bukan JSON");
  }
  if (data.status !== 10000) {
    throw new Error(`Login gagal: [${data.status}] ${data.msg}`);
  }
  const token = data.data?.token;
  const pid = data.data?.pid;
  if (!token || !pid) {
    throw new Error("Token/pid tidak ditemukan meski status sukses.");
  }
  console.log("🔑 Login sukses, token & pid didapat");
  return { token, pid };
}

async function getAuth() {
  if (cachedAuth) return cachedAuth;
  cachedAuth = await login();
  return cachedAuth;
}

// ============ BAGIAN 1: KONEKSI KE WEBSOCKET SUMBER DATA ============
let failures = 0; // kegagalan beruntun; reset saat koneksi terbukti sehat

function nextDelay() {
  const base = Math.min(3000 * 2 ** Math.max(failures - 1, 0), 120000);
  return Math.round(base * (0.8 + Math.random() * 0.4)); // jitter ±20%
}

function parseDeviceMessage(p, receivedAt) {
  if (p.deviceID === undefined || p.deviceID === null || p.deviceID === "")
    return null;
  // dayjs.tz(undefined) diam-diam berarti "sekarang" -> delay 0 yang menyesatkan. Tolak eksplisit.
  if (p.dtu === undefined || p.dtu === null || p.dtu === "") return null;

  let dtuEpoch;
  try {
    dtuEpoch = dayjs.tz(p.dtu, DEVICE_TZ).valueOf();
  } catch (_) {
    return null;
  }
  if (!Number.isFinite(dtuEpoch)) return null;

  return {
    deviceId: String(p.deviceID),
    deviceName: p.ext?.deviceName || null,
    nodeId: p.nodeID ?? null,
    dtu: new Date(dtuEpoch),
    receivedAt: new Date(receivedAt),
    delayMs: receivedAt - dtuEpoch,
  };
}

// conn = status koneksi yang sedang berjalan { gotData, authOk }
function handleMessage(raw, ws, conn) {
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
        conn.authOk = true;
      } else if (msg.status) {
        console.log("⚠️ Auth WS ditolak, token dihapus dan akan login ulang");
        ingest.lastError = `auth ditolak: ${msg.status}`;
        cachedAuth = null;
        // Jangan langsung putus: format balasan auth belum tentu persis "success".
        // Kalau data tetap mengalir dalam masa tenggang, koneksi dibiarkan.
        setTimeout(() => {
          if (!conn.gotData) ws.terminate();
        }, AUTH_REJECT_GRACE_MS);
      }
    }
    return;
  }

  ingest.lastDataAt = receivedAt;
  conn.gotData = true;
  if (!msg.payload) return;

  const record = parseDeviceMessage(msg.payload, receivedAt);
  if (!record) {
    stats.invalid++;
    return;
  }
  enqueue(record);
}

async function connectWebSocket() {
  ingest.wsState = "connecting";

  let auth;
  try {
    auth = await getAuth();
  } catch (e) {
    failures++;
    ingest.wsState = "disconnected";
    ingest.lastError = `login gagal: ${e.message}`;
    const delay = nextDelay();
    console.error(
      `❌ Gagal login: ${e.message}. Coba lagi dalam ${Math.round(delay / 1000)} detik...`,
    );
    setTimeout(safeConnect, delay);
    return;
  }

  const ws = new WebSocket(process.env.WS_SOURCE_URL, {
    handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
    agent: proxyWsAgent,
  });
  const conn = { gotData: false, authOk: false };
  let lastActivity = Date.now(); // pesan apa pun ATAU pong
  let heartbeat = null;

  ws.on("open", () => {
    console.log("✅ Terhubung ke WebSocket, mengirim auth...");
    ingest.wsState = "connected";
    ingest.connectedAt = Date.now();
    lastActivity = Date.now();

    ws.send(
      JSON.stringify({
        action: ACTION_AUTH,
        payload: {
          username: process.env.LOGIN_USERNAME,
          pid: auth.pid,
          token: auth.token,
        },
      }),
    );

    heartbeat = setInterval(() => {
      const now = Date.now();

      // 1) Koneksi setengah mati: tidak ada pesan maupun pong
      if (now - lastActivity > WS_ACTIVITY_TIMEOUT_MS) {
        console.error(
          `⚠️ Tidak ada aktivitas WS selama ${Math.round((now - lastActivity) / 1000)} detik, memutus koneksi`,
        );
        ingest.lastError = "watchdog: koneksi tidak merespons";
        ws.terminate();
        return;
      }

      // 2) Koneksi hidup tapi data berhenti (opsional)
      if (WS_DATA_SILENCE_RECONNECT_MS > 0) {
        const ref = Math.max(ingest.connectedAt || 0, ingest.lastDataAt || 0);
        if (now - ref > WS_DATA_SILENCE_RECONNECT_MS) {
          console.error(
            `⚠️ Tidak ada data selama ${Math.round((now - ref) / 1000)} detik walau koneksi hidup, reconnect`,
          );
          ingest.lastError = "watchdog: data berhenti";
          ws.terminate();
          return;
        }
      }

      try {
        ws.ping();
      } catch (_) {
        /* koneksi sedang menutup */
      }
    }, WS_PING_INTERVAL_MS);
  });

  ws.on("pong", () => {
    lastActivity = Date.now();
  });

  ws.on("message", (raw) => {
    lastActivity = Date.now();
    try {
      handleMessage(raw, ws, conn);
    } catch (e) {
      stats.invalid++;
      console.error("❌ Pesan WS gagal diproses:", e.message);
    }
  });

  ws.on("close", (code) => {
    if (heartbeat) clearInterval(heartbeat);
    ingest.wsState = "disconnected";
    ingest.lastCloseAt = Date.now();
    ingest.reconnects++;

    if (conn.gotData || conn.authOk) {
      failures = 0;
    } else {
      failures++;
      // Dua kali gagal tanpa pernah sehat: token kemungkinan kedaluwarsa, paksa login ulang
      if (failures >= 2) cachedAuth = null;
    }

    const delay = nextDelay();
    console.log(
      `⚠️ WebSocket terputus (code ${code}), reconnect dalam ${Math.round(delay / 1000)} detik...`,
    );
    setTimeout(safeConnect, delay);
  });

  ws.on("error", (err) => {
    ingest.lastError = `ws error: ${err.message}`;
    console.error("WS error:", err.message);
  });
}

function safeConnect() {
  connectWebSocket().catch((e) => {
    console.error("❌ connectWebSocket error:", e.message);
    ingest.wsState = "disconnected";
    ingest.lastError = `connect error: ${e.message}`;
    failures++;
    setTimeout(safeConnect, nextDelay());
  });
}
safeConnect();

// ============ BAGIAN 2: SIMPAN DATA KE DATABASE ============
function valuesClause(rowCount, colCount) {
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const base = i * colCount;
    const cols = [];
    for (let c = 1; c <= colCount; c++) cols.push(`$${base + c}`);
    rows.push(`(${cols.join(",")})`);
  }
  return rows.join(",");
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const toParams = (r) => [
  r.deviceId,
  r.deviceName,
  r.nodeId,
  r.dtu,
  r.receivedAt,
  r.delayMs,
];

// Satu baris per device: field "terkini" dari pesan dengan dtu terbaru,
// last_received dari penerimaan terbaru.
function collapseLatest(batch) {
  const map = new Map();
  for (const r of batch) {
    const cur = map.get(r.deviceId);
    if (!cur) {
      map.set(r.deviceId, { ...r });
      continue;
    }
    const maxReceived =
      r.receivedAt > cur.receivedAt ? r.receivedAt : cur.receivedAt;
    if (r.dtu >= cur.dtu) Object.assign(cur, r);
    cur.receivedAt = maxReceived;
  }
  return [...map.values()];
}

// Rollup memakai received_at, sama dengan filter waktu di query mentah
function rollupMinute(batch) {
  const map = new Map();
  for (const r of batch) {
    const t = Math.floor(r.receivedAt.getTime() / 60000) * 60000;
    const cur = map.get(t);
    if (cur) {
      cur.cnt++;
      cur.sum += r.delayMs;
      if (r.delayMs > cur.max) cur.max = r.delayMs;
    } else {
      map.set(t, {
        bucket: new Date(t),
        cnt: 1,
        sum: r.delayMs,
        max: r.delayMs,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.bucket - b.bucket); // urutan tetap, cegah deadlock
}

function rollupDevice10m(batch) {
  const map = new Map();
  for (const r of batch) {
    const t = Math.floor(r.receivedAt.getTime() / 600000) * 600000;
    const key = `${t}|${r.deviceId}`;
    const cur = map.get(key);
    if (cur) {
      cur.cnt++;
      if (r.delayMs > cur.max) cur.max = r.delayMs;
      if (r.deviceName) cur.name = r.deviceName;
    } else {
      map.set(key, {
        deviceId: r.deviceId,
        bucket: new Date(t),
        cnt: 1,
        max: r.delayMs,
        name: r.deviceName,
      });
    }
  }
  return [...map.values()].sort((a, b) =>
    a.deviceId < b.deviceId
      ? -1
      : a.deviceId > b.deviceId
        ? 1
        : a.bucket - b.bucket,
  );
}

const FRESHER = "EXCLUDED.last_dtu >= device_latest_state.last_dtu";
const UPSERT_LATEST_TAIL = `
  ON CONFLICT (device_id) DO UPDATE SET
    last_received = GREATEST(device_latest_state.last_received, EXCLUDED.last_received),
    device_name   = CASE WHEN ${FRESHER} THEN EXCLUDED.device_name ELSE device_latest_state.device_name END,
    node_id       = CASE WHEN ${FRESHER} THEN EXCLUDED.node_id ELSE device_latest_state.node_id END,
    last_dtu      = GREATEST(device_latest_state.last_dtu, EXCLUDED.last_dtu),
    delay_ms      = CASE WHEN ${FRESHER} THEN EXCLUDED.delay_ms ELSE device_latest_state.delay_ms END,
    updated_at    = now()`;

async function insertBatch(batch) {
  const client = await writerPool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");

    for (const part of chunk(batch, INSERT_CHUNK_SIZE)) {
      await client.query(
        `INSERT INTO device_delay_history
           (device_id, device_name, node_id, dtu, received_at, delay_ms)
         VALUES ${valuesClause(part.length, 6)}`,
        part.flatMap(toParams),
      );
    }

    // Rollup di transaksi yang sama dengan data mentah: selalu konsisten
    for (const part of chunk(rollupMinute(batch), 5000)) {
      await client.query(
        `INSERT INTO delay_rollup_minute (bucket, cnt, sum_delay, max_delay)
         VALUES ${valuesClause(part.length, 4)}
         ON CONFLICT (bucket) DO UPDATE SET
           cnt       = delay_rollup_minute.cnt + EXCLUDED.cnt,
           sum_delay = delay_rollup_minute.sum_delay + EXCLUDED.sum_delay,
           max_delay = GREATEST(delay_rollup_minute.max_delay, EXCLUDED.max_delay)`,
        part.flatMap((m) => [m.bucket, m.cnt, m.sum, m.max]),
      );
    }
    for (const part of chunk(rollupDevice10m(batch), 5000)) {
      await client.query(
        `INSERT INTO delay_rollup_device_10m (device_id, bucket, cnt, max_delay, device_name)
         VALUES ${valuesClause(part.length, 5)}
         ON CONFLICT (device_id, bucket) DO UPDATE SET
           cnt         = delay_rollup_device_10m.cnt + EXCLUDED.cnt,
           max_delay   = GREATEST(delay_rollup_device_10m.max_delay, EXCLUDED.max_delay),
           device_name = COALESCE(EXCLUDED.device_name, delay_rollup_device_10m.device_name)`,
        part.flatMap((d) => [d.deviceId, d.bucket, d.cnt, d.max, d.name]),
      );
    }

    for (const part of chunk(collapseLatest(batch), INSERT_CHUNK_SIZE)) {
      await client.query(
        `INSERT INTO device_latest_state
           (device_id, device_name, node_id, last_dtu, last_received, delay_ms)
         VALUES ${valuesClause(part.length, 6)}
         ${UPSERT_LATEST_TAIL}`,
        part.flatMap(toParams),
      );
    }

    // Bersihkan device_id lama yang punya nama sama tapi last_received sudah lebih tua
    // dan sudah stale > 1 hari (agar tidak menumpuk "ghost" device)
    await client.query(`
      DELETE FROM device_latest_state d1
      USING device_latest_state d2
      WHERE d1.device_name IS NOT NULL
        AND d1.device_name = d2.device_name
        AND d1.device_id <> d2.device_id
        AND d1.last_received < d2.last_received
        AND d1.last_received < now() - interval '1 day'
    `);

    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      broken = true;
    }
    throw e;
  } finally {
    client.release(broken);
  }
}

const isDataError = (e) =>
  /^(22|23)/.test(e.code || "") && !/no partition/i.test(e.message || "");

let lastWriteError = null;

// Mengembalikan record yang BELUM tertulis. Array kosong = semua beres.
async function writeBatch(batch) {
  try {
    await insertBatch(batch);
    stats.written += batch.length;
    return [];
  } catch (e) {
    if (!isDataError(e)) {
      lastWriteError = e;
      return batch;
    }
    if (batch.length === 1) {
      stats.rejected++;
      console.error(
        `❌ Record ditolak DB (device ${batch[0].deviceId}, delay ${batch[0].delayMs}ms): ${e.message}`,
      );
      return [];
    }
    const mid = batch.length >> 1;
    const left = await writeBatch(batch.slice(0, mid));
    if (left.length > 0) return left.concat(batch.slice(mid));
    return writeBatch(batch.slice(mid));
  }
}

let flushing = false;
let lastFlushErrorLog = 0;

async function flushBuffer() {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer;
  buffer = [];
  let unwritten;
  try {
    unwritten = await writeBatch(batch);
  } catch (e) {
    lastWriteError = e;
    unwritten = batch;
  } finally {
    flushing = false;
  }

  if (unwritten.length === 0) {
    ingest.lastFlushOkAt = Date.now();
    return;
  }

  requeue(unwritten);
  ingest.lastFlushErrorAt = Date.now();
  ingest.lastFlushError = lastWriteError?.message || "unknown";
  const now = Date.now();
  if (now - lastFlushErrorLog > 10000) {
    lastFlushErrorLog = now;
    console.error(
      `❌ Gagal simpan ke database, ${unwritten.length} record dikembalikan ke buffer (buffer=${buffer.length}): ${ingest.lastFlushError}`,
    );
  }
}
setInterval(flushBuffer, FLUSH_INTERVAL_MS);

// ============ BAGIAN 2b: FLUSH TRAFFIC COUNTER (UPSERT PER MENIT) ============
let trafficFlushing = false;

async function writeTraffic(snapshot) {
  const bucketStart = new Date(Math.floor(Date.now() / 60000) * 60000);
  const client = await writerPool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    for (const [action, count] of Object.entries(snapshot)) {
      await client.query(
        `INSERT INTO action_traffic_history (action, count, bucket_start)
         VALUES ($1, $2, $3)
         ON CONFLICT (action, bucket_start)
         DO UPDATE SET count = action_traffic_history.count + EXCLUDED.count`,
        [action, count, bucketStart],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      broken = true;
    }
    throw e;
  } finally {
    client.release(broken);
  }
}

async function flushTraffic() {
  if (trafficFlushing || Object.keys(trafficCounter).length === 0) return;
  trafficFlushing = true;
  const snapshot = trafficCounter;
  trafficCounter = {};
  try {
    await writeTraffic(snapshot);
  } catch (e) {
    for (const [action, count] of Object.entries(snapshot)) {
      trafficCounter[action] = (trafficCounter[action] || 0) + count;
    }
    console.error(
      "❌ Gagal simpan traffic counter (akan dicoba lagi):",
      e.message,
    );
  } finally {
    trafficFlushing = false;
  }
}
setInterval(flushTraffic, TRAFFIC_FLUSH_INTERVAL_MS);

// ============ BAGIAN 2c: PEMELIHARAAN PARTISI & RETENSI ============
const HISTORY_RETENTION_DAYS = Math.max(
  Number(process.env.HISTORY_RETENTION_DAYS) || 7,
  2,
);
const PARTITION_AHEAD_DAYS = 3;
const ROLLUP_MINUTE_RETENTION_DAYS =
  Number(process.env.ROLLUP_RETENTION_DAYS) || 90;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const MAINTENANCE_RETRY_MS = 5 * 60 * 1000;

const retention = {
  lastRunAt: null,
  lastOkAt: null,
  lastError: null,
  created: 0,
  dropped: 0,
  defaultHasRows: false,
};

async function runPartitionMaintenance() {
  retention.lastRunAt = Date.now();
  try {
    const { rows } = await writerPool.query(
      "SELECT * FROM maintain_history_partitions($1, $2, $3)",
      [
        HISTORY_RETENTION_DAYS,
        PARTITION_AHEAD_DAYS,
        ROLLUP_MINUTE_RETENTION_DAYS,
      ],
    );
    const r = rows[0];
    if (r.drop_failed > 0) {
      retention.lastError = `${r.drop_failed} partisi gagal dihapus`;
      console.error(`⚠️ ${retention.lastError}, dicoba lagi dalam 5 menit`);
      return false; // lastOkAt tidak diperbarui, jadi peringatan retention_stalled muncul bila berlanjut
    }
    retention.lastOkAt = Date.now();
    retention.lastError = null;
    retention.created = r.created;
    retention.dropped = r.dropped;
    retention.defaultHasRows = r.default_has_rows;
    if (r.created || r.dropped) {
      console.log(
        `🗂️ Partisi: ${r.created} dibuat, ${r.dropped} dihapus (retensi ${HISTORY_RETENTION_DAYS} hari)`,
      );
    }
    if (r.default_has_rows) {
      console.error(
        "⚠️ Partisi default berisi data: ada baris tanpa partisi. Periksa pemeliharaan partisi.",
      );
    }
    return true;
  } catch (e) {
    retention.lastError = e.message;
    console.error("❌ Pemeliharaan partisi gagal:", e.message);
    return false;
  }
}

function scheduleMaintenance(delayMs) {
  setTimeout(async () => {
    const ok = await runPartitionMaintenance();
    scheduleMaintenance(ok ? MAINTENANCE_INTERVAL_MS : MAINTENANCE_RETRY_MS);
  }, delayMs);
}
scheduleMaintenance(2000);

// ============ BAGIAN 3: API + DASHBOARD ============
const app = express();
app.use(express.static("public"));

const ah = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ---- Health ----
// Liveness sederhana: hanya menandakan proses hidup. Jangan dipakai probe yang me-restart
// pod saat DB bermasalah, karena restart tidak memperbaiki DB.
app.get("/healthz", (req, res) => res.send("ok"));

async function checkDb() {
  let timer;
  try {
    await Promise.race([
      apiPool.query("SELECT 1"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 3000);
      }),
    ]);
    return true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function computeHealth(dbOk) {
  const now = Date.now();
  const age = (t) => (t ? now - t : null);
  const problems = [];
  const warnings = [];

  const wsConnected = ingest.wsState === "connected";
  const ref = Math.max(ingest.connectedAt || 0, ingest.lastDataAt || 0);
  const silentForMs = wsConnected ? now - ref : null;

  if (!wsConnected) problems.push("ws_disconnected");
  else if (silentForMs > HEALTH_DATA_STALE_MS) problems.push("no_data");

  if (!dbOk) problems.push("db_unreachable");
  if (
    ingest.lastFlushErrorAt &&
    ingest.lastFlushErrorAt > (ingest.lastFlushOkAt || 0)
  ) {
    problems.push("db_write_failing");
  }
  if (buffer.length > MAX_BUFFER_RECORDS * 0.5) warnings.push("buffer_high");

  const down = problems.some((p) =>
    ["ws_disconnected", "no_data", "db_unreachable"].includes(p),
  );
  const status = down
    ? "down"
    : problems.length || warnings.length
      ? "degraded"
      : "ok";

  return {
    status,
    trusted: problems.length === 0, // false = status device di dashboard tidak boleh dipercaya
    problems,
    warnings,
    checkedAt: new Date(now).toISOString(),
    uptimeSec: Math.round(process.uptime()),
    ws: {
      state: ingest.wsState,
      lastMessageAgeMs: age(ingest.lastMessageAt),
      lastDataAgeMs: age(ingest.lastDataAt),
      silentForMs,
      reconnects: ingest.reconnects,
      lastError: ingest.lastError,
    },
    db: {
      reachable: dbOk,
      lastFlushOkAgeMs: age(ingest.lastFlushOkAt),
      lastFlushError: ingest.lastFlushError,
    },
    buffer: { size: buffer.length, max: MAX_BUFFER_RECORDS },
  };
}

// Selalu 200 agar dashboard bisa membacanya. Untuk uptime monitor eksternal pakai ?strict=1 (503 jika tidak tepercaya).
app.get(
  "/api/health",
  ah(async (req, res) => {
    const health = computeHealth(await checkDb());
    if (req.query.strict === "1" && !health.trusted) res.status(503);
    res.json(health);
  }),
);

// ---- Data ----
const RANGE_MINUTES = { "15m": 15, "1h": 60, "24h": 1440 };
function parseRange(rangeParam) {
  return RANGE_MINUTES[rangeParam] || RANGE_MINUTES["1h"];
}
const cutoffFor = (req) =>
  new Date(Date.now() - parseRange(req.query.range) * 60000);

// CASE WHEN kategori delay — SATU-SATUNYA TEMPAT untuk ubah batas kategori
const CATEGORY_SQL = `
  CASE
    WHEN ABS(delay_ms) < 5000 THEN '0-5s'
    WHEN ABS(delay_ms) < 60000 THEN '5s-1m'
    ELSE '>1m'
  END
`;
const CATEGORY_ORDER = ["0-5s", "5s-1m", ">1m"];

function fillCategoryCounts(rows) {
  const map = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0]));
  rows.forEach((r) => {
    map[r.category] = Number(r.count);
  });
  return CATEGORY_ORDER.map((c) => ({ category: c, count: map[c] }));
}

app.get(
  "/api/devices",
  ah(async (req, res) => {
    const { rows } = await apiPool.query(`
      SELECT DISTINCT ON (COALESCE(device_name, device_id)) *
      FROM device_latest_state
      ORDER BY COALESCE(device_name, device_id),
               last_received DESC,
               last_dtu DESC
    `);
    // urutkan lagi sesuai kebutuhan UI (delay tertinggi dulu)
    rows.sort((a, b) => Number(b.delay_ms) - Number(a.delay_ms));
    res.json(rows);
  }),
);

app.get(
  "/api/devices/:id/history",
  ah(async (req, res) => {
    const { rows } = await apiPool.query(
      `SELECT dtu, received_at, delay_ms
       FROM device_delay_history
       WHERE device_id = $1 AND received_at > $2
       ORDER BY received_at ASC`,
      [req.params.id, cutoffFor(req)],
    );
    res.json(rows);
  }),
);

app.get(
  "/api/devices/:id/stats",
  ah(async (req, res) => {
    const cutoff = cutoffFor(req);

    const agg = await apiPool.query(
      `SELECT COALESCE(MAX(delay_ms), 0) AS max_delay, COALESCE(AVG(delay_ms), 0) AS avg_delay, COUNT(*) AS total_count
       FROM device_delay_history WHERE device_id = $1 AND received_at > $2`,
      [req.params.id, cutoff],
    );

    const catRows = await apiPool.query(
      `SELECT ${CATEGORY_SQL} AS category, COUNT(*) AS count
       FROM device_delay_history WHERE device_id = $1 AND received_at > $2
       GROUP BY category`,
      [req.params.id, cutoff],
    );

    res.json({ ...agg.rows[0], categories: fillCategoryCounts(catRows.rows) });
  }),
);

app.get(
  "/api/stats/summary",
  ah(async (req, res) => {
    const cutoff = cutoffFor(req);

    const catCurrent = await apiPool.query(
      `SELECT ${CATEGORY_SQL} AS category, COUNT(*) AS count FROM device_latest_state GROUP BY category`,
    );
    const totalDevices = await apiPool.query(
      `SELECT COUNT(*) AS total FROM device_latest_state`,
    );
    const currentWorst = await apiPool.query(
      `SELECT device_id, device_name, delay_ms FROM device_latest_state ORDER BY delay_ms DESC LIMIT 1`,
    );
    const historicalWorst = await apiPool.query(
      `SELECT h.device_id, COALESCE(h.device_name, dl.device_name) AS device_name, h.delay_ms
       FROM device_delay_history h
       LEFT JOIN device_latest_state dl ON dl.device_id = h.device_id
       WHERE h.received_at > $1
       ORDER BY h.delay_ms DESC LIMIT 1`,
      [cutoff],
    );
    const topOffenders = await apiPool.query(
      `SELECT h.device_id, COALESCE(MAX(h.device_name), dl.device_name) AS device_name, MAX(h.delay_ms) AS max_delay
       FROM device_delay_history h
       LEFT JOIN device_latest_state dl ON dl.device_id = h.device_id
       WHERE h.received_at > $1
       GROUP BY h.device_id, dl.device_name
       ORDER BY max_delay DESC LIMIT 5`,
      [cutoff],
    );

    res.json({
      totalDevices: Number(totalDevices.rows[0].total),
      categories: fillCategoryCounts(catCurrent.rows),
      currentWorst: currentWorst.rows[0] || null,
      historicalWorst: historicalWorst.rows[0] || null,
      topOffenders: topOffenders.rows,
    });
  }),
);

app.get(
  "/api/stats/top-stale",
  ah(async (req, res) => {
    const { rows } = await apiPool.query(
      `SELECT device_id, device_name, last_received
       FROM device_latest_state
       ORDER BY last_received ASC
       LIMIT 5`,
    );
    res.json(rows);
  }),
);

app.get(
  "/api/stats/timeline",
  ah(async (req, res) => {
    const { rows } = await apiPool.query(
      `SELECT date_trunc('minute', received_at) AS bucket, AVG(delay_ms) AS avg_delay, MAX(delay_ms) AS max_delay
       FROM device_delay_history WHERE received_at > $1
       GROUP BY bucket ORDER BY bucket ASC`,
      [cutoffFor(req)],
    );
    res.json(rows);
  }),
);

app.get("/api/traffic/live", (req, res) => {
  res.json(trafficCumulative);
});

app.get(
  "/api/traffic/history",
  ah(async (req, res) => {
    const { rows } = await apiPool.query(
      `SELECT action, bucket_start AS bucket, count
       FROM action_traffic_history
       WHERE bucket_start > $1
       ORDER BY bucket_start ASC`,
      [cutoffFor(req)],
    );
    res.json(rows);
  }),
);

// ---- Summary per tanggal ----
const SUMMARY_TIMEOUT_MS = 60000; // query harian berat, lebih longgar dari apiPool default (15 detik)
const summaryCache = new Map(); // date -> { at, ttl, data }

app.get(
  "/api/summary",
  ah(async (req, res) => {
    const date = String(
      req.query.date || dayjs().tz(DEVICE_TZ).format("YYYY-MM-DD"),
    );
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "format date harus YYYY-MM-DD" });
    }

    // Batas hari mengikuti zona waktu device (WIB), bukan UTC server
    const start = dayjs.tz(`${date} 00:00:00`, DEVICE_TZ);
    if (!start.isValid())
      return res.status(400).json({ error: "tanggal tidak valid" });
    const end = start.add(1, "day");

    const oldest = dayjs()
      .subtract(HISTORY_RETENTION_DAYS, "day")
      .startOf("day");
    if (start.isBefore(oldest)) {
      return res.status(400).json({
        error: `data mentah hanya disimpan ${HISTORY_RETENTION_DAYS} hari`,
      });
    }
    if (start.isAfter(dayjs())) {
      return res.status(400).json({ error: "tanggal di masa depan" });
    }

    // Hari lampau tidak berubah lagi -> cache lama. Hari ini -> cache singkat.
    const isToday = end.isAfter(dayjs());
    const ttl = isToday ? 60 * 1000 : 60 * 60 * 1000;
    const hit = summaryCache.get(date);
    if (hit && Date.now() - hit.at < hit.ttl) return res.json(hit.data);

    const client = await apiPool.connect();
    let aggRows, registered;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = ${SUMMARY_TIMEOUT_MS}`);
      // GROUP BY device_id: device yang kirim >= 1 baris otomatis masuk,
      // device tanpa satu pun baris di rentang ini otomatis tidak muncul.
      aggRows = (
        await client.query(
          `SELECT device_id,
                  MAX(device_name)       AS device_name,
                  COUNT(*)::int          AS cnt,
                  MIN(delay_ms)::bigint  AS min_delay,
                  MAX(delay_ms)::bigint  AS max_delay,
                  AVG(delay_ms)::float8  AS avg_delay
           FROM device_delay_history
           WHERE received_at >= $1 AND received_at < $2
           GROUP BY device_id`,
          [start.toDate(), end.toDate()],
        )
      ).rows;
      registered = Number(
        (await client.query("SELECT COUNT(*) AS n FROM device_latest_state"))
          .rows[0].n,
      );
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
      throw e;
    } finally {
      client.release();
    }

    // Exclude device yang min, max, dan avg-nya semuanya 0
    const devices = aggRows
      .filter(
        (d) =>
          !(
            Number(d.min_delay) === 0 &&
            Number(d.max_delay) === 0 &&
            d.avg_delay === 0
          ),
      )
      .map((d) => ({
        deviceId: d.device_id,
        deviceName: d.device_name,
        count: d.cnt,
        minDelay: Number(d.min_delay),
        maxDelay: Number(d.max_delay),
        avgDelay: Math.round(d.avg_delay),
      }))
      .sort((a, b) => b.maxDelay - a.maxDelay);

    const data = {
      date,
      range: { from: start.toISOString(), to: end.toISOString() },
      totals: {
        registeredDevices: registered,
        sentData: aggRows.length, // device yang kirim >= 1x
        noData: Math.max(registered - aggRows.length, 0), // di-exclude: tidak kirim sama sekali
        excludedZero: aggRows.length - devices.length, // di-exclude: min=max=avg=0
        shown: devices.length,
        records: aggRows.reduce((s, d) => s + d.cnt, 0),
      },
      devices,
    };

    if (summaryCache.size > 20)
      summaryCache.delete(summaryCache.keys().next().value);
    summaryCache.set(date, { at: Date.now(), ttl, data });
    res.json(data);
  }),
);

app.use((err, req, res, next) => {
  console.error(`❌ ${req.method} ${req.originalUrl}:`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "internal_error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Dashboard jalan di http://localhost:${PORT}`),
);
