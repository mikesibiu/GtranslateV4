# Opus Fixed This (v189)

Changes made by Claude Opus 4.6 after a full-codebase review of GTranslateV4.
Previous development was done with Sonnet. This documents what Opus found and fixed.

---

## 1. Stream Restart State Loss (Critical Bug)

**File:** `server.js` (createRecognitionStream)

**Problem:** When the Google STT stream auto-restarts at 290s, the translation rules
engine's dedup state was NOT reset. This meant if a phrase was spoken right before the
restart, it would be shown once — then immediately suppressed as a duplicate when the
speaker continued on the new stream. Translations were silently lost.

**Fix:** Added `translationRules.resetForNewUtterance()` call inside
`createRecognitionStream()` on every restart (auto or manual). Now the dedup window,
recent translations list, and last-translated-text tracker all reset cleanly when a
new STT stream begins.

---

## 2. Translation API Timeout Protection (New)

**File:** `server.js` (performTranslation)

**Problem:** `translateWithRetry()` had no timeout. If Google Translate API stalled
(network issue, quota exhaustion), the request would hang forever. The client would
never receive a translation and have no idea what happened.

**Fix:** Wrapped the translate call in `Promise.race()` with a configurable timeout
(default 15s via `config.json`). On timeout, the error propagates through the existing
error handler and the client receives a `translation-error` event.

---

## 3. Audio Clipping Detection (New)

**File:** `audio-processor.js`, `client-audio.js`

**Problem:** When a user speaks too loudly, samples are silently clamped to [-1, 1]
with zero feedback. STT quality degrades and nobody knows why.

**Fix:**
- AudioWorklet now counts clipped samples per buffer
- When >5% of samples clip, sends `clipping: true` + `clipRatio` in the message
- Client-side displays a red "CLIP" warning on the audio level meter
- Users can now see when they need to move back from the mic or lower gain

---

## 4. Adaptive AGC Target Level (Enhancement)

**File:** `audio-processor.js`

**Problem:** AGC target was fixed at 0.35. This is optimal for normal room volume,
but whispered speech (common in quiet settings) needs a higher target (~0.45), and
loud environments need a lower target (~0.25).

**Fix:** Added adaptive target adjustment:
- Very quiet input (levelSmooth < 0.05): target raised to 0.45 for better STT pickup
- Very loud input (levelSmooth > 0.50): target lowered to 0.25 to avoid clipping
- Normal range: uses base target (0.35)
- Base target level stored separately so adaptation doesn't drift permanently

---

## 5. TTS Queue Size Cap (Bug Fix)

**File:** `client-tts.js`

**Problem:** If `processNextInQueue()` failed (e.g., voice loading race condition on
mobile), the TTS queue would grow unbounded. After 10+ minutes of a speaker: 100+
items in queue, causing GC pauses and UI lag on mobile devices.

**Fix:** Added a 50-item cap. When exceeded, the oldest 10 items are dropped. This
prevents memory bloat while keeping recent translations available for playback.

---

## 6. Paragraph Seal Race Condition Fix (Bug Fix)

**File:** `client.js` (sealCurrentParagraph)

**Problem:** If a translation arrived at 19.9s and the paragraph sealed at 20s:
1. DOM updates with new translation
2. `sealCurrentParagraph()` sets `currentParagraphEl = null`
3. Next translation finds null — `.para-text span missing` error logged
4. Translation silently dropped

**Fix:**
- Added early return guard: `if (!this.currentParagraphEl) return;` prevents double-seal
- Sealed paragraphs get a `.sealed` CSS class for debugging visibility
- Ensures clean state even if multiple seal triggers fire in quick succession

---

## 7. Billing Purge Date Bug Fix

**File:** `billing-db.js` (purgeOldData)

**Problem:** Used `CURRENT_DATE` (midnight-truncated) instead of `CURRENT_TIMESTAMP`.
Data created at 11:59 PM on the 90-day boundary was never purged because
`CURRENT_DATE - 90 days` = midnight, which is after 11:59 PM of that day.
Over time: ~500 rows per year that never get cleaned up.

**Fix:** Changed `CURRENT_DATE` to `CURRENT_TIMESTAMP` in the DELETE query.

