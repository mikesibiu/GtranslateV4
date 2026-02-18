# GTranslate V4 — Possible Improvements

_Last updated: v129 (2026-02-18)_

---

## Bugs / Known Issues

| # | Issue | File(s) | Notes |
|---|-------|---------|-------|
| ~~B1~~ | ~~Single-word `isFinal` translations~~ | ~~`server.js`~~ | ✅ **Fixed v129** — explicit pre-filter in server.js rejects isFinal results with < 3 words and no sentence ending before calling the rules engine |
| ~~B2~~ | ~~`useServerTTS` not reset on socket reconnect~~ | ~~`index.html`~~ | ✅ **Fixed v129** — `useServerTTS = true` reset in `socket.on('connect', ...)` which fires on every (re)connect |
| ~~B3~~ | ~~iOS Safari AudioContext gesture requirement~~ | ~~`index.html`~~ | **N/A** — Safari not used |
| ~~B4~~ | ~~README is outdated~~ | ~~`README.md`~~ | ✅ **Fixed v129** — README fully rewritten to reflect v129 state |

---

## TTS — Google Cloud (EarBuds Mode)

| # | Improvement | Priority | Notes |
|---|-------------|----------|-------|
| T1 | **TTS billing tracking** — server currently synthesizes without logging character usage | Medium | Add `trackUsage('tts', text.length, targetLang)` in `tts-synthesize` handler after successful synthesis |
| T2 | **Rate-limit `tts-synthesize` events** — no server-side guard against rapid-fire requests from a single socket | High | Add per-socket cooldown (~1s) or queue on server; malicious client could generate large TTS bills |
| T3 | **TTS request deduplication on server** — same text sent twice quickly (e.g., on reconnect) triggers two synthesis calls | Low | Keep a short TTL cache of recent (text, lang) pairs per socket |
| T4 | **TTS queue interrupt on newer content** — if a long phrase is playing and a newer translation arrives, the old audio finishes first creating a delay | Medium | Track `currentSource`; call `source.stop()` when a newer item arrives with significantly different content |
| T5 | **TTS audio feedback indicator** — no UI signal that server TTS is active vs. Web Speech API fallback | Low | Add subtle status badge ("🔊 Google TTS" / "🔊 Browser TTS") in EarBuds mode |
| T6 | **TTS voice selector UI** — voice is fixed to Neural2 defaults; user cannot pick gender/variant | Low | Add a voice selector dropdown in EarBuds settings populated from `TTS_VOICE_MAP` |
| T7 | **TTS MP3 caching** — frequently repeated phrases (e.g., "Amen", "Thank you") are re-synthesized every time | Low | LRU cache on server keyed by `(text, lang)` → Buffer; saves cost + latency |
| T8 | **Expose `speakingRate` control for server TTS** — the `speechRate` slider already exists but server TTS `rate` param is passed; verify it's applied correctly on playback | Low | Confirm `rate: this.speechRate` in `drainTTSQueue` matches expected Neural2 range (0.5–2.0) |

---

## Translation Quality

| # | Improvement | Priority | Notes |
|---|-------------|----------|-------|
| Q1 | **Interim box shows source language for listener** — in EarBuds/TTS modes the interim box should show the last translation instead of the raw STT text | Medium | Implementation was reverted (see `TODO-INTERIM-FIX.md`); fix B1 first, then re-apply |
| Q2 | **Adaptive translation interval** — 6s fixed interval is a compromise; could shorten when speech is dense (many words/sec) and lengthen during silences | Low | Measure words/sec in rolling window, adjust `translationInterval` dynamically |
| Q3 | **Sentence-boundary detection** — translations fired at fixed intervals often cut mid-sentence; could detect strong sentence endings and translate immediately | Medium | Trigger translation when `transcript` ends with `.!?` and ≥5 words received since last translation |

---

## Audio & STT

| # | Improvement | Priority | Notes |
|---|-------------|----------|-------|
| A1 | **System audio (tab capture) on mobile** — `getDisplayMedia` is unavailable on iOS/Android; show a clearer message when user tries | Low | Detect and hide/disable "System Audio" option on mobile |
| A2 | **Noise gate in AudioWorklet** — AGC amplifies background noise during silence; a simple noise gate would reduce false STT triggers | Low | Add energy threshold in `audio-processor.js` below which audio is zeroed |

---

## Infrastructure / Ops

| # | Improvement | Priority | Notes |
|---|-------------|----------|-------|
| I1 | **Health check includes TTS client** — `/health` endpoint currently doesn't verify TTS client is initialized | Low | Add `ttsReady: true/false` field to health response |
| I2 | **Billing dashboard shows TTS costs** — `getUsageSummary` / `getDailyUsage` aggregate `tts` rows but the frontend billing view may not display them | Medium | Update billing UI to render TTS character totals alongside STT/translation |
| I3 | **npm audit vulnerabilities** — 6 vulnerabilities (1 low, 1 moderate, 4 high) flagged after v128 install | High | Run `npm audit fix` and review breaking changes |
| I4 | **Docker image out of date** — Dockerfile doesn't include `@google-cloud/text-to-speech`; image rebuild needed | Medium | Rebuild and push Docker image after v128 |
