/**
 * cleanup-glossary.js
 * Post-processes glossary_final.csv:
 *  - Preserves first 104 curated entries exactly
 *  - Filters garbled/wrong entries from Codex-added section
 *  - Fixes a small set of useful entries with wrong casing
 *  - Writes cleaned result back to glossary_final.csv
 */
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'glossary_final.csv');
const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(l => l.trim());

// Header + 104 curated entries = first 105 lines. Never touch these.
const CURATED_COUNT = 105;
const curated = lines.slice(0, CURATED_COUNT);
const rest    = lines.slice(CURATED_COUNT);

// ── Specific fixes: wrong casing on otherwise useful terms ────────────────────
const FIXES = new Map([
    // [ro, wrongEn] → fixedEn
    ['Babilonul|BABYLON',         'Babylon'],
    ['babilonul|BABYLON',         'Babylon'],
    ['lucrarea|MINISTRY',         'ministry'],
    ['invataturile|TEACHINGS',    'teachings'],
    ['botezat|named',             'baptized'],  // "botezat" = "baptized", not "named"
]);

function applyFix(ro, en) {
    const key = `${ro}|${en}`;
    return FIXES.get(key) || en;
}

// ── Drop rules ────────────────────────────────────────────────────────────────
const MONTHS = new Set([
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
]);

// Translations that are clearly wrong (specific ro→en pairs)
const WRONG_PAIRS = new Map([
    ['Regatul',    'United'],       // should be Kingdom
    ['regatul',    'United'],
    ['sugestii',   'Related'],      // means "suggestions"
    ['vieții',     'LEARNING'],     // means "of life"
    ['corpului',   'Corps'],        // means "of the body"
    ['loial',      'fair'],         // means "loyal"
    ['prima',      'received'],     // means "first/the first"
    ['motive',     'STATEMENT'],    // means "reasons"
    ['măsuri',     'are the measures'],
    ['Poți',       'You can'],      // trivial
    ['Cine',       'Who'],          // trivial
    ['Partea',     'part'],         // trivial
]);

// English translations so trivial Google always gets them right — no glossary value
const TRIVIAL_EN = new Set([
    'these','those','who','can','other','how','what','where','when','why',
    'bring','reach','show','allow','have','they','You can','Who','part',
    'we do','made','being','four','one','both','all','some','any','on',
    'than','from','between','because','also',
]);

function shouldDrop(ro, en) {
    // All-caps word of 3+ letters in English (Google's uncertainty marker)
    if (/\b[A-Z]{3,}\b/.test(en)) return true;

    // Mixed-case artifact (wEEKLY, pRINCIPLES, AspEcts)
    if (/[a-z][A-Z]/.test(en)) return true;

    // Romanian source has a hyphen (contracted particles: sa-si, intr-o, etc.)
    if (ro.includes('-')) return true;

    // English starts with non-letter (like '-Explore', "'s actions")
    if (/^[^a-zA-Z]/.test(en.trim())) return true;

    // Known wrong pairs
    if (WRONG_PAIRS.get(ro) === en) return true;

    // Month names
    if (MONTHS.has(en)) return true;

    // Trivial words Google handles perfectly
    if (TRIVIAL_EN.has(en.trim())) return true;

    return false;
}

// ── Process Codex-added entries ───────────────────────────────────────────────
let kept = 0, dropped = 0, fixed = 0;
const cleanedRest = [];
const existing = new Set(curated.slice(1).map(l => {
    const c = l.indexOf(','); return l.slice(0, c).trim().toLowerCase();
}));

for (const line of rest) {
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const ro = line.slice(0, comma).trim();
    let   en = line.slice(comma + 1).trim();
    if (!ro || !en) continue;

    // Skip if already covered by curated section
    if (existing.has(ro.toLowerCase())) { dropped++; continue; }

    // Apply fixes first (before drop check)
    const fixedEn = applyFix(ro, en);
    if (fixedEn !== en) { en = fixedEn; fixed++; }

    if (shouldDrop(ro, en)) {
        console.log(`  DROP: ${ro} → ${en}`);
        dropped++;
    } else {
        cleanedRest.push([ro, en]);
        existing.add(ro.toLowerCase());
        kept++;
    }
}

// ── Write output ──────────────────────────────────────────────────────────────
const allLines = [
    ...curated,
    ...cleanedRest.map(([r, e]) => `${r},${e}`)
];

fs.writeFileSync(FILE, allLines.join('\n') + '\n', 'utf8');

console.log(`\n── Cleanup complete ──`);
console.log(`Curated preserved: ${CURATED_COUNT - 1}`);
console.log(`Codex entries kept: ${kept}`);
console.log(`Entries fixed:      ${fixed}`);
console.log(`Entries dropped:    ${dropped}`);
console.log(`Total in file:      ${CURATED_COUNT - 1 + kept}`);
