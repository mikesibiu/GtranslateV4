/**
 * merge-glossaries.js
 *
 * Merges glossary_clean.csv (curated JW terms) with filtered entries from
 * glossary_from_docs.csv (PDF-extracted, needs heavy cleaning).
 *
 * Filtering rules for docs entries:
 *  1. No hyphens (PDF split artifacts)
 *  2. No mid-word uppercase (concatenation like aIsus, aBibliaeste)
 *  3. No double-vowel prefix (article concatenation: aacolo, aaerului)
 *  4. Source length ≤ 13 chars for single words (longer = likely concatenated)
 *  5. No concatenated English target (no-space target with length > 12)
 *  6. No all-caps target (Google's "uncertain" output marker)
 *  7. Source must be ≥ 4 chars
 *  8. Target must not equal source (untranslated)
 *  9. No digits in source
 * 10. Target must not contain comma (multi-word confusion like "Video,")
 *
 * Output: glossaries/glossary_final.csv
 */

const fs   = require('fs');
const path = require('path');

const CLEAN_CSV = path.join(__dirname, 'glossaries', 'glossary_clean.csv');
const DOCS_CSV  = path.join(__dirname, 'glossaries', 'glossary_from_docs.csv');
const OUTPUT    = path.join(__dirname, 'glossaries', 'glossary_final.csv');

// ── Load clean glossary (already curated) ─────────────────────────────────────
function loadCSV(file) {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const rows = [];
    for (const line of lines.slice(1)) {
        const comma = line.indexOf(',');
        if (comma < 0) continue;
        const ro = line.slice(0, comma).trim();
        const en = line.slice(comma + 1).trim();
        if (ro && en) rows.push([ro, en]);
    }
    return rows;
}

// ── Filter for docs-CSV entries ────────────────────────────────────────────────
function isGoodDocsEntry(ro, en) {
    const enLow = en.toLowerCase().trim();
    const roLow = ro.toLowerCase().trim();

    // Must have meaningful length
    if (ro.length < 4) return false;

    // No hyphens (PDF split artifact)
    if (ro.includes('-')) return false;

    // No digits
    if (/\d/.test(ro)) return false;

    // No mid-word uppercase (concatenation like aIsus, aBibliaeste)
    if (/[a-z][A-Z]/.test(ro)) return false;

    // No double-vowel at start (article concat: aacolo → a+acolo, aaerului → a+aerului)
    if (/^[aeiouăâî]{2}/i.test(ro)) return false;

    // Single-word source must be ≤ 13 chars
    if (!ro.includes(' ') && ro.length > 13) return false;

    // No concatenated English target (no space, long)
    if (!en.includes(' ') && en.length > 12) return false;

    // No all-caps target (uncertainty marker, e.g. TIMES, YOUNG, BRING)
    if (/^[A-Z][A-Z]+s?$/.test(en.trim())) return false;

    // Target must not equal source (normalized)
    if (roLow.replace(/[^a-z]/g,'') === enLow.replace(/[^a-z]/g,'')) return false;

    // Target must not contain comma (malformed like "Video,")
    if (en.includes(',')) return false;

    // Target must not contain Romanian diacritics (untranslated)
    if (/[ăâîșțĂÂÎȘȚşţ]/.test(en)) return false;

    return true;
}

// ── Main ───────────────────────────────────────────────────────────────────────
const cleanRows = loadCSV(CLEAN_CSV);
console.log(`Loaded ${cleanRows.length} entries from glossary_clean.csv`);

// Build lookup set from clean glossary (lowercase source key)
const existing = new Map(cleanRows.map(([ro, en]) => [ro.toLowerCase(), en]));

const docsRows  = loadCSV(DOCS_CSV);
let docsKept = 0, docsDropped = 0;
const newEntries = [];

for (const [ro, en] of docsRows) {
    if (existing.has(ro.toLowerCase())) { docsDropped++; continue; }
    if (!isGoodDocsEntry(ro, en)) { docsDropped++; continue; }
    newEntries.push([ro, en]);
    existing.set(ro.toLowerCase(), en);
    docsKept++;
}

console.log(`Docs: kept ${docsKept} new entries, dropped ${docsDropped}`);

// Combine clean + new, sort multi-word first then alphabetical
const allRows = [...cleanRows, ...newEntries];
allRows.sort((a, b) => {
    const aw = a[0].split(' ').length, bw = b[0].split(' ').length;
    if (bw !== aw) return bw - aw;
    return a[0].localeCompare(b[0]);
});

const csv = ['ro,en', ...allRows.map(([ro, en]) => `${ro},${en}`)].join('\n') + '\n';
fs.writeFileSync(OUTPUT, csv, 'utf8');

console.log(`\n✅ Final glossary written to ${OUTPUT}`);
console.log(`   Total entries: ${allRows.length}`);
console.log('\nSample new entries added from docs:');
newEntries.slice(0, 20).forEach(([ro, en]) => console.log(`  ${ro} → ${en}`));
