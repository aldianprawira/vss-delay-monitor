const {
  INSERT_CHUNK_SIZE,
  FLUSH_INTERVAL_MS,
  TRAFFIC_FLUSH_INTERVAL_MS,
} = require("./config");
const { writerPool, withTransaction } = require("./db");
const {
  stats,
  ingest,
  drainBuffer,
  requeueRecords,
  getBufferSize,
  drainTrafficCounter,
  restoreTrafficCounter,
} = require("./state");

function buildValuesClause(rowCount, colCount) {
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const base = i * colCount;
    const cols = [];
    for (let c = 1; c <= colCount; c++) cols.push(`$${base + c}`);
    rows.push(`(${cols.join(",")})`);
  }
  return rows.join(",");
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const toRecordParams = (r) => [
  r.deviceId,
  r.deviceName,
  r.nodeId,
  r.dtu,
  r.receivedAt,
  r.delayMs,
];

function collapseLatestByDevice(batch) {
  const map = new Map();
  for (const r of batch) {
    const cur = map.get(r.deviceId);
    if (!cur) {
      map.set(r.deviceId, { ...r });
      continue;
    }
    const maxReceived =
      r.receivedAt > cur.receivedAt ? r.receivedAt : cur.receivedAt;
    // Out-of-order packets can arrive later with an older dtu; keep telemetry from the newest dtu while tracking latest receipt.
    if (r.dtu >= cur.dtu) Object.assign(cur, r);
    cur.receivedAt = maxReceived;
  }
  return [...map.values()];
}

function aggregateByMinute(batch) {
  const map = new Map();
  for (const r of batch) {
    const bucketEpoch = Math.floor(r.receivedAt.getTime() / 60000) * 60000;
    const cur = map.get(bucketEpoch);
    if (cur) {
      cur.cnt++;
      cur.sum += r.delayMs;
      if (r.delayMs > cur.max) cur.max = r.delayMs;
    } else {
      map.set(bucketEpoch, {
        bucket: new Date(bucketEpoch),
        cnt: 1,
        sum: r.delayMs,
        max: r.delayMs,
      });
    }
  }
  // Consistent ordering prevents row-level lock deadlocks during concurrent upserts.
  return [...map.values()].sort((a, b) => a.bucket - b.bucket);
}

