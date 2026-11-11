const { Pool } = require("pg");
const { DATABASE_URL } = require("./config");

// Separate pools prevent heavy dashboard queries from starving real-time ingestion writes.
const writerPool = new Pool({
  connectionString: DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
});

const apiPool = new Pool({
  connectionString: DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});

for (const [poolName, pool] of [
  ["writer", writerPool],
  ["api", apiPool],
]) {
  pool.on("error", (err) => {
    console.error(`❌ [pool ${poolName}] Idle connection error:`, err.message);
  });
}

async function withTransaction(pool, workFn, { statementTimeoutMs } = {}) {
  const client = await pool.connect();
  let connectionBroken = false;
  try {
    await client.query("BEGIN");
    if (statementTimeoutMs) {
      await client.query(`SET LOCAL statement_timeout = ${Number(statementTimeoutMs)}`);
    }
    const result = await workFn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      connectionBroken = true;
    }
    throw err;
  } finally {
    client.release(connectionBroken);
  }
}

async function isDatabaseReachable(timeoutMs = 3000) {
  let timer;
  try {
    await Promise.race([
      apiPool.query("SELECT 1"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  writerPool,
  apiPool,
  withTransaction,
  isDatabaseReachable,
};
