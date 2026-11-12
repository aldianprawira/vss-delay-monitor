const NAV = [
  { href: "/index.html", key: "index", label: "Overview" },
  { href: "/traffic.html", key: "traffic", label: "Traffic" },
  { href: "/devices.html", key: "devices", label: "Live Monitoring" },
  { href: "/summary.html", key: "summary", label: "Daily Summary" },
  { href: "/monthly.html", key: "monthly", label: "Monthly Summary" },
];

const THEME_STORAGE_KEY = "vss_theme";

const ICONS = {
  clock: `<svg class="trp-icon trp-clock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.4 1.6" stroke-linecap="round"/></svg>`,
  calendar: `<svg class="trp-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.2" y="3.2" width="11.6" height="10.6" rx="1.8"/><path d="M5 1.8v2.4M11 1.8v2.4M2.2 6.4h11.6" stroke-linecap="round"/></svg>`,
  copy: `<svg class="trp-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.2" y="5.2" width="8.6" height="8.6" rx="1.5"/><path d="M3.5 10.8H2.8a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v.7" stroke-linecap="round"/></svg>`,
  paste: `<svg class="trp-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5.5 2.5h5v2h-5z"/><rect x="3" y="3.5" width="10" height="10.5" rx="1.5"/></svg>`,
  sun: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" stroke-linecap="round"/></svg>`,
  moon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M13.2 9.8A5.6 5.6 0 0 1 6.2 2.8a5.6 5.6 0 1 0 7 7Z" stroke-linejoin="round"/></svg>`,
};

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

const charts = {};
let activeQueryController = null;
let activeTimePicker = null;
let activePollTrigger = null;

function getCurrentTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch (_) {}
  return "light";
}

function getThemeChartTokens() {
  const isDark = document.documentElement.dataset.theme === "dark";
  return {
    textColor: isDark ? "#94a3b8" : "#475569",
    gridColor: isDark ? "#1e293b" : "#e2e8f0",
    surfaceColor: isDark ? "#111827" : "#ffffff",
  };
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (_) {}

  const btn = $("#themeToggle");
  if (btn) {
    const isDark = theme === "dark";
    btn.innerHTML = `${isDark ? ICONS.sun : ICONS.moon}<span>${isDark ? "Light" : "Dark"}</span>`;
    btn.setAttribute(
      "aria-label",
      isDark ? "Switch to light theme" : "Switch to dark theme",
    );
    btn.setAttribute("aria-pressed", String(isDark));
  }

  if (window.Chart) {
    const tokens = getThemeChartTokens();
    Chart.defaults.color = tokens.textColor;
    Object.values(charts).forEach((chart) => {
      if (chart.config.type === "doughnut") {
        chart.data.datasets.forEach((ds) => {
          ds.borderColor = tokens.surfaceColor;
        });
      }
      if (chart.options?.scales?.y?.grid) {
        chart.options.scales.y.grid.color = tokens.gridColor;
      }
      chart.update("none");
    });
  }
}

// Apply saved theme immediately so the document does not flash before DOMContentLoaded.
applyTheme(getCurrentTheme());

// Load Google Fonts asynchronously so external font fetches never block CSSOM construction or page navigation.
if (document.head && !document.getElementById("vssFonts")) {
  const fontLink = document.createElement("link");
  fontLink.id = "vssFonts";
  fontLink.rel = "stylesheet";
  fontLink.href =
    "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap";
  fontLink.media = "print";
  fontLink.onload = () => {
    fontLink.media = "all";
  };
  document.head.appendChild(fontLink);
}

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

function inferTone(cat) {
  if (!cat) return "info";
  if (cat.tone) return cat.tone;
  const k = String(cat.key || "").toUpperCase();
  if (k === "ONLINE" || k === "0-5S") return "ok";
  if (k === "WARNING" || k === "5S-1M") return "warn";
  if (k === "OFFLINE" || k === ">1M") return "err";
  return "info";
}

