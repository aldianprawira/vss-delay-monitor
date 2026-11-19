const path = require("path");
const nodemailer = require("nodemailer");
const XLSX = require("xlsx");
const { Resvg } = require("@resvg/resvg-js");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const {
  DEVICE_TZ,
  EMAIL_ENABLED,
  EMAIL_TEST_MODE,
  EMAIL_SEND_HOUR,
  EMAIL_SEND_MINUTE,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
  EMAIL_TO,
  EMAIL_CC,
  EMAIL_TEST_TO,
  EMAIL_TEST_CC,
  DASHBOARD_URL,
} = require("./config");
const { writerPool } = require("./db");
const { getOrGenerateDailySummary, getMonthlySummary } = require("./dailySummary");
const {
  DELAY_CATEGORIES,
  STALENESS_CATEGORIES,
  formatDelay,
  formatStaleness,
  getCategory,
} = require("../public/format");

const EMAIL_CHECK_INTERVAL_MS = 60 * 1000;

function escHtml(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function pct(n, total) {
  return total > 0 ? ((n / total) * 100).toFixed(1) : "0.0";
}

const FONT_REGULAR = path.join(__dirname, "assets/fonts/Roboto-Regular.ttf");
const FONT_BOLD = path.join(__dirname, "assets/fonts/Roboto-Bold.ttf");

function svgToPng(svg) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: {
      fontFiles: [FONT_REGULAR, FONT_BOLD],
      loadSystemFonts: false,
      defaultFontFamily: "Roboto",
    },
  });
  return resvg.render().asPng();
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function describeDonutArc(cx, cy, rOuter, rInner, startAngle, endAngle) {
  const sweep = endAngle - startAngle;
  if (sweep >= 359.99) {
    const mid = startAngle + 180;
    return (
      describeDonutArc(cx, cy, rOuter, rInner, startAngle, mid) +
      " " +
      describeDonutArc(cx, cy, rOuter, rInner, mid, endAngle)
    );
  }
  const p1 = polarToCartesian(cx, cy, rOuter, startAngle);
  const p2 = polarToCartesian(cx, cy, rOuter, endAngle);
  const p3 = polarToCartesian(cx, cy, rInner, endAngle);
  const p4 = polarToCartesian(cx, cy, rInner, startAngle);
  const largeArc = sweep > 180 ? 1 : 0;
  return [
    `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function renderDoughnutSvg(items) {
  const width = 440;
  const height = 220;
  const cx = 115;
  const cy = 110;
  const rOuter = 82;
  const rInner = 50;
  const total = items.reduce((s, it) => s + Number(it.value || 0), 0);

  let arcs = "";
  if (total <= 0) {
    arcs = `<circle cx="${cx}" cy="${cy}" r="${(rOuter + rInner) / 2}" fill="none" stroke="#e2e8f0" stroke-width="${rOuter - rInner}" />`;
  } else {
    let angle = 0;
    for (const it of items) {
      const val = Number(it.value || 0);
      if (val <= 0) continue;
      const sweep = (val / total) * 360;
      const d = describeDonutArc(cx, cy, rOuter, rInner, angle, angle + sweep);
      arcs += `<path d="${d}" fill="${it.color}" stroke="#ffffff" stroke-width="2" />`;
      angle += sweep;
    }
  }

  const legendStartY = 66;
  const legendItems = items
    .map((it, idx) => {
      const y = legendStartY + idx * 32;
      const label = `${it.label}: ${Number(it.value || 0).toLocaleString()} (${pct(it.value, total)}%)`;
      return `
        <rect x="230" y="${y - 10}" width="12" height="12" rx="3" fill="${it.color}" />
        <text x="250" y="${y}" font-family="Roboto, Arial, sans-serif" font-size="13" font-weight="600" fill="#334155">${escHtml(label)}</text>
      `;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#ffffff" />
    ${arcs}
    ${legendItems}
  </svg>`;
}

function niceStep(maxVal, targetTicks = 6) {
  if (maxVal <= 0) return 10;
  const raw = maxVal / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return Math.max(1, step * mag);
}

function renderStackedBarSvg(days, seriesList, valueGetter) {
  const width = 920;
  const height = 280;
  const padL = 52;
  const padR = 20;
  const padT = 36;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const totals = days.map((d) =>
    seriesList.reduce((sum, s) => sum + Number(valueGetter(d, s.key) || 0), 0),
  );
  const rawMax = Math.max(10, ...totals);
  const step = niceStep(rawMax, 6);
  const yMax = Math.ceil(rawMax / step) * step;

  let gridLines = "";
  for (let v = 0; v <= yMax; v += step) {
    const y = padT + plotH - (v / yMax) * plotH;
    gridLines += `
      <line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1" />
      <text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="Roboto, Arial, sans-serif" font-size="11" fill="#64748b">${v.toLocaleString()}</text>
    `;
  }

  const slotW = plotW / Math.max(1, days.length);
  const barW = Math.max(6, Math.min(22, slotW * 0.68));
  let bars = "";
  let xLabels = "";

  days.forEach((d, i) => {
    const cx = padL + i * slotW + slotW / 2;
    const x = cx - barW / 2;
    let yCursor = padT + plotH;

    for (const s of seriesList) {
      const val = Number(valueGetter(d, s.key) || 0);
      if (val <= 0) continue;
      const h = (val / yMax) * plotH;
      yCursor -= h;
      bars += `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="${s.color}" rx="1.5" />`;
    }

    xLabels += `<text x="${cx.toFixed(1)}" y="${height - 10}" text-anchor="middle" font-family="Roboto, Arial, sans-serif" font-size="11" fill="#64748b">${escHtml(d.dayLabel)}</text>`;
  });

  // Render legend right-aligned at the top.
  let legendX = width - padR;
  let legend = "";
  for (let i = seriesList.length - 1; i >= 0; i--) {
    const s = seriesList[i];
    const textW = s.key.length * 7.2 + 24;
    legendX -= textW;
    legend += `
      <rect x="${legendX}" y="10" width="12" height="12" rx="3" fill="${s.color}" />
      <text x="${legendX + 16}" y="20" font-family="Roboto, Arial, sans-serif" font-size="12" font-weight="600" fill="#475569">${escHtml(s.key)}</text>
    `;
    legendX -= 10;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#ffffff" />
    ${legend}
    ${gridLines}
    ${bars}
    ${xLabels}
  </svg>`;
}

function buildExcelBuffer(rows, headers, colWidths, sheetName) {
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  ws["!cols"] = colWidths.map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function buildOfflineExcel(summary) {
  const rows = (summary.offlineDevices || [])
    .slice()
    .sort((a, b) => Number(b.ageMs) - Number(a.ageMs))
    .map((d) => ({
      Device: d.deviceName || "-",
      "Device ID": String(d.deviceId),
      "Silent Duration": formatStaleness(d.ageMs),
      "Last Seen": new Date(d.lastReceived).toLocaleString("en-GB", {
        timeZone: DEVICE_TZ,
      }),
      "Last DTU": d.lastDtu
        ? new Date(d.lastDtu).toLocaleString("en-GB", { timeZone: DEVICE_TZ })
        : "-",
      Status: "OFFLINE",
    }));

  return buildExcelBuffer(
    rows,
    [
      "Device",
      "Device ID",
      "Silent Duration",
      "Last Seen",
      "Last DTU",
      "Status",
    ],
    [28, 24, 18, 22, 22, 12],
    "Offline Devices",
  );
}

function buildDelayExcel(summary) {
  const rows = (summary.devices || [])
    .slice()
    .sort((a, b) => Number(b.avgDelay) - Number(a.avgDelay))
    .map((d) => ({
      Device: d.deviceName || "-",
      "Device ID": String(d.deviceId),
      Records: d.count,
      Min: formatDelay(d.minDelay),
      Avg: `${formatDelay(d.avgDelay)} (${getCategory(d.avgDelay).key})`,
      Max: `${formatDelay(d.maxDelay)} (${getCategory(d.maxDelay).key})`,
    }));

  return buildExcelBuffer(
    rows,
    ["Device", "Device ID", "Records", "Min", "Avg", "Max"],
    [28, 24, 12, 14, 18, 18],
    "Delay Summary",
  );
}

async function buildDailyEmailPayload(dateStr) {
  const targetDate =
    dateStr ||
    dayjs().tz(DEVICE_TZ).subtract(1, "day").format("YYYY-MM-DD");
  const monthStr = targetDate.slice(0, 7);

  const [daily, monthly] = await Promise.all([
    getOrGenerateDailySummary(targetDate),
    getMonthlySummary(monthStr),
  ]);

  const staleMap = Object.fromEntries(
    STALENESS_CATEGORIES.map((c) => [c.key, 0]),
  );
  (daily.stalenessCategories || []).forEach((c) => {
    staleMap[c.category] = Number(c.count || 0);
  });

  const delayCounts = Object.fromEntries(
    DELAY_CATEGORIES.map((c) => [c.key, 0]),
  );
  (daily.devices || []).forEach((d) => {
    const key = getCategory(d.avgDelay).key;
    delayCounts[key] = (delayCounts[key] || 0) + 1;
  });

  const stalePiePng = svgToPng(
    renderDoughnutSvg(
      STALENESS_CATEGORIES.map((c) => ({
        label: c.key,
        value: staleMap[c.key] || 0,
        color: c.color,
      })),
    ),
  );

  const delayPiePng = svgToPng(
    renderDoughnutSvg(
      DELAY_CATEGORIES.map((c) => ({
        label: c.key,
        value: delayCounts[c.key] || 0,
        color: c.color,
      })),
    ),
  );

  const staleBarPng = svgToPng(
    renderStackedBarSvg(
      monthly.days || [],
      [...STALENESS_CATEGORIES].reverse(),
      (d, key) => d.stalenessByCat?.[key] ?? 0,
    ),
  );

  const delayBarPng = svgToPng(
    renderStackedBarSvg(
      monthly.days || [],
      [...DELAY_CATEGORIES.slice(1)].reverse(),
      (d, key) => d.delayByCat?.[key] ?? 0,
    ),
  );

  const offlineXlsx = buildOfflineExcel(daily);
  const delayXlsx = buildDelayExcel(daily);

  return {
    date: daily.date,
    month: monthly.month,
    daily,
    monthly,
    images: {
      stalePiePng,
      delayPiePng,
      staleBarPng,
      delayBarPng,
    },
    excels: {
      offlineFilename: `daily-summary-offline-devices_${daily.date}.xlsx`,
      offlineBuffer: offlineXlsx,
      delayFilename: `daily-summary-delay_${daily.date}.xlsx`,
      delayBuffer: delayXlsx,
    },
  };
}

function buildEmailHtml(payload, { inlineDataUri = false, isTest = false } = {}) {
  const { date, daily, images } = payload;
  const t = daily.totals || {};
  const offlineCount = Number(t.offlineDevices ?? 0);
  const regCount = Number(t.registeredDevices ?? 0);
  const onlineCount = Number(t.onlineDevices ?? 0);
  const warnCount = Number(t.warningDevices ?? 0);
  const recordsCount = Number(t.records ?? 0);
  const shownCount = Number(t.shown ?? 0);

  const topOfflineRows = (daily.offlineDevices || [])
    .slice()
    .sort((a, b) => Number(b.ageMs) - Number(a.ageMs))
    .slice(0, 10)
    .map(
      (d) => `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#0f172a;">${escHtml(d.deviceName || d.deviceId || "-")}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#334155;">${escHtml(formatStaleness(d.ageMs))}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:11px;font-weight:700;color:#b91c1c;">OFFLINE</td>
      </tr>`,
    )
    .join("");

  const topDelayRows = (daily.devices || [])
    .slice()
    .sort((a, b) => Number(b.avgDelay) - Number(a.avgDelay))
    .slice(0, 10)
    .map(
      (d) => `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#0f172a;">${escHtml(d.deviceName || d.deviceId || "-")}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#334155;">${escHtml(formatDelay(d.avgDelay))} <span style="font-size:11px;color:#64748b;">(${escHtml(getCategory(d.avgDelay).key)})</span></td>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#334155;">${escHtml(formatDelay(d.maxDelay))} <span style="font-size:11px;color:#64748b;">(${escHtml(getCategory(d.maxDelay).key)})</span></td>
      </tr>`,
    )
    .join("");

  const imgSrc = (cid, buf) =>
    inlineDataUri
      ? `data:image/png;base64,${buf.toString("base64")}`
      : `cid:${cid}`;

  const testBanner = isTest
    ? `<div style="background:#fef3c7;border:1px solid #f59e0b;color:#92400e;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:13px;">
        <strong>[TEST MODE]</strong> This is a test dispatch of the Daily Summary email.
       </div>`
    : "";

  const dashboardLink = DASHBOARD_URL
    ? `<a href="${escHtml(DASHBOARD_URL)}/summary.html?date=${encodeURIComponent(date)}" style="color:#2563eb;text-decoration:none;font-weight:600;">Open Dashboard &rarr;</a>`
    : "";

  return `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f1f5f9" style="background-color:#f1f5f9;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" width="920" align="center" cellspacing="0" cellpadding="0" style="width:100%;max-width:920px;margin:0 auto;">
          <tr>
            <td>
              ${testBanner}
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td>
                    <h1 style="margin:0;font-size:22px;color:#0f172a;">Daily Summary Report</h1>
                    <div style="margin-top:4px;font-size:13px;color:#475569;">
                      Report Date: <strong>${escHtml(date)}</strong> (WIB) &middot; Midnight snapshot &amp; daily delay summary
                    </div>
                  </td>
                  <td align="right" style="vertical-align:middle;font-size:13px;">
                    ${dashboardLink}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td height="16" style="height:16px;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr>
            <td>
              <!-- KPI Cards -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td width="32%" style="background-color:#ffffff;border:1px solid #e2e8f0;border-top:3px solid #2563eb;border-radius:10px;padding:16px;vertical-align:top;">
                    <div style="font-size:12px;color:#64748b;font-weight:600;">Total devices</div>
                    <div style="font-size:28px;font-weight:700;color:#0f172a;margin:6px 0;">${regCount.toLocaleString()}</div>
                    <div style="font-size:12px;color:#64748b;">${onlineCount.toLocaleString()} online &middot; ${warnCount.toLocaleString()} warning</div>
                  </td>
                  <td width="16" style="width:16px;font-size:0;line-height:0;">&nbsp;</td>
                  <td width="32%" style="background-color:#ffffff;border:1px solid #e2e8f0;border-top:3px solid ${offlineCount > 0 ? "#dc2626" : "#16a34a"};border-radius:10px;padding:16px;vertical-align:top;">
                    <div style="font-size:12px;color:#64748b;font-weight:600;">Total offline</div>
                    <div style="font-size:28px;font-weight:700;color:#0f172a;margin:6px 0;">${offlineCount.toLocaleString()}</div>
                    <div style="font-size:12px;color:#64748b;">${pct(offlineCount, regCount)}% of total &middot; captured at 00:00</div>
                  </td>
                  <td width="16" style="width:16px;font-size:0;line-height:0;">&nbsp;</td>
                  <td width="32%" style="background-color:#ffffff;border:1px solid #e2e8f0;border-top:3px solid #2563eb;border-radius:10px;padding:16px;vertical-align:top;">
                    <div style="font-size:12px;color:#64748b;font-weight:600;">Total records</div>
                    <div style="font-size:28px;font-weight:700;color:#0f172a;margin:6px 0;">${recordsCount.toLocaleString()}</div>
                    <div style="font-size:12px;color:#64748b;">${shownCount.toLocaleString()} active devices on ${escHtml(date)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td height="16" style="height:16px;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr>
            <td>
              <!-- Doughnut Charts -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td width="49%" style="background-color:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;vertical-align:top;">
                    <div style="font-size:14px;font-weight:700;color:#0f172a;margin-bottom:10px;">Staleness status distribution (captured at 00:00)</div>
                    <img src="${imgSrc("stale-pie", images.stalePiePng)}" width="420" alt="Staleness status distribution" style="width:100%;max-width:440px;height:auto;display:block;" />
                    <div style="font-size:12px;font-weight:700;color:#334155;margin:14px 0 6px;">Top 10 Offline devices (captured at 00:00)</div>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                      <thead>
                        <tr style="background:#f8fafc;">
                          <th align="left" style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b;">Device</th>
                          <th align="left" style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b;">Silent Duration</th>
                          <th align="left" style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b;">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${topOfflineRows || `<tr><td colspan="3" style="padding:8px;font-size:12px;color:#64748b;text-align:center;">No offline devices</td></tr>`}
                      </tbody>
                    </table>
                  </td>
                  <td width="16" style="width:16px;font-size:0;line-height:0;">&nbsp;</td>
                  <td width="49%" style="background-color:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;vertical-align:top;">
                    <div style="font-size:14px;font-weight:700;color:#0f172a;margin-bottom:10px;">Device distribution by average delay category</div>
                    <img src="${imgSrc("delay-pie", images.delayPiePng)}" width="420" alt="Delay category distribution" style="width:100%;max-width:440px;height:auto;display:block;" />
                    <div style="font-size:12px;font-weight:700;color:#334155;margin:14px 0 6px;">Top 10 Delay summary</div>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                      <thead>
                        <tr style="background:#f8fafc;">
                          <th align="left" style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b;">Device</th>
                          <th align="left" style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b;">Avg Delay</th>
                          <th align="left" style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b;">Max Delay</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${topDelayRows || `<tr><td colspan="3" style="padding:8px;font-size:12px;color:#64748b;text-align:center;">No delay records</td></tr>`}
                      </tbody>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td height="16" style="height:16px;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr>
            <td>
              <!-- Monthly Stacked Bar Charts -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="background-color:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;">
                    <div style="font-size:14px;font-weight:700;color:#0f172a;margin-bottom:10px;">Daily staleness distribution (captured at 00:00)</div>
                    <img src="${imgSrc("stale-bar", images.staleBarPng)}" width="888" alt="Daily staleness distribution" style="width:100%;height:auto;display:block;" />
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td height="16" style="height:16px;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr>
            <td>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="background-color:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;">
                    <div style="font-size:14px;font-weight:700;color:#0f172a;margin-bottom:10px;">Daily devices with average delay &gt; 5s</div>
                    <img src="${imgSrc("delay-bar", images.delayBarPng)}" width="888" alt="Daily devices with average delay > 5s" style="width:100%;height:auto;display:block;" />
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td height="12" style="height:12px;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr>
            <td align="center" style="font-size:12px;color:#64748b;">
              Attached: <strong>${escHtml(payload.excels.offlineFilename)}</strong> and <strong>${escHtml(payload.excels.delayFilename)}</strong>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function ensureEmailLogTable() {
  await writerPool.query(`
    CREATE TABLE IF NOT EXISTS daily_email_logs (
      report_date DATE PRIMARY KEY,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recipients TEXT,
      status TEXT NOT NULL
    )
  `);
}

function createTransporter() {
  const opts = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    tls: { rejectUnauthorized: false },
  };
  if (SMTP_USER && SMTP_PASS) {
    opts.auth = { user: SMTP_USER, pass: SMTP_PASS };
  }
  return nodemailer.createTransport(opts);
}

async function renderDailyEmailPreview(dateStr, { isTest = EMAIL_TEST_MODE } = {}) {
  const payload = await buildDailyEmailPayload(dateStr);
  return buildEmailHtml(payload, { inlineDataUri: true, isTest });
}

async function sendDailySummaryEmail(
  dateStr,
  { to, isTest = EMAIL_TEST_MODE, force = false } = {},
) {
  const targetDate =
    dateStr ||
    dayjs().tz(DEVICE_TZ).subtract(1, "day").format("YYYY-MM-DD");

  const recipients = (
    to ||
    (isTest ? EMAIL_TEST_TO : EMAIL_TO)
  ).trim();
  if (!recipients) {
    throw new Error(
      isTest
        ? "EMAIL_TEST_TO is not configured"
        : "EMAIL_TO is not configured",
    );
  }

  let claimedProdRow = false;
  if (!isTest && !force) {
    await ensureEmailLogTable();
    const { rowCount } = await writerPool.query(
      `INSERT INTO daily_email_logs (report_date, recipients, status)
       VALUES ($1::date, $2, 'sending')
       ON CONFLICT (report_date) DO NOTHING`,
      [targetDate, recipients],
    );
    if (rowCount === 0) {
      return { skipped: true, reason: "already_sent", date: targetDate };
    }
    claimedProdRow = true;
  }

  try {
    const payload = await buildDailyEmailPayload(targetDate);
    const html = buildEmailHtml(payload, { inlineDataUri: false, isTest });
    const subjectPrefix = isTest ? "[TEST] " : "";
    const subject = `${subjectPrefix}VSS Daily Summary Report - ${payload.date}`;

    const ccRecipients = isTest ? EMAIL_TEST_CC : EMAIL_CC;
    const transporter = createTransporter();
    const info = await transporter.sendMail({
      from: EMAIL_FROM,
      to: recipients,
      ...(ccRecipients ? { cc: ccRecipients } : {}),
      subject,
      html,
      attachments: [
        {
          filename: "stale-pie.png",
          content: payload.images.stalePiePng,
          cid: "stale-pie",
        },
        {
          filename: "delay-pie.png",
          content: payload.images.delayPiePng,
          cid: "delay-pie",
        },
        {
          filename: "stale-bar.png",
          content: payload.images.staleBarPng,
          cid: "stale-bar",
        },
        {
          filename: "delay-bar.png",
          content: payload.images.delayBarPng,
          cid: "delay-bar",
        },
        {
          filename: payload.excels.offlineFilename,
          content: payload.excels.offlineBuffer,
        },
        {
          filename: payload.excels.delayFilename,
          content: payload.excels.delayBuffer,
        },
      ],
    });

    if (claimedProdRow) {
      await writerPool.query(
        `UPDATE daily_email_logs SET status = 'sent', sent_at = NOW() WHERE report_date = $1::date`,
        [targetDate],
      );
    }

    return {
      skipped: false,
      date: payload.date,
      recipients,
      isTest,
      messageId: info.messageId,
    };
  } catch (err) {
    if (claimedProdRow) {
      await writerPool
        .query(`DELETE FROM daily_email_logs WHERE report_date = $1::date AND status = 'sending'`, [
          targetDate,
        ])
        .catch(() => {});
    }
    throw err;
  }
}

function startDailyEmailScheduler() {
  if (!EMAIL_ENABLED) {
    console.log("📧 [daily-email] Scheduler disabled (EMAIL_ENABLED != true)");
    return;
  }

  let running = false;
  let lastTestSentDate = null;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const nowWib = dayjs().tz(DEVICE_TZ);
      const targetMinutes = EMAIL_SEND_HOUR * 60 + EMAIL_SEND_MINUTE;
      const currentMinutes = nowWib.hour() * 60 + nowWib.minute();
      if (currentMinutes < targetMinutes) return;

      const yesterday = nowWib.subtract(1, "day").format("YYYY-MM-DD");
      if (EMAIL_TEST_MODE && lastTestSentDate === yesterday) return;

      const result = await sendDailySummaryEmail(yesterday, {
        isTest: EMAIL_TEST_MODE,
      });
      if (!result.skipped) {
        if (EMAIL_TEST_MODE) lastTestSentDate = yesterday;
        console.log(
          `📧 [daily-email] Sent ${result.isTest ? "[TEST] " : ""}report for ${result.date} to ${result.recipients}`,
        );
      }
    } catch (err) {
      console.error("❌ [daily-email] Scheduled send failed:", err.message);
    } finally {
      running = false;
    }
  }

  tick();
  setInterval(tick, EMAIL_CHECK_INTERVAL_MS);
  console.log(
    `📧 [daily-email] Scheduler active (${String(EMAIL_SEND_HOUR).padStart(2, "0")}:${String(EMAIL_SEND_MINUTE).padStart(2, "0")} WIB, testMode=${EMAIL_TEST_MODE})`,
  );
}

module.exports = {
  renderDailyEmailPreview,
  sendDailySummaryEmail,
  startDailyEmailScheduler,
};
