# GTranslate V4 — Possible Improvements

_Last updated: v130 (2026-02-19)_

---

## Bugs / Known Issues

| # | Issue | File(s) | Notes |
|---|-------|---------|-------|
| ~~B1~~ | ~~Single-word `isFinal` translations~~ | ~~`server.js`~~ | ✅ **Fixed v129** — pre-filter rejects isFinal < 3 words without sentence ending |
| ~~B2~~ | ~~`useServerTTS` not reset on reconnect~~ | ~~`index.html`~~ | ✅ **Fixed v129** — reset in `socket.on('connect')` |
| ~~B4~~ | ~~README outdated~~ | ~~`README.md`~~ | ✅ **Fixed v129** |

---

## 🔴 HIGH PRIORITY

| # | Item | Area | Notes |
|---|------|------|-------|
| H1 | **Rate-limit `tts-synthesize` socket events** | Security / Cost | No per-socket guard; a single bad client can trigger unlimited Neural2 synthesis at ~$16/1M chars. Add a 1-2s cooldown or server-side queue per socket. |
| H2 | **Fix npm audit vulnerabilities** | Security | 6 vulns (4 high) flagged after v128 install. Run `npm audit fix` and check for breaking changes. |
| H3 | **Authentication / access control** | Security / Cost | Anyone with the URL drives up API costs. Add at minimum a shared password (HTTP Basic Auth via express middleware or env-var token check). |
| ~~H4~~ | ~~VAD — stop sending audio during silence~~ | ~~Cost / Quality~~ | ✅ **Fixed v130** — raw RMS VAD in AudioWorklet (threshold 0.005, 680ms holdover); `isSilent` flag gates `socket.emit('audio-data')` in index.html |

---

## 🟡 MEDIUM PRIORITY

### TTS (EarBuds Mode)

| # | Item | Notes |
|---|------|-------|
| T1 | **TTS billing tracking** | Add `trackUsage('tts', text.length, targetLang)` after successful synthesis in `tts-synthesize` handler. Currently no cost visibility for TTS. |
| T2 | **TTS queue interrupt on stale content** | If a long phrase is playing and new translation arrives, old audio finishes first. Track `currentSource`; call `source.stop()` and flush queue when new content is substantially different. |
| T3 | **TTS MP3 caching for repeated phrases** | Common phrases ("Amen", "Let us pray", "Thank you") are re-synthesized every time. LRU cache on server keyed by `(text.toLowerCase(), lang)` → Buffer saves cost and latency. |
| T4 | **Billing dashboard shows TTS cost** | `getUsageSummary` aggregates `tts` rows but the frontend billing view likely doesn't render them. Add TTS row to the billing UI. |

### Translation Quality

| # | Item | Notes |
|---|------|-------|
| Q1 | **Interim box shows target language for listener** | In EarBuds mode the interim box still shows source language STT. Should show last translation + "...". Was reverted — B1 fix is prerequisite; safe to re-apply now. |
| ~~Q2~~ | ~~Translation retry on transient error~~ | ✅ **Already implemented** — `translateWithRetry()` has 3 retries with exponential backoff (1s/2s/4s) for 503, 429, UNAVAILABLE, RESOURCE_EXHAUSTED, ECONNRESET |
| Q3 | **Sentence-boundary triggered translation** | Rules engine already has `detectSentenceEnding()` at Priority 1, but it checks `newText` quality which can be < 3 words for a single final sentence. Loosen the quality threshold for sentence-ending results (2 words minimum instead of 3). |

### Audio / STT

| # | Item | Notes |
|---|------|-------|
| A1 | **WEBM_OPUS encoding** | Browsers natively capture audio as OPUS. Sending WEBM_OPUS to Google STT instead of resampled LINEAR16 reduces bandwidth ~3× and lowers latency. Google STT V1 supports `WEBM_OPUS` encoding. Requires changing AudioWorklet output format. |
| A2 | **Noise gate in AudioWorklet** | AGC amplifies background noise during silence. Add energy threshold in `audio-processor.js` below which samples are zeroed. Pairs well with H4 (VAD). |

### Infrastructure

