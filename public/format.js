const DELAY_CATEGORIES = [
  { key: "0-5s", min: 0, max: 5000, color: "#28a745" }, // Hijau
  { key: "5s-1m", min: 5000, max: 60000, color: "#ffc107" }, // Kuning
  { key: ">1m", min: 60000, max: Infinity, color: "#dc3545" }, // Merah
];

const STALENESS_CATEGORIES = [
  {
    key: "ONLINE",
    min: 0,
    max: 600000, // 10 menit
    color: "#28a745",
    desc: "Device melapor baru-baru ini. Kondisi normal, tidak perlu tindakan.",
  },
  {
    key: "WARNING",
    min: 600000,
    max: 3600000, // 1 jam
    color: "#ffc107",
    desc: "Device sudah cukup lama diam. Kemungkinan ada gangguan jaringan, daya, atau perangkat, sehingga perlu dicek.",
  },
  {
    key: "OFFLINE",
    min: 3600000,
    max: Infinity,
    color: "#dc3545",
    desc: "Device tidak melapor dalam waktu lama. Anggap terputus sampai ada laporan baru.",
  },
];

// Pecah nilai ms menjadi bagian tanda dan detik absolut.
// Nilai di bawah 1 detik tidak diberi tanda minus (hindari "-0s").
function splitSigned(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  const totalSeconds = Math.floor(Math.abs(n) / 1000);
  return { sign: n < 0 && totalSeconds > 0 ? "-" : "", totalSeconds };
}

function formatDelay(ms) {
  const p = splitSigned(ms);
  if (!p) return "-";
  const { sign, totalSeconds } = p;

  if (totalSeconds < 60) return `${sign}${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${sign}${m}m ${s}s`;
  }
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${sign}${h}h ${m}m ${s}s`;
}

// Sama seperti formatDelay tapi dengan satuan hari untuk staleness besar
function formatStaleness(ms) {
  const p = splitSigned(ms);
  if (!p) return "-";
  const { sign, totalSeconds } = p;

  if (totalSeconds < 60) return `${sign}${totalSeconds}s lalu`;
  if (totalSeconds < 3600)
    return `${sign}${Math.floor(totalSeconds / 60)}m lalu`;
  if (totalSeconds < 86400)
    return `${sign}${Math.floor(totalSeconds / 3600)}h lalu`;
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  return `${sign}${days}d ${hours}h lalu`;
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
