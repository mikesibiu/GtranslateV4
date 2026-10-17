/**
 * Decides when the translation_log -> translation_log_archive job may touch the DB.
 * Querying Neon every 5 min around the clock keeps its compute awake (5-min auto-suspend)
 * and burned the whole monthly CPU quota, so the job only runs inside meeting windows.
 *
 * Regular windows are the Thu/Sun meetings (Europe/Bucharest). Extra one-off meetings are
 * listed in capture-windows.json as { "start": ISO-8601 with offset, "end": ISO-8601 }.
 */

const fs = require('fs');
const path = require('path');

const TIMEZONE = 'Europe/Bucharest';
const GRACE_MS = 10 * 60 * 1000; // keep archiving briefly after the end so the tail is captured
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000; // a longer entry is almost certainly a typo
const HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})$/; // without one, Date.parse would use the server's UTC

// day: 0 = Sunday ... 6 = Saturday; times are Bucharest wall-clock minutes since midnight.
// Windows must end before midnight: the grace check below looks up the weekday of "now - grace".
const REGULAR_WINDOWS = [
    { day: 0, startMin: 12 * 60 + 30, endMin: 16 * 60 },  // Sun 12:30-16:00
    { day: 4, startMin: 19 * 60, endMin: 22 * 60 },       // Thu 19:00-22:00
];

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const clockFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
});

function bucharestClock(date) {
    const parts = {};
    for (const { type, value } of clockFormat.formatToParts(date)) parts[type] = value;
    return {
        day: WEEKDAYS[parts.weekday],
        minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };
}

/**
 * @param {string} [filePath] - JSON file holding the extra windows
 * @param {object} [logger] - optional, used to report a malformed file
 * @returns {Array<{start: number, end: number}>} epoch-ms windows; invalid entries are dropped
 */
function loadExtraWindows(filePath = path.join(__dirname, 'capture-windows.json'), logger) {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') logger?.error(`[archive] Cannot read ${filePath}: ${err.message}`);
        return [];
    }
    if (!Array.isArray(raw)) {
        logger?.error(`[archive] ${filePath} must contain an array`);
        return [];
    }
    const windows = [];
    for (const entry of raw) {
        const valid = typeof entry?.start === 'string' && typeof entry?.end === 'string'
            && HAS_OFFSET.test(entry.start) && HAS_OFFSET.test(entry.end);
        const start = valid ? Date.parse(entry.start) : NaN;
        const end = valid ? Date.parse(entry.end) : NaN;
        if (Number.isNaN(start) || Number.isNaN(end) || end <= start || end - start > MAX_WINDOW_MS) {
            logger?.error(`[archive] Ignoring invalid capture window: ${JSON.stringify(entry)}`);
            continue;
        }
        windows.push({ start, end });
    }
    return windows;
}

/**
 * @param {Date} now
 * @param {Array<{start: number, end: number}>} extraWindows - from loadExtraWindows()
 */
function isInCaptureWindow(now, extraWindows = []) {
    const t = now.getTime();
    // Compare at minute granularity, like the regular windows, so a cron tick a few ms past
    // the boundary still counts as the final grace tick
    const tMinute = Math.floor(t / 60000) * 60000;
    if (extraWindows.some(w => t >= w.start && tMinute <= w.end + GRACE_MS)) return true;

    // Check "now" and "now minus grace" so a regular window's tail is also covered
    return [now, new Date(t - GRACE_MS)].some(d => {
        const { day, minutes } = bucharestClock(d);
        return REGULAR_WINDOWS.some(w => w.day === day && minutes >= w.startMin && minutes <= w.endMin);
    });
}

module.exports = { loadExtraWindows, isInCaptureWindow, REGULAR_WINDOWS, GRACE_MS };