| # | Item | Notes |
|---|------|-------|
| I1 | **End-to-end latency tracking** | Measure audio-captured → STT result → translation → client display time. Log p50/p95 to understand real-world performance. Crucial for a live event app. |
| ~~I2~~ | ~~Error tracking (Sentry)~~ | ✅ **Fixed v130** — `@sentry/node` installed; conditional init from `SENTRY_DSN` env var; `captureError()` helper used in translation, TTS, and stream-start catch blocks. **Action needed:** set `SENTRY_DSN` in Heroku config vars. |
| I3 | **Docker image rebuild** | Dockerfile missing `@google-cloud/text-to-speech`; stale since v127. |

---

## 🟢 LOW / FUTURE

### TTS

| # | Item | Notes |
|---|------|-------|
| T5 | **TTS status indicator in UI** | Small badge "🔊 Google TTS" vs "🔊 Browser TTS" so user knows which engine is active. |
| T6 | **TTS voice selector** | Expose Neural2 voice variants in UI (currently hardcoded per language). |

### Quality

| # | Item | Notes |
|---|------|-------|
| Q4 | **Adaptive translation interval** | 6s fixed is a compromise. Shorten when speech is dense (many words/sec), lengthen during silences. Measure rolling words/sec in the rules engine. |
| Q5 | **Glossary expansion** | The religious/theocratic domain glossary is a key differentiator. Systematically audit missed terms from session exports. |

### Infrastructure

| # | Item | Notes |
|---|------|-------|
| I4 | **Uptime monitoring** | Heroku free-tier dynos restart randomly. UptimeRobot (free) can alert within 1 min of downtime. Point it at `/health`. |
| I5 | **Redis Socket.IO adapter** | Required if ever scaling beyond 1 Heroku dyno. Currently all state is in-process; multiple dynos would split clients across instances. |
| I6 | **Google Cloud Secret Manager** | Replace `google-credentials.json` file with GCP Secret Manager. Prevents accidental credential commit and supports rotation. Requires `secretmanager.googleapis.com` to be enabled. |
| I7 | **Cloud Monitoring / Alerting** | GCP-native alerting on STT error rate, quota exhaustion, and translation latency. Complements Sentry. |
| ~~I8~~ | ~~Session state on reconnect~~ | ✅ **Fixed v130** — server emits `committedTranslation` with each result; client echoes it back in `start-streaming`; server restores dedup state on reconnect |

---

## APIs to Authorize in GCP Console

| API | Why | Priority |
|-----|-----|----------|
| **Secret Manager API** (`secretmanager.googleapis.com`) | Secure credential storage; replace JSON file | Medium |
| **Cloud Speech-to-Text V2** (`speech.googleapis.com` V2 scope) | Chirp model — significantly better recognition quality, especially for non-English and accented speech. Was blocked by PERMISSION_DENIED; worth retrying. | High (when ready) |
| **Cloud Monitoring API** (`monitoring.googleapis.com`) | Quota alerts, latency dashboards, error rate alerting | Low |
| **Cloud Logging API** (`logging.googleapis.com`) | Centralize Winston logs from Heroku into GCP; enables log-based alerting | Low |
| **Cloud Natural Language API** (`language.googleapis.com`) | Could improve sentence segmentation for translation triggering (alternative to current regex approach) | Low / Optional |

> **Already authorized (should be):** Speech V1, Translation V3, Text-to-Speech V1

---

## Professional-Grade Checklist

Things production translation tools typically have that this app currently lacks:

- [ ] **Authentication** — even a simple shared password (H3)
- [ ] **Cost controls** — per-session budget cap, daily quota limit, VAD to stop streaming during silence (H4)
- [ ] **Observability** — Sentry + uptime monitor + latency tracking (I2, I4, I1)
- [ ] **Retry logic** — translation errors silently drop phrases (Q2)
- [x] **Server-side TTS** — ✅ done (v128)
- [x] **Deduplication** — ✅ 3-layer server dedup
- [x] **Stream auto-restart** — ✅ 290s proactive restart
- [x] **Billing tracking** — ✅ PostgreSQL (TTS column pending T1)
- [x] **Custom glossary** — ✅ religious terminology
- [ ] **Audio encoding optimization** — WEBM_OPUS instead of LINEAR16 (A1)
- [ ] **Graceful quota exhaustion handling** — clear user-facing message + pause
- [ ] **HTTPS/WSS enforced** — Heroku enforces this automatically; verify no HTTP fallback
