const {
  HISTORY_RETENTION_DAYS,
  PARTITION_AHEAD_DAYS,
  ROLLUP_MINUTE_RETENTION_DAYS,
  MAINTENANCE_INTERVAL_MS,
  MAINTENANCE_RETRY_MS,
} = require("./config");
const { writerPool, withTransaction } = require("./db");

const retentionState = {
  lastRunAt: null,
  lastOkAt: null,
  lastError: null,
  created: 0,
  dropped: 0,
  defaultHasRows: false,
};

const MAINTENANCE_PARAMS = [
  HISTORY_RETENTION_DAYS,
  PARTITION_AHEAD_DAYS,
  ROLLUP_MINUTE_RETENTION_DAYS,
];

// Evacuate rows from the default partition before creating new partitions so PostgreSQL does not reject overlapping constraints.
async function recoverDefaultPartitionAndMaintain() {
  return withTransaction(
    writerPool,
    async (client) => {
      await client.query(
        "LOCK TABLE device_delay_history_default IN ACCESS EXCLUSIVE MODE",
      );
      await client.query(
        "CREATE TEMP TABLE tmp_default_rows ON COMMIT DROP AS SELECT * FROM device_delay_history_default",
      );
      await client.query("TRUNCATE TABLE device_delay_history_default");

      const { rows } = await client.query(
        "SELECT * FROM maintain_history_partitions($1, $2, $3)",
        MAINTENANCE_PARAMS,
      );

      const { rowCount: relocatedCount } = await client.query(
        `INSERT INTO device_delay_history
         SELECT * FROM tmp_default_rows
         WHERE received_at >= date_trunc('day', now()) - make_interval(days => $1)`,
        [HISTORY_RETENTION_DAYS],
      );

      console.log(
        `🔄 Relocated ${relocatedCount} rows from default partition into daily partitions.`,
      );
      return rows[0];
    },
    { statementTimeoutMs: 120000 },
  );
}

async function executeMaintenanceQuery() {
  try {
    const { rows } = await writerPool.query(
      "SELECT * FROM maintain_history_partitions($1, $2, $3)",
      MAINTENANCE_PARAMS,
    );
    const result = rows[0];
    if (result.default_has_rows) {
      return await recoverDefaultPartitionAndMaintain();
    }
    return result;
  } catch (err) {
    if (/default partition/i.test(err.message || "")) {
      console.log(
        "⚠️ Default partition contains overlapping rows; relocating rows and retrying partition creation...",
      );
      return await recoverDefaultPartitionAndMaintain();
    }
    throw err;
  }
}

async function runPartitionMaintenance() {
  retentionState.lastRunAt = Date.now();
  try {
    const result = await executeMaintenanceQuery();
    if (result.drop_failed > 0) {
      retentionState.lastError = `${result.drop_failed} partitions failed to drop`;
      console.error(`⚠️ ${retentionState.lastError}; retrying in 5 minutes.`);
      return false;
    }
    retentionState.lastOkAt = Date.now();
    retentionState.lastError = null;
    retentionState.created = result.created;
    retentionState.dropped = result.dropped;
    retentionState.defaultHasRows = result.default_has_rows;

    if (result.created || result.dropped) {
      console.log(
        `🗂️ Partitions maintained: ${result.created} created, ${result.dropped} dropped (retention: ${HISTORY_RETENTION_DAYS} days).`,
      );
    }
    if (result.default_has_rows) {
      console.error(
        "⚠️ Default partition contains rows; verify partition maintenance schedule.",
      );
    }
    return true;
  } catch (err) {
    retentionState.lastError = err.message;
    console.error("❌ Partition maintenance failed:", err.message);
    return false;
  }
}

function scheduleNextMaintenance(delayMs) {
  setTimeout(async () => {
    const ok = await runPartitionMaintenance();
    scheduleNextMaintenance(
      ok ? MAINTENANCE_INTERVAL_MS : MAINTENANCE_RETRY_MS,
    );
  }, delayMs);
}

async function startPartitionMaintenance() {
  const ok = await runPartitionMaintenance();
  scheduleNextMaintenance(ok ? MAINTENANCE_INTERVAL_MS : MAINTENANCE_RETRY_MS);
}

module.exports = {
  retentionState,
  startPartitionMaintenance,
};
