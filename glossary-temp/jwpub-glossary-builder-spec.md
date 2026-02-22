# JWPUB Glossary Builder — Task Spec (Updated)

## Overview
Build a Node.js script `build-glossary-from-jwpub.js` that:
1. Reads `.jwpub` files (JW.org proprietary format) from this directory (note: some editions package `contents` as a nested ZIP).
2. Extracts vocabulary and titles from the inner SQLite DB using the `Word` and `SearchIndexDocument` tables (plus `Document.Title`).
3. Ranks Romanian candidate terms by frequency (from the RO SearchIndex) with a small boost for terms seen in titles.
4. Translates candidates via Google Translate API v2 with request caching and exponential backoff retry.
5. Validates each translation against the English vocabulary set and titles, with a domain allowlist that biases acceptance of theocratic JW.org terms.
6. Generates reviewer artifacts, a frequency‑ranked Top‑500 export, and merges accepted pairs after the 104 curated baseline rows in `glossary_final.csv` (preserving curated order).

All input and output files stay in THIS directory only.

---

## What is a JWPUB file?
A `.jwpub` is a ZIP archive containing:
- `manifest.json` — metadata
- `contents` — either a SQLite DB directly, or a nested ZIP that contains the SQLite DB and assets

Important: For the LFF (Enjoy Life Forever) jwpubs here, `contents` is itself a ZIP. The inner SQLite contains tables like `Word`, `SearchIndexDocument`, and `Document`. The `Document.Content` BLOB is compressed/binary; rather than reverse the codec, we rely on the search index and titles, which are sufficient for building a frequency‑weighted glossary.

**Explore the files before coding — quick checks:**
```bash
python3 - <<'PY'
import zipfile, tempfile
with zipfile.ZipFile('lff_E.jwpub') as outer:
    inner = tempfile.mkstemp(suffix='.zip')[1]
    open(inner,'wb').write(outer.read('contents'))
    import zipfile as z
    with z.ZipFile(inner) as inner_zip:
        for n in inner_zip.namelist():
            if n.lower().endswith('.db'):
                open('/tmp/lff_E.db','wb').write(inner_zip.read(n))
                break
PY
sqlite3 /tmp/lff_E.db ".tables"
sqlite3 /tmp/lff_E.db ".schema Word"
sqlite3 /tmp/lff_E.db "SELECT count(*) FROM SearchIndexDocument;"
sqlite3 /tmp/lff_E.db "SELECT DocumentId, Title FROM Document ORDER BY DocumentId LIMIT 5;"
```

---

## Input files (already in this directory)
- `lff_M.jwpub` — Romanian version of "Enjoy Life Forever"
- `lff_E.jwpub` — English version of "Enjoy Life Forever"
- `glossary_final.csv` — 104 hand‑curated baseline entries (DO NOT delete these)

---

## Tools and npm packages
Run `npm install` — `package.json` is already present. Uses:
- `adm-zip` — read the ZIP/JWPUB and the nested `contents` archive
- `https` — Node built‑in, for Google Translate API calls
- `he` — safe HTML entity decoding when necessary

System requirement:
- `sqlite3` CLI — used to query the SQLite DB (avoids native addon builds). Verify with `sqlite3 --version`.

---

## Script: `build-glossary-from-jwpub.js`

### Data extraction and mining (SearchIndex + Titles)
- Detect whether `contents` is a nested ZIP; if so, open it and locate the `.db` inside (pick the largest if multiple).
- Query vocabulary with `sqlite3` CLI:
  - `SELECT WordId, Word FROM Word` → term list.
  - `SELECT WordId, SUM(WordOccurrenceCount) FROM SearchIndexDocument GROUP BY WordId` → frequency per WordId.
  - `SELECT Title FROM Document WHERE Title IS NOT NULL` → titles text for domain cues.
- Build a Romanian candidate set by:
  - Keeping tokens with length ≥ 5, or capitalized tokens with length ≥ 3.
  - Preserving diacritics and hyphens; dropping numbers and obvious noise.
  - Removing Romanian stopwords unless capitalized (proper nouns).
  - Ranking by frequency from the RO SearchIndex, with a small boost for tokens seen in titles.

### Translation (Google Translate v2)
- Batch requests; cache to `translate-cache.json`.
- Retry with exponential backoff on transient errors (e.g., 429/5xx).
- Optional cap with `MAX_TERMS` to control spend/time per run (e.g., 600 or 1000).

### Validation and filters (vocabulary‑based + domain bias)
- Build an English vocabulary set from EN `Word` and use EN titles as additional context.
- Accept a translation when one or more English tokens appear in the EN vocabulary or titles.
- Domain allowlist (strong bias when present in translation and observed in EN data):
  - governing body, congregation, pioneer, publisher, elder, baptism, kingdom, preach, good news, shepherd, anointed, annoited, anointed ones, faithful and discreet slave, ransom sacrifice
- Skip heuristics for artifacts: underscores in output, all‑caps codes, extremely long unbroken strings, Romanian characters in EN output, and very common English function words.

### Outputs and merge
- `glossary_review.csv` — ro,en,confidence,votes/occurrences for manual QA.
- `glossary_from_docs.csv` — two‑column (ro,en) validated pairs.
- `glossary_top_500.csv` — frequency‑ranked Top‑500 (ro,en,freq,confidence).
- `glossary_final.csv` — merge by appending new rows after the first 104 curated entries; CSV‑escaped; curated order preserved.

---

## Running
```bash
cd glossary-temp
npm install

# quick pass (control cost)
MAX_TERMS=600 node build-glossary-from-jwpub.js

# larger pass
MAX_TERMS=1000 node build-glossary-from-jwpub.js
```

Environment: `GTranslate_API_KEY` must be set (already set in the project shell).

---

## Expected output
- `glossary_from_docs.csv` — new validated entries (RO,EN), CSV‑escaped
- `glossary_review.csv` — (ro,en,confidence,occurrences,votes) for manual QA
- `glossary_top_500.csv` — top 500 by RO frequency (then confidence)
- `glossary_final.csv` — updated file: preserves top 104 curated entries; appends new validated entries

---

## Constraints
- Work only inside this directory (`glossary-temp/`)
- Do NOT modify any files in the parent directory
- Do NOT delete or overwrite the 104 baseline entries at the top of `glossary_final.csv`
- The script name must be `build-glossary-from-jwpub.js`

---

## Why this approach (rationale)
- JW.org packaging reality: In these jwpubs, `contents` is a nested ZIP and `Document.Content` is compressed. Using the SearchIndex and titles avoids reverse‑engineering while still reflecting the publication’s vocabulary and salience.
- Domain precision: The allowlist (e.g., “Governing Body”, “faithful and discreet slave”, “ransom sacrifice”) nudges acceptance toward theocratic terms used across JW literature.
- Frequency‑first ranking: RO SearchIndex frequencies ensure the glossary prioritizes what appears most to readers.
- Cost control & reproducibility: Translation caching, backoff, and `MAX_TERMS` make runs stable and affordable.
- Data safety & merge discipline: CSV escaping prevents malformed rows; the curated 104‑row block remains intact; new entries append after it.