function badge(cat) {
  const tone = inferTone(cat);
  return `<span class="badge badge-${esc(tone)}">${esc(cat.key)}</span>`;
}

let shellBuilt = false;

function buildShell() {
  if (shellBuilt) return;
  const content = $("main.content");
  if (!content) return;
  shellBuilt = true;

  const page = document.body.dataset.page;

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";
  sidebar.innerHTML = `
    <div class="brand">VSS Monitoring<small>by IT Operations</small></div>
    <nav class="nav" aria-label="Primary navigation">
      ${NAV.map((n) => `<a href="${n.href}" class="${n.key === page ? "active" : ""}" ${n.key === page ? 'aria-current="page"' : ""}>${n.label}</a>`).join("")}
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
        <span id="conn" class="pill" aria-live="polite">Loading…</span>
        <button id="themeToggle" type="button" class="theme-toggle"></button>
      </div>
    </header>`;

  content.parentNode.insertBefore(sidebar, content);
  content.parentNode.insertBefore(main, content);
  main.appendChild(content);
  content.insertAdjacentHTML(
    "afterbegin",
    '<div id="ingestBanner"></div><div id="pageError" aria-live="assertive"></div>',
  );
  document.body.classList.add("shell-mounted");

  applyTheme(getCurrentTheme());
  $("#themeToggle").addEventListener("click", () => {
    applyTheme(getCurrentTheme() === "dark" ? "light" : "dark");
  });

  const kpisEl = $("#kpis");
  if (kpisEl && !kpisEl.innerHTML.trim()) {
    kpisEl.innerHTML = `<div class="card state-msg">Loading telemetry metrics…</div>`;
  }
  document.querySelectorAll("tbody").forEach((tb) => {
    if (!tb.innerHTML.trim()) {
      const cols =
        tb.closest("table")?.querySelectorAll("thead th").length || 1;
      tb.innerHTML = `<tr><td class="empty" colspan="${cols}">Loading telemetry data…</td></tr>`;
    }
  });
}

function renderPageError(err) {
  const box = $("#pageError");
  if (!box) return;
  if (!err) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `
    <div class="banner">
      <div style="flex:1">
        <strong>Unable to load telemetry data</strong>
        ${esc(err.message || "Request failed")}. Check server connectivity or try again.
      </div>
      <button type="button" class="btn-primary" id="retryPollBtn">Retry now</button>
    </div>`;
  const retryBtn = $("#retryPollBtn", box);
  if (retryBtn && activePollTrigger) {
    retryBtn.addEventListener("click", () => activePollTrigger());
  }
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
        renderPageError(null);
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
      if (runId === currentRunId) {
        renderPageError(err);
        setStatus(false);
      }
    } finally {
      if (runId === currentRunId) {
        running = false;
        activeQueryController = null;
        if (activeTimePicker) activeTimePicker.setLoading(false);
      }
    }
  }

  activePollTrigger = () => execute({ manual: true });
  execute({ manual: false });
  setInterval(() => execute({ manual: false }), intervalMs);
  document.addEventListener(
    "visibilitychange",
    () => !document.hidden && execute({ manual: false }),
  );
  return activePollTrigger;
}

function upsertChart(id, config) {
  if (charts[id]) {
    charts[id].data = config.data;
    charts[id].update("none");
  } else {
    charts[id] = new Chart(document.getElementById(id), config);
  }
}

