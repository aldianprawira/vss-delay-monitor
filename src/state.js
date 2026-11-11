const { MAX_BUFFER_RECORDS, STATS_LOG_INTERVAL_MS } = require("./config");

let buffer = [];
let trafficCounter = {};
const trafficCumulative = {};
const stats = { written: 0, invalid: 0, rejected: 0, dropped: 0 };

const ingest = {
  wsState: "connecting",
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

function enforceBufferLimit() {
  if (buffer.length <= MAX_BUFFER_RECORDS) return;
  // Drop an extra 10% headroom to avoid slicing the array on every incoming message during an outage.
  const excess =
    buffer.length - MAX_BUFFER_RECORDS + Math.floor(MAX_BUFFER_RECORDS * 0.1);
  buffer.splice(0, excess);
  stats.dropped += excess;
}

function enqueueRecord(record) {
  buffer.push(record);
  enforceBufferLimit();
}

function requeueRecords(records) {
  buffer = records.concat(buffer);
  enforceBufferLimit();
}

function drainBuffer() {
  const batch = buffer;
  buffer = [];
  return batch;
}

function getBufferSize() {
  return buffer.length;
}

function incrementTraffic(action) {
  const key = action == null ? "unknown" : String(action).slice(0, 32);
  trafficCounter[key] = (trafficCounter[key] || 0) + 1;
  trafficCumulative[key] = (trafficCumulative[key] || 0) + 1;
}

function drainTrafficCounter() {
  const snapshot = trafficCounter;
  trafficCounter = {};
  return snapshot;
}

function restoreTrafficCounter(snapshot) {
  for (const [action, count] of Object.entries(snapshot)) {
    trafficCounter[action] = (trafficCounter[action] || 0) + count;
  }
}

function startStatsLogger() {
  setInterval(() => {
    console.log(
      `📊 1m stats: written=${stats.written} invalid=${stats.invalid} rejected=${stats.rejected} dropped=${stats.dropped} buffer=${buffer.length}`,
    );
    stats.written = 0;
    stats.invalid = 0;
    stats.rejected = 0;
    stats.dropped = 0;
  }, STATS_LOG_INTERVAL_MS);
}

module.exports = {
  stats,
  ingest,
  trafficCumulative,
  enqueueRecord,
  requeueRecords,
  drainBuffer,
  getBufferSize,
  incrementTraffic,
  drainTrafficCounter,
  restoreTrafficCounter,
  startStatsLogger,
};
