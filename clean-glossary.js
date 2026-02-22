/**
 * clean-glossary.js — Post-process glossary_fixed.csv to remove still-garbled entries
 * and add proper JW domain terms that are missing from the original.
 *
 * Garbled indicators:
 *  - Translation contains an underscore (e.g. love_afa, samuel_samuel)
 *  - Translation has no spaces AND looks like a non-English word (CamelCase proper noun
 *    with ≥10 chars that exactly echoes the source structure)
 *  - Translation is an all-caps acronym-style output for a short source (e.g. NS, ATs, ACAT)
 *  - Translation still contains Romanian diacritics
 *  - Translation is suspiciously close to the source (levenshtein distance ≤ 2 on short words)
 *  - Translation is a known garbage output pattern
 */

const fs   = require('fs');
const path = require('path');

const INPUT  = path.join(__dirname, 'glossaries', 'glossary_fixed.csv');
const OUTPUT = path.join(__dirname, 'glossaries', 'glossary_clean.csv');

// ── Patterns that indicate a garbled translation ────────────────────────────────
const ROMANIAN_DIACRITICS = /[ăâîșțĂÂÎȘȚşţ]/;

// Known garbage outputs that slipped through the first pass
const KNOWN_GARBAGE_EN = new Set([
    'ator', 'atorit', 'atorul', 'atorii',
    'ation', 'ation', 'tions', 'ations',
    'ating', 'ting', 'ting',
    'ns', 'ats', 'acat', 'aest', 'antula',
    'aier', 'asit', 'cesima', 'azboai',
    'stine', 'eldora', 'seascale', 'siva',
    'anthill', 'sissus', 'andal', 'arils', 'blies',
    'stipiehova', 'aneinfluenza', 'tuceaisanswer',
    'stevesettes', 'thematerial', 'atorfor', 'actorfor',
    'bliese', 'andscientist', 'unitedstates',
    'depreaching', 'love_afa', 'samuel_samuel',
    'aquisus', 'acatele', 'aterougous', 'aterogus',
    'atorit', 'siplin', 'siply', 'cumanume',
    // Wrong translations of garbled Isus (Jesus) fragments
    'jesuits', 'jesuit',
]);

// Garbled source words to always drop regardless of translation
const GARBLED_SOURCES = new Set([
    'isusi',   // fragment of Isus → mistranslated as "Jesuits"
    'isusle',  // fragment of Isus → the real term is already in JW_TERMS
    'siisus',  // same
]);

function isGarbled(ro, en) {
    const enLow = en.toLowerCase().trim();
    const roLow = ro.toLowerCase().trim();

    // Explicitly garbled source words
    if (GARBLED_SOURCES.has(roLow)) return true;

    // Romanian diacritics remain in translation
    if (ROMANIAN_DIACRITICS.test(en)) return true;

    // Known garbage English outputs
    if (KNOWN_GARBAGE_EN.has(enLow)) return true;

    // Contains underscore → concatenated garbage (e.g. love_afa)
    if (en.includes('_')) return true;

    // All-caps, short, looks like an abbreviation/code (e.g. ACAT, AEST, ATs, NS)
    if (/^[A-Z]{2,5}s?$/.test(en.trim())) return true;

    // No spaces, ≥12 chars, and the translation contains a chunk of the source → concatenated garbage
    if (!en.includes(' ') && en.length >= 12 && enLow.includes(roLow.slice(0, 4))) return true;

    // NOTE: Levenshtein filter removed — it incorrectly drops valid transliterations
    // like iehova→Jehovah, organiza→organize, continu→continue, revela→reveal.

    return false;
}

// Simple Levenshtein distance
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({length: m + 1}, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
                : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
}

