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
const {
  DELAY_CATEGORIES,
  STALENESS_CATEGORIES,
  getCategory,
  getStalenessCategory,
} = require("../public/format");

const dailySnapshotCache = new Map();
const monthlySummaryCache = new Map();

function getHealthyDelayMaxMs() {
  return Number(DELAY_CATEGORIES[0]?.max) || 5000;
}

function getOfflineCategoryKey() {
  return STALENESS_CATEGORIES[STALENESS_CATEGORIES.length - 1]?.key || "OFFLINE";
}

function getOnlineCategoryKey() {
  return STALENESS_CATEGORIES[0]?.key || "ONLINE";
}

// Re-evaluate staleness and delay categories dynamically from stored raw ms values so threshold edits in format.js apply retroactively.
function hydrateSnapshotCategories(snap) {
  if (!snap) return null;

  const onlineKey = getOnlineCategoryKey();
  const offlineKey = getOfflineCategoryKey();
  const stalenessCounts = Object.fromEntries(
    STALENESS_CATEGORIES.map((c) => [c.key, 0]),
  );

  let offlineDevices = [];
  let registeredCount = Number(snap.totals?.registeredDevices || 0);

  if (Array.isArray(snap.stateDevices)) {
    registeredCount = snap.stateDevices.length;
    for (const d of snap.stateDevices) {
      const ageMs = Math.max(0, Number(d.ageMs) || 0);
      const cat = getStalenessCategory(ageMs);
      stalenessCounts[cat.key] = (stalenessCounts[cat.key] || 0) + 1;
      if (cat.key === offlineKey) {
        offlineDevices.push({
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          lastReceived: d.lastReceived,
          lastDtu: d.lastDtu,
          ageMs,
        });
      }
    }
    offlineDevices.sort((a, b) => b.ageMs - a.ageMs);
  } else {
    for (const c of snap.stalenessCategories || []) {
      if (c.category in stalenessCounts) {
        stalenessCounts[c.category] = Number(c.count) || 0;
      }
    }
    offlineDevices = (snap.offlineDevices || []).filter(
      (d) => getStalenessCategory(d.ageMs).key === offlineKey,
    );
  }

  const warningCount = STALENESS_CATEGORIES.filter(
    (c) => c.key !== onlineKey && c.key !== offlineKey,
  ).reduce((sum, c) => sum + (stalenessCounts[c.key] || 0), 0);

  const stalenessCategories = STALENESS_CATEGORIES.map((c) => ({
    category: c.key,
    count: stalenessCounts[c.key] || 0,
  }));

  const delayCounts = Object.fromEntries(
    DELAY_CATEGORIES.map((c) => [c.key, 0]),
  );
  for (const dev of snap.devices || []) {
    const cat = getCategory(dev.avgDelay);
    delayCounts[cat.key] = (delayCounts[cat.key] || 0) + 1;
  }
  const delayCategories = DELAY_CATEGORIES.map((c) => ({
    category: c.key,
    count: delayCounts[c.key] || 0,
  }));

  return {
    ...snap,
    totals: {
      ...snap.totals,
      registeredDevices: registeredCount,
      onlineDevices: stalenessCounts[onlineKey] || 0,
      warningDevices: warningCount,
      offlineDevices: stalenessCounts[offlineKey] || 0,
    },
    stalenessCategories,
    delayCategories,
    offlineDevices,
  };
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

function canRecomputeDate(dateStr) {
  const start = dayjs.tz(`${dateStr} 00:00:00`, DEVICE_TZ);
  const oldestRetained = dayjs()
    .tz(DEVICE_TZ)
    .subtract(HISTORY_RETENTION_DAYS, "day")
    .startOf("day");
  return !start.isBefore(oldestRetained);
}

async function getStoredSnapshot(dateStr) {
  if (dailySnapshotCache.has(dateStr)) {
    return dailySnapshotCache.get(dateStr);
  }
  const { rows } = await apiPool.query(
    "SELECT data FROM daily_summary_snapshots WHERE summary_date = $1",
    [dateStr],
  );
  const raw = rows[0]?.data || null;
  if (!raw) return null;
  if (!Array.isArray(raw.stateDevices) && canRecomputeDate(dateStr)) {
    return null;
  }
  const hydrated = hydrateSnapshotCategories(raw);
  dailySnapshotCache.set(dateStr, hydrated);
  return hydrated;
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
  dailySnapshotCache.set(dateStr, data);
  monthlySummaryCache.delete(dateStr.slice(0, 7));
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
      // Join a single grouped subquery instead of running a correlated subquery per device row.
      const latestRes = await client.query(
        `WITH prior_history AS (
           SELECT device_id, MAX(received_at) AS max_received
           FROM device_delay_history
           WHERE received_at <= $1
           GROUP BY device_id
         )
         SELECT DISTINCT ON (COALESCE(dl.device_name, dl.device_id))
                dl.device_id,
                dl.device_name,
                dl.last_dtu,
                CASE
                  WHEN dl.last_received <= $1 THEN dl.last_received
                  ELSE COALESCE(ph.max_received, dl.last_received)
                END AS last_received_at_capture
         FROM device_latest_state dl
         LEFT JOIN prior_history ph ON ph.device_id = dl.device_id
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

  const stateDevices = stateRows.map((row) => {
    const lastReceivedMs = new Date(row.last_received_at_capture).getTime();
    return {
      deviceId: row.device_id,
      deviceName: row.device_name,
      lastReceived: row.last_received_at_capture,
      lastDtu: row.last_dtu,
      ageMs: Math.max(0, captureEpoch - lastReceivedMs),
    };
  });

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

  const registeredCount = stateDevices.length;
  const rawData = {
    date: dateStr,
    capturedAt: captureTime.toISOString(),
    isCompletedDay,
    range: { from: start.toISOString(), to: end.toISOString() },
    totals: {
      registeredDevices: registeredCount,
      sentData: aggRows.length,
      noData: Math.max(registeredCount - aggRows.length, 0),
      excludedZero: aggRows.length - devices.length,
      shown: devices.length,
      records: aggRows.reduce((sum, d) => sum + d.cnt, 0),
    },
    stateDevices,
    devices,
  };

  const hydrated = hydrateSnapshotCategories(rawData);

  if (isCompletedDay) {
    await saveSnapshot(dateStr, captureTime.toDate(), hydrated);
  }

  return hydrated;
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
    return hydrateSnapshotCategories(liveTodayCache.data);
  }

  if (!canRecomputeDate(dateStr)) {
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

async function backfillRecentCompletedDays() {
  const todayStart = dayjs().tz(DEVICE_TZ).startOf("day");
  const oldestRetained = todayStart.subtract(HISTORY_RETENTION_DAYS, "day");

  const { rows } = await apiPool.query(
    `SELECT summary_date::text AS date_str,
            jsonb_typeof(data->'stateDevices') = 'array' AS has_state_devices
     FROM daily_summary_snapshots
     WHERE summary_date >= $1 AND summary_date < $2`,
    [oldestRetained.format("YYYY-MM-DD"), todayStart.format("YYYY-MM-DD")],
  );
  const validExisting = new Set(
    rows.filter((r) => r.has_state_devices).map((r) => r.date_str),
  );

  for (let i = 1; i <= HISTORY_RETENTION_DAYS; i++) {
    const dayStart = todayStart.subtract(i, "day");
    const dateStr = dayStart.format("YYYY-MM-DD");
    if (validExisting.has(dateStr)) continue;

    const dayEnd = dayStart.add(1, "day");
    // Use LIMIT 1 index probe per day instead of a full SELECT DISTINCT scan across millions of rows.
    const { rows: probe } = await apiPool.query(
      `SELECT 1 FROM device_delay_history
       WHERE received_at >= $1 AND received_at < $2
       LIMIT 1`,
      [dayStart.toDate(), dayEnd.toDate()],
    );
    if (probe.length > 0 || i === 1) {
      await computeDailySummary(dateStr);
      console.log(`🕛 Backfilled daily summary snapshot for ${dateStr}.`);
    }
  }
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
      await getMonthlySummary(yesterdayStr.slice(0, 7));
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
  scheduleNextMidnightCapture();
  // Run backfill and monthly cache warm-up asynchronously so server startup and HTTP requests are never blocked.
  (async () => {
    try {
      await ensureDailySummaryTable();
      await backfillRecentCompletedDays();
      const defaultMonth = dayjs()
        .tz(DEVICE_TZ)
        .subtract(1, "day")
        .format("YYYY-MM");
      await getMonthlySummary(defaultMonth);
    } catch (err) {
      console.error("❌ Daily summary initialization failed:", err.message);
    }
  })();
}

async function getMonthlySummary(monthStr) {
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

  if (monthlySummaryCache.has(monthStr)) {
    return monthlySummaryCache.get(monthStr);
  }

  const monthEnd = monthStart.add(1, "month");
  const daysInMonth = monthStart.daysInMonth();

  const { rows } = await apiPool.query(
    `SELECT summary_date::text AS date_str, data
     FROM daily_summary_snapshots
     WHERE summary_date >= $1 AND summary_date < $2
     ORDER BY summary_date ASC`,
    [monthStart.format("YYYY-MM-DD"), monthEnd.format("YYYY-MM-DD")],
  );

  const snapshotByDate = new Map(
    rows.map((r) => [r.date_str, hydrateSnapshotCategories(r.data)]),
  );
  const capturedDays = rows.length;
  const healthyDelayKey = DELAY_CATEGORIES[0]?.key || "0-5s";
  const healthyDelayMaxMs = getHealthyDelayMaxMs();

  const days = [];
  let sumOffline = 0;
  let sumDelayed = 0;
  let totalRecords = 0;
  let peakOffline = { count: 0, date: null };
  let peakDelayOver5s = { count: 0, date: null };

  const offlineMap = new Map();
  const delayMap = new Map();

  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = String(d).padStart(2, "0");
    const dateStr = `${monthStr}-${dayStr}`;
    const snap = snapshotByDate.get(dateStr);

    const emptyStalenessByCat = Object.fromEntries(
      STALENESS_CATEGORIES.map((c) => [c.key, 0]),
    );
    const emptyDelayByCat = Object.fromEntries(
      DELAY_CATEGORIES.map((c) => [c.key, 0]),
    );

    if (!snap) {
      days.push({
        date: dateStr,
        dayLabel: dayStr,
        captured: false,
        stalenessByCat: emptyStalenessByCat,
        delayByCat: emptyDelayByCat,
        online: 0,
        warning: 0,
        offline: 0,
        delayOver5s: 0,
        records: 0,
      });
      continue;
    }

    const stalenessByCat = { ...emptyStalenessByCat };
    for (const c of snap.stalenessCategories || []) {
      stalenessByCat[c.category] = Number(c.count) || 0;
    }

    const delayByCat = { ...emptyDelayByCat };
    for (const c of snap.delayCategories || []) {
      delayByCat[c.category] = Number(c.count) || 0;
    }

    const online = Number(snap.totals?.onlineDevices || 0);
    const warning = Number(snap.totals?.warningDevices || 0);
    const offline = Number(snap.totals?.offlineDevices || 0);
    const records = Number(snap.totals?.records || 0);

    for (const dev of snap.devices || []) {
      const avg = Math.abs(Number(dev.avgDelay) || 0);
      const isDelayed = avg >= healthyDelayMaxMs ? 1 : 0;

      const cur = delayMap.get(dev.deviceId);
      const cnt = Number(dev.count) || 0;
      const minD = Number(dev.minDelay) || 0;
      const maxD = Number(dev.maxDelay) || 0;
      const avgD = Number(dev.avgDelay) || 0;

      if (!cur) {
        delayMap.set(dev.deviceId, {
          deviceId: dev.deviceId,
          deviceName: dev.deviceName || null,
          activeDays: 1,
          daysOver5s: isDelayed,
          count: cnt,
          minDelay: minD,
          maxDelay: maxD,
          weightedDelaySum: avgD * cnt,
        });
      } else {
        cur.activeDays++;
        cur.daysOver5s += isDelayed;
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

    const delayOver5s = DELAY_CATEGORIES.filter(
      (c) => c.key !== healthyDelayKey,
    ).reduce((sum, c) => sum + (delayByCat[c.key] || 0), 0);

    sumOffline += offline;
    sumDelayed += delayOver5s;
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
      stalenessByCat,
      delayByCat,
      online,
      warning,
      offline,
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

  const result = {
    month: monthStr,
    totals: {
      daysInMonth,
      capturedDays,
      avgDailyOffline:
        capturedDays > 0 ? Math.round(sumOffline / capturedDays) : 0,
      peakOffline,
      avgDailyDelayOver5s:
        capturedDays > 0 ? Math.round(sumDelayed / capturedDays) : 0,
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

  monthlySummaryCache.set(monthStr, result);
  return result;
}

module.exports = {
  getOrGenerateDailySummary,
  getMonthlySummary,
  startDailySummaryScheduler,
};
