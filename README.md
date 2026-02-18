# GTranslate V5 — Real-time Speech Translation

Real-time speech translation web application using Google Cloud Speech-to-Text, Translation, and Text-to-Speech APIs. Unlimited-duration streaming with automatic stream restart.

## Features

- ✅ **Unlimited Duration** — Proactive stream restart every 290s (Google limit ~305s), transparent to the user
- 🎤 **Multiple Audio Sources** — Microphone or system audio (tab/screen capture)
- 🌍 **Multi-language Support** — 10+ languages for speech recognition and translation
- ⚡ **Two Translation Modes**
  - **Talks Mode** — 6-second intervals, visual translation cards for presentations
  - **EarBuds Mode** — 6-second intervals, Google Cloud TTS Neural2 audio output (no visual cards)
- 🔊 **Google Cloud TTS (EarBuds)** — Neural2 voices for ro, en, fr, de, es, it, hu; Web Speech API automatic fallback
- 📊 **Real-time Audio Monitoring** — Visual level meter and adjustable gain control (AGC)
- 📥 **Session Export** — Download translations as JSON
- 🔒 **Production-Ready Security** — CSP headers, CORS protection, rate limiting, connection limits
- 💳 **Billing Tracking** — PostgreSQL-backed usage logging (STT minutes, translation chars, TTS chars)
- 📖 **Custom Glossaries** — Domain-specific terminology via Google Cloud Translation glossary API

## Quick Start

### Prerequisites

1. **Node.js 14+** — [Download](https://nodejs.org/)
2. **Google Cloud Account** with these APIs enabled:
   - Cloud Speech-to-Text
   - Cloud Translation API (Advanced / v3)
   - Cloud Text-to-Speech
3. **Service Account Credentials** — See [SETUP.md](./SETUP.md)

### Installation

```bash
# 1. Install dependencies
npm install

# 2. Place your Google Cloud credentials
# Save as: google-credentials.json

# 3. Start the server
npm start

# 4. Open browser
http://localhost:3003
```

## Project Structure

```
GtranslateV5/
├── server.js                    # Express + Socket.IO backend
├── index.html                   # Full single-file frontend
├── audio-processor.js           # AudioWorklet with AGC
├── translation-rules-engine.js  # Centralized translation decision logic
├── billing-db.js                # PostgreSQL usage tracking
├── package.json
│
├── glossaries/                  # Custom glossary CSV files
├── build-glossary.js            # Glossary builder script
├── GLOSSARY-GUIDE.md
│
├── documents/                   # PDF source files for glossaries
│
├── test/                        # Automated tests (Mocha + Chai)
│
└── SETUP.md
```

## Technology Stack

### Backend
- **Node.js / Express** — Server runtime
- **Socket.IO** — Real-time WebSocket communication
- **@google-cloud/speech** — Speech-to-Text V1 API
- **@google-cloud/translate** — Translation V3 API (with glossary support)
- **@google-cloud/text-to-speech** — Neural2 TTS for EarBuds mode
- **pg (PostgreSQL)** — Billing/usage persistence
- **Winston** — Structured logging

### Frontend
- **Vanilla JavaScript** — No framework dependencies
- **Web Audio API / AudioWorklet** — Audio capture with AGC
- **Web Audio API (AudioContext)** — MP3 playback for server TTS
- **Socket.IO Client** — Real-time communication

## Translation Modes

| Mode | Interval | Output | TTS |
|------|----------|--------|-----|
| Talks | 6s | Visual cards | Off |
| EarBuds | 6s | Audio only | Google Cloud Neural2 |

EarBuds mode automatically falls back to the browser's Web Speech API if the server TTS returns an error, and re-enables server TTS on the next reconnect.

## Security Features

- ✅ Server-side input validation and sanitization
- ✅ Audio data rate limiting (2 MB/sec)
- ✅ Content Security Policy (CSP) headers
- ✅ CORS with origin whitelist
- ✅ Maximum connection limits (global & per-IP)
- ✅ Session inactivity timeout (30 min default)
- ✅ Maximum auto-restart attempts (10)

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3003` | Server port |
| `NODE_ENV` | `development` | Environment |
| `GOOGLE_APPLICATION_CREDENTIALS` | `./google-credentials.json` | Credentials path |
| `GOOGLE_CLOUD_PROJECT` | _(from credentials)_ | GCP project ID |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | Translation API location |
| `MAX_CONNECTIONS` | `50` | Max concurrent connections |
| `MAX_CONNECTIONS_PER_IP` | `5` | Max connections per IP |
| `INACTIVITY_TIMEOUT` | `1800000` | Session timeout (ms) |
| `GLOSSARY_ENABLED` | `false` | Enable custom glossary |
| `TRANSLATION_MODEL` | `advanced` | Translation model |

## Custom Glossaries

Improve translation accuracy with custom glossaries. See [GLOSSARY-GUIDE.md](./GLOSSARY-GUIDE.md).

```bash
node build-glossary.js
```

## Testing

```bash
npm test              # All tests
npm run test:unit     # Unit tests only
npm run test:integration  # Integration tests only
```

## Browser Compatibility

- ✅ **Chrome / Edge** — Full support
- ✅ **Firefox** — Full support
- ✅ **Mobile browsers** — Microphone only (no system audio)

## API Costs (approximate)

| API | Rate |
|-----|------|
| Speech-to-Text | ~$0.006 / 15 s |
| Translation (Advanced) | ~$20 / 1M chars |
| Text-to-Speech (Neural2) | ~$16 / 1M chars |

Estimate: ~$0.50–2.00 per hour of continuous use.

## Troubleshooting

**No audio detected**
1. Check browser microphone permissions
2. Verify audio source selection
3. Adjust gain slider (1×–20×)
4. Check audio level meter

**WebSocket connection issues**
1. Check firewall / proxy settings
2. Verify port 3003 is accessible
3. Check browser console for errors

**Translation errors**
1. Verify Google Cloud credentials and enabled APIs
2. Review server logs: `logs/gtranslate-v4.log`

## Development

```bash
npm run dev       # Start with nodemon (auto-reload)
npm run test:watch  # Tests in watch mode
```

---

**Version:** v129
**Last Updated:** February 2026
