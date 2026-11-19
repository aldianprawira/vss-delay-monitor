require("dotenv").config();

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || "";

module.exports = {
  PORT: process.env.PORT || 3000,
  DATABASE_URL: process.env.DATABASE_URL,
  PROXY_URL,

  LOGIN_URL: process.env.LOGIN_URL,
  LOGIN_USERNAME: process.env.LOGIN_USERNAME,
  LOGIN_PASSWORD: process.env.LOGIN_PASSWORD,
  LOGIN_LANG: process.env.LOGIN_LANG || "0",
  LOGIN_CLIENT: process.env.LOGIN_CLIENT || "2",
  WS_SOURCE_URL: process.env.WS_SOURCE_URL,

  DEVICE_TZ: "Asia/Jakarta",
  ACTION_AUTH: "80000",
  ACTION_DEVICE_DATA: "80003",

  FLUSH_INTERVAL_MS: 1000,
  TRAFFIC_FLUSH_INTERVAL_MS: 10000,
  STATS_LOG_INTERVAL_MS: 60000,
  MAX_BUFFER_RECORDS: 50000,
  // 5,000 rows * 6 columns = 30,000 parameters, staying safely below PostgreSQL's 65,535 limit.
  INSERT_CHUNK_SIZE: 5000,

  LOGIN_TIMEOUT_MS: 10000,
  WS_HANDSHAKE_TIMEOUT_MS: 10000,
  WS_PING_INTERVAL_MS: 15000,
  WS_ACTIVITY_TIMEOUT_MS: Number(process.env.WS_ACTIVITY_TIMEOUT_MS) || 45000,
  WS_DATA_SILENCE_RECONNECT_MS:
    Number(process.env.WS_DATA_SILENCE_RECONNECT_MS) || 0,
  AUTH_REJECT_GRACE_MS: 10000,
  HEALTH_DATA_STALE_MS: Number(process.env.HEALTH_DATA_STALE_MS) || 120000,

  HISTORY_RETENTION_DAYS: Math.max(
    Number(process.env.HISTORY_RETENTION_DAYS) || 7,
    2,
  ),
  PARTITION_AHEAD_DAYS: 3,
  ROLLUP_MINUTE_RETENTION_DAYS:
    Number(process.env.ROLLUP_RETENTION_DAYS) || 90,
  MAINTENANCE_INTERVAL_MS: 60 * 60 * 1000,
  MAINTENANCE_RETRY_MS: 5 * 60 * 1000,

  SUMMARY_TIMEOUT_MS: 60000,

  EMAIL_ENABLED: process.env.EMAIL_ENABLED === "true",
  EMAIL_TEST_MODE: process.env.EMAIL_TEST_MODE !== "false",
  EMAIL_SEND_HOUR: Number(process.env.EMAIL_SEND_HOUR ?? 10),
  EMAIL_SEND_MINUTE: Number(process.env.EMAIL_SEND_MINUTE ?? 0),
  SMTP_HOST: process.env.SMTP_HOST || "smtpgw2.ioh.co.id",
  SMTP_PORT: Number(process.env.SMTP_PORT || 25),
  SMTP_SECURE: process.env.SMTP_SECURE === "true",
  SMTP_USER: process.env.SMTP_USER || "",
  SMTP_PASS: process.env.SMTP_PASS || "",
  EMAIL_FROM: process.env.EMAIL_FROM || "b2bops_alert_noreply@ioh.co.id",
  EMAIL_TO: process.env.EMAIL_TO || "",
  EMAIL_CC: process.env.EMAIL_CC || "",
  EMAIL_TEST_TO: process.env.EMAIL_TEST_TO || "",
  EMAIL_TEST_CC: process.env.EMAIL_TEST_CC || "",
  DASHBOARD_URL: process.env.DASHBOARD_URL || "",
};
