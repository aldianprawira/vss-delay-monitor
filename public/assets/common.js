const NAV = [
  { href: "/index.html", key: "index", label: "Overview" },
  { href: "/delay.html", key: "delay", label: "Delay" },
  { href: "/staleness.html", key: "staleness", label: "Staleness" },
  { href: "/traffic.html", key: "traffic", label: "Traffic" },
  { href: "/devices.html", key: "devices", label: "Devices" },
  { href: "/summary.html", key: "summary", label: "Summary" },
];

const $ = (sel, root = document) => root.querySelector(sel);

// Escape untrusted device names and IDs before interpolating into innerHTML to prevent XSS.
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const pct = (n, total) => (total > 0 ? ((n / total) * 100).toFixed(1) : "0.0");

let activeQueryController = null;
let activeTimePicker = null;

async function api(url, options = {}) {
  const signal =
    options.signal ||
    (url !== "/api/health" && activeQueryController
      ? activeQueryController.signal
      : undefined);
  const res = await fetch(url, { ...options, signal });
  if (!res.ok) {
    let errMsg = `HTTP ${res.status} for ${url}`;
    try {
      const body = await res.json();
      if (body && body.error) errMsg = body.error;
    } catch (_) {}
    throw new Error(errMsg);
  }
  return res.json();
}