function aggregateDevice10m(batch) {
  const map = new Map();
  for (const r of batch) {
    const bucketEpoch = Math.floor(r.receivedAt.getTime() / 600000) * 600000;
    const key = `${bucketEpoch}|${r.deviceId}`;
    const cur = map.get(key);
    if (cur) {
      cur.cnt++;
      if (r.delayMs > cur.max) cur.max = r.delayMs;
      if (r.deviceName) cur.name = r.deviceName;
    } else {
      map.set(key, {
        deviceId: r.deviceId,
        bucket: new Date(bucketEpoch),
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

const IS_FRESHER_DTU = "EXCLUDED.last_dtu >= device_latest_state.last_dtu";
const UPSERT_LATEST_SQL_TAIL = `
  ON CONFLICT (device_id) DO UPDATE SET
    last_received = GREATEST(device_latest_state.last_received, EXCLUDED.last_received),
    device_name   = CASE WHEN ${IS_FRESHER_DTU} THEN EXCLUDED.device_name ELSE device_latest_state.device_name END,
    node_id       = CASE WHEN ${IS_FRESHER_DTU} THEN EXCLUDED.node_id ELSE device_latest_state.node_id END,
    last_dtu      = GREATEST(device_latest_state.last_dtu, EXCLUDED.last_dtu),
    delay_ms      = CASE WHEN ${IS_FRESHER_DTU} THEN EXCLUDED.delay_ms ELSE device_latest_state.delay_ms END,
    updated_at    = now()`;

async function insertBatch(batch) {
  await withTransaction(writerPool, async (client) => {
    for (const part of chunkArray(batch, INSERT_CHUNK_SIZE)) {
      await client.query(
        `INSERT INTO device_delay_history
           (device_id, device_name, node_id, dtu, received_at, delay_ms)
         VALUES ${buildValuesClause(part.length, 6)}`,
        part.flatMap(toRecordParams),
      );
    }

    for (const part of chunkArray(aggregateByMinute(batch), INSERT_CHUNK_SIZE)) {
      await client.query(
        `INSERT INTO delay_rollup_minute (bucket, cnt, sum_delay, max_delay)
         VALUES ${buildValuesClause(part.length, 4)}
         ON CONFLICT (bucket) DO UPDATE SET
           cnt       = delay_rollup_minute.cnt + EXCLUDED.cnt,
           sum_delay = delay_rollup_minute.sum_delay + EXCLUDED.sum_delay,
           max_delay = GREATEST(delay_rollup_minute.max_delay, EXCLUDED.max_delay)`,
        part.flatMap((m) => [m.bucket, m.cnt, m.sum, m.max]),
      );
    }

    for (const part of chunkArray(aggregateDevice10m(batch), INSERT_CHUNK_SIZE)) {
      await client.query(
        `INSERT INTO delay_rollup_device_10m (device_id, bucket, cnt, max_delay, device_name)
         VALUES ${buildValuesClause(part.length, 5)}
         ON CONFLICT (device_id, bucket) DO UPDATE SET
           cnt         = delay_rollup_device_10m.cnt + EXCLUDED.cnt,
           max_delay   = GREATEST(delay_rollup_device_10m.max_delay, EXCLUDED.max_delay),
           device_name = COALESCE(EXCLUDED.device_name, delay_rollup_device_10m.device_name)`,
        part.flatMap((d) => [d.deviceId, d.bucket, d.cnt, d.max, d.name]),
      );
    }

    for (const part of chunkArray(
      collapseLatestByDevice(batch),
      INSERT_CHUNK_SIZE,
    )) {
      await client.query(
        `INSERT INTO device_latest_state
           (device_id, device_name, node_id, last_dtu, last_received, delay_ms)
         VALUES ${buildValuesClause(part.length, 6)}
         ${UPSERT_LATEST_SQL_TAIL}`,
        part.flatMap(toRecordParams),
      );
    }

    // Re-registered hardware may receive a new device_id while keeping its device_name; prune stale ghost entries after 24h.
    await client.query(`
      DELETE FROM device_latest_state d1
      USING device_latest_state d2
      WHERE d1.device_name IS NOT NULL
        AND d1.device_name = d2.device_name
        AND d1.device_id <> d2.device_id
        AND d1.last_received < d2.last_received
        AND d1.last_received < now() - interval '1 day'
    `);
  });
}

// Exclude missing-partition errors (23514) from row rejection so records are requeued until partition maintenance runs.
const isRowValidationError = (err) =>
  /^(22|23)/.test(err.code || "") && !/no partition/i.test(err.message || "");

let lastWriteError = null;

async function writeBatchWithIsolation(batch) {
  try {
    await insertBatch(batch);
    stats.written += batch.length;
    return [];
  } catch (err) {
    if (!isRowValidationError(err)) {
      lastWriteError = err;
      return batch;
    }
    if (batch.length === 1) {
      stats.rejected++;
      console.error(
        `❌ Database rejected record (device ${batch[0].deviceId}, delay ${batch[0].delayMs}ms): ${err.message}`,
      );
      return [];
    }
    // Bisect the batch to isolate and discard malformed records without losing valid siblings.
    const mid = batch.length >> 1;
    const leftUnwritten = await writeBatchWithIsolation(batch.slice(0, mid));
    if (leftUnwritten.length > 0) return leftUnwritten.concat(batch.slice(mid));
    return writeBatchWithIsolation(batch.slice(mid));
  }
}

let isFlushingBuffer = false;
let lastFlushErrorLogAt = 0;

async function flushBuffer() {
  if (isFlushingBuffer || getBufferSize() === 0) return;
  isFlushingBuffer = true;
  const batch = drainBuffer();
  let unwritten;
  try {
    unwritten = await writeBatchWithIsolation(batch);
  } catch (err) {
    lastWriteError = err;
    unwritten = batch;
  } finally {
    isFlushingBuffer = false;
  }

  if (unwritten.length === 0) {
    ingest.lastFlushOkAt = Date.now();
    return;
  }

  requeueRecords(unwritten);
  ingest.lastFlushErrorAt = Date.now();
  ingest.lastFlushError = lastWriteError?.message || "unknown";
  const now = Date.now();
  if (now - lastFlushErrorLogAt > 10000) {
    lastFlushErrorLogAt = now;
    console.error(
      `❌ Failed to write batch to database; requeued ${unwritten.length} records (buffer=${getBufferSize()}): ${ingest.lastFlushError}`,
    );
  }
}

let isFlushingTraffic = false;

async function writeTrafficSnapshot(snapshot) {
  const bucketStart = new Date(Math.floor(Date.now() / 60000) * 60000);
  await withTransaction(writerPool, async (client) => {
    for (const [action, count] of Object.entries(snapshot)) {
      await client.query(
        `INSERT INTO action_traffic_history (action, count, bucket_start)
         VALUES ($1, $2, $3)
         ON CONFLICT (action, bucket_start)
         DO UPDATE SET count = action_traffic_history.count + EXCLUDED.count`,
        [action, count, bucketStart],
      );
    }
  });
}

async function flushTraffic() {
  if (isFlushingTraffic) return;
  const snapshot = drainTrafficCounter();
  if (Object.keys(snapshot).length === 0) return;

  isFlushingTraffic = true;
  try {
    await writeTrafficSnapshot(snapshot);
  } catch (err) {
    restoreTrafficCounter(snapshot);
    console.error(
      "❌ Failed to flush traffic counters (will retry):",
      err.message,
    );
  } finally {
    isFlushingTraffic = false;
  }
}

function startWriterLoops() {
  setInterval(flushBuffer, FLUSH_INTERVAL_MS);
  setInterval(flushTraffic, TRAFFIC_FLUSH_INTERVAL_MS);
}

module.exports = { startWriterLoops };
