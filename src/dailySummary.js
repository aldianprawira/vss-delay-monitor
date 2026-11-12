const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const {
  DEVICE_TZ,
  HISTORY_RETENTION_DAYS,
  SUMMARY_TIMEOUT_MS,
} = require("./config");
const { apiPool, writerPool, withTransaction } = require("./db");

const ONLINE_MAX_MS = 3600000;
const WARNING_MAX_MS = 21600000;

function classifyStaleness(ageMs) {
  const safeAge = Math.max(Number(ageMs) || 0, 0);
  if (safeAge < ONLINE_MAX_MS) return "ONLINE";
  if (safeAge < WARNING_MAX_MS) return "WARNING";
  return "OFFLINE";
}

async function ensureDailySummaryTable() {
  await writerPool.query(`
    CREATE TABLE IF NOT EXISTS daily_summary_snapshots (
      summary_date DATE PRIMARY KEY,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      data JSONB NOT NULL
    )
  `);
}

async function getStoredSnapshot(dateStr) {
  const { rows } = await apiPool.query(
    "SELECT data FROM daily_summary_snapshots WHERE summary_date = $1",
    [dateStr],
  );
  return rows[0]?.data || null;
}

async function saveSnapshot(dateStr, capturedAt, data) {
  await writerPool.query(
    `INSERT INTO daily_summary_snapshots (summary_date, captured_at, data)
     VALUES ($1, $2, $3)
     ON CONFLICT (summary_date) DO UPDATE SET
       captured_at = EXCLUDED.captured_at,
       data = EXCLUDED.data`,
    [dateStr, capturedAt, JSON.stringify(data)],
  );
}

async function computeDailySummary(dateStr, { cancelOnCloseRes } = {}) {
  const start = dayjs.tz(`${dateStr} 00:00:00`, DEVICE_TZ);
  const end = start.add(1, "day");
  const now = dayjs();
  const isCompletedDay = !end.isAfter(now);
  const captureTime = isCompletedDay ? end : now;
  const captureEpoch = captureTime.valueOf();

  const { stateRows, aggRows } = await withTransaction(
    apiPool,
    async (client) => {
      const latestRes = await client.query(
        `SELECT DISTINCT ON (COALESCE(dl.device_name, dl.device_id))
                dl.device_id,
                dl.device_name,
                dl.last_dtu,
                CASE
                  WHEN dl.last_received <= $1 THEN dl.last_received
                  ELSE COALESCE(
                    (SELECT MAX(h.received_at)
                     FROM device_delay_history h
                     WHERE h.device_id = dl.device_id
                       AND h.received_at <= $1),
                    dl.last_received
                  )
                END AS last_received_at_capture
         FROM device_latest_state dl
         ORDER BY COALESCE(dl.device_name, dl.device_id),
                  dl.last_received DESC,
                  dl.last_dtu DESC`,
        [captureTime.toDate()],
      );

      const aggRes = await client.query(
        `SELECT device_id,
                MAX(device_name)       AS device_name,
                COUNT(*)::int          AS cnt,
                MIN(delay_ms)::bigint  AS min_delay,
                MAX(delay_ms)::bigint  AS max_delay,
                AVG(delay_ms)::float8  AS avg_delay
         FROM device_delay_history
         WHERE received_at >= $1 AND received_at < $2
         GROUP BY device_id`,
        [start.toDate(), end.toDate()],
      );

      return { stateRows: latestRes.rows, aggRows: aggRes.rows };
    },
    { statementTimeoutMs: SUMMARY_TIMEOUT_MS, cancelOnCloseRes },
  );

  const stalenessCounts = { ONLINE: 0, WARNING: 0, OFFLINE: 0 };
  const offlineDevices = [];

  for (const row of stateRows) {
    const lastReceivedMs = new Date(row.last_received_at_capture).getTime();
    const ageMs = Math.max(0, captureEpoch - lastReceivedMs);
    const status = classifyStaleness(ageMs);
    stalenessCounts[status]++;
    if (status === "OFFLINE") {
      offlineDevices.push({
        deviceId: row.device_id,
        deviceName: row.device_name,
        lastReceived: row.last_received_at_capture,
        lastDtu: row.last_dtu,
        ageMs,
      });
    }
  }
  offlineDevices.sort((a, b) => b.ageMs - a.ageMs);

  // Devices reporting exclusively 0ms delays are inactive or uncalibrated and excluded from the delay table.
  const devices = aggRows
    .filter(
      (d) =>
        !(
          Number(d.min_delay) === 0 &&
          Number(d.max_delay) === 0 &&
          d.avg_delay === 0
        ),
    )
    .map((d) => ({
      deviceId: d.device_id,
      deviceName: d.device_name,
      count: d.cnt,
      minDelay: Number(d.min_delay),
      maxDelay: Number(d.max_delay),
      avgDelay: Math.round(d.avg_delay),
    }))
    .sort((a, b) => b.maxDelay - a.maxDelay);

  const registeredCount = stateRows.length;
  const data = {
    date: dateStr,
    capturedAt: captureTime.toISOString(),
    isCompletedDay,
    range: { from: start.toISOString(), to: end.toISOString() },
    totals: {
      registeredDevices: registeredCount,
      offlineDevices: stalenessCounts.OFFLINE,
      onlineDevices: stalenessCounts.ONLINE,
      warningDevices: stalenessCounts.WARNING,
      sentData: aggRows.length,
      noData: Math.max(registeredCount - aggRows.length, 0),
      excludedZero: aggRows.length - devices.length,
      shown: devices.length,
      records: aggRows.reduce((sum, d) => sum + d.cnt, 0),
    },
    stalenessCategories: [
      { category: "ONLINE", count: stalenessCounts.ONLINE },
      { category: "WARNING", count: stalenessCounts.WARNING },
      { category: "OFFLINE", count: stalenessCounts.OFFLINE },
    ],
    offlineDevices,
    devices,
  };

  if (isCompletedDay) {
    await saveSnapshot(dateStr, captureTime.toDate(), data);
  }

  return data;
}

