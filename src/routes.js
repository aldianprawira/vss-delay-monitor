const express = require("express");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const {
  DEVICE_TZ,
  HEALTH_DATA_STALE_MS,
  MAX_BUFFER_RECORDS,
} = require("./config");
const {
  apiPool,
  isDatabaseReachable,
} = require("./db");
const {
  getOrGenerateDailySummary,
  getMonthlySummary,
} = require("./dailySummary");
const { DELAY_CATEGORIES } = require("../public/format");
const {
  ingest,
  trafficCumulative,
  getBufferSize,
} = require("./state");

const router = express.Router();

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err?.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  });

const RANGE_MINUTES = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "3h": 180,
  "6h": 360,
  "12h": 720,
  "24h": 1440,
  "2d": 2880,
  "7d": 10080,
};

function parseTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getTimeWindow(req) {
  const fromParam = parseTimestamp(req.query.from);
  const toParam = parseTimestamp(req.query.to);
  if (fromParam || toParam) {
    const to = toParam || new Date();
    const from = fromParam || new Date(to.getTime() - 3600000);
    return from <= to ? { from, to } : { from: to, to: from };
  }
  const minutes = RANGE_MINUTES[req.query.range] || RANGE_MINUTES["1h"];
  const to = new Date();
  const from = new Date(to.getTime() - minutes * 60000);
  return { from, to };
}

