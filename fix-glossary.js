/**
 * fix-glossary.js — Re-translate the Romanian → English glossary via Google Translate API.
 * Uses the GTranslate_API_KEY environment variable (Translation API v2 REST).
 *
 * Usage:  node fix-glossary.js
 * Output: glossaries/glossary_fixed.csv
 *
 * Rows where the API returns the same text as input (garbled / untranslatable)
 * are silently dropped, per user instruction.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const API_KEY = process.env.GTranslate_API_KEY;
if (!API_KEY) {
    console.error('GTranslate_API_KEY environment variable not set.');
    process.exit(1);
}

// ── Translate a batch of up to 20 terms via Translation API v2 REST ───────────
function translateBatch(terms) {
    return new Promise((resolve, reject) => {
        const qs   = terms.map(t => `q=${encodeURIComponent(t)}`).join('&');
        const body = `${qs}&source=ro&target=en&format=text`;
        const options = {
            hostname: 'translation.googleapis.com',
            path: `/language/translate/v2?key=${API_KEY}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) return reject(new Error(json.error.message));
                    resolve(json.data.translations.map(t => t.translatedText.trim()));
                } catch (e) {
                    reject(new Error(`Parse error: ${data.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Read the source CSV ────────────────────────────────────────────────────────
const INPUT  = path.join(__dirname, 'glossaries', 'glossary_2025-10-04T20-34-34.csv');
const OUTPUT = path.join(__dirname, 'glossaries', 'glossary_fixed.csv');

const lines = fs.readFileSync(INPUT, 'utf8').trim().split('\n');
const rows  = lines.slice(1).map(l => {
    const comma = l.indexOf(',');
    return l.slice(0, comma).trim();
}).filter(r => r.length > 0);

// ── Drop garbled entries: translation identical to source (API couldn't translate it) ──
function isGarbled(source, translated) {
    const n = s => s.toLowerCase().replace(/[^a-z]/g, '');
    return n(source) === n(translated);
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
    const BATCH  = 20;
    const fixed  = ['ro,en'];
    let kept = 0, dropped = 0;

    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        try {
            const translations = await translateBatch(batch);
            for (let j = 0; j < batch.length; j++) {
                const ro = batch[j];
                const en = translations[j];
                if (isGarbled(ro, en)) {
                    console.log(`  ✂️  DROPPED: ${ro} → ${en}`);
                    dropped++;
                } else {
                    console.log(`  ✓  ${ro} → ${en}`);
                    fixed.push(`${ro},${en}`);
                    kept++;
                }
            }
        } catch (err) {
            console.error(`  ✗  Batch failed: ${err.message}`);
            dropped += batch.length;
        }

        if (i + BATCH < rows.length) await new Promise(r => setTimeout(r, 200));
    }

    fs.writeFileSync(OUTPUT, fixed.join('\n') + '\n', 'utf8');
    console.log(`\n── Done ──`);
    console.log(`Kept: ${kept}   Dropped/garbled: ${dropped}`);
    console.log(`Output: ${OUTPUT}`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