---

## 8. Configuration Extraction (New)

**File:** `config.json` (new), `server.js`

**Problem:** Magic numbers scattered across the codebase:
- 290000ms stream limit
- 15000ms translation interval
- 0.65 overlap threshold
- 0.35 AGC target
- 2MB/sec rate limit
- 50 max connections
- 90 day purge age
- etc.

All required code changes to tune.

**Fix:** Created `config.json` with all tunable parameters organized by category
(stream, translation, modes, audio, billing, connection). Server.js loads it at
startup with env var overrides. Config is optional — all values have inline defaults.

This enables:
- A/B testing different thresholds without code changes
- Per-deployment tuning (Koyeb vs local vs Docker)
- Quick iteration on translation quality parameters

---

## 9. Expanded Filler Words (Enhancement)

**File:** `translation-rules-engine.js`

**Problem:** Filler word set was minimal. Real Romanian STT output includes many
discourse markers not covered: "na", "hai", "mda", "aaa", "eee", "practic", etc.
These would pass the quality check and trigger unnecessary translations of noise.

**Fix:** Added 12 additional filler entries covering:
- English variants: 'uhh', 'umm', 'ahh', 'ohh', 'oh', 'huh'
- Romanian discourse markers: 'bon', 'gata', 'nu', 'na', 'hai', 'mda'
- Romanian verbal fillers: 'aaa', 'eee', 'ihi', 'practic', 'zic', 'asa'

---

## 10. Non-Romanian Source Language Path Fixes (3 changes)

**Files:** `server.js`

**Problem:** The entire post-processing pipeline assumed Romanian source. When using
en→ro or fr→ro (or any non-Romanian source):

- `applyTermMappings()` fired all 30+ Romanian-specific regex rules on the output.
  Source-aware checks matched English/French cognates (e.g., English "congregation"
  triggered the `/congregati/` check, wrongly rewriting Romanian output).
- `FALLBACK_TRANSLATIONS` keys are Romanian words — would never match, but still
  ran the normalization logic on every translation for no reason.
- `STT_PHRASE_HINTS` (70+ Romanian words/phrases) were sent to Google STT even when
  the source language was English or French, wasting the phrase hints budget.

**Fixes:**
1. `applyTermMappings()` now only runs when `sourceLangBase === 'ro'`
2. `FALLBACK_TRANSLATIONS` lookup now guarded by `sourceLangBase === 'ro'`
3. `speechContexts` in the STT request is now empty `[]` for non-Romanian sources
4. `verifyReligiousTerms()` was already correctly guarded (`targetLang !== 'ro'`)
5. `preserveSourceNumbers()` and `preserveDates()` are language-agnostic — left as-is

---

## 11. Version Bump

**Files:** `index.html`, `server.js`

Updated version from v188 to v189. Updated `appVersion` in translation log entries.

---

## Test Results

180 passing, 1 pre-existing failure (integration test requiring a live server).
All unit tests pass. No regressions introduced.

---

## What Was NOT Changed (and Why)

- **Post-processor rules remain in code** — Extracting to CSV would be a great next
  step, but the current rules are tightly coupled to source-aware checks (`sourceText`
  parameter) that don't map cleanly to a flat CSV. A proper extraction needs a rule
  format that supports conditions, not just pattern/replacement. Flagged for future work.

- **Glossary is already wired up** — Contrary to initial review suspicion, the glossary
  IS being used. `getGlossaryPath()` returns the correct path, and `translateWithRetry()`
  passes it as `glossaryConfig`. The graceful fallback (retry without glossary on
  NOT_FOUND) is correctly implemented. No fix needed here.

- **Rate limiting already exists** — The initial review flagged missing rate limiting,
  but `server.js` already has `MAX_AUDIO_BYTES_PER_SECOND` enforcement (2MB/sec) and
  per-chunk size validation (`MAX_AUDIO_CHUNK_SIZE`). Now configurable via config.json.

- **Overlap threshold not made per-mode** — config.json defines per-mode thresholds
  but the rules engine doesn't read config.json (it's server-side only). This would
  require passing config down to the engine constructor. Left as future work.

---

*Generated by Claude Opus 4.6 (1M context) — 2026-04-04*
