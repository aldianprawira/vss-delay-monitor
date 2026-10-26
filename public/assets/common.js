const NAV = [
  { href: "/index.html", key: "index", label: "Overview" },
  { href: "/delay.html", key: "delay", label: "Delay" },
  { href: "/staleness.html", key: "staleness", label: "Staleness" },
  { href: "/traffic.html", key: "traffic", label: "Traffic" },
  { href: "/devices.html", key: "devices", label: "Devices" },
  { href: "/summary.html", key: "summary", label: "Summary" },
];

const $ = (sel, root = document) => root.querySelector(sel);

// Semua data dari server/device WAJIB lewat esc() sebelum masuk innerHTML
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const pct = (n, total) => (total > 0 ? ((n / total) * 100).toFixed(1) : "0.0");

async function api(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} untuk ${url}`);
  return r.json();
}

function badge(cat) {
  return `<span class="badge" style="--c:${esc(cat.color)}">${esc(cat.key)}</span>`;
}

// ---------- Layout ----------
function buildShell() {
  const page = document.body.dataset.page;
  const content = $("main.content");

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";
  sidebar.innerHTML = `
    <div class="brand">VSS Delay Monitor<small>Device telemetry</small></div>
    <nav class="nav">
      ${NAV.map((n) => `<a href="${n.href}" class="${n.key === page ? "active" : ""}">${n.label}</a>`).join("")}
    </nav>`;

  const main = document.createElement("div");
  main.className = "main";
  main.innerHTML = `
    <header class="topbar">
      <div>
        <h1>${esc(document.body.dataset.title || "")}</h1>
        <div class="sub">${esc(document.body.dataset.sub || "")}</div>
      </div>
      <div class="status">
        <span id="ingest" class="pill" title="Status penerimaan data dari sumber">Ingestor: …</span>
        <span id="conn" class="pill">Memuat…</span>
      </div>
    </header>`;

  content.parentNode.insertBefore(sidebar, content);
  content.parentNode.insertBefore(main, content);
  main.appendChild(content);
  content.insertAdjacentHTML("afterbegin", '<div id="ingestBanner"></div>');
}

function setStatus(ok) {
  const el = $("#conn");
  if (!el) return;
  el.className = "pill " + (ok ? "ok" : "err");
  el.textContent = ok
    ? `Live · ${new Date().toLocaleTimeString()}`
    : "Gagal memuat data";
}

// ---------- Kesehatan ingestor ----------
function ingestMessages(h) {
  const text = {
    ws_disconnected: "Koneksi ke WebSocket sumber terputus",
    no_data: `Tidak ada data masuk selama ${formatDelay(h.ws.silentForMs)}`,
    db_unreachable: "Database tidak dapat dihubungi",
    db_write_failing: "Penulisan data ke database gagal",
    buffer_high: "Antrean data tertahan di memori cukup besar",
  };
  return [...h.problems, ...h.warnings].map((k) => text[k] || k);
}

async function refreshIngestHealth() {
  const pill = $("#ingest"),
    box = $("#ingestBanner");
  if (!pill) return;
  try {
    const h = await api("/api/health");
    const msgs = ingestMessages(h);
    pill.className =
      "pill " +
      (h.status === "ok" ? "ok" : h.status === "down" ? "err" : "warn");
    pill.textContent = {
      ok: "Ingestor: normal",
      down: "Ingestor: bermasalah",
      degraded: "Ingestor: terganggu",
    }[h.status];
    pill.title = msgs.join("\n") || "Data masuk normal";
    box.innerHTML = h.trusted
      ? ""
      : `
      <div class="banner ${h.status === "down" ? "" : "warn"}">
        <div><strong>Data di halaman ini mungkin tidak akurat</strong>
        ${msgs.map(esc).join("; ")}. Status device (ONLINE, WARNING, OFFLINE) dan delay terkini
        bisa tidak mencerminkan kondisi device yang sebenarnya.</div>
      </div>`;
  } catch (e) {
    pill.className = "pill";
    pill.textContent = "Ingestor: tidak diketahui";
    pill.title = e.message; // banner dibiarkan; pill "Gagal memuat data" di sebelahnya sudah menandakan server tak terjangkau
  }
}

function startHealthLoop() {
  let running = false;
  const tick = async () => {
    if (running || document.hidden) return;
    running = true;
    try {
      await refreshIngestHealth();
    } finally {
      running = false;
    }
  };
  tick();
  setInterval(tick, 10000);
  document.addEventListener(
    "visibilitychange",
    () => !document.hidden && tick(),
  );
}

// Polling tanpa tumpang tindih, berhenti saat tab tersembunyi. Mengembalikan fungsi refresh manual.
function poll(fn, ms) {
  let running = false;
  async function tick() {
    if (running || document.hidden) return;
    running = true;
    try {
      await fn();
      setStatus(true);
    } catch (e) {
      console.error(e);
      setStatus(false);
    } finally {
      running = false;
    }
  }
  tick();
  setInterval(tick, ms);
  document.addEventListener(
    "visibilitychange",
    () => !document.hidden && tick(),
  );
  return tick;
}

// ---------- Chart helpers ----------
const charts = {};
function upsertChart(id, config) {
  if (charts[id]) {
    charts[id].data = config.data;
    charts[id].update("none");
  } else {
    charts[id] = new Chart(document.getElementById(id), config);
  }
}

function pieConfig(labels, data, colors) {
  const total = data.reduce((a, b) => a + b, 0);
  return {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderWidth: 2 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "62%",
      plugins: {
        legend: { position: "right" },
        tooltip: {
          callbacks: {
            label: (c) => `${c.label}: ${c.parsed} (${pct(c.parsed, total)}%)`,
          },
        },
      },
    },
  };
}

// ---------- Format waktu sumbu X ----------
// Label grafik waktu berupa epoch ms (angka). Pemformatan dilakukan di sini, bukan di pemanggil.
const TIME_OPTS = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

function fmtTick(ms, multiDay) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], TIME_OPTS);
  return multiDay
    ? `${d.toLocaleDateString([], { day: "2-digit", month: "short" })} ${time}`
    : time;
}

function fmtFull(ms, withSeconds) {
  const o = { day: "2-digit", month: "short", ...TIME_OPTS };
  if (withSeconds) o.second = "2-digit";
  return new Date(ms).toLocaleString([], o);
}

// Celah dianggap ada bila selisih dua titik >= GAP_FACTOR x selisih tipikal (median) antar titik
const GAP_FACTOR = 2;

function medianStep(xs) {
  const d = [];
  for (let i = 1; i < xs.length; i++) {
    const v = xs[i] - xs[i - 1];
    if (v > 0) d.push(v);
  }
  if (!d.length) return 0;
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
}

// Ubah data[] (sejajar labels) menjadi titik {x, y}; sisipkan y=null di tiap celah
function toGapPoints(labels, data, gapMs) {
  const xs = labels.map(Number);
  const limit = gapMs ?? medianStep(xs) * GAP_FACTOR;
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    if (i > 0 && limit > 0 && xs[i] - xs[i - 1] >= limit) {
      out.push({ x: xs[i - 1] + (xs[i] - xs[i - 1]) / 2, y: null });
    }
    const v = data[i];
    out.push({ x: xs[i], y: v == null || v === "" ? null : Number(v) });
  }
  return out;
}

// Tick waktu yang "bulat" (menurut jam lokal)
const NICE_TIME_STEPS = [
  60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3,
  43200e3, 86400e3,
];

function lineConfig(labels, datasets, extra = {}, gapMs) {
  return {
    type: "line",
    data: {
      datasets: datasets.map((ds) => ({
        ...ds,
        data: toGapPoints(labels, ds.data, gapMs),
        spanGaps: false, // jangan sambung titik yang dipisah celah
        // titik tunggal di antara dua celah tetap terlihat
        pointRadius: (ctx) => {
          const d = ctx.dataset.data,
            i = ctx.dataIndex;
          return d[i]?.y != null && d[i - 1]?.y == null && d[i + 1]?.y == null
            ? 2
            : 0;
        },
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      elements: {
        point: { radius: 0 },
        line: { tension: 0.25, borderWidth: 2 },
      },
      scales: {
        y: { beginAtZero: true, grid: { color: "#eef2f7" } },
        x: {
          type: "linear", // skala waktu sungguhan: celah terlihat sebagai jarak
          grid: { display: false },
          ticks: {
            maxRotation: 0,
            callback(value) {
              return fmtTick(Number(value), this.max - this.min > 20 * 3600e3);
            },
          },
          afterBuildTicks(axis) {
            const span = axis.max - axis.min;
            if (!(span > 0)) return;
            const step =
              NICE_TIME_STEPS.find((s) => span / s <= 8) ||
              NICE_TIME_STEPS[NICE_TIME_STEPS.length - 1];
            const off = new Date(axis.min).getTimezoneOffset() * 60000;
            const ticks = [];
            for (
              let t = Math.ceil((axis.min - off) / step) * step + off;
              t <= axis.max;
              t += step
            )
              ticks.push({ value: t });
            axis.ticks = ticks;
          },
        },
      },
      plugins: {
        legend: { position: "top", align: "end" },
        tooltip: {
          filter: (item) => item.parsed.y !== null, // titik penyela celah tidak ditampilkan
          callbacks: {
            // Detik hanya ditampilkan bila datanya memang per-detik (bukan bucket menit)
            title: (items) => {
              const pts = items[0].chart.data.datasets[0].data
                .filter((p) => p.y != null)
                .slice(0, 50);
              const withSeconds = pts.some((p) => p.x % 60000 !== 0);
              return fmtFull(items[0].parsed.x, withSeconds);
            },
          },
        },
      },
      ...extra,
    },
  };
}

const kpi = (label, value, hint = "") =>
  `<div class="card kpi"><h3>${esc(label)}</h3><div class="value">${value}</div><div class="hint">${hint}</div></div>`;

const deviceName = (d) => esc(d.device_name || d.device_id);
const detailHref = (id, name) =>
  `/device.html?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name || "")}`;

document.addEventListener("DOMContentLoaded", () => {
  buildShell();
  if (window.Chart) {
    Chart.defaults.font.family = "Inter, system-ui, sans-serif";
    Chart.defaults.color = "#667085";
  }
  document.dispatchEvent(new Event("shell-ready"));
  startHealthLoop();
});

// ---------- Sumbu Y untuk grafik delay (data dalam ms) ----------
const NICE_DELAY_STEPS = [
  1e3,
  2e3,
  5e3,
  10e3,
  15e3,
  30e3, // detik
  60e3,
  120e3,
  300e3,
  600e3,
  900e3,
  1800e3, // menit
  3600e3,
  7200e3,
  10800e3,
  21600e3,
  43200e3,
  86400e3, // jam
];
const niceDelayStep = (span) =>
  NICE_DELAY_STEPS.find((s) => span / s <= 6) ||
  NICE_DELAY_STEPS[NICE_DELAY_STEPS.length - 1];

// Label ringkas untuk tick: 30s, 1m, 1m 30s, 2h, 1h 30m
function formatAxisDelay(ms) {
  const a = Math.abs(ms),
    sign = ms < 0 ? "-" : "";
  if (a === 0) return "0";
  if (a < 60000) return `${sign}${a / 1000}s`;
  if (a < 3600000) {
    const m = Math.floor(a / 60000),
      s = (a % 60000) / 1000;
    return `${sign}${m}m${s ? ` ${s}s` : ""}`;
  }
  const h = Math.floor(a / 3600000),
    m = Math.floor((a % 3600000) / 60000);
  return `${sign}${h}h${m ? ` ${m}m` : ""}`;
}

// Line chart khusus delay: data HARUS dalam milidetik
function delayLineConfig(labels, datasets, gapMs) {
  const cfg = lineConfig(labels, datasets, {}, gapMs);

  cfg.options.scales.y = {
    ...cfg.options.scales.y,
    ticks: { callback: (v) => formatAxisDelay(v) },
    afterBuildTicks(axis) {
      // Jangan pakai axis.min/axis.max di sini: Chart.js sudah memperluasnya satu langkah penuh
      // ke bawah nol bila ada SATU nilai negatif kecil. Baca langsung dari data.
      const chart = axis.chart;
      let dmin = Infinity;
      let dmax = -Infinity;
      chart.data.datasets.forEach((ds, i) => {
        if (!chart.isDatasetVisible(i)) return;
        for (const p of ds.data) {
          const raw = p && typeof p === "object" ? p.y : p;
          if (raw == null) continue; // titik penyela celah
          const n = Number(raw);
          if (!Number.isFinite(n)) continue;
          if (n < dmin) dmin = n;
          if (n > dmax) dmax = n;
        }
      });
      if (!Number.isFinite(dmin)) {
        dmin = 0;
        dmax = 1000;
      }

      // Negatif yang sangat kecil dibanding skala (mis. -2 detik pada grafik 19 jam) dianggap derau:
      // sumbu tetap mulai dari 0. Negatif yang berarti tetap menurunkan sumbu.
      const noise = Math.max(1000, 0.05 * Math.max(dmax, 0));
      const lower = dmin >= 0 || -dmin <= noise ? 0 : dmin;

      const upper = Math.max(dmax, lower + 1000);
      const step = niceDelayStep(upper - lower);
      const start = lower === 0 ? 0 : Math.floor(lower / step) * step;
      const end = Math.max(Math.ceil(upper / step) * step, start + step);

      const ticks = [];
      for (let v = start; v <= end; v += step) ticks.push({ value: v });
      axis.ticks = ticks;
      axis.min = start;
      axis.max = end;
    },
  };

  // Aman bila lineConfig belum punya objek tooltip
  const tooltip = (cfg.options.plugins.tooltip =
    cfg.options.plugins.tooltip || {});
  tooltip.callbacks = {
    ...(tooltip.callbacks || {}),
    label: (c) => `${c.dataset.label}: ${formatDelay(c.parsed.y)}`,
  };

  return cfg;
}
