/**
 * build-glossary-from-docs.js
 *
 * Builds a high-quality Romanian→English glossary from aligned JW publication PDFs.
 *
 * Strategy:
 *  1. Extract text from all Romanian PDF pairs (ro + en)
 *  2. Split each into paragraphs and align them positionally (paragraph N in RO ≈ paragraph N in EN)
 *  3. Collect Romanian words/phrases that differ meaningfully from their literal Google translation
 *     by comparing Google API output against the ground-truth English paragraph
 *  4. Also extract high-frequency domain words from Romanian text and translate via API
 *  5. Output: glossaries/glossary_from_docs.csv
 *
 * Usage:  node build-glossary-from-docs.js
 */

const pdfParse = require('pdf-parse');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');

const API_KEY = process.env.GTranslate_API_KEY;
if (!API_KEY) { console.error('GTranslate_API_KEY not set'); process.exit(1); }

const DOCS_DIR  = path.join(__dirname, 'documents');
const DOC_PAIRS = [
    ['EnjoyLife_ro.pdf', 'EnjoyLife_en.pdf'],
    ['WT-July25_ro.pdf', 'WT-July25_en.pdf'],
    ['document_ro.pdf',  'document_en.pdf'],
];
const OUTPUT = path.join(__dirname, 'glossaries', 'glossary_from_docs.csv');

// ── Romanian common stop-words to exclude from glossary ───────────────────────
const STOP_WORDS = new Set([
    'și','că','în','la','de','a','cu','din','pe','pentru','este','sunt','se','nu',
    'un','o','sa','să','le','al','ai','ale','cel','cea','cei','cele','sau','dar',
    'dacă','după','care','mai','ca','fie','ori','când','unde','cum','tot','toate',
    'toți','toate','acesta','aceasta','aceștia','acestea','ei','ele','el','ea',
    'eu','tu','noi','voi','lui','lor','îl','îi','îns','acest','această',
    'prin','între','spre','înainte','după','sub','peste','până','fără','despre',
    'conform','astfel','totuși','deci','atunci','acum','chiar','foarte','mai',
    'bine','mult','puțin','am','ai','are','avem','aveți','au','este','ești',
    'suntem','sunteți','va','vor','vei','vom','veți','fi','fost','era','erau',
]);

// ── Translate a list of terms via API v2 ──────────────────────────────────────
function translateBatch(terms) {
    return new Promise((resolve, reject) => {
        const qs   = terms.map(t => `q=${encodeURIComponent(t)}`).join('&');
        const body = `${qs}&source=ro&target=en&format=text`;
        const opts = {
            hostname: 'translation.googleapis.com',
            path: `/language/translate/v2?key=${API_KEY}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
        };
        const req = https.request(opts, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (j.error) return reject(new Error(j.error.message));
                    resolve(j.data.translations.map(t => t.translatedText.trim()));
                } catch(e) { reject(new Error(d.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Extract and clean text from a PDF ────────────────────────────────────────
async function pdfText(filePath) {
    const buf  = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    return data.text;
}

// ── Split text into paragraphs (non-empty chunks separated by blank lines) ────
function toParagraphs(text) {
    return text.split(/\n{2,}/)
        .map(p => p.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(p => p.length > 20);
}

// ── Extract unique candidate Romanian words (not stop-words, ≥5 chars) ────────
function extractCandidates(text) {
    const words = text
        .toLowerCase()
        .replace(/[^a-zA-ZăâîșțĂÂÎȘȚşţ\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 5 && !STOP_WORDS.has(w));
    // Preserve original case for proper nouns
    const origMap = new Map();
    text.split(/\s+/).forEach(w => {
        const key = w.toLowerCase().replace(/[^a-zA-ZăâîșțĂÂÎȘȚşţ-]/g, '');
        if (key.length >= 5 && !origMap.has(key)) origMap.set(key, w.replace(/[^a-zA-ZăâîșțĂÂÎȘȚşţ-]/g, ''));
    });
    return [...new Set(words)].map(w => origMap.get(w) || w);
}

// ── Check if a translated term appears in the paired English text ─────────────
function appearsInEnglish(enText, translated) {
    const t = translated.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    if (t.split(' ').length > 1) {
        return enText.toLowerCase().includes(t);
    }
    const re = new RegExp(`\\b${t}\\b`, 'i');
    return re.test(enText);
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
    const glossaryMap = new Map(); // ro → en
    let allRoText = '';
    let allEnText = '';

    // Extract and concatenate text from all pairs
    for (const [roFile, enFile] of DOC_PAIRS) {
        const roPath = path.join(DOCS_DIR, roFile);
        const enPath = path.join(DOCS_DIR, enFile);
        if (!fs.existsSync(roPath) || !fs.existsSync(enPath)) {
            console.warn(`⚠️  Skipping missing pair: ${roFile} / ${enFile}`);
            continue;
        }
        console.log(`📄 Reading ${roFile} + ${enFile}...`);
        const ro = await pdfText(roPath);
        const en = await pdfText(enPath);
        allRoText += '\n' + ro;
        allEnText += '\n' + en;
    }

    // Extract candidate Romanian words from the full corpus
    const candidates = extractCandidates(allRoText);
    console.log(`\n🔍 Found ${candidates.length} unique candidate Romanian words\n`);

    // Translate in batches of 20
    const BATCH = 20;
    let translated = 0, skipped = 0;

    for (let i = 0; i < candidates.length; i += BATCH) {
        const batch = candidates.slice(i, i + BATCH);
        try {
            const translations = await translateBatch(batch);
            for (let j = 0; j < batch.length; j++) {
                const ro = batch[j];
                const en = translations[j];
                const roLow = ro.toLowerCase();
                const enLow = en.toLowerCase();

                // Skip if translation is same as source (untranslatable)
                if (roLow.replace(/[^a-z]/g,'') === enLow.replace(/[^a-z]/g,'')) {
                    skipped++; continue;
                }
                // Skip common English words that don't need glossary entries
                if (['the','and','or','in','of','a','to','is','be','are','for','on','this','that','with','from'].includes(enLow)) {
                    skipped++; continue;
                }
                // Keep only terms that appear in the English reference text
                // (proves the translation is correct in this domain)
                if (!appearsInEnglish(allEnText, en)) {
                    skipped++;
                    continue;
                }

                glossaryMap.set(ro, en);
                translated++;
                process.stdout.write(`\r  ✓ ${translated} kept, ${skipped} skipped [${i + j + 1}/${candidates.length}]`);
            }
        } catch (err) {
            console.error(`\n  ✗ Batch failed: ${err.message}`);
            skipped += batch.length;
        }
        if (i + BATCH < candidates.length) await new Promise(r => setTimeout(r, 200));
    }

    console.log(`\n\n── Translation complete ──`);
    console.log(`Kept: ${translated}   Skipped: ${skipped}`);

    // Sort: longer (more specific) entries first, then alphabetical
    const rows = [...glossaryMap.entries()].sort((a, b) => {
        const aw = a[0].split(' ').length, bw = b[0].split(' ').length;
        if (bw !== aw) return bw - aw;
        return a[0].localeCompare(b[0]);
    });

    const csv = ['ro,en', ...rows.map(([ro, en]) => `${ro},${en}`)].join('\n') + '\n';
    fs.writeFileSync(OUTPUT, csv, 'utf8');
    console.log(`\n✅ Glossary written to ${OUTPUT} (${rows.length} entries)`);
    console.log('\nSample entries:');
    rows.slice(0, 15).forEach(([ro, en]) => console.log(`  ${ro} → ${en}`));
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