function badge(cat) {
  return `<span class="badge" style="--c:${esc(cat.color)}">${esc(cat.key)}</span>`;
}

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
        <div id="timePicker"></div>
        <span id="ingest" class="pill" title="Upstream data ingestion status">Ingestor: …</span>
        <span id="conn" class="pill">Loading…</span>
      </div>
    </header>`;

  content.parentNode.insertBefore(sidebar, content);
  content.parentNode.insertBefore(main, content);
  main.appendChild(content);
  content.insertAdjacentHTML("afterbegin", '<div id="ingestBanner"></div>');
}

function setStatus(ok, customText) {
  const el = $("#conn");
  if (!el) return;
  if (customText) {
    el.className = "pill warn";
    el.textContent = customText;
    return;
  }
  el.className = "pill " + (ok ? "ok" : "err");
  el.textContent = ok
    ? `Live · ${new Date().toLocaleTimeString()}`
    : "Failed to load data";
}

function ingestMessages(health) {
  const descriptions = {
    ws_disconnected: "Disconnected from upstream WebSocket",
    no_data: `No incoming data for ${formatDelay(health.ws.silentForMs)}`,
    db_unreachable: "Database is unreachable",
    db_write_failing: "Database writes are failing",
    buffer_high: "In-memory ingestion buffer is critically high",
  };
  return [...health.problems, ...health.warnings].map(
    (key) => descriptions[key] || key,
  );
}

async function refreshIngestHealth() {
  const pill = $("#ingest");
  const bannerBox = $("#ingestBanner");
  if (!pill) return;
  try {
    const health = await api("/api/health");
    const msgs = ingestMessages(health);
    pill.className =
      "pill " +
      (health.status === "ok"
        ? "ok"
        : health.status === "down"
          ? "err"
          : "warn");
    pill.textContent = {
      ok: "Ingestor: healthy",
      down: "Ingestor: down",
      degraded: "Ingestor: degraded",
    }[health.status];
    pill.title = msgs.join("\n") || "Data ingestion is healthy";
    bannerBox.innerHTML = health.trusted
      ? ""
      : `
      <div class="banner ${health.status === "down" ? "" : "warn"}">
        <div><strong>Data on this page may be inaccurate</strong>
        ${msgs.map(esc).join("; ")}. Device statuses (ONLINE, WARNING, OFFLINE) and latest delays
        may not reflect actual device conditions.</div>
      </div>`;
  } catch (err) {
    pill.className = "pill";
    pill.textContent = "Ingestor: unknown";
    pill.title = err.message;
  }
}

// Skip ticks while a request is in flight or the tab is backgrounded to avoid piling up concurrent requests.
function createVisibilityLoop(taskFn, intervalMs) {
  let running = false;
  async function tick() {
    if (running || document.hidden) return;
    running = true;
    try {
      await taskFn();
    } finally {
      running = false;
    }
  }
  tick();
  setInterval(tick, intervalMs);
  document.addEventListener(
    "visibilitychange",
    () => !document.hidden && tick(),
  );
  return tick;
}

function startHealthLoop() {
  createVisibilityLoop(refreshIngestHealth, 10000);
}

function poll(fn, intervalMs) {
  let running = false;
  let currentRunId = 0;

  async function execute({ manual = false } = {}) {
    if (!manual && (running || document.hidden)) return;
    if (manual && activeQueryController) {
      activeQueryController.abort();
    }

    const runId = ++currentRunId;
    const controller = new AbortController();
    activeQueryController = controller;
    running = true;

    if (manual && activeTimePicker) {
      activeTimePicker.setLoading(true, () => controller.abort());
    }

    try {
      await fn();
      if (runId === currentRunId) {
        if (manual && activeTimePicker) activeTimePicker.commitPendingRange();
        setStatus(true);
      }
    } catch (err) {
      if (controller.signal.aborted || err?.name === "AbortError") {
        if (runId === currentRunId) {
          setStatus(true, "Query cancelled");
        }
        return;
      }
      console.error(err);
      if (runId === currentRunId) setStatus(false);
    } finally {
      if (runId === currentRunId) {
        running = false;
        activeQueryController = null;
        if (activeTimePicker) activeTimePicker.setLoading(false);
      }
    }
  }

  execute({ manual: false });
  setInterval(() => execute({ manual: false }), intervalMs);
  document.addEventListener(
    "visibilitychange",
    () => !document.hidden && execute({ manual: false }),
  );
  return () => execute({ manual: true });
}

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

function categoryPieConfig(categories) {
  return pieConfig(
    categories.map((c) => c.category),
    categories.map((c) => c.count),
    categories.map(
      (c) => (DELAY_CATEGORIES.find((x) => x.key === c.category) || {}).color,
    ),
  );
}

function countDelayedDevices(categories) {
  return categories
    .filter((c) => c.category !== "0-5s")
    .reduce((sum, c) => sum + Number(c.count), 0);
}

const TIME_OPTS = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

function fmtTick(ms, multiDay) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], TIME_OPTS);
  return multiDay
    ? `${d.toLocaleDateString([], { day: "2-digit", month: "short" })} ${time}`
    : time;
}

function fmtFull(ms, withSeconds) {
  const opts = { day: "2-digit", month: "short", ...TIME_OPTS };
  if (withSeconds) opts.second = "2-digit";
  return new Date(ms).toLocaleString([], opts);
}

const GAP_FACTOR = 2;

function medianStep(xs) {
  const deltas = [];
  for (let i = 1; i < xs.length; i++) {
    const diff = xs[i] - xs[i - 1];
    if (diff > 0) deltas.push(diff);
  }
  if (!deltas.length) return 0;
  deltas.sort((a, b) => a - b);
  return deltas[deltas.length >> 1];
}

// Insert null-valued midpoints between timestamps exceeding typical spacing so Chart.js breaks the line across outages.
function toGapPoints(labels, data, gapMs) {
  const xs = labels.map(Number);
  const limit = gapMs ?? medianStep(xs) * GAP_FACTOR;
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    if (i > 0 && limit > 0 && xs[i] - xs[i - 1] >= limit) {
      out.push({ x: xs[i - 1] + (xs[i] - xs[i - 1]) / 2, y: null });
    }
    const val = data[i];
    out.push({ x: xs[i], y: val == null || val === "" ? null : Number(val) });
  }
  return out;
}

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
        spanGaps: false,
        // Keep isolated single-point measurements visible when surrounded by data gaps.
        pointRadius: (ctx) => {
          const d = ctx.dataset.data;
          const i = ctx.dataIndex;
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
          type: "linear",
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
            const tzOffsetMs = new Date(axis.min).getTimezoneOffset() * 60000;
            const ticks = [];
            for (
              let t =
                Math.ceil((axis.min - tzOffsetMs) / step) * step + tzOffsetMs;
              t <= axis.max;
              t += step
            ) {
              ticks.push({ value: t });
            }
            axis.ticks = ticks;
          },
        },
      },
      plugins: {
        legend: { position: "top", align: "end" },
        tooltip: {
          filter: (item) => item.parsed.y !== null,
          callbacks: {
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

const NICE_DELAY_STEPS = [
  1e3, 2e3, 5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3,
  3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3,
];

const niceDelayStep = (span) =>
  NICE_DELAY_STEPS.find((s) => span / s <= 6) ||
  NICE_DELAY_STEPS[NICE_DELAY_STEPS.length - 1];

function formatAxisDelay(ms) {
  const absMs = Math.abs(ms);
  const sign = ms < 0 ? "-" : "";
  if (absMs === 0) return "0";
  if (absMs < 60000) return `${sign}${absMs / 1000}s`;
  if (absMs < 3600000) {
    const m = Math.floor(absMs / 60000);
    const s = (absMs % 60000) / 1000;
    return `${sign}${m}m${s ? ` ${s}s` : ""}`;
  }
  const h = Math.floor(absMs / 3600000);
  const m = Math.floor((absMs % 3600000) / 60000);
  return `${sign}${h}h${m ? ` ${m}m` : ""}`;
}

function delayLineConfig(labels, datasets, gapMs) {
  const cfg = lineConfig(labels, datasets, {}, gapMs);

  cfg.options.scales.y = {
    ...cfg.options.scales.y,
    ticks: { callback: (v) => formatAxisDelay(v) },
    afterBuildTicks(axis) {
      // Read bounds directly from dataset values because Chart.js pre-expands axis.min by a full step on tiny negative clock skews.
      const chart = axis.chart;
      let dmin = Infinity;
      let dmax = -Infinity;
      chart.data.datasets.forEach((ds, i) => {
        if (!chart.isDatasetVisible(i)) return;
        for (const p of ds.data) {
          const raw = p && typeof p === "object" ? p.y : p;
          if (raw == null) continue;
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

      // Clamp minor negative clock drift (<=5% of range) to 0 so the Y-axis only drops below zero for genuine negative skew.
      const noiseThreshold = Math.max(1000, 0.05 * Math.max(dmax, 0));
      const lower = dmin >= 0 || -dmin <= noiseThreshold ? 0 : dmin;

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

  const tooltip = (cfg.options.plugins.tooltip =
    cfg.options.plugins.tooltip || {});
  tooltip.callbacks = {
    ...(tooltip.callbacks || {}),
    label: (c) => `${c.dataset.label}: ${formatDelay(c.parsed.y)}`,
  };

  return cfg;
}

function delayTrendConfig(timeline) {
  return delayLineConfig(
    timeline.map((t) => new Date(t.bucket).getTime()),
    [
      {
        label: "Average",
        data: timeline.map((t) => Number(t.avg_delay)),
        borderColor: "#2563eb",
      },
      {
        label: "Maximum",
        data: timeline.map((t) => Number(t.max_delay)),
        borderColor: "#dc2626",
      },
    ],
  );
}

function createTableController({
  state,
  pageSize = 50,
  prepareItems,
  getSortValue,
  renderRow,
  colSpan,
  emptyMessage,
  onAfterRender,
}) {
  function getFilteredAndSorted() {
    const list = prepareItems(state);
    const { sort, dir } = state;
    const directionMultiplier = dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const va = getSortValue(a, sort);
      const vb = getSortValue(b, sort);
      return (va < vb ? -1 : va > vb ? 1 : 0) * directionMultiplier;
    });
    return list;
  }

  function render() {
    const list = getFilteredAndSorted();
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    state.page = Math.min(state.page, pages - 1);
    const slice = list.slice(
      state.page * pageSize,
      (state.page + 1) * pageSize,
    );

    $("#rows").innerHTML =
      slice.map(renderRow).join("") ||
      `<tr><td class="empty" colspan="${colSpan}">${esc(emptyMessage)}</td></tr>`;

    $("#count").textContent =
      `${list.length.toLocaleString()} of ${state.all.length.toLocaleString()} devices`;
    $("#pageInfo").textContent = `Page ${state.page + 1} of ${pages}`;
    $("#prev").disabled = state.page === 0;
    $("#next").disabled = state.page >= pages - 1;

    document.querySelectorAll("th.sortable").forEach((th) => {
      th.querySelector(".si").textContent =
        th.dataset.sort === state.sort
          ? state.dir === "asc"
            ? "▲"
            : "▼"
          : "";
    });

    if (onAfterRender) onAfterRender(list);
  }

  function bindControls() {
    const qEl = $("#q");
    if (qEl) {
      qEl.addEventListener("input", (e) => {
        state.q = e.target.value;
        state.page = 0;
        render();
      });
    }
    $("#prev").addEventListener("click", () => {
      state.page--;
      render();
    });
    $("#next").addEventListener("click", () => {
      state.page++;
      render();
    });
    document.querySelectorAll("th.sortable").forEach((th) =>
      th.addEventListener("click", () => {
        const col = th.dataset.sort;
        state.dir =
          state.sort === col && state.dir === "asc" ? "desc" : "asc";
        state.sort = col;
        render();
      }),
    );
  }

  return { render, getFilteredAndSorted, bindControls };
}

const QUICK_RANGES = [
  { key: "5m", from: "now-5m", to: "now", label: "Last 5 minutes", short: "5m" },
  { key: "15m", from: "now-15m", to: "now", label: "Last 15 minutes", short: "15m" },
  { key: "30m", from: "now-30m", to: "now", label: "Last 30 minutes", short: "30m" },
  { key: "1h", from: "now-1h", to: "now", label: "Last 1 hour", short: "1h" },
  { key: "3h", from: "now-3h", to: "now", label: "Last 3 hours", short: "3h" },
  { key: "6h", from: "now-6h", to: "now", label: "Last 6 hours", short: "6h" },
  { key: "12h", from: "now-12h", to: "now", label: "Last 12 hours", short: "12h" },
  { key: "24h", from: "now-24h", to: "now", label: "Last 24 hours", short: "24h" },
  { key: "2d", from: "now-2d", to: "now", label: "Last 2 days", short: "2d" },
  { key: "7d", from: "now-7d", to: "now", label: "Last 7 days", short: "7d" },
  { key: "today", from: "now/d", to: "now", label: "Today", short: "Today" },
  {
    key: "yesterday",
    from: "now-1d/d",
    to: "now-1d/d+24h",
    label: "Yesterday",
    short: "Yesterday",
  },
];

const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
const RECENT_RANGES_KEY = "vss_recent_time_ranges";
const ACTIVE_RANGE_KEY = "vss_active_time_range";
const COPIED_RANGE_KEY = "vss_copied_time_range";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function toDateTimeLocalValue(ms) {
  return formatDateTime(ms).replace(" ", "T");
}

function parseTimeExpr(expr, nowMs = Date.now()) {
  const str = String(expr || "").trim();
  if (!str) return null;
  if (str === "now") return nowMs;
  if (str === "now/d") {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (str === "now-1d/d") {
    const d = new Date(nowMs);
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (str === "now-1d/d+24h") {
    const d = new Date(nowMs);
    d.setDate(d.getDate() - 1);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }
  const relMatch = /^now-(\d+)([smhd])$/i.exec(str);
  if (relMatch) {
    return nowMs - Number(relMatch[1]) * UNIT_MS[relMatch[2].toLowerCase()];
  }
  const parsed = new Date(str.includes("T") ? str : str.replace(" ", "T")).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function loadRecentRanges() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_RANGES_KEY) || "[]");
    return Array.isArray(raw) ? raw.slice(0, 5) : [];
  } catch (_) {
    return [];
  }
}

function saveRecentRange(fromStr, toStr) {
  try {
    const list = loadRecentRanges().filter(
      (r) => !(r.from === fromStr && r.to === toStr),
    );
    list.unshift({ from: fromStr, to: toStr });
    localStorage.setItem(RECENT_RANGES_KEY, JSON.stringify(list.slice(0, 5)));
  } catch (_) {}
}

function createTimeRangePicker(
  mountTarget,
  { defaultKey = "1h", align = "right", onChange } = {},
) {
  const container =
    typeof mountTarget === "string" ? $(mountTarget) : mountTarget;
  const fallbackPreset =
    QUICK_RANGES.find((q) => q.key === defaultKey) || QUICK_RANGES[3];

  let fromRaw = fallbackPreset.from;
  let toRaw = fallbackPreset.to;
  let previousRange = null;
  let onCancelCallback = null;

  try {
    const saved = JSON.parse(sessionStorage.getItem(ACTIVE_RANGE_KEY) || "null");
    if (
      saved &&
      parseTimeExpr(saved.fromRaw) !== null &&
      parseTimeExpr(saved.toRaw) !== null
    ) {
      fromRaw = saved.fromRaw;
      toRaw = saved.toRaw;
    }
  } catch (_) {}

  const root = document.createElement("div");
  root.className = "trp";
  root.innerHTML = `
    <div class="trp-bar">
      <button type="button" class="trp-prev" title="Shift time range backward">«</button>
      <button type="button" class="trp-toggle" title="Select time range">
        <span class="trp-clock">🕒</span>
        <span class="trp-spinner" aria-hidden="true"></span>
        <span class="trp-label"></span>
        <span class="trp-caret">▾</span>
      </button>
      <button type="button" class="trp-next" title="Shift time range forward">»</button>
    </div>
    <button type="button" class="trp-cancel" title="Cancel active query">✕ Cancel</button>
    <div class="trp-popover ${align === "right" ? "right-align" : ""}">
      <div class="trp-abs">
        <div class="trp-title">Absolute time range</div>
        <div class="trp-field">
          <label>From</label>
          <div class="trp-input-group">
            <input type="text" class="trp-from" spellcheck="false" />
            <span class="trp-cal-btn" title="Pick date and time">
              📅
              <input type="datetime-local" step="1" class="trp-cal-native trp-cal-from" />
            </span>
          </div>
        </div>
        <div class="trp-field">
          <label>To</label>
          <div class="trp-input-group">
            <input type="text" class="trp-to" spellcheck="false" />
            <span class="trp-cal-btn" title="Pick date and time">
              📅
              <input type="datetime-local" step="1" class="trp-cal-native trp-cal-to" />
            </span>
          </div>
        </div>
        <div class="trp-err"></div>
        <div class="trp-actions">
          <button type="button" class="trp-icon-btn trp-copy" title="Copy time range">📋</button>
          <button type="button" class="trp-icon-btn trp-paste" title="Paste time range">📥</button>
          <button type="button" class="trp-apply-btn">Apply time range</button>
        </div>
        <div class="trp-recent">
          <div class="trp-title" style="font-size:12px">Recently used absolute ranges</div>
          <div class="trp-recent-list"></div>
        </div>
      </div>
      <div class="trp-quick">
        <div class="trp-search-wrap">
          <input type="search" class="trp-search" placeholder="Search quick ranges" />
        </div>
        <div class="trp-quick-list"></div>
      </div>
    </div>
  `;
  container.appendChild(root);

  const prevBtn = $(".trp-prev", root);
  const nextBtn = $(".trp-next", root);
  const toggleBtn = $(".trp-toggle", root);
  const cancelBtn = $(".trp-cancel", root);
  const labelEl = $(".trp-label", root);
  const caretEl = $(".trp-caret", root);
  const popover = $(".trp-popover", root);
  const fromInput = $(".trp-from", root);
  const toInput = $(".trp-to", root);
  const calFrom = $(".trp-cal-from", root);
  const calTo = $(".trp-cal-to", root);
  const errEl = $(".trp-err", root);
  const searchInput = $(".trp-search", root);
  const quickListEl = $(".trp-quick-list", root);
  const recentListEl = $(".trp-recent-list", root);

  function getActivePreset() {
    return QUICK_RANGES.find((q) => q.from === fromRaw && q.to === toRaw) || null;
  }

  function getWindow() {
    const now = Date.now();
    const f = parseTimeExpr(fromRaw, now) ?? now - 3600000;
    const t = parseTimeExpr(toRaw, now) ?? now;
    const fromMs = Math.min(f, t);
    const toMs = Math.max(f, t);
    const preset = getActivePreset();
    const label = preset
      ? preset.label
      : `${formatDateTime(fromMs)} to ${formatDateTime(toMs)}`;
    const shortLabel = preset
      ? preset.short
      : `${formatDateTime(fromMs).slice(5, 16)} – ${formatDateTime(toMs).slice(5, 16)}`;
    return {
      fromMs,
      toMs,
      fromRaw,
      toRaw,
      label,
      shortLabel,
      isRelative: fromRaw.startsWith("now") || toRaw.startsWith("now"),
    };
  }

  function toQueryString() {
    const { fromMs, toMs } = getWindow();
    return `from=${fromMs}&to=${toMs}`;
  }

  function renderQuickList() {
    const q = searchInput.value.trim().toLowerCase();
    const preset = getActivePreset();
    quickListEl.innerHTML = QUICK_RANGES.filter(
      (item) => !q || item.label.toLowerCase().includes(q),
    )
      .map(
        (item) =>
          `<button type="button" class="trp-quick-item ${preset && preset.key === item.key ? "active" : ""}" data-from="${esc(item.from)}" data-to="${esc(item.to)}">${esc(item.label)}</button>`,
      )
      .join("");
  }

  function renderRecentList() {
    const recent = loadRecentRanges();
    recentListEl.innerHTML =
      recent
        .map(
          (r) =>
            `<button type="button" class="trp-recent-item" data-from="${esc(r.from)}" data-to="${esc(r.to)}">${esc(r.from)} to ${esc(r.to)}</button>`,
        )
        .join("") || `<div class="hint" style="font-size:11px;color:var(--muted)">No recent ranges</div>`;
  }

  function syncUI() {
    const w = getWindow();
    labelEl.textContent = w.label;
    fromInput.value = fromRaw;
    toInput.value = toRaw;
    calFrom.value = toDateTimeLocalValue(w.fromMs);
    calTo.value = toDateTimeLocalValue(w.toMs);
    errEl.style.display = "none";
    renderQuickList();
    renderRecentList();
  }

  function closePopover() {
    popover.classList.remove("open");
    caretEl.textContent = "▾";
  }

  function setLoading(isLoading, cancelFn = null) {
    root.classList.toggle("loading", isLoading);
    prevBtn.disabled = isLoading;
    toggleBtn.disabled = isLoading;
    nextBtn.disabled = isLoading;
    onCancelCallback = isLoading ? cancelFn : null;
    if (isLoading) closePopover();
  }

  function commitPendingRange() {
    previousRange = null;
  }

  function revertPendingRange() {
    if (!previousRange) return;
    fromRaw = previousRange.fromRaw;
    toRaw = previousRange.toRaw;
    previousRange = null;
    try {
      sessionStorage.setItem(
        ACTIVE_RANGE_KEY,
        JSON.stringify({ fromRaw, toRaw }),
      );
    } catch (_) {}
    syncUI();
  }

  cancelBtn.addEventListener("click", () => {
    const cancelFn = onCancelCallback;
    revertPendingRange();
    setLoading(false);
    if (cancelFn) cancelFn();
  });

  function applyRange(newFrom, newTo, isAbsoluteCommit = false) {
    const now = Date.now();
    const f = parseTimeExpr(newFrom, now);
    const t = parseTimeExpr(newTo, now);
    if (f === null || t === null || f > t) {
      errEl.textContent =
        f === null || t === null
          ? "Invalid time format. Use 'now-1h' or 'YYYY-MM-DD HH:mm:ss'."
          : "'From' must not be later than 'To'.";
      errEl.style.display = "block";
      return;
    }
    previousRange = { fromRaw, toRaw };
    fromRaw = newFrom.trim();
    toRaw = newTo.trim();
    try {
      sessionStorage.setItem(
        ACTIVE_RANGE_KEY,
        JSON.stringify({ fromRaw, toRaw }),
      );
    } catch (_) {}

    if (
      isAbsoluteCommit &&
      !fromRaw.startsWith("now") &&
      !toRaw.startsWith("now")
    ) {
      saveRecentRange(formatDateTime(f), formatDateTime(t));
    }

    syncUI();
    closePopover();
    if (onChange) onChange(getWindow());
  }

  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !popover.classList.contains("open");
    document
      .querySelectorAll(".trp-popover.open")
      .forEach((el) => el.classList.remove("open"));
    if (willOpen) {
      syncUI();
      popover.classList.add("open");
      caretEl.textContent = "▴";
    } else {
      closePopover();
    }
  });

  popover.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", closePopover);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePopover();
  });

  calFrom.addEventListener("change", () => {
    if (calFrom.value) {
      fromInput.value = formatDateTime(new Date(calFrom.value).getTime());
    }
  });
  calTo.addEventListener("change", () => {
    if (calTo.value) {
      toInput.value = formatDateTime(new Date(calTo.value).getTime());
    }
  });

  $(".trp-apply-btn", root).addEventListener("click", () => {
    applyRange(fromInput.value, toInput.value, true);
  });

  searchInput.addEventListener("input", renderQuickList);

  quickListEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".trp-quick-item");
    if (!btn) return;
    applyRange(btn.dataset.from, btn.dataset.to, false);
  });

  recentListEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".trp-recent-item");
    if (!btn) return;
    applyRange(btn.dataset.from, btn.dataset.to, false);
  });

  $(".trp-copy", root).addEventListener("click", () => {
    const payload = JSON.stringify({
      from: fromInput.value.trim(),
      to: toInput.value.trim(),
    });
    try {
      localStorage.setItem(COPIED_RANGE_KEY, payload);
      if (navigator.clipboard) navigator.clipboard.writeText(payload);
    } catch (_) {}
  });

  $(".trp-paste", root).addEventListener("click", () => {
    try {
      const saved = JSON.parse(localStorage.getItem(COPIED_RANGE_KEY) || "null");
      if (saved && saved.from && saved.to) {
        fromInput.value = saved.from;
        toInput.value = saved.to;
      }
    } catch (_) {}
  });

  function shiftWindow(direction) {
    const { fromMs, toMs } = getWindow();
    const step = Math.max(60000, Math.round((toMs - fromMs) / 2)) * direction;
    const now = Date.now();
    const nextTo = Math.min(now, toMs + step);
    const nextFrom = Math.min(nextTo - 60000, fromMs + step);
    applyRange(formatDateTime(nextFrom), formatDateTime(nextTo), true);
  }

  prevBtn.addEventListener("click", () => shiftWindow(-1));
  nextBtn.addEventListener("click", () => shiftWindow(1));

  syncUI();
  const controller = {
    getWindow,
    toQueryString,
    setRange: applyRange,
    setLoading,
    commitPendingRange,
    revertPendingRange,
  };
  activeTimePicker = controller;
  return controller;
}

document.addEventListener("DOMContentLoaded", () => {
  buildShell();
  if (window.Chart) {
    Chart.defaults.font.family = "Inter, system-ui, sans-serif";
    Chart.defaults.color = "#667085";
  }
  document.dispatchEvent(new Event("shell-ready"));
  startHealthLoop();
});