const liveTodayCache = { date: null, at: 0, data: null };

async function getOrGenerateDailySummary(dateStr, { cancelOnCloseRes } = {}) {
  const start = dayjs.tz(`${dateStr} 00:00:00`, DEVICE_TZ);
  if (!start.isValid()) {
    const err = new Error("Invalid calendar date.");
    err.status = 400;
    throw err;
  }
  if (start.isAfter(dayjs())) {
    const err = new Error("Date cannot be in the future.");
    err.status = 400;
    throw err;
  }

  const end = start.add(1, "day");
  const isCompletedDay = !end.isAfter(dayjs());

  if (isCompletedDay) {
    const stored = await getStoredSnapshot(dateStr);
    if (stored) return stored;
  } else if (
    liveTodayCache.date === dateStr &&
    Date.now() - liveTodayCache.at < 60000 &&
    liveTodayCache.data
  ) {
    return liveTodayCache.data;
  }

  const oldestRetained = dayjs()
    .subtract(HISTORY_RETENTION_DAYS, "day")
    .startOf("day");
  if (start.isBefore(oldestRetained)) {
    const err = new Error(
      `No stored snapshot for ${dateStr}, and raw history is only retained for ${HISTORY_RETENTION_DAYS} days.`,
    );
    err.status = 400;
    throw err;
  }

  const computed = await computeDailySummary(dateStr, { cancelOnCloseRes });
  if (!isCompletedDay) {
    liveTodayCache.date = dateStr;
    liveTodayCache.at = Date.now();
    liveTodayCache.data = computed;
  }
  return computed;
}

function scheduleNextMidnightCapture() {
  const now = dayjs().tz(DEVICE_TZ);
  // Run 5 seconds after 00:00 WIB so in-flight batches from 23:59:59 have flushed.
  const nextMidnight = now.add(1, "day").startOf("day").add(5, "second");
  const delayMs = Math.max(5000, nextMidnight.diff(now));

  setTimeout(async () => {
    const yesterdayStr = dayjs()
      .tz(DEVICE_TZ)
      .subtract(1, "day")
      .format("YYYY-MM-DD");
    try {
      await computeDailySummary(yesterdayStr);
      console.log(`🕛 Daily summary generated for ${yesterdayStr}.`);
    } catch (err) {
      console.error(
        `❌ Failed to generate midnight summary for ${yesterdayStr}:`,
        err.message,
      );
    }
    scheduleNextMidnightCapture();
  }, delayMs);
}

async function startDailySummaryScheduler() {
  try {
    await ensureDailySummaryTable();
    const yesterdayStr = dayjs()
      .tz(DEVICE_TZ)
      .subtract(1, "day")
      .format("YYYY-MM-DD");
    const existing = await getStoredSnapshot(yesterdayStr);
    if (!existing) {
      await computeDailySummary(yesterdayStr);
      console.log(`🕛 Backfilled daily summary snapshot for ${yesterdayStr}.`);
    }
  } catch (err) {
    console.error("❌ Daily summary initialization failed:", err.message);
  }
  scheduleNextMidnightCapture();
}

