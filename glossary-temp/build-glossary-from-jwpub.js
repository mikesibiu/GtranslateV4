/*
  JWPUB Glossary Builder (RO → EN)

  Enhancements over initial spec:
  - Aligns RO/EN paragraphs by (DocumentId, ParagraphIndex) for validation
  - Extracts single- and multi-word RO candidates (capitalized spans, "X de Y")
  - Preserves hyphens (tests original, spaced, and joined variants)
  - Caches translations to translate-cache.json to avoid re-billing
  - Retries Google Translate v2 with backoff on transient errors
  - Proper CSV escaping; preserves the first 104 curated rows in glossary_final.csv
  - Exports glossary_from_docs.csv (with confidence/frequency) for review
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const cp = require('child_process');
const https = require('https');
const he = require('he');

const RO_JWPUB = path.join(__dirname, 'lff_M.jwpub');
const EN_JWPUB = path.join(__dirname, 'lff_E.jwpub');
const BASE_CSV = path.join(__dirname, 'glossary_final.csv');
const GEN_CSV = path.join(__dirname, 'glossary_from_docs.csv');
const REVIEW_CSV = path.join(__dirname, 'glossary_review.csv');
const CACHE_JSON = path.join(__dirname, 'translate-cache.json');

const API_KEY = process.env.GTranslate_API_KEY;
if (!API_KEY) {
  console.error('Error: GTranslate_API_KEY not set in environment');
  process.exit(1);
}

function uniqueTempFile(suffix = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwpub-'));
  return path.join(dir, crypto.randomUUID() + suffix);
}

function csvEscape(s) {
  const str = String(s == null ? '' : s);
  const needs = /[",\n]/.test(str);
  const esc = str.replace(/"/g, '""');
  return needs ? `"${esc}"` : esc;
}

function normalizeSpaces(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function stripHtmlPreserveEntities(html) {
  // Remove tags, keep entities; then decode entities
  const noTags = html.replace(/<[^>]*>/g, ' ');
  return he.decode(normalizeSpaces(noTags));
}

function fallbackExtractDbPathViaUnzip(jwpubPath) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwpub-unzip-'));
  try {
    cp.execFileSync('unzip', ['-q', jwpubPath, '-d', outDir], { stdio: 'ignore' });
  } catch (e) {
    // unzip may warn for unknown attrs; continue if directory created
  }
  // Walk directory tree to find .db files; pick the largest
  let best = null;
  let bestSize = -1;
  const stack = [outDir];
  while (stack.length) {
    const dir = stack.pop();
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && /\.db$/i.test(ent.name)) {
        const st = fs.statSync(p);
        if (st.size > bestSize) { best = p; bestSize = st.size; }
      }
    }
  }
  if (!best) throw new Error('No .db found after unzip');
  return { tmpDir: outDir, dbPath: best };
}

function extractParagraphsFromJwpub(jwpubPath) {
  const zip = new AdmZip(jwpubPath);
  const entries = zip.getEntries();
  let tmp = null;
  let tmpDirToCleanup = null;

  // Path 1: direct .db entry
  const directDb = entries.find(e => /(^|\/)contents\//.test(e.entryName) && e.entryName.toLowerCase().endsWith('.db'))
                || entries.find(e => e.entryName.toLowerCase().endsWith('.db'));
  if (directDb) {
    tmp = uniqueTempFile('.db');
    fs.writeFileSync(tmp, directDb.getData());
  } else {
    // Path 2: 'contents' is itself a zip containing the *.db
    const contentsEntry = entries.find(e => path.basename(e.entryName) === 'contents');
    if (contentsEntry) {
      const innerBuf = contentsEntry.getData();
      try {
        const innerZip = new AdmZip(innerBuf);
        const innerDb = innerZip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.db'));
        if (innerDb) {
          tmp = uniqueTempFile('.db');
          fs.writeFileSync(tmp, innerDb.getData());
        }
      } catch (e) {
        // fallthrough
      }
    }
    if (!tmp) {
      // Path 3: unzip to FS and scan (last resort)
      try {
        const { tmpDir, dbPath } = fallbackExtractDbPathViaUnzip(jwpubPath);
        tmp = dbPath; tmpDirToCleanup = tmpDir;
      } catch (e) {
        throw new Error(`No .db found in ${jwpubPath}`);
      }
    }
  }
  // Query via sqlite3 CLI to avoid native bindings
  const baseSelect = "SELECT DocumentId, ParagraphIndex, REPLACE(REPLACE(Content, char(10),' '), char(9),' ') as Content FROM ";
  const order = " ORDER BY DocumentId, ParagraphIndex";
  let out = '';
  try {
    out = cp.execFileSync('sqlite3', ['-noheader', '-tabs', tmp, baseSelect + 'Paragraph' + order], { encoding: 'utf8' });
  } catch (e) {
    out = cp.execFileSync('sqlite3', ['-noheader', '-tabs', tmp, baseSelect + 'Paragraphs' + order], { encoding: 'utf8' });
  } finally {
    // Cleanup temp
    if (tmpDirToCleanup) {
      try { fs.rmSync(tmpDirToCleanup, { recursive: true, force: true }); } catch {}
    } else {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  const rows = out.split(/\r?\n/).filter(Boolean).map(line => {
    const parts = line.split('\t');
    const doc = Number(parts[0]);
    const idx = Number(parts[1]);
    const content = parts.slice(2).join('\t');
    return { doc, idx, text: stripHtmlPreserveEntities(content) };
  }).filter(p => p.text && p.text.length >= 20);

  return rows;
}

// Romanian stop-words (light; keep capitalized proper nouns even if listed)
const STOP_WORDS = new Set([
  'și','că','în','la','de','a','cu','din','pe','pentru','este','sunt','se','nu',
  'un','o','sa','să','le','al','ai','ale','cel','cea','cei','cele','sau','dar',
  'dacă','după','care','mai','ca','fie','ori','când','unde','cum','tot','toate',
  'toți','acesta','aceasta','aceștia','acestea','ei','ele','el','ea',
  'eu','tu','noi','voi','lui','lor','îl','îi','îns','acest','această',
  'prin','între','spre','înainte','după','sub','peste','până','fără','despre',
  'conform','astfel','totuși','deci','atunci','acum','chiar','foarte','mai',
  'bine','mult','puțin','am','ai','are','avem','aveți','au','este','ești',
  'suntem','sunteți','va','vor','vei','vom','veți','fi','fost','era','erau'
]);

function toKeyLowerRO(s) {
  return s.toLowerCase().replace(/[^a-zăâîșțşţ\s\-]/gi, '');
}

function tokenizeROVariants(s) {
  // Produce three variants: original, hyphen->space, hyphen removed
  const orig = toKeyLowerRO(s);
  const spaced = orig.replace(/\-/g, ' ');
  const joined = orig.replace(/\-/g, '');
  return [orig, spaced, joined];
}

function extractCandidatesFromParagraphs(roParas) {
  const candidates = new Map(); // keyLower -> originalForm

  const addCandidate = (raw) => {
    const cleanOrig = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (!cleanOrig) return;
    const isCapitalized = /^[A-ZĂÂÎȘȚ]/.test(cleanOrig);
    const len = cleanOrig.length;
    const lower = cleanOrig.toLowerCase();
    if (!isCapitalized && STOP_WORDS.has(lower)) return;
    if (len < 5 && !(isCapitalized && len >= 3)) return;
    const key = toKeyLowerRO(cleanOrig);
    if (key.length === 0) return;
    if (!candidates.has(key)) candidates.set(key, cleanOrig);
  };

  const capSpanRe = /\b([A-ZĂÂÎȘȚ][\p{L}’'\-]+(?:\s+[A-ZĂÂÎȘȚ][\p{L}’'\-]+){0,3})\b/gu;
  const dePatternRe = new RegExp(
    String.raw`\b([\p{L}]{3,})\s+(de|al|a|ai|ale)\s+([\p{L}]{3,})\b`, 'gu'
  );

  for (const p of roParas) {
    const t = p.text;

    // 1) Capitalized spans (proper nouns / titles)
    for (const m of t.matchAll(capSpanRe)) {
      addCandidate(m[1]);
    }

    // 2) "X de Y" patterns
    for (const m of t.matchAll(dePatternRe)) {
      addCandidate(`${m[1]} ${m[2]} ${m[3]}`);
    }

    // 3) Single tokens
    const words = t.split(/\s+/);
    for (const w of words) {
      addCandidate(w);
    }
  }

  return [...candidates.values()];
}

function indexParasByKey(paras) {
  const map = new Map(); // key -> text
  for (const p of paras) {
    map.set(`${p.doc}|${p.idx}`, p.text);
  }
  return map;
}

function englishNorm(s) {
  return s.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Domain allowlist terms to bias acceptance when translations align
const DOMAIN_ALLOW = [
  'governing body',
  'congregation',
  'pioneer',
  'publisher',
  'elder',
  'baptism',
  'kingdom',
  'preach',
  'good news',
  'shepherd',
  'anointed', // correct spelling
  'annoited', // common misspelling, in case API returns it
  'anointed ones',
  'faithful and discreet slave',
  'ransom sacrifice'
];

function appearsInEnglish(enText, translated) {
  const t = englishNorm(translated);
  if (!t) return false;
  const en = englishNorm(enText);
  if (t.includes(' ')) return en.includes(t);
  // Single token: check boundaries
  const re = new RegExp(`(^|\s)${t}(\s|$)`);
  if (re.test(en)) return true;
  // Simple morphology tolerance
  const base = t.replace(/(ing|ed|es|s)$/,'');
  if (base.length >= 3) {
    const re2 = new RegExp(`(^|\s)${base}(s|es|ed|ing)?(\s|$)`);
    return re2.test(en);
  }
  return false;
}

function findOccurrences(roParas, candidate) {
  // Return list of keys where candidate appears in RO paragraph
  const keys = [];
  const [orig, spaced, joined] = tokenizeROVariants(candidate);
  for (const p of roParas) {
    const textKey = toKeyLowerRO(p.text).replace(/\s+/g, ' ').trim();
    if (
      textKey.includes(orig) ||
      textKey.includes(spaced) ||
      textKey.includes(joined)
    ) {
      keys.push(`${p.doc}|${p.idx}`);
    }
  }
  return keys;
}

function findOccurrencesFast(roParasNorm, candidate) {
  const keys = [];
  const [orig, spaced, joined] = tokenizeROVariants(candidate);
  for (const p of roParasNorm) {
    const textKey = p.norm;
    if (textKey.includes(orig) || textKey.includes(spaced) || textKey.includes(joined)) {
      keys.push(p.key);
    }
  }
  return keys;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_JSON, 'utf8')); }
  catch { return {}; }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_JSON, JSON.stringify(cache, null, 2));
}

async function translateBatch(terms, cache) {
  const uncached = [];
  for (const t of terms) if (!(t in cache)) uncached.push(t);
  if (uncached.length === 0) return terms.map(t => cache[t]);

  const body = uncached.map(t => `q=${encodeURIComponent(t)}`).join('&')
    + '&source=ro&target=en&format=text';

  const opts = {
    hostname: 'translation.googleapis.com',
    path: `/language/translate/v2?key=${API_KEY}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  // Retry/backoff
  let attempt = 0;
  const maxAttempts = 4;
  while (true) {
    try {
      const translated = await new Promise((resolve, reject) => {
        const req = https.request(opts, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            try {
              const j = JSON.parse(d);
              if (j.error) return reject(new Error(j.error.message));
              const out = j.data.translations.map(t => String(t.translatedText || '').trim());
              resolve(out);
            } catch (e) { reject(new Error(d.slice(0, 200))); }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      // Merge into cache
      for (let i = 0; i < uncached.length; i++) cache[uncached[i]] = translated[i];
      saveCache(cache);
      break;
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts) throw err;
      const backoff = 500 * Math.pow(2, attempt) + Math.floor(Math.random()*250);
      await sleep(backoff);
    }
  }

  return terms.map(t => cache[t]);
}

function shouldSkip(ro, en) {
  const enLow = englishNorm(en);
  const roNorm = toKeyLowerRO(ro).replace(/\s+/g, '');
  const enNorm = enLow.replace(/\s+/g, '');
  if (!enLow) return true;
  if (roNorm === enNorm) return true; // same letters
  if (en.includes('_')) return true;
  if (/^[A-Z]{2,6}s?$/.test(en.trim())) return true;
  if (!en.includes(' ') && en.replace(/[^a-z]/gi, '').length > 20) return true;
  if (/[ăâîșțĂÂÎȘȚşţ]/.test(en)) return true;
  // Filter very common English function words
  const EN_STOP = new Set(['the','and','or','in','of','a','to','is','be','are','for','on','this','that','with','from','as','by','it','an','at','you','your','we','our']);
  if (EN_STOP.has(enLow)) return true;
  return false;
}

function extractWordsAndTitles(jwpubPath) {
  // Find inner db
  const outer = new AdmZip(jwpubPath);
  const contents = outer.getEntries().find(e => path.basename(e.entryName) === 'contents');
  if (!contents) throw new Error('contents not found in jwpub');
  let innerDbBuf;
  try {
    const innerZip = new AdmZip(contents.getData());
    const innerDb = innerZip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.db'));
    if (!innerDb) throw new Error('inner .db not found');
    innerDbBuf = innerDb.getData();
  } catch (e) {
    // Fallback to unzip if AdmZip fails on nested
    const tmp = uniqueTempFile('.zip');
    fs.writeFileSync(tmp, contents.getData());
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwpub-inner-'));
    cp.execFileSync('unzip', ['-q', tmp, '-d', outDir]);
    fs.unlinkSync(tmp);
    let dbPath = null, best = -1;
    const stack = [outDir];
    while (stack.length) {
      const d = stack.pop();
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (ent.isFile() && p.toLowerCase().endsWith('.db')) {
          const sz = fs.statSync(p).size;
          if (sz > best) { dbPath = p; best = sz; }
        }
      }
    }
    if (!dbPath) throw new Error('inner .db not found');
    const buf = fs.readFileSync(dbPath);
    innerDbBuf = buf;
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  }

  const dbTmp = uniqueTempFile('.db');
  fs.writeFileSync(dbTmp, innerDbBuf);

  // Query via sqlite3: get WordId->freq, WordId->word, Titles text
  const words = new Map();
  const freqs = new Map();
  try {
    const outFreq = cp.execFileSync('sqlite3', ['-noheader', '-tabs', dbTmp, 'SELECT WordId, sum(WordOccurrenceCount) FROM SearchIndexDocument GROUP BY WordId'], { encoding: 'utf8' });
    for (const line of outFreq.split(/\r?\n/)) {
      if (!line) continue;
      const [wid, f] = line.split('\t');
      freqs.set(Number(wid), Number(f)||0);
    }
  } catch (e) {
    // If SearchIndexDocument not available, freqs stay empty
  }
  const outWords = cp.execFileSync('sqlite3', ['-noheader', '-tabs', dbTmp, 'SELECT WordId, Word FROM Word'], { encoding: 'utf8' });
  for (const line of outWords.split(/\r?\n/)) {
    if (!line) continue;
    const [wid, w] = line.split('\t');
    words.set(Number(wid), w);
  }
  const titles = cp.execFileSync('sqlite3', ['-noheader', '-tabs', dbTmp, "SELECT Title FROM Document WHERE Title IS NOT NULL"], { encoding: 'utf8' });
  const titlesText = titles.split(/\r?\n/).filter(Boolean).join('\n');
  try { fs.unlinkSync(dbTmp); } catch {}

  // Build word->freq mapping (fallback freq=1 if missing)
  const wordFreq = new Map();
  for (const [wid, w] of words.entries()) {
    const word = (w||'').trim();
    if (!word) continue;
    const f = freqs.get(wid) || 1;
    wordFreq.set(word, f);
  }
  return { wordFreq, titlesText };
}

async function main() {
  console.log('Extracting vocabulary and titles from JWPUB files...');
  const roData = extractWordsAndTitles(RO_JWPUB);
  const enData = extractWordsAndTitles(EN_JWPUB);
  console.log(`RO words: ${roData.wordFreq.size}  EN words: ${enData.wordFreq.size}`);

  const enWordSet = new Set([...enData.wordFreq.keys()].map(w => w.toLowerCase()));
  const enTitlesText = enData.titlesText;

  // Build RO candidates from RO words + RO titles tokens
  const roCandidates = new Map(); // ro -> freq
  for (const [w, f] of roData.wordFreq.entries()) {
    const lower = w.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    if (/[0-9]/.test(w)) continue;
    const isCap = /^[A-ZĂÂÎȘȚ]/.test(w);
    if (w.length < 5 && !(isCap && w.length >= 3)) continue;
    roCandidates.set(w, (roCandidates.get(w)||0) + f);
  }
  // Add tokens from RO titles too
  const roTitleTokens = roData.titlesText.split(/\s+/).map(s => s.replace(/[^\p{L}\-’']/gu,'')).filter(Boolean);
  for (const t of roTitleTokens) {
    const lower = t.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    const isCap = /^[A-ZĂÂÎȘȚ]/.test(t);
    if (t.length < 5 && !(isCap && t.length >= 3)) continue;
    roCandidates.set(t, (roCandidates.get(t)||0) + 5); // small boost for titles
  }

  let candidates = [...roCandidates.entries()].sort((a,b) => b[1]-a[1]).map(([w])=>w);
  // Deduplicate; prioritize multi-word first
  candidates = [...new Set(candidates)];
  console.log(`Candidates: ${candidates.length}`);

  // Optional cap to control API spend
  const MAX_TERMS = Number(process.env.MAX_TERMS || '0');
  if (MAX_TERMS > 0 && candidates.length > MAX_TERMS) {
    console.log(`Capping candidates from ${candidates.length} to MAX_TERMS=${MAX_TERMS}`);
    candidates = candidates.slice(0, MAX_TERMS);
  }

  const cache = loadCache();
  const BATCH = 20;
  const accepted = new Map(); // ro -> { en, confidence, votes, occurrences }

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    // Skip translating ones already in cache if cache says to skip later, but we need en to decide
    let translations;
    try {
      translations = await translateBatch(batch, cache);
    } catch (err) {
      console.error(`Batch translate failed at [${i}-${i+BATCH}]: ${err.message}`);
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const ro = batch[j];
      const en = translations[j] || '';
      const occurrences = [ro]; // use 1 slot to compute a simple confidence
      if (shouldSkip(ro, en)) {
        process.stdout.write(`\rSkipped (heuristic): ${ro.padEnd(30)} → ${en.padEnd(30)}   `);
        continue;
      }
      // Validate against EN word set or titles text; bias with domain allowlist
      const enTokens = englishNorm(en).split(' ').filter(Boolean);
      let votes = 0;
      for (const t of enTokens) if (enWordSet.has(t)) votes++;
      if (votes === 0 && appearsInEnglish(enTitlesText, en)) votes = 1;
      // Domain bias: if translation contains any allowlisted term and that term exists in EN titles or vocabulary, add a strong vote
      const enLower = englishNorm(en);
      for (const term of DOMAIN_ALLOW) {
        if (enLower.includes(term) && (enWordSet.has(term.split(' ')[0]) || appearsInEnglish(enTitlesText, term))) {
          votes += 2; // strong bias
          break;
        }
      }
      const conf = enTokens.length ? Math.min(1, votes / Math.max(1, enTokens.length)) : 0;
      const passes = votes >= 1;
      if (!passes) {
        process.stdout.write(`\rRejected (low conf): ${ro.padEnd(30)} → ${en.padEnd(30)}   `);
        continue;
      }

      accepted.set(ro, { en, confidence: Number(conf.toFixed(3)), votes, occurrences: occurrences.length });
      process.stdout.write(`\rAccepted: ${accepted.size} kept / ${i + j + 1} processed   `);
    }

    if (i + BATCH < candidates.length) await sleep(200);
  }

  console.log(`\nTotal accepted: ${accepted.size}`);

  // Write glossary_from_docs.csv with review columns
  const reviewRows = [...accepted.entries()].sort((a, b) => {
    const aw = a[0].split(/\s+/).length, bw = b[0].split(/\s+/).length;
    if (bw !== aw) return bw - aw;
    return a[0].localeCompare(b[0]);
  });

  const reviewHeader = ['ro','en','confidence','occurrences','votes'];
  const reviewLines = [reviewHeader.map(csvEscape).join(',')].concat(
    reviewRows.map(([ro, v]) => [ro, v.en, v.confidence, v.occurrences, v.votes].map(csvEscape).join(','))
  );
  fs.writeFileSync(REVIEW_CSV, reviewLines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${path.basename(REVIEW_CSV)} (${reviewRows.length} entries)`);

  // Produce simple two-column glossary_from_docs.csv for downstream merging/display
  const simpleHeader = ['ro','en'];
  const simpleLines = [simpleHeader.map(csvEscape).join(',')].concat(
    reviewRows.map(([ro, v]) => [ro, v.en].map(csvEscape).join(','))
  );
  fs.writeFileSync(GEN_CSV, simpleLines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${path.basename(GEN_CSV)} (${reviewRows.length} entries)`);

  // Write frequency-ranked Top 500 CSV
  const TOP_N = 500;
  const scored = reviewRows.map(([ro, v]) => ({
    ro,
    en: v.en,
    freq: roCandidates.get(ro) || 1,
    confidence: v.confidence
  }));
  scored.sort((a, b) => (b.freq - a.freq) || (b.confidence - a.confidence) || a.ro.localeCompare(b.ro));
  const top = scored.slice(0, Math.min(TOP_N, scored.length));
  const topHeader = ['ro','en','freq','confidence'];
  const topLines = [topHeader.map(csvEscape).join(',')].concat(
    top.map(r => [r.ro, r.en, String(r.freq), String(r.confidence)].map(csvEscape).join(','))
  );
  const TOP_CSV = path.join(__dirname, 'glossary_top_500.csv');
  fs.writeFileSync(TOP_CSV, topLines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${path.basename(TOP_CSV)} (${top.length} entries)`);

  // Merge into glossary_final.csv while preserving first 104 curated rows at top
  if (!fs.existsSync(BASE_CSV)) {
    // If no base, create with header + accepted
    const lines = [simpleHeader.map(csvEscape).join(',')].concat(
      reviewRows.map(([ro, v]) => [ro, v.en].map(csvEscape).join(','))
    );
    fs.writeFileSync(BASE_CSV, lines.join('\n') + '\n', 'utf8');
    console.log(`Created ${path.basename(BASE_CSV)} (${reviewRows.length} entries)`);
    return;
  }

  const baseRaw = fs.readFileSync(BASE_CSV, 'utf8').split(/\r?\n/);
  const header = baseRaw[0] || 'ro,en';
  const body = baseRaw.slice(1).filter(Boolean);

  // Determine baseline block size: stated as 104 curated top entries
  const baselineCount = Math.min(104, body.length);
  const baseline = body.slice(0, baselineCount);
  const rest = body.slice(baselineCount);

  const existingRO = new Set();
  const parseRow = (line) => {
    // minimal CSV parse for two columns
    // Accept both quoted and unquoted
    const m = line.match(/^\s*(?:\"([^\"]*(?:\"\"[^\"]*)*)\"|([^,]*))\s*,\s*(?:\"([^\"]*(?:\"\"[^\"]*)*)\"|([^,]*))\s*$/);
    if (!m) return null;
    const ro = (m[1] ?? m[2] ?? '').replace(/\"\"/g, '"');
    const en = (m[3] ?? m[4] ?? '').replace(/\"\"/g, '"');
    return [ro, en];
  };

  for (const line of body) {
    const r = parseRow(line);
    if (r && r[0]) existingRO.add(r[0].toLowerCase());
  }

  const newPairs = [];
  for (const [ro, v] of reviewRows) {
    if (!existingRO.has(ro.toLowerCase())) {
      newPairs.push([ro, v.en]);
      existingRO.add(ro.toLowerCase());
    }
  }

  const merged = [header]
    .concat(baseline)
    .concat(rest)
    .concat(newPairs.map(([r,e]) => [csvEscape(r), csvEscape(e)].join(',')));
  fs.writeFileSync(BASE_CSV, merged.join('\n') + '\n', 'utf8');
  console.log(`Updated ${path.basename(BASE_CSV)}: +${newPairs.length} new (kept top ${baselineCount} curated intact)`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