function pieConfig(labels, data, colors, { legendStats = true } = {}) {
  const total = data.reduce((a, b) => a + Number(b), 0);
  const tokens = getThemeChartTokens();
  const displayLabels = legendStats
    ? labels.map(
        (l, i) =>
          `${l}: ${Number(data[i]).toLocaleString()} (${pct(data[i], total)}%)`,
      )
    : labels;
  return {
    type: "doughnut",
    data: {
      labels: displayLabels,
      datasets: [
        {
          data,
          backgroundColor: colors,
          borderColor: tokens.surfaceColor,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "62%",
      layout: {
        padding: { top: 2, bottom: 2, left: 4, right: 12 },
      },
      plugins: {
        legend: {
          position: "right",
          labels: {
            boxWidth: 12,
            boxHeight: 12,
            usePointStyle: true,
            pointStyle: "rectRounded",
            padding: 12,
            font: { size: 12, weight: "500" },
          },
        },
        tooltip: {
          callbacks: {
            label: (c) => {
              if (legendStats) return c.label;
              const dsTotal = c.dataset.data.reduce(
                (a, b) => a + Number(b),
                0,
              );
              return `${c.label}: ${Number(c.parsed).toLocaleString()} (${pct(c.parsed, dsTotal)}%)`;
            },
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
  const tokens = getThemeChartTokens();
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
        y: { beginAtZero: true, grid: { color: tokens.gridColor } },
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

const kpi = (label, value, hint = "", tone = "primary") =>
  `<div class="card kpi" data-tone="${esc(tone)}"><h3>${esc(label)}</h3><div class="value">${value}</div><div class="hint">${hint}</div></div>`;

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
        borderColor: "#1d4ed8",
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
  root = document,
  state,
  pageSize = 50,
  prepareItems,
  getSortValue,
  renderRow,
  colSpan,
  emptyMessage,
  onAfterRender,
}) {
  const scope = typeof root === "string" ? $(root) : root;
  const find = (sel) => $(sel, scope);

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
    const size = state.pageSize || pageSize;
    const list = getFilteredAndSorted();
    const pages = Math.max(1, Math.ceil(list.length / size));
    state.page = Math.min(state.page, pages - 1);
    const slice = list.slice(state.page * size, (state.page + 1) * size);

    const rowsEl = find(".rows") || find("#rows");
    const countEl = find(".count") || find("#count");
    const pageInfoEl = find(".pageInfo") || find("#pageInfo");
    const prevEl = find(".prev") || find("#prev");
    const nextEl = find(".next") || find("#next");

    if (rowsEl) {
      rowsEl.innerHTML =
        slice.map(renderRow).join("") ||
        `<tr><td class="empty" colspan="${colSpan}">${esc(emptyMessage)}</td></tr>`;
    }
    if (countEl) {
      countEl.textContent = `${list.length.toLocaleString()} of ${state.all.length.toLocaleString()} devices`;
    }
    if (pageInfoEl) {
      pageInfoEl.textContent = `Page ${state.page + 1} of ${pages}`;
    }
    if (prevEl) prevEl.disabled = state.page === 0;
    if (nextEl) nextEl.disabled = state.page >= pages - 1;

    scope.querySelectorAll("th.sortable").forEach((th) => {
      const isSorted = th.dataset.sort === state.sort;
      th.setAttribute(
        "aria-sort",
        isSorted ? (state.dir === "asc" ? "ascending" : "descending") : "none",
      );
      const indicator = th.querySelector(".si");
      if (indicator) {
        indicator.setAttribute("aria-hidden", "true");
        indicator.textContent = isSorted
          ? state.dir === "asc"
            ? "▲"
            : "▼"
          : "";
      }
    });

    if (onAfterRender) onAfterRender(list);
  }

  function toggleSort(col) {
    state.dir = state.sort === col && state.dir === "asc" ? "desc" : "asc";
    state.sort = col;
    render();
  }

  function bindControls() {
    const qEl = find(".q") || find("#q");
    if (qEl) {
      qEl.addEventListener("input", (e) => {
        state.q = e.target.value;
        state.page = 0;
        render();
      });
    }
    const pageSizeEl = find(".pageSize") || find("#pageSize");
    if (pageSizeEl) {
      pageSizeEl.addEventListener("change", (e) => {
        state.pageSize = Number(e.target.value) || pageSize;
        state.page = 0;
        render();
      });
    }
    const prevEl = find(".prev") || find("#prev");
    if (prevEl) {
      prevEl.addEventListener("click", () => {
        state.page--;
        render();
      });
    }
    const nextEl = find(".next") || find("#next");
    if (nextEl) {
      nextEl.addEventListener("click", () => {
        state.page++;
        render();
      });
    }
    scope.querySelectorAll("th.sortable").forEach((th) => {
      th.setAttribute("tabindex", "0");
      th.addEventListener("click", () => toggleSort(th.dataset.sort));
      th.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleSort(th.dataset.sort);
        }
      });
    });
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
      <button type="button" class="trp-prev" title="Shift time range backward" aria-label="Shift time range backward">«</button>
      <button type="button" class="trp-toggle" title="Select time range" aria-expanded="false" aria-haspopup="dialog">
        ${ICONS.clock}
        <span class="trp-spinner" aria-hidden="true"></span>
        <span class="trp-label"></span>
        <span class="trp-caret" aria-hidden="true">▾</span>
      </button>
      <button type="button" class="trp-next" title="Shift time range forward" aria-label="Shift time range forward">»</button>
    </div>
    <button type="button" class="trp-cancel" title="Cancel active query">✕ Cancel</button>
    <div class="trp-popover ${align === "right" ? "right-align" : ""}" role="dialog" aria-label="Time range selector">
      <div class="trp-abs">
        <div class="trp-title">Absolute time range</div>
        <div class="trp-field">
          <label for="trpFromInput">From</label>
          <div class="trp-input-group">
            <input id="trpFromInput" type="text" class="trp-from" spellcheck="false" />
            <span class="trp-cal-btn" title="Pick start date and time">
              ${ICONS.calendar}
              <input type="datetime-local" step="1" class="trp-cal-native trp-cal-from" aria-label="Pick start date and time" />
            </span>
          </div>
        </div>
        <div class="trp-field">
          <label for="trpToInput">To</label>
          <div class="trp-input-group">
            <input id="trpToInput" type="text" class="trp-to" spellcheck="false" />
            <span class="trp-cal-btn" title="Pick end date and time">
              ${ICONS.calendar}
              <input type="datetime-local" step="1" class="trp-cal-native trp-cal-to" aria-label="Pick end date and time" />
            </span>
          </div>
        </div>
        <div class="trp-err" role="alert"></div>
        <div class="trp-actions">
          <button type="button" class="trp-icon-btn trp-copy" title="Copy time range" aria-label="Copy time range">${ICONS.copy}</button>
          <button type="button" class="trp-icon-btn trp-paste" title="Paste time range" aria-label="Paste time range">${ICONS.paste}</button>
          <button type="button" class="trp-apply-btn">Apply time range</button>
        </div>
        <div class="trp-recent">
          <div class="trp-title" style="font-size:0.75rem">Recently used absolute ranges</div>
          <div class="trp-recent-list"></div>
        </div>
      </div>
      <div class="trp-quick">
        <div class="trp-search-wrap">
          <label for="trpQuickSearch" class="sr-only">Search quick ranges</label>
          <input id="trpQuickSearch" type="search" class="trp-search" placeholder="Search quick ranges…" />
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
        .join("") ||
      `<div class="hint" style="font-size:0.74rem;color:var(--muted)">No recent custom ranges saved</div>`;
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
    toggleBtn.setAttribute("aria-expanded", "false");
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
      toggleBtn.setAttribute("aria-expanded", "true");
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

if (typeof MutationObserver !== "undefined") {
  const shellObserver = new MutationObserver(() => {
    const mainEl = $("main.content");
    if (mainEl && mainEl.nextElementSibling) {
      shellObserver.disconnect();
      buildShell();
    }
  });
  shellObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

document.addEventListener("DOMContentLoaded", () => {
  buildShell();
  if (window.Chart) {
    const tokens = getThemeChartTokens();
    Chart.defaults.font.family =
      '"Plus Jakarta Sans", system-ui, -apple-system, sans-serif';
    Chart.defaults.color = tokens.textColor;
  }
  document.dispatchEvent(new Event("shell-ready"));
  startHealthLoop();
});