async function backfillMissingSnapshotsInWindow(
  windowStart,
  windowEnd,
  existingDatesSet,
  { cancelOnCloseRes } = {},
) {
  const oldestRetained = dayjs()
    .tz(DEVICE_TZ)
    .subtract(HISTORY_RETENTION_DAYS, "day")
    .startOf("day");
  const todayStart = dayjs().tz(DEVICE_TZ).startOf("day");

  const scanStart = windowStart.isAfter(oldestRetained)
    ? windowStart
    : oldestRetained;
  const scanEnd = windowEnd.isBefore(todayStart) ? windowEnd : todayStart;

  if (!scanStart.isBefore(scanEnd)) return;

  const { rows } = await withTransaction(
    apiPool,
    (client) =>
      client.query(
        `SELECT DISTINCT (received_at AT TIME ZONE $3)::date::text AS date_str
         FROM device_delay_history
         WHERE received_at >= $1 AND received_at < $2
         ORDER BY date_str ASC`,
        [scanStart.toDate(), scanEnd.toDate(), DEVICE_TZ],
      ),
    { statementTimeoutMs: SUMMARY_TIMEOUT_MS, cancelOnCloseRes },
  );

  for (const row of rows) {
    if (!existingDatesSet.has(row.date_str)) {
      await computeDailySummary(row.date_str, { cancelOnCloseRes });
      existingDatesSet.add(row.date_str);
    }
  }
}

