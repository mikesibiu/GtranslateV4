#!/usr/bin/env node
/**
 * capture-meeting-logs.js
 * Queries the Neon translation_log table and saves a CSV snapshot to meeting-logs/.
 *
 * Scheduled via macOS crontab (machine timezone: EEST = UTC+3):
 *   Sun 13:50 EEST  → 50 13 * * 0
 *   Sun 14:40 EEST  → 40 14 * * 0
 *   Thu 19:50 EEST  → 50 19 * * 4
 *   Thu 20:45 EEST  → 45 20 * * 4
 *
 * Usage: node scripts/capture-meeting-logs.js [--lookback-hours N]
 *   Default lookback: 3 hours (covers a full 2-hour meeting + buffer)
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// Load DATABASE_URL from scripts/.env.local — does NOT override variables
// already set in the environment (env wins over .env.local)
const envFile = path.join(__dirname, '.env.local');
if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n');
    for (const line of lines) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set. Add it to scripts/.env.local');
    process.exit(1);
}

// Parse --lookback-hours from argv with strict validation
let lookbackHours = 3;
const lbArg = process.argv.indexOf('--lookback-hours');
if (lbArg !== -1 && process.argv[lbArg + 1]) {
    lookbackHours = parseFloat(process.argv[lbArg + 1]);
    if (!Number.isFinite(lookbackHours) || lookbackHours <= 0 || lookbackHours > 72) {
        console.error('ERROR: --lookback-hours must be a number between 0 and 72');
        process.exit(1);
    }
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    max: 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 15000,
});

async function run() {
    let client;
    try {
        client = await pool.connect();

        const rows = await client.query(
            `SELECT id, created_at, translation_reason, source_text, translated_text, session_id
             FROM translation_log
             WHERE created_at >= NOW() - ($1::numeric * interval '1 hour')
             ORDER BY created_at ASC`,
            [lookbackHours]
        );

        if (rows.rowCount === 0) {
            console.log('No rows found in the last', lookbackHours, 'hours. Nothing saved.');
            return;
        }

        // Build filename entirely in UTC: YYYY-MM-DD-HHmm-<dayname>-snapshot<N>.csv
        const now     = new Date();
        const iso     = now.toISOString();                           // e.g. 2026-04-06T13:50:00.000Z
        const dateStr = iso.slice(0, 10);                            // 2026-04-06
        const timeStr = iso.slice(11, 16).replace(':', '');          // 1350
        const days    = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
        const dayName = days[now.getUTCDay()];
        const outDir  = path.join(__dirname, '..', 'meeting-logs');

        // Ensure output directory exists
        fs.mkdirSync(outDir, { recursive: true });

        // Find next available snapshot index
        let n = 1;
        let outPath;
        do {
            outPath = path.join(outDir, `${dateStr}-${timeStr}-${dayName}-snapshot${n}.csv`);
            n++;
        } while (fs.existsSync(outPath));

        // Write CSV
        const header = 'id,time_utc,reason,session_id,source_romanian,translated_english\n';
        const csvRows = rows.rows.map(r => {
            const fields = [
                escapeCsv(String(r.id)),
                r.created_at ? r.created_at.toISOString() : '',
                escapeCsv(r.translation_reason || ''),
                escapeCsv(r.session_id || ''),
                escapeCsv(r.source_text || ''),
                escapeCsv(r.translated_text || ''),
            ];
            return fields.join(',');
        });

        fs.writeFileSync(outPath, header + csvRows.join('\n') + '\n', 'utf8');
        console.log(`Saved ${rows.rowCount} rows → ${outPath}`);

    } finally {
        if (client) client.release();
        await pool.end();
    }
}

function escapeCsv(val) {
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

run().catch(err => {
    console.error('capture-meeting-logs error:', err);
    process.exit(1);
});
