const DELAY_CATEGORIES = [
  { key: "0-5s", min: 0, max: 5000, color: "#059669", tone: "ok" },
  { key: "5s-1m", min: 5000, max: 60000, color: "#d97706", tone: "warn" },
  { key: ">1m", min: 60000, max: Infinity, color: "#dc2626", tone: "err" },
];

const STALENESS_CATEGORIES = [
  { key: "ONLINE", min: 0, max: 3600000, color: "#059669", tone: "ok" },
  { key: "WARNING", min: 3600000, max: 21600000, color: "#d97706", tone: "warn" },
  { key: "OFFLINE", min: 21600000, max: Infinity, color: "#dc2626", tone: "err" },
];

// Suppress negative signs when sub-second values round down to 0 to prevent rendering "-0s".
function splitSignedSeconds(ms) {
  const numericMs = Number(ms);
  if (!Number.isFinite(numericMs)) return null;
  const totalSeconds = Math.floor(Math.abs(numericMs) / 1000);
  return {
    sign: numericMs < 0 && totalSeconds > 0 ? "-" : "",
    totalSeconds,
  };
}

function formatDelay(ms) {
  const parsed = splitSignedSeconds(ms);
  if (!parsed) return "-";
  const { sign, totalSeconds } = parsed;

  if (totalSeconds < 60) return `${sign}${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${sign}${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${sign}${hours}h ${minutes}m ${seconds}s`;
}

function formatStaleness(ms) {
  const parsed = splitSignedSeconds(ms);
  if (!parsed) return "-";
  const { sign, totalSeconds } = parsed;

  if (totalSeconds < 60) return `${sign}${totalSeconds}s ago`;
  if (totalSeconds < 3600) {
    return `${sign}${Math.floor(totalSeconds / 60)}m ago`;
  }
  if (totalSeconds < 86400) {
    return `${sign}${Math.floor(totalSeconds / 3600)}h ago`;
  }
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  return `${sign}${days}d ${hours}h ago`;
}

function getCategory(ms) {
  const absMs = Math.abs(Number(ms));
  return (
    DELAY_CATEGORIES.find((c) => absMs >= c.min && absMs < c.max) ||
    DELAY_CATEGORIES[DELAY_CATEGORIES.length - 1]
  );
}

function getStalenessCategory(ms) {
  const safeMs = Math.max(ms, 0);
  return (
    STALENESS_CATEGORIES.find((c) => safeMs >= c.min && safeMs < c.max) ||
    STALENESS_CATEGORIES[STALENESS_CATEGORIES.length - 1]
  );
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DELAY_CATEGORIES,
    STALENESS_CATEGORIES,
    formatDelay,
    formatStaleness,
    getCategory,
    getStalenessCategory,
  };
}