// Build SQL CASE branches directly from public/format.js so category changes apply across backend queries automatically.
function buildCategorySql(columnExpr = "delay_ms") {
  const escapeSqlLiteral = (str) => String(str).replace(/'/g, "''");
  const branches = DELAY_CATEGORIES.slice(0, -1).map(
    (c) =>
      `WHEN ABS(${columnExpr}) < ${Number(c.max)} THEN '${escapeSqlLiteral(c.key)}'`,
  );
  const fallback = escapeSqlLiteral(
    DELAY_CATEGORIES[DELAY_CATEGORIES.length - 1].key,
  );
  return `CASE ${branches.join(" ")} ELSE '${fallback}' END`;
}

const CATEGORY_SQL = buildCategorySql("delay_ms");
const CATEGORY_ORDER = DELAY_CATEGORIES.map((c) => c.key);

function fillCategoryCounts(rows) {
  const countsByCategory = Object.fromEntries(
    CATEGORY_ORDER.map((category) => [category, 0]),
  );
  for (const row of rows) {
    countsByCategory[row.category] = Number(row.count);
  }
  return CATEGORY_ORDER.map((category) => ({
    category,
    count: countsByCategory[category],
  }));
}

function computeHealth(dbReachable) {
  const now = Date.now();
  const ageSince = (timestamp) => (timestamp ? now - timestamp : null);
  const problems = [];
  const warnings = [];

  const wsConnected = ingest.wsState === "connected";
  const lastActiveDataRef = Math.max(
    ingest.connectedAt || 0,
    ingest.lastDataAt || 0,
  );
  const silentForMs = wsConnected ? now - lastActiveDataRef : null;
  const bufferSize = getBufferSize();

  if (!wsConnected) problems.push("ws_disconnected");
  else if (silentForMs > HEALTH_DATA_STALE_MS) problems.push("no_data");

  if (!dbReachable) problems.push("db_unreachable");
  if (
    ingest.lastFlushErrorAt &&
    ingest.lastFlushErrorAt > (ingest.lastFlushOkAt || 0)
  ) {
    problems.push("db_write_failing");
  }
  if (bufferSize > MAX_BUFFER_RECORDS * 0.5) warnings.push("buffer_high");

  const isDown = problems.some((p) =>
    ["ws_disconnected", "no_data", "db_unreachable"].includes(p),
  );
  const status = isDown
    ? "down"
    : problems.length || warnings.length
      ? "degraded"
      : "ok";

  return {
    status,
    trusted: problems.length === 0,
    problems,
    warnings,
    checkedAt: new Date(now).toISOString(),
    uptimeSec: Math.round(process.uptime()),
    ws: {
      state: ingest.wsState,
      lastMessageAgeMs: ageSince(ingest.lastMessageAt),
      lastDataAgeMs: ageSince(ingest.lastDataAt),
      silentForMs,
      reconnects: ingest.reconnects,
      lastError: ingest.lastError,
    },
    db: {
      reachable: dbReachable,
      lastFlushOkAgeMs: ageSince(ingest.lastFlushOkAt),
      lastFlushError: ingest.lastFlushError,
    },
    buffer: { size: bufferSize, max: MAX_BUFFER_RECORDS },
  };
}

// Liveness probe excludes DB checks because restarting the container cannot recover a database outage.
router.get("/healthz", (req, res) => res.send("ok"));

// Return HTTP 200 by default so the dashboard can parse the payload; external monitors can pass ?strict=1 for 503.
router.get(
  "/api/health",
  asyncHandler(async (req, res) => {
    const health = computeHealth(await isDatabaseReachable());
    if (req.query.strict === "1" && !health.trusted) res.status(503);
    res.json(health);
  }),
);

router.get(
  "/api/devices",
  asyncHandler(async (req, res) => {
    const { rows } = await apiPool.query(`
      SELECT DISTINCT ON (COALESCE(device_name, device_id)) *
      FROM device_latest_state
      ORDER BY COALESCE(device_name, device_id),
               last_received DESC,
               last_dtu DESC
    `);
    // PostgreSQL requires ORDER BY to match DISTINCT ON, so re-sort by highest delay in memory for the UI.
    rows.sort((a, b) => Number(b.delay_ms) - Number(a.delay_ms));
    res.json(rows);
  }),
);

router.get(
  "/api/devices/:id/history",
  asyncHandler(async (req, res) => {
    const { from, to } = getTimeWindow(req);
    const { rows } = await apiPool.query(
      `SELECT dtu, received_at, delay_ms
       FROM device_delay_history
       WHERE device_id = $1 AND received_at >= $2 AND received_at <= $3
       ORDER BY received_at ASC`,
      [req.params.id, from, to],
    );
    res.json(rows);
  }),
);

router.get(
  "/api/devices/:id/stats",
  asyncHandler(async (req, res) => {
    const { from, to } = getTimeWindow(req);
    const [agg, catRows] = await Promise.all([
      apiPool.query(
        `SELECT COALESCE(MAX(delay_ms), 0) AS max_delay,
                COALESCE(AVG(delay_ms), 0) AS avg_delay,
                COUNT(*) AS total_count
         FROM device_delay_history
         WHERE device_id = $1 AND received_at >= $2 AND received_at <= $3`,
        [req.params.id, from, to],
      ),
      apiPool.query(
        `SELECT ${CATEGORY_SQL} AS category, COUNT(*) AS count
         FROM device_delay_history
         WHERE device_id = $1 AND received_at >= $2 AND received_at <= $3
         GROUP BY category`,
        [req.params.id, from, to],
      ),
    ]);

    res.json({ ...agg.rows[0], categories: fillCategoryCounts(catRows.rows) });
  }),
);

router.get("/api/traffic/live", (req, res) => {
  res.json(trafficCumulative);
});

router.get(
  "/api/traffic/history",
  asyncHandler(async (req, res) => {
    const { from, to } = getTimeWindow(req);
    const { rows } = await apiPool.query(
      `SELECT action, bucket_start AS bucket, count
       FROM action_traffic_history
       WHERE bucket_start >= date_trunc('minute', $1::timestamptz)
         AND bucket_start <= date_trunc('minute', $2::timestamptz)
       ORDER BY bucket_start ASC`,
      [from, to],
    );
    res.json(rows);
  }),
);

router.get(
  "/api/summary",
  asyncHandler(async (req, res) => {
    const defaultDate = dayjs()
      .tz(DEVICE_TZ)
      .subtract(1, "day")
      .format("YYYY-MM-DD");
    const date = String(req.query.date || defaultDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res
        .status(400)
        .json({ error: "Invalid date format; expected YYYY-MM-DD." });
    }

    const data = await getOrGenerateDailySummary(date, {
      cancelOnCloseRes: res,
    });
    res.json(data);
  }),
);

router.get(
  "/api/monthly-summary",
  asyncHandler(async (req, res) => {
    const defaultMonth = dayjs()
      .tz(DEVICE_TZ)
      .subtract(1, "day")
      .format("YYYY-MM");
    const month = String(req.query.month || defaultMonth);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res
        .status(400)
        .json({ error: "Invalid month format; expected YYYY-MM." });
    }

    const data = await getMonthlySummary(month, {
      cancelOnCloseRes: res,
    });
    res.json(data);
  }),
);

module.exports = router;