// ── Critical JW domain terms to add (always override if duplicate) ─────────────
// These are the terms that genuinely need to be in a JW glossary.
// Google Translate frequently mistranslates these in religious contexts.
const JW_TERMS = [
    // Core JW terminology
    ['congregație',          'congregation'],
    ['congregații',          'congregations'],
    ['congregației',         'congregation'],
    ['congregațiile',        'congregations'],
    ['congres',              'convention'],
    ['congrese',             'conventions'],
    ['congres special',      'special convention'],
    ['congrese speciale',    'special conventions'],
    ['congres regional',     'regional convention'],
    ['congres de circuit',   'circuit assembly'],
    ['vestitor',             'publisher'],
    ['vestitori',            'publishers'],
    ['Martorii lui Iehova',  "Jehovah's Witnesses"],
    ['Martorul lui Iehova',  "Jehovah's Witness"],
    ['Iehova',               'Jehovah'],
    ['Sala Regatului',       'Kingdom Hall'],
    ['Sala regatului',       'Kingdom Hall'],
    ['Betei',                'Bethel'],
    ['Betel',                'Bethel'],
    ['circuit',              'circuit'],
    ['supraveghetor de circuit', 'circuit overseer'],
    ['bătrân',               'elder'],
    ['bătrâni',              'elders'],
    ['slujitor de slujire',  'ministerial servant'],
    ['slujitori de slujire', 'ministerial servants'],
    ['botez',                'baptism'],
    ['boteza',               'to baptize'],
    ['predicare',            'preaching'],
    ['predicarea',           'the preaching'],
    ['predicat',             'preached'],
    ['predicator',           'preacher'],
    ['Biblia',               'the Bible'],
    ['biblic',               'biblical'],
    ['biblice',              'biblical'],
    ['Scripturile',          'the Scriptures'],
    ['scripturi',            'scriptures'],
    ['Psalmul',              'Psalm'],
    ['Ieremia',              'Jeremiah'],
    ['Isaia',                'Isaiah'],
    ['Ezechiel',             'Ezekiel'],
    ['Avraam',               'Abraham'],
    ['Iacov',                'Jacob'],
    ['Moise',                'Moses'],
    ['David',                'David'],
    ['Marcu',                'Mark'],
    ['Matei',                'Matthew'],
    ['Luca',                 'Luke'],
    ['Ioan',                 'John'],
    ['Romani',               'Romans'],
    ['Efeseni',              'Ephesians'],
    ['Filipeni',             'Philippians'],
    ['Coloseni',             'Colossians'],
    ['cei răi',              'the wicked'],
    ['cei drepți',           'the righteous'],
    ['cei buni',             'the good'],
    ['bunătate',             'kindness'],
    ['Cartea Bucuriei',      'The Book of Joy'],
    ['bucurie',              'joy'],
    ['speranță',             'hope'],
    ['credință',             'faith'],
    ['iubire',               'love'],
    ['înțelepciune',         'wisdom'],
    ['umilință',             'humility'],
    ['recunoștință',         'gratitude'],
    ['răscumpărare',         'ransom'],
    ['mântuire',             'salvation'],
    ['Împărăția lui Dumnezeu', "God's Kingdom"],
    ['Împărăția',            'Kingdom'],
    ['Dumnezeu',             'God'],
    ['Isus',                 'Jesus'],
    ['Cristos',              'Christ'],
    ['Isus Cristos',         'Jesus Christ'],
    ['Duhul Sfânt',          'holy spirit'],
    ['duh sfânt',            'holy spirit'],
    ['rugăciune',            'prayer'],
    ['a se ruga',            'to pray'],
    ['familie',              'family'],
    ['familie creștină',     'Christian family'],
    ['soție',                'wife'],
    ['soț',                  'husband'],
    ['copii',                'children'],
    ['fraților',             'brothers'],
    ['surorilor',            'sisters'],
    ['frați',                'brothers'],
    ['surori',               'sisters'],
    ['adunare',              'congregation'],
    ['asistență totală',     'total attendance'],
    ['nume nou',             'new name'],
    ['nume noi',             'new names'],
];

// ── Read and filter the translated CSV ────────────────────────────────────────
const lines  = fs.readFileSync(INPUT, 'utf8').trim().split('\n');
const header = lines[0];
let kept = 0, dropped = 0;

const rows = [];
for (const line of lines.slice(1)) {
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const ro = line.slice(0, comma).trim();
    const en = line.slice(comma + 1).trim();
    if (!ro || !en || en === 'ERROR') { dropped++; continue; }
    if (isGarbled(ro, en)) {
        console.log(`  ✂️  DROPPED: ${ro} → ${en}`);
        dropped++;
    } else {
        rows.push([ro, en]);
        kept++;
    }
}

// Add JW terms (avoid duplicates by key)
const existing = new Set(rows.map(r => r[0].toLowerCase()));
let added = 0;
for (const [ro, en] of JW_TERMS) {
    if (!existing.has(ro.toLowerCase())) {
        rows.push([ro, en]);
        added++;
    }
}

// Sort: multi-word phrases first (more specific), then alphabetically
rows.sort((a, b) => {
    const aWords = a[0].split(' ').length;
    const bWords = b[0].split(' ').length;
    if (bWords !== aWords) return bWords - aWords; // more words first
    return a[0].localeCompare(b[0]);
});

const output = [header, ...rows.map(r => `${r[0]},${r[1]}`)].join('\n') + '\n';
fs.writeFileSync(OUTPUT, output, 'utf8');

console.log(`\n── Clean glossary written to ${OUTPUT} ──`);
console.log(`Kept from API translations: ${kept}`);
console.log(`Dropped as garbled:          ${dropped}`);
console.log(`Added JW domain terms:       ${added}`);
console.log(`Total entries:               ${rows.length}`);