async function getMonthlySummary(monthStr, { cancelOnCloseRes } = {}) {
  const monthStart = dayjs.tz(`${monthStr}-01 00:00:00`, DEVICE_TZ);
  if (!monthStart.isValid()) {
    const err = new Error("Invalid month format; expected YYYY-MM.");
    err.status = 400;
    throw err;
  }
  const now = dayjs().tz(DEVICE_TZ);
  if (monthStart.isAfter(now.startOf("month"))) {
    const err = new Error("Month cannot be in the future.");
    err.status = 400;
    throw err;
  }

  const monthEnd = monthStart.add(1, "month");
  const daysInMonth = monthStart.daysInMonth();

  const initialRes = await apiPool.query(
    `SELECT summary_date::text AS date_str
     FROM daily_summary_snapshots
     WHERE summary_date >= $1 AND summary_date < $2`,
    [monthStart.format("YYYY-MM-DD"), monthEnd.format("YYYY-MM-DD")],
  );
  const existingDates = new Set(initialRes.rows.map((r) => r.date_str));

  await backfillMissingSnapshotsInWindow(monthStart, monthEnd, existingDates, {
    cancelOnCloseRes,
  });

  const { rows } = await apiPool.query(
    `SELECT summary_date::text AS date_str, data
     FROM daily_summary_snapshots
     WHERE summary_date >= $1 AND summary_date < $2
     ORDER BY summary_date ASC`,
    [monthStart.format("YYYY-MM-DD"), monthEnd.format("YYYY-MM-DD")],
  );

  const snapshotByDate = new Map(rows.map((r) => [r.date_str, r.data]));
  const capturedDays = rows.length;

  const days = [];
  let sumOffline = 0;
  let sumDelayOver5s = 0;
  let totalRecords = 0;
  let peakOffline = { count: 0, date: null };
  let peakDelayOver5s = { count: 0, date: null };

  const offlineMap = new Map();
  const delayMap = new Map();

  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = String(d).padStart(2, "0");
    const dateStr = `${monthStr}-${dayStr}`;
    const snap = snapshotByDate.get(dateStr);

    if (!snap) {
      days.push({
        date: dateStr,
        dayLabel: dayStr,
        captured: false,
        online: 0,
        warning: 0,
        offline: 0,
        delay0to5s: 0,
        delay5sto1m: 0,
        delayOver1m: 0,
        delayOver5s: 0,
        records: 0,
      });
      continue;
    }

    const online = Number(snap.totals?.onlineDevices || 0);
    const warning = Number(snap.totals?.warningDevices || 0);
    const offline = Number(snap.totals?.offlineDevices || 0);
    const records = Number(snap.totals?.records || 0);

    let delay0to5s = 0;
    let delay5sto1m = 0;
    let delayOver1m = 0;

    for (const dev of snap.devices || []) {
      const avg = Math.abs(Number(dev.avgDelay) || 0);
      if (avg < 5000) delay0to5s++;
      else if (avg < 60000) delay5sto1m++;
      else delayOver1m++;

      const cur = delayMap.get(dev.deviceId);
      const cnt = Number(dev.count) || 0;
      const minD = Number(dev.minDelay) || 0;
      const maxD = Number(dev.maxDelay) || 0;
      const avgD = Number(dev.avgDelay) || 0;
      const isOver5s = avg >= 5000 ? 1 : 0;

      if (!cur) {
        delayMap.set(dev.deviceId, {
          deviceId: dev.deviceId,
          deviceName: dev.deviceName || null,
          activeDays: 1,
          daysOver5s: isOver5s,
          count: cnt,
          minDelay: minD,
          maxDelay: maxD,
          weightedDelaySum: avgD * cnt,
        });
      } else {
        cur.activeDays++;
        cur.daysOver5s += isOver5s;
        cur.count += cnt;
        if (minD < cur.minDelay) cur.minDelay = minD;
        if (maxD > cur.maxDelay) cur.maxDelay = maxD;
        cur.weightedDelaySum += avgD * cnt;
        if (dev.deviceName) cur.deviceName = dev.deviceName;
      }
    }

    for (const off of snap.offlineDevices || []) {
      const cur = offlineMap.get(off.deviceId);
      const ageMs = Number(off.ageMs) || 0;
      if (!cur) {
        offlineMap.set(off.deviceId, {
          deviceId: off.deviceId,
          deviceName: off.deviceName || null,
          daysOffline: 1,
          firstOfflineDate: dateStr,
          lastOfflineDate: dateStr,
          maxAgeMs: ageMs,
          lastReceived: off.lastReceived,
        });
      } else {
        cur.daysOffline++;
        cur.lastOfflineDate = dateStr;
        if (ageMs > cur.maxAgeMs) cur.maxAgeMs = ageMs;
        if (off.lastReceived > cur.lastReceived) {
          cur.lastReceived = off.lastReceived;
        }
        if (off.deviceName) cur.deviceName = off.deviceName;
      }
    }

    const delayOver5s = delay5sto1m + delayOver1m;
    sumOffline += offline;
    sumDelayOver5s += delayOver5s;
    totalRecords += records;

    if (peakOffline.date === null || offline > peakOffline.count) {
      peakOffline = { count: offline, date: dateStr };
    }
    if (peakDelayOver5s.date === null || delayOver5s > peakDelayOver5s.count) {
      peakDelayOver5s = { count: delayOver5s, date: dateStr };
    }

    days.push({
      date: dateStr,
      dayLabel: dayStr,
      captured: true,
      online,
      warning,
      offline,
      delay0to5s,
      delay5sto1m,
      delayOver1m,
      delayOver5s,
      records,
    });
  }

  const offlineDevices = [...offlineMap.values()].sort(
    (a, b) => b.daysOffline - a.daysOffline || b.maxAgeMs - a.maxAgeMs,
  );

  const delayDevices = [...delayMap.values()]
    .map((d) => ({
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      activeDays: d.activeDays,
      daysOver5s: d.daysOver5s,
      count: d.count,
      minDelay: d.minDelay,
      maxDelay: d.maxDelay,
      avgDelay: d.count > 0 ? Math.round(d.weightedDelaySum / d.count) : 0,
    }))
    .sort((a, b) => b.avgDelay - a.avgDelay || b.maxDelay - a.maxDelay);

  const chronicThreshold = Math.min(3, Math.max(1, capturedDays));
  const chronicOfflineCount = offlineDevices.filter(
    (d) => d.daysOffline >= chronicThreshold,
  ).length;

  return {
    month: monthStr,
    totals: {
      daysInMonth,
      capturedDays,
      avgDailyOffline:
        capturedDays > 0 ? Math.round(sumOffline / capturedDays) : 0,
      peakOffline,
      avgDailyDelayOver5s:
        capturedDays > 0 ? Math.round(sumDelayOver5s / capturedDays) : 0,
      peakDelayOver5s,
      chronicOfflineCount,
      chronicThreshold,
      uniqueOfflineDevices: offlineDevices.length,
      totalRecords,
      avgDailyRecords:
        capturedDays > 0 ? Math.round(totalRecords / capturedDays) : 0,
    },
    days,
    offlineDevices,
    delayDevices,
  };
}

module.exports = {
  getOrGenerateDailySummary,
  getMonthlySummary,
  startDailySummaryScheduler,
};
