const express = require("express");
const { PORT } = require("./src/config");
const { startStatsLogger } = require("./src/state");
const { startIngestor } = require("./src/ingestor");
const { startWriterLoops } = require("./src/writer");
const { startPartitionMaintenance } = require("./src/maintenance");
const routes = require("./src/routes");

process.on("unhandledRejection", (reason) => {
  console.error(
    "❌ unhandledRejection:",
    reason instanceof Error ? reason.stack : reason,
  );
});

// Exit on uncaught exceptions so the process supervisor (PM2/Docker/K8s) can restart cleanly.
process.on("uncaughtException", (err) => {
  console.error("💥 uncaughtException:", err.stack || err);
  process.exit(1);
});

const app = express();
app.use(express.static("public"));
app.use(routes);

app.use((err, req, res, next) => {
  console.error(`❌ ${req.method} ${req.originalUrl}:`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "internal_error" });
});

app.listen(PORT, () => {
  console.log(`🚀 Dashboard running at http://localhost:${PORT}`);
});

startStatsLogger();
startIngestor();

// Ensure daily partitions exist before starting database write loops so initial batches do not spill into the default partition.
startPartitionMaintenance().finally(() => {
  startWriterLoops();
});
