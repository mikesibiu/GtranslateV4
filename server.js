/**
 * GTranslate V4 Server
 * Real-time speech translation using Google Cloud Speech-to-Text API
 * Stream proactively restarts at 290s (Google Cloud limit is ~305s)
 */

const crypto = require('crypto');
const cron = require('node-cron');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const speech = require('@google-cloud/speech');
const { TranslationServiceClient } = require('@google-cloud/translate').v3;
const winston = require('winston');
const path = require('path');
const fs = require('fs');
const billingDb = require('./billing-db');
const TranslationRulesEngine = require('./translation-rules-engine');
const { applyTermMappings, verifyReligiousTerms, preserveSourceNumbers, preserveDates, extractByWordLCP } = require('./translation-post-processor');
const session = require('express-session');

// ===== CONFIGURATION =====
// Load environment variables if .env file exists
try {
    require('dotenv').config();
} catch (e) {
    // dotenv not installed, use defaults
}

// Load config.json for tunable parameters (env vars still override)
let APP_CONFIG = {};
try {
    APP_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (e) {
    // config.json is optional — defaults below cover all values
}

const PORT = process.env.PORT || 3003;
const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS || String(APP_CONFIG.connection?.maxConnections || 50));
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP || String(APP_CONFIG.connection?.maxConnectionsPerIp || 5));
const INACTIVITY_TIMEOUT = parseInt(process.env.INACTIVITY_TIMEOUT || String(APP_CONFIG.connection?.inactivityTimeoutMs || 30 * 60 * 1000));
const MAX_AUDIO_CHUNK_SIZE = APP_CONFIG.audio?.maxChunkSize || 1024 * 1024; // 1MB per chunk
const STREAM_DURATION_LIMIT_MS = APP_CONFIG.stream?.durationLimitMs || 290000; // Proactive restart at 290s (Google limit is ~305s)
const TRANSLATION_TIMEOUT_MS = APP_CONFIG.translation?.timeoutMs || 15000; // Timeout for Google Translate API calls

const APP_PASSWORD = process.env.APP_PASSWORD || null;

// Guard: SESSION_SECRET must be set in production — hardcoded fallback is a security hole
if (NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    console.error('FATAL: SESSION_SECRET environment variable is not set. Refusing to start in production.');
    process.exit(1);
}
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'gtranslate-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }
});

// ===== LOGGING SETUP =====
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}
const LOG_FILE = path.join(LOG_DIR, 'gtranslate-v4.log');

// Initialize logger FIRST before using it
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || (NODE_ENV === 'production' ? 'info' : 'debug'),
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : '';
            return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: LOG_FILE })
    ]
});

// ===== GOOGLE CLOUD CREDENTIALS SETUP =====
// Support both file-based (local/Docker) and environment variable (Heroku) credentials
let googleCredentials;
let CREDENTIALS_PATH;
let credentialsProjectId = null;

if (process.env.GOOGLE_CREDENTIALS_JSON_B64) {
    // Koyeb deployment: base64-encoded JSON (avoids shell quoting issues with multiline JSON)
    try {
        const json = Buffer.from(process.env.GOOGLE_CREDENTIALS_JSON_B64, 'base64').toString('utf8');
        googleCredentials = JSON.parse(json);
        credentialsProjectId = googleCredentials.project_id || null;
        logger.info('✅ Using Google credentials from base64 environment variable');
    } catch (error) {
        logger.error('❌ Failed to parse GOOGLE_CREDENTIALS_JSON_B64 environment variable');
        logger.error('Error:', error.message);
        process.exit(1);
    }
} else if (process.env.GOOGLE_CREDENTIALS_JSON) {
    // Heroku/Cloud deployment: credentials from environment variable
    try {
        googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        credentialsProjectId = googleCredentials.project_id || null;
        logger.info('✅ Using Google credentials from environment variable');
    } catch (error) {
        logger.error('❌ Failed to parse GOOGLE_CREDENTIALS_JSON environment variable');
        logger.error('Error:', error.message);
        process.exit(1);
    }
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Docker/VM deployment: credentials from file path
    const credPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    const appDir = path.resolve(__dirname);

    // Resolve symlinks to get real path and prevent traversal attacks
    let realCredPath;
    try {
        realCredPath = fs.realpathSync(credPath);
    } catch (error) {
        logger.error('❌ Credentials file does not exist or is not accessible', {
            providedPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            resolvedPath: credPath,
            error: error.message
        });
        process.exit(1);
    }

    // Only allow credentials files within the application directory or standard system paths
    const allowedDirs = [appDir, '/usr/', '/etc/'];
    const isAllowed = allowedDirs.some(dir => realCredPath.startsWith(path.resolve(dir)));
    if (isAllowed) {
        // Ensure it's actually a file, not a directory
        const stats = fs.statSync(realCredPath);
        if (!stats.isFile()) {
            logger.error('❌ Credentials path is not a file', { realCredPath });
            process.exit(1);
        }
        CREDENTIALS_PATH = realCredPath;
    } else {
        logger.error('❌ Credentials path outside allowed directories', { credPath, realCredPath });
        process.exit(1);
    }
    try {
        const rawCreds = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
        const parsedCreds = JSON.parse(rawCreds);
        credentialsProjectId = parsedCreds.project_id || null;
    } catch (error) {
        logger.warn('⚠️ Unable to read project_id from credentials file', { error: error.message });
    }
} else {
    // Local development: credentials from default file
    CREDENTIALS_PATH = path.join(__dirname, 'google-credentials.json');
    if (fs.existsSync(CREDENTIALS_PATH)) {
        try {
            const rawCreds = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
            const parsedCreds = JSON.parse(rawCreds);
            credentialsProjectId = parsedCreds.project_id || null;
        } catch (error) {
            logger.warn('⚠️ Unable to read project_id from default credentials', { error: error.message });
        }
    }
}

// ===== CHECK CREDENTIALS =====
if (googleCredentials) {
    // Using credentials from environment variable (Heroku)
    // Google Cloud clients will be initialized with explicit credentials
} else if (CREDENTIALS_PATH && fs.existsSync(CREDENTIALS_PATH)) {
    // Using credentials from file (local/Docker)
    process.env.GOOGLE_APPLICATION_CREDENTIALS = CREDENTIALS_PATH;
} else {
    logger.error('❌ Credentials not found!');
    logger.error('Please provide credentials via:');
    logger.error('  1. GOOGLE_CREDENTIALS_JSON environment variable (Heroku/Cloud)');
    logger.error('  2. GOOGLE_APPLICATION_CREDENTIALS path (Docker/VM)');
    logger.error('  3. google-credentials.json file (Local development)');
    process.exit(1);
}

// ===== INITIALIZE GOOGLE CLOUD CLIENTS =====
const speechClient = googleCredentials
    ? new speech.SpeechClient({ credentials: googleCredentials })
    : new speech.SpeechClient();

const translateClient = googleCredentials
    ? new TranslationServiceClient({ credentials: googleCredentials })
    : new TranslationServiceClient();

// Get project ID and location for v3 API
const projectId = googleCredentials?.project_id || credentialsProjectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const parent = projectId ? `projects/${projectId}/locations/${location}` : null;
// Two unidirectional glossaries — one per translation direction.
// Both contain the same 734 JW domain entries; the en→ro one has columns swapped.
const roEnGlossaryPath = parent ? `${parent}/glossaries/ro-en-religious-terms` : null;
const enRoGlossaryPath = parent ? `${parent}/glossaries/en-ro-religious-terms` : null;
// Helper: pick the right glossary path for a given translation direction
function getGlossaryPath(sourceLangCode, targetLangCode) {
    if (sourceLangCode === 'ro' && targetLangCode === 'en') return roEnGlossaryPath;
    if (sourceLangCode === 'en' && targetLangCode === 'ro') return enRoGlossaryPath;
    return null; // no glossary for other language pairs
}
const translationModel = process.env.TRANSLATION_MODEL || 'advanced';

if (!projectId) {
    logger.error('❌ No Google Cloud project ID found - translations will fail');
    logger.error('Set project ID via:');
    logger.error('  1. GOOGLE_CLOUD_PROJECT environment variable');
    logger.error('  2. GCP_PROJECT environment variable');
    logger.error('  3. project_id in credentials JSON');
    process.exit(1);
}

logger.info('✅ Google Cloud Speech-to-Text client initialized');
logger.info('✅ Google Cloud Translation v3 client initialized', {
    projectId,
    location,
    translationModel,
    roEnGlossary: roEnGlossaryPath || 'disabled',
    enRoGlossary: enRoGlossaryPath || 'disabled',
});

// Log startup configuration
logger.info('Server Configuration', {
    nodeEnv: NODE_ENV,
    port: PORT,
    maxConnections: MAX_CONNECTIONS,
    maxConnectionsPerIP: MAX_CONNECTIONS_PER_IP,
    inactivityTimeoutMs: INACTIVITY_TIMEOUT
});

// ===== EXPRESS SETUP =====
const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);
app.use(sessionMiddleware);

// Security headers middleware
app.use((req, res, next) => {
    // Content Security Policy
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self' ws: wss:; " +
        "img-src 'self' data:; " +
        "font-src 'self'; " +
        "object-src 'none'; " +
        "base-uri 'self'; " +
        "form-action 'self'; " +
        "frame-ancestors 'none'; " +
        "upgrade-insecure-requests"
    );

    // Other security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'microphone=*, camera=(), geolocation=(), payment=()');

    next();
});

// Build CORS allowlist once at startup (not per-request)
const _allowedOriginsSet = new Set([
    'http://localhost:3003',
    'http://127.0.0.1:3003',
    'https://gtranslate-v4-96dfeefd9842.herokuapp.com',
    'https://gtranslate.farace.net',
    'https://translate.farace.net',
    'https://gtranslate-mysysadmin-aa6fe3a2.koyeb.app'
]);
// Allow additional origins from ALLOWED_ORIGINS env var (comma-separated)
if (process.env.ALLOWED_ORIGINS) {
    process.env.ALLOWED_ORIGINS.split(',').forEach(o => {
        const trimmed = o.trim();
        if (trimmed) _allowedOriginsSet.add(trimmed);
    });
}

// Strengthen CORS configuration
const io = socketIo(server, {
    cors: {
        origin: (origin, callback) => {
            // Allow same-origin requests (no origin header)
            if (!origin) return callback(null, true);

            if (_allowedOriginsSet.has(origin)) {
                callback(null, true);
            } else {
                logger.warn('CORS blocked origin', { origin });
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["Content-Type"]
    },
    // Additional Socket.IO security
    maxHttpBufferSize: 1e6, // 1MB max
    pingTimeout: 60000,
    pingInterval: 25000
});

io.engine.use(sessionMiddleware);

function requireAuth(req, res, next) {
    if (!APP_PASSWORD) return next();
    if (req.session && req.session.authenticated) return next();
    if (req.path && req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required' });
    res.redirect('/login');
}

app.get('/login', (req, res) => {
    if (!APP_PASSWORD || (req.session && req.session.authenticated)) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const password = (req.body && req.body.password) || '';
    if (APP_PASSWORD && password === APP_PASSWORD) {
        req.session.authenticated = true;
        return res.redirect('/');
    }
    res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/billing', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'billing.html'));
});

app.get('/audio-processor.js', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'audio-processor.js'));
});

app.get('/client-utils.js', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'client-utils.js'));
});

app.get('/client.js', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'client.js'));
});

app.get('/client-audio.js', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'client-audio.js'));
});

app.get('/client-session.js', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'client-session.js'));
});

app.get('/client-tts.js', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'client-tts.js'));
});

app.get('/client-init.js', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'client-init.js'));
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// ===== BILLING API ENDPOINTS =====

// Track usage (called from client)
app.post('/api/billing/track', requireAuth, express.json(), async (req, res) => {
    try {
        const { type, amount, language } = req.body;

        // Validate input
        if (!type || !amount || !language) {
            return res.status(400).json({ error: 'Missing required fields: type, amount, language' });
        }

        if (!['stt', 'translation', 'glossary'].includes(type)) {
            return res.status(400).json({ error: 'Invalid type. Must be: stt, translation, or glossary' });
        }

        if (typeof amount !== 'number' || amount < 0) {
            return res.status(400).json({ error: 'Amount must be a positive number' });
        }

        // Cap per-request amount to prevent data inflation from malformed/malicious clients
        const MAX_BILLING_AMOUNT = 50000;
        if (amount > MAX_BILLING_AMOUNT) {
            return res.status(400).json({ error: `Amount exceeds maximum allowed value (${MAX_BILLING_AMOUNT})` });
        }

        // Track usage in database
        const success = await billingDb.trackUsage(type, amount, language);

        if (success) {
            res.json({ success: true });
        } else {
            res.status(500).json({ error: 'Failed to track usage' });
        }
    } catch (error) {
        logger.error('Error tracking billing usage:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get usage summary
app.get('/api/billing/summary', requireAuth, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        // Default to current month if no dates provided
        const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        const end = endDate ? new Date(endDate) : new Date();

        const summary = await billingDb.getUsageSummary(start, end);

        res.json({
            success: true,
            startDate: start.toISOString().split('T')[0],
            endDate: end.toISOString().split('T')[0],
            data: summary
        });
    } catch (error) {
        logger.error('Error getting billing summary:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get daily usage for charts
app.get('/api/billing/daily', requireAuth, async (req, res) => {
    try {
        const days = parseInt(req.query.days || '30');

        if (days < 1 || days > 365) {
            return res.status(400).json({ error: 'Days must be between 1 and 365' });
        }

        const dailyUsage = await billingDb.getDailyUsage(days);

        res.json({
            success: true,
            days,
            data: dailyUsage
        });
    } catch (error) {
        logger.error('Error getting daily usage:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===== INTERNAL CAPTURE ENDPOINT =====
// Called by cron-job.org at scheduled meeting times to snapshot translation_log → meeting_snapshots.
// Auth: Bearer token via CAPTURE_TOKEN env var (set on Koyeb).

// Simple in-memory rate limiter: max 10 calls per minute
const _captureCalls = [];
function _captureRateOk() {
    const now = Date.now();
    const cutoff = now - 60000;
    while (_captureCalls.length && _captureCalls[0] < cutoff) _captureCalls.shift();
    if (_captureCalls.length >= 10) return false;
    _captureCalls.push(now);
    return true;
}

app.post('/internal/capture-logs', express.json({ limit: '4kb' }), async (req, res) => {
    if (!_captureRateOk()) {
        return res.status(429).json({ error: 'Too many requests' });
    }

    const captureToken = process.env.CAPTURE_TOKEN;
    if (!captureToken) {
        return res.status(503).json({ error: 'Capture endpoint not configured' });
    }

    const authHeader = req.headers['authorization'] || '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    // Constant-time comparison to prevent timing attacks
    const tokensMatch = provided.length === captureToken.length &&
        crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(captureToken));
    if (!tokensMatch) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Restrict label to safe characters only
    const rawLabel = (req.body && req.body.label) ? String(req.body.label) : 'manual';
    const label = /^[\w-]{1,64}$/.test(rawLabel) ? rawLabel : 'manual';

    try {
        const count = await billingDb.captureSnapshot(label);
        logger.info(`📸 Meeting snapshot captured: ${count} rows, label="${label}"`);
        res.json({ success: true, rows: count, label });
    } catch (error) {
        logger.error('Capture snapshot error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===== HELPER FUNCTIONS =====

/**
 * Translation with exponential backoff retry logic
 * Uses Translation API v3 with glossary support for improved accuracy
 * Handles transient failures (503, 429, network errors) and glossary fallback
 */
async function translateWithRetry(text, targetLang, sourceLanguage, clientId, maxRetries = 3) {
    if (!parent) {
        logger.error('Translation failed - no project ID configured', { clientId });
        throw new Error('Translation service not properly configured');
    }

    // Validate source language
    if (!sourceLanguage || typeof sourceLanguage !== 'string') {
        logger.error('Invalid source language parameter', { clientId, sourceLanguage });
        throw new Error('Source language is required for translation');
    }

    // Pick direction-appropriate glossary (ro→en or en→ro; null for other pairs)
    const sourceLangCode = sourceLanguage.includes('-')
        ? sourceLanguage.split('-')[0]
        : sourceLanguage;
    let activeGlossaryPath = getGlossaryPath(sourceLangCode, targetLang);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Build translation request
            const request = {
                parent: parent,
                contents: [text],
                mimeType: 'text/plain',
                sourceLanguageCode: sourceLangCode,
                targetLanguageCode: targetLang,
            };

            // Add model parameter only if using 'nmt' (standard neural translation)
            // Don't specify model to use Google's latest/best automatic model selection
            if (translationModel === 'nmt') {
                request.model = `${parent}/models/nmt`;
            }
            // For 'advanced', omit model parameter to use Google's best available model

            // Add direction-appropriate glossary if available
            if (activeGlossaryPath) {
                request.glossaryConfig = {
                    glossary: activeGlossaryPath,
                    ignoreCase: true  // Case-insensitive for JW domain terms
                };
                logger.debug('Using glossary for translation', { glossaryPath: activeGlossaryPath, clientId });
            }

            const [response] = await translateClient.translateText(request);

            // When a glossary was applied, prefer glossary_translations (glossary-aware result)
            const translation = (activeGlossaryPath && response.glossaryTranslations?.length)
                ? response.glossaryTranslations[0].translatedText
                : response.translations[0].translatedText;

            return translation;
        } catch (error) {
            const errorCode = error.code ? String(error.code) : '';
            const errorMessage = error.message || '';

            // Check if this is a glossary-related error
            const isGlossaryError = errorMessage.includes('glossary') ||
                                   errorMessage.includes('NOT_FOUND') ||
                                   errorCode === '5'; // NOT_FOUND code

            // If glossary error on first attempt with glossary, retry without glossary
            if (isGlossaryError && activeGlossaryPath) {
                logger.warn('Glossary not found or error, retrying without glossary', {
                    clientId,
                    glossaryPath: activeGlossaryPath,
                    error: errorMessage
                });
                activeGlossaryPath = null;
                // Don't count this as a retry attempt - try again immediately
                attempt--;
                continue;
            }

            // Check if error is retryable (transient network/service issues)
            const isRetryable = errorCode === '503' ||
                               errorCode === '429' ||
                               errorCode === '14' ||  // UNAVAILABLE
                               errorCode === '8' ||   // RESOURCE_EXHAUSTED
                               error.code === 503 ||
                               error.code === 429 ||
                               error.code === 14 ||
                               error.code === 8 ||
                               error.code === 'ECONNRESET' ||
                               error.code === 'ETIMEDOUT' ||
                               error.code === 'UNAVAILABLE' ||
                               error.code === 'RESOURCE_EXHAUSTED';

            if (!isRetryable || attempt === maxRetries) {
                logger.error('Translation failed (non-retryable or max retries)', {
                    clientId,
                    attempt,
                    error: errorMessage,
                    code: error.code,
                    sourceLanguage,
                    targetLang,
                    usedGlossary: !!activeGlossaryPath
                });
                throw error;
            }

            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            logger.warn(`Translation retry ${attempt}/${maxRetries}`, {
                clientId,
                error: errorMessage,
                code: error.code,
                delayMs: delay
            });
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// ===== SOCKET.IO CONNECTION HANDLING =====
let activeConnections = 0;
const connectionsByIp = new Map(); // Track connections per IP

io.on('connection', (socket) => {
    // Reject unauthenticated socket connections
    if (APP_PASSWORD && !(socket.request.session && socket.request.session.authenticated)) {
        socket.emit('connection-error', { message: 'Authentication required', code: 'UNAUTHORIZED' });
        socket.disconnect(true);
        return;
    }

    // Get client IP address (trust proxy: read x-forwarded-for behind Heroku/Koyeb)
    const xForwardedFor = socket.handshake.headers['x-forwarded-for'];
    const clientIp = xForwardedFor
        ? xForwardedFor.split(',')[0].trim()
        : (socket.handshake.address || socket.conn.remoteAddress);

    // Check global connection limit
    if (activeConnections >= MAX_CONNECTIONS) {
        logger.warn('Connection rejected - max connections reached', {
            activeConnections,
            maxConnections: MAX_CONNECTIONS,
            clientIp
        });
        socket.emit('connection-error', {
            message: 'Server is at maximum capacity. Please try again later.'
        });
        socket.disconnect(true);
        return;
    }

    // Check per-IP connection limit
    const ipConnections = connectionsByIp.get(clientIp) || 0;
    if (ipConnections >= MAX_CONNECTIONS_PER_IP) {
        logger.warn('Connection rejected - max connections per IP reached', {
            clientIp,
            connections: ipConnections,
            maxPerIp: MAX_CONNECTIONS_PER_IP
        });
        socket.emit('connection-error', {
            message: 'Too many connections from your IP address. Please try again later.'
        });
        socket.disconnect(true);
        return;
    }

    activeConnections++;
    connectionsByIp.set(clientIp, ipConnections + 1);

    const clientId = socket.id.substring(0, 8);

    logger.info('✅ Client connected', {
        socketId: socket.id,
        clientIp,
        totalConnections: activeConnections,
        ipConnections: ipConnections + 1
    });

    let recognizeStream = null;
    let currentLanguage = 'ro-RO';
    let targetLanguage = 'en';
    let accumulatedText = '';
    let translationCount = 0;
    let sessionActive = false;
    let restartStreamTimer = null;
    let lastInterimText = '';
    let lastTranslationTime = null; // Track when last translation happened for 15s max interval
    let lastTranslatedText = ''; // Track concatenated source text already translated
    let translationInterval = 6000; // Store translation interval for restarts
    let lastActivityTime = Date.now();
    let inactivityTimer = null;
    const INACTIVITY_TIMEOUT_MS = INACTIVITY_TIMEOUT; // Use config value
    let isRestarting = false; // Prevent race conditions during auto-restart
    let translationInFlight = false; // Prevent concurrent translations (race condition fix)
    let pendingTranslationQueue = []; // Queue of deferred final translations (replaces single slot — fast speakers fired multiple isFinals while one was in-flight, middle sentences were silently dropped)
    const MAX_PENDING_QUEUE_DEPTH = 4; // Drop oldest when queue exceeds this depth (prevents flood on network spike)
    let restartTimeout = null; // Track the scheduled restart timeout
    let restartAttempts = 0; // Track restart attempts
    const MAX_RESTART_ATTEMPTS = 10; // Maximum auto-restart attempts
    let audioBufferDuringRestart = []; // Buffer audio during stream restarts
    let audioBufferWarned = false; // Flag to log buffer-full warning only once
    let streamDurationTimer = null; // Proactive restart timer (290s)
    const MAX_AUDIO_BUFFER_SIZE = 50; // Max chunks to buffer (prevent memory issues)
    let translationRules = null; // Centralized translation rules engine
    let currentMode = 'talks'; // Persist selected mode across restarts
    let consecutiveAudioTimeouts = 0; // Guard against infinite restart storm during silence
    let lastTextChangeTime = Date.now(); // Track when text last changed for pause detection
    // v160: full-text-then-extract restored with the KEY FIX: committedTranslation = translatedFull
    // (not committedTranslation = prev_committed + emitted, which caused cascade divergence in v155)
    let committedTranslation = ''; // Full translation emitted so far (reset on session start)
    let lastFullTranslation = ''; // Last full-transcript translation (for LCP matching)

    // Domain-specific STT phrase hints to reduce mis-hearings (e.g., “vestitori”)
    // STT phrase hints — boost domain-specific vocabulary the base model struggles with.
    //
    // RULES FOR THIS LIST:
    //  1. Only include words/phrases that actually fail without hints.
    //  2. Prefer multi-word phrases over single tokens — single-token hints cause the
    //     decoder to commit early, then decode the NEXT word with weakened beam energy,
    //     producing garbles in the immediately following word (confirmed root cause).
    //  3. NEVER include high-frequency Romanian function words or particles.
    //     “mai” (meaning “more/also/still”) appears in virtually every sentence;
    //     boosting it at any level creates a global attractor that garbles adjacent tokens.
    //  4. Boost is set to 10 (half of Google's documented max of 20). Max boost=20
    //     explicitly increases false positives per Google documentation.
    const STT_PHRASE_HINTS = [
        'vestitori',
        'Martorii lui Iehova',
        // Convention vocabulary — use only multi-word forms to avoid early-commit garbling
        // (single-token 'congres'/'congrese' removed: they caused adjacent-word substitutions)
        'congres special',
        'congrese speciale',
        'congres regional',
        'congrese regionale',
        'congres de circuit',
        'congrese de circuit',
        'asistența totală',
        'glosar',
        'traducere',
        'EarBuds',
        'gheață',
        'gheată',
        'Noua Zeelandă',
        'New Zealand',
        'New York',
        'New World',
        'nume nou',
        'nume noi',
        // Joy/rejoice vocabulary — prevents “bucuriei” → English “rejoice” code-switch
        'bucurie',
        'bucuriei',
        'bucurați-vă',
        'bucurați',
        'cartea bucuriei',
        // Congregation — prevents STT code-switch and helps Translation API pick “congregation” not “church”
        'congregație',
        'congregației',
        'congregațiile',
        'congregații',
        // Location/context terms
        'domiciliu',   // prevents mishearing as “domesti” (house arrest / home territory)
        'Domești',     // Romanian village name (JW preaching territory reports)
        'Tongo',       // stadium/venue name (STT garbles to “Togo” — country in Africa)
        // Hospitality/kindness vocabulary — prevents “bunătate” (kindness) → “bani” (money)
        'bunătate',
        'bunătatea',
        'cu bunătate',
        // Biblical people — commonly garbled by STT in JW meeting context
        // NOTE: Single-token proper nouns are an accepted exception to the multi-word preference.
        // Biblical names have no adjacent-word ambiguity the decoder can exploit, so early-commit
        // risk is low. All other hints below remain multi-word.
        'Isaia',       // Isaiah → STT produces "Nisa aia", "zona" etc. for Bible book references
        'Ieremia',     // Jeremiah
        'Ezechiel',    // Ezekiel
        'Avraam',      // Abraham
        'David',       // King David → STT produced "Daddy" (Yankee) in one session
        'Iacov',       // Jacob → STT produced "Yankee" in one session
        'Moise',       // Moses
        'Varnava',     // Barnabas → STT produced "banaval" (2026-04-05 session)
        'Barnaba',     // alternate Romanian form of Barnabas
        'Galileea',    // Galilee — proper noun, acceptable single-token exception
        // New Testament locations — multi-word forms for Sea of Galilee
        'marea Galileii',    // Sea of Galilee
        'marea Galileei',    // alternate genitive form
        // Bible books often referenced by short name — use multi-word to avoid false-positives
        // ('fapte' = "deeds/actions" in ordinary speech — single token would over-commit)
        'Fapte apostolilor', // Acts of the Apostles
        'cartea Fapte',      // "the book of Acts" reference form
        // Motivation vocabulary — prevents STT substitution pură→fură (2026-04-05 session)
        'motivație pură',    // pure motivation
        'motivație greșită', // wrong motivation
        // Demon possession — referenced in Acts/Gospels discussions
        'posedat de demon',
        'posedate de demon',
        'posedat de demoni',
        // Prostration/bowing — s-au plătit (paid) confused with s-au plecat (bowed)
        's-au plecat',       // they bowed
        's-au prosternat',   // they prostrated themselves
        // Field service/ministry vocabulary
        'serviciul de predicare',  // preaching service/ministry
        'serviciul de teren',      // field service
        // Biblical Hebrew words in common Romanian JW use
        'cei răi',     // the wicked ones → STT produced "cei răni" (wounded) — Matthew 5:45
        'cei drepți',  // the righteous ones
        'cei buni',    // the good ones
        // Months — Romanian only; 'mai' OMITTED (it's the most common Romanian particle;
        // boosting it globally destroys token-boundary stability throughout every sentence)
        'ianuarie','februarie','martie','aprilie','iunie','iulie','august','septembrie','octombrie','noiembrie','decembrie',
        'january','february','march','april','may','june','july','august','september','october','november','december',
        // Watchtower magazine — prevents STT from garbling "Turnul de Veghe" to phonetic variants
        'Turnul de Veghe',
        'revista Turnul de Veghe',
        // Romanian name "Edi" — prevents Google STT from mishearing as other words
        'Edi',
        // Convention — definite article forms ("congresul/adunarea") not covered by bare "congres" hints
        // STT mishears "congresul de circuit" as "congresul de tip construcție" without boosting
        'congresul de circuit',
        'congresul regional',
        'congresul special',
        'adunare de circuit',
        'adunarea de circuit',
        'adunarea locală',
        // Core religious figures — bare forms needed; "gumă"/"mama" misheard from these
        // Single-token proper nouns are acceptable (no adjacent-word ambiguity risk)
        'Iehova',
        'Isus',
        'Isus Hristos',
        'Dumnezeu',
        // Daniel 12:4 — "sigilează" (seal up) misheard as "frigideaza" (non-word)
        // Using phrase form only (safer than bare verb — avoids early-commit on the following word)
        'sigilează cartea',
        // New Testament disciples — "ucenicii" misheard as "felii" (slices)
        'ucenicii',
        'ucenicul',
        // Bible study vocabulary — "studiul" misheard as "soțul" (husband)
        'studiul'
    ];

    // Helper function to update last activity time
    function updateActivity() {
        lastActivityTime = Date.now();

        // Clear existing inactivity timer
        if (inactivityTimer) {
            clearTimeout(inactivityTimer);
        }

        // Set new inactivity timer
        if (sessionActive) {
            inactivityTimer = setTimeout(() => {
                const inactiveMinutes = Math.floor((Date.now() - lastActivityTime) / 60000);
                logger.warn('Session timeout due to inactivity', {
                    clientId,
                    inactiveMinutes,
                    translationCount
                });

                sessionActive = false;
                cleanupStream();

                socket.emit('session-timeout', {
                    message: `Session stopped due to ${Math.floor(INACTIVITY_TIMEOUT_MS / 60000)} minutes of inactivity`,
                    inactiveMinutes
                });
            }, INACTIVITY_TIMEOUT_MS);
        }
    }

    // Helper function to clean up stream properly
    function cleanupStream() {
        isRestarting = false; // Cancel any pending auto-restart
        translationInFlight = false; // Reset so new sessions aren't blocked
        pendingTranslationQueue = []; // Discard any deferred translations
        lastTranslatedText = '';
        lastInterimText = ''; // BUG-13: prevent stale pause-timer retranslation after restart

        // Cancel proactive stream duration timer
        if (streamDurationTimer) {
            clearTimeout(streamDurationTimer);
            streamDurationTimer = null;
        }

        // Cancel any pending restart timeout
        if (restartTimeout) {
            clearTimeout(restartTimeout);
            restartTimeout = null;
        }

        if (recognizeStream) {
            try {
                // Remove all event listeners to prevent memory leaks
                recognizeStream.removeAllListeners('error');
                recognizeStream.removeAllListeners('end');
                recognizeStream.removeAllListeners('close');
                recognizeStream.removeAllListeners('data');
                recognizeStream.removeAllListeners('pipe');
                recognizeStream.removeAllListeners('unpipe');

                // End the stream if it's still writable
                if (recognizeStream.writable) {
                    recognizeStream.end();
                }

                recognizeStream = null;
            } catch (error) {
                logger.error('Error cleaning up stream', {
                    clientId,
                    error: error.message
                });
                recognizeStream = null;
            }
        }
    }

    // Helper function to schedule auto-restart (prevents code duplication)
    // Guards against double-fire from both 'end' and 'close' events
    function scheduleAutoRestart() {
        if (!sessionActive || isRestarting) {
            recognizeStream = null; // Still clear stale reference
            return; // Already restarting or session ended
        }

        isRestarting = true;

        // Cancel any pending restart timeout
        if (restartTimeout) {
            clearTimeout(restartTimeout);
            restartTimeout = null;
        }

        restartAttempts++;

        if (restartAttempts > MAX_RESTART_ATTEMPTS) {
            logger.error('❌ Maximum restart attempts exceeded', {
                clientId,
                attempts: restartAttempts
            });
            sessionActive = false;
            isRestarting = false;
            cleanupStream();
            socket.emit('recognition-error', {
                message: 'Stream restarted too many times. Please refresh the page and try again.',
                code: 'MAX_RESTARTS_EXCEEDED'
            });
            return;
        }

        logger.info('🔄 Auto-restarting stream...', {
            clientId,
            attempt: restartAttempts,
            maxAttempts: MAX_RESTART_ATTEMPTS
        });

        // Remove listeners from old stream BEFORE nulling it.
        // Without this, the dying stream fires 'end'/'close' AFTER the new stream starts,
        // triggering scheduleAutoRestart() again on the healthy new stream — killing it.
        // This cascade caused Audio Timeout every 10s after any silence period.
        if (recognizeStream) {
            try {
                recognizeStream.removeAllListeners('error');
                recognizeStream.removeAllListeners('end');
                recognizeStream.removeAllListeners('close');
                recognizeStream.removeAllListeners('data');
                // After stripping listeners, attach a silent no-op error handler.
                // Duplexify/_destroy fires a second 'error' event asynchronously during
                // stream teardown (via process.processTicksAndRejections). Without this,
                // that deferred error has no listener → uncaught → process crash.
                recognizeStream.on('error', () => {});
            } catch (e) { /* ignore */ }
        }
        recognizeStream = null;
        translationInFlight = false; // BUG-21: prevent deadlock if translation was mid-flight at restart
        pendingTranslationQueue = []; // Discard queued translations — stale after stream restart

        restartTimeout = setTimeout(() => {
            restartTimeout = null;
            if (sessionActive && isRestarting) {
                // isRestarting cleared inside createRecognitionStream after buffer flush (TOCTOU fix)
                createRecognitionStream(currentLanguage, targetLanguage, translationInterval, currentMode, true)
                    .catch((error) => {
                        logger.error('Failed to restart stream', { clientId, error: error.message });
                        isRestarting = false; // Clear on error so audio stops buffering
                    });
            } else {
                isRestarting = false;
            }
        }, 0); // No delay - restart immediately
    }

    // Fallback single-word translations for common Romanian terms that may pass through unchanged
    const FALLBACK_TRANSLATIONS = {
        gheata: 'ice',
        gheată: 'boot',
        gheață: 'ice'
    };


    /**
     * Full-text translation with LCP extraction (v160).
     *
     * Sends the full STT transcript to Google Translate for maximum context quality,
     * then extracts only the new (unemitted) portion using word-level LCP matching.
     *
     * KEY FIX vs v155: committedTranslation = translatedFull (not += emitted),
     * so each subsequent LCP match compares the whole previous full translation —
     * eliminating the divergence cascade that broke v150–v156.
     *
     * Fallback: if LCP match ratio < 60%, translates decision.newText (the delta chunk)
     * directly — same as v157. committedTranslation is still set to translatedFull so
     * the next attempt has a clean baseline.
     *
     * @param {string} fullText - Full STT transcript for this utterance
     * @param {Object} decision - Decision object from shouldTranslate()
     * @param {boolean} clearInterim - If true, clear lastInterimText after a complete translation
     */
    async function performTranslation(fullText, decision, clearInterim = false) {
        const newText = (decision.newText || '').trim();
        if (!newText) {
            logger.info('⏭️ Approved but empty newText - skipping emit', { clientId, reason: decision.reason });
            translationInFlight = false; // Clear flag set by caller (drain) so future translations aren't blocked
            return;
        }

        // translationInFlight is set by the caller before the async gap (RC-4 fix).
        // performTranslation must not set it again — the finally block clears it.
        try {
            // ── Step 1: Translate the FULL current transcript for maximum context ──
            // Race against a timeout to prevent hangs if Google Translate API stalls
            const translatedFull = await Promise.race([
                translateWithRetry(fullText.trim(), targetLanguage, currentLanguage, clientId),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Translation timeout after ${TRANSLATION_TIMEOUT_MS}ms`)), TRANSLATION_TIMEOUT_MS)
                )
            ]);

            logger.debug('🔤 Full-text translation', {
                clientId,
                fullTextWords: fullText.trim().split(/\s+/).length,
                newTextWords: newText.split(/\s+/).length,
                hasCommitted: !!committedTranslation,
                committedWords: committedTranslation ? committedTranslation.split(/\s+/).length : 0
            });

            // ── Step 2: Extract only the NEW portion via word-level LCP ──
            let emitted = null;
            let usedLCP = false;

            if (committedTranslation) {
                const tail = extractByWordLCP(translatedFull, committedTranslation);
                if (tail) {
                    emitted = tail;
                    usedLCP = true;
                    logger.debug('✂️ LCP extraction succeeded', { clientId, tailWords: tail.split(/\s+/).length });
                } else {
                    logger.info('⚠️ LCP extraction failed (<75% match) — emitting full translation', {
                        clientId,
                        committedPreview: committedTranslation.substring(0, 60),
                        fullPreview: translatedFull.substring(0, 60)
                    });
                }
            } else {
                // First translation in this session — emit entire full translation
                emitted = translatedFull.trim();
                usedLCP = true;
            }

            // ── Fallback: LCP failed — emit full translation (full context preserved) ──
            // v127 behavior: never translate chunks in isolation. A decontextualized chunk
            // translation loses grammatical context and produces broken English.
            if (!emitted) {
                emitted = translatedFull.trim();
            }

            // ── KEY FIX: committedTranslation = translatedFull (not += emitted) ──
            // This prevents the divergence cascade that broke v150-v156:
            // each subsequent LCP starts from the WHOLE previous full translation.
            committedTranslation = translatedFull;
            lastFullTranslation = translatedFull;

            // ── Step 3: Post-processing ──
            // Language-aware: applyTermMappings and source-aware fixes assume
            // Romanian source. Only apply them for ro→* translations.
            // verifyReligiousTerms has its own internal guard (targetLang === 'ro').
            // preserveSourceNumbers and preserveDates are language-agnostic.
            const sourceLangBase = currentLanguage.split('-')[0];
            if (sourceLangBase === 'ro') {
                emitted = applyTermMappings(emitted, fullText);
            }
            emitted = verifyReligiousTerms(emitted, fullText, targetLanguage);
            emitted = preserveSourceNumbers(newText, emitted);
            emitted = preserveDates(newText, emitted);

            // Single-word fallback translation (Romanian source only — keys are Romanian words)
            if (sourceLangBase === 'ro') {
                const normalizedSource = newText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const normalizedEmitted = emitted.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                if (normalizedSource === normalizedEmitted && FALLBACK_TRANSLATIONS[normalizedSource]) {
                    emitted = FALLBACK_TRANSLATIONS[normalizedSource];
                }
            }

            // Update source tracking
            const ltRaw = `${lastTranslatedText} ${newText}`.trim();
            lastTranslatedText = ltRaw.length > 2000 ? ltRaw.slice(-2000) : ltRaw;
            lastTranslationTime = Date.now();

            if (!emitted) {
                logger.info('⏭️ Empty translation result - skipping emit', { clientId });
            } else {
                const isDuplicate = translationRules.isTranslationDuplicate(emitted);

                if (isDuplicate) {
                    logger.info('🚫 POST-TRANSLATION DUPLICATE detected - skipping emit', {
                        clientId,
                        emittedPreview: emitted.substring(0, 200)
                    });
                }

                translationRules.recordTranslatedOutput(emitted);

                if (!isDuplicate) {
                    const acRaw = (accumulatedText ? accumulatedText + ' ' : '') + emitted;
                    accumulatedText = acRaw.length > 1000 ? acRaw.slice(-1000) : acRaw;
                    translationCount++;

                    logger.info('✅ Translation completed', {
                        clientId,
                        reason: decision.reason,
                        confidence: decision.confidence,
                        method: usedLCP ? 'full+lcp' : 'full+lcp_failed',
                        newContent: emitted.substring(0, 200),
                        sourceText: newText.substring(0, 200),
                        count: translationCount,
                        isComplete: decision.isComplete
                    });

                    translationRules.recordTranslation(fullText, emitted);

                    socket.emit('translation-result', {
                        original: newText,
                        translated: emitted,
                        accumulated: accumulatedText,
                        count: translationCount,
                        isInterim: !decision.isComplete,
                        reason: decision.reason
                    });

                    // Persist to translation_log for debugging (fire-and-forget)
                    billingDb.logTranslation({
                        sessionId: clientId,
                        clientId: clientId,
                        sourceText: newText,
                        translatedText: emitted,
                        sourceLanguage: currentLanguage,
                        targetLanguage: targetLanguage,
                        reason: decision.reason,
                        appVersion: 'v195'
                    }).catch(() => {}); // Non-fatal

                    restartAttempts = 0;
                }
            }

            // Clear interim text after a complete result (main handler only)
            if (clearInterim && decision.isComplete) {
                lastInterimText = '';
            }

        } catch (error) {
            logger.error('Translation error', {
                clientId,
                reason: decision.reason,
                error: error.message
            });
            socket.emit('translation-error', {
                message: error.message
            });
        } finally {
            translationInFlight = false;
            // Drain one item from the pending queue (each item re-enters this finally,
            // so the whole queue is processed in order without recursion depth growing).
            if (pendingTranslationQueue.length > 0 && sessionActive) {
                const { transcript: pt, decision: pd } = pendingTranslationQueue.shift();
                logger.info('▶️ Running deferred pending translation', {
                    clientId,
                    preview: pt.substring(0, 60),
                    remaining: pendingTranslationQueue.length
                });
                translationInFlight = true;
                performTranslation(pt, pd, true).catch(err => {
                    logger.error('Deferred translation error', { clientId, error: err.message });
                });
            }
        }
    }

    // Extract stream creation logic into separate function (fixes recursive event emission)
    async function createRecognitionStream(sourceLanguage, targetLang, interval, mode = 'talks', isRestart = false) {
        try {
            currentLanguage = sourceLanguage;
            targetLanguage = targetLang;
            translationInterval = interval;
            const intervalMs = translationInterval;

            // Only reset counters on initial start, not on auto-restart
            if (!isRestart) {
                accumulatedText = '';
                translationCount = 0;
                restartAttempts = 0; // Reset restart counter on new session
            }
            // Always reset LCP state on any restart (auto or manual).
            // Google STT starts a fresh transcript accumulation on every new stream,
            // so committedTranslation from the previous stream is always stale and
            // will cause every LCP extraction to fail until it's cleared.
            committedTranslation = '';
            lastFullTranslation = '';

            // Reset rules engine dedup state on stream restart to prevent
            // legitimate new-stream phrases from being suppressed as duplicates
            // of pre-restart content.
            if (translationRules) {
                translationRules.resetForNewUtterance();
            }

            sessionActive = true;
            updateActivity(); // Start inactivity timer

            logger.info('🎤 Starting speech recognition stream', {
                clientId,
                sourceLanguage: currentLanguage,
                targetLanguage,
                receivedInterval: translationInterval,
                finalIntervalMs: intervalMs
            });

            const request = {
                config: {
                    encoding: 'LINEAR16',
                    sampleRateHertz: 48000,
                    languageCode: currentLanguage,
                    enableAutomaticPunctuation: true,
                    model: 'latest_long',
                    useEnhanced: true,
                    maxAlternatives: 1,
                    enableWordTimeOffsets: false,
                    enableWordConfidence: false,
                    enableSpeakerDiarization: false,
                    // Only send Romanian phrase hints when source language is Romanian.
                    // For other languages these hints are irrelevant noise that wastes
                    // the phrase hints budget and could interfere with recognition.
                    speechContexts: currentLanguage.startsWith('ro') ? [
                        {
                            phrases: STT_PHRASE_HINTS,
                            boost: 10  // 10 = midpoint; 20 (max) explicitly increases false positives per Google docs
                        }
                    ] : []
                },
                interimResults: true,
                singleUtterance: false
            };

            recognizeStream = speechClient
                .streamingRecognize(request)
                .on('error', (error) => {
                    const errorCode = error.code ? String(error.code) : '';
                    logger.error('Speech recognition error', {
                        clientId,
                        error: error.message,
                        code: error.code,
                        errorCode,
                        stack: error.stack
                    });

                    // Check if this is a stream timeout error (305 seconds exceeded)
                    // gRPC codes: 11 = OUT_OF_RANGE, 4 = DEADLINE_EXCEEDED
                    const isStreamTimeout = error.code === 11 ||
                                          error.code === 4 ||
                                          error.message.includes('maximum allowed stream duration') ||
                                          error.message.includes('Exceeded maximum allowed stream duration');

                    // "Audio Timeout" means Google got no audio for ~10s (silence: prayer, song, break).
                    // This is NOT a real error — reset the restart counter so silence never kills the stream.
                    // Checked independently of isStreamTimeout: if Google ever changes the gRPC code for
                    // this error, it would previously have been emitted as a client error instead of restarted.
                    const isAudioTimeout = error.message.includes('Audio Timeout') ||
                                          error.message.includes('Long duration elapsed without audio');

                    if (isAudioTimeout && sessionActive) {
                        consecutiveAudioTimeouts++;
                        logger.info('🔇 Audio timeout (silence detected)', { clientId, consecutiveAudioTimeouts });
                        if (consecutiveAudioTimeouts >= 5) {
                            // Sustained silence storm — stop restarting, notify client.
                            // Without this cap, restartAttempts resets to 0 on each timeout,
                            // so MAX_RESTART_ATTEMPTS is never reached and the loop runs forever.
                            consecutiveAudioTimeouts = 0;
                            sessionActive = false;
                            cleanupStream();
                            socket.emit('recognition-error', {
                                message: 'No audio received for an extended period. Tap Stop and Start to resume.',
                                code: 'SUSTAINED_AUDIO_TIMEOUT'
                            });
                        } else {
                            restartAttempts = 0; // Silence is not a failure; don't count toward max
                            scheduleAutoRestart();
                        }
                    } else if (isStreamTimeout && sessionActive) {
                        logger.info('🔄 Stream timeout detected, auto-restarting...', { clientId });
                        scheduleAutoRestart();
                    } else {
                        // Only emit error for non-timeout errors
                        socket.emit('recognition-error', {
                            message: error.message,
                            code: error.code
                        });
                    }
                })
                .on('end', () => {
                    logger.warn('⚠️ Recognition stream ended by Google Cloud', { clientId });
                    scheduleAutoRestart();
                })
                .on('close', () => {
                    logger.warn('⚠️ Recognition stream closed by Google Cloud', { clientId });
                    scheduleAutoRestart();
                })
                .on('pipe', () => {
                    logger.debug('📡 Stream pipe event', { clientId });
                })
                .on('unpipe', () => {
                    logger.debug('📡 Stream unpipe event', { clientId });
                })
                .on('data', async (data) => {
                    consecutiveAudioTimeouts = 0; // Real data received — silence storm ended
                    logger.info('📥 GOOGLE CLOUD DATA EVENT!', {
                        clientId,
                        hasResults: !!data.results,
                        resultsLength: data.results?.length,
                        rawData: JSON.stringify(data).substring(0, 200)
                    });

                    const result = data.results[0];
                    if (!result) return;

                    const alternative = result.alternatives[0];
                    const transcript = alternative.transcript || '';
                    const isFinal = result.isFinal || false;

                    // Skip empty transcripts but don't block the flow
                    if (transcript.length === 0) {
                        logger.debug('Empty transcript in alternative', { clientId });
                        return;
                    }

                    logger.debug('📝 Recognition result', {
                        clientId,
                        transcript: transcript.substring(0, 200),
                        isFinal,
                        length: transcript.length,
                        sessionActive
                    });

                    // Send interim results to client for visual feedback
                    if (sessionActive) {
                        socket.emit('interim-result', {
                            text: transcript,
                            isFinal
                        });

                        // Update activity timestamp
                        updateActivity();

                        // Track text changes for pause detection
                        const previousInterimText = lastInterimText;
                        lastInterimText = transcript;
                        const textChanged = previousInterimText !== transcript;

                        // Clear pause detection timer if text is still changing
                        if (textChanged && restartStreamTimer) {
                            clearTimeout(restartStreamTimer);
                            restartStreamTimer = null;
                        }

                        // ===========================================
                        // CENTRALIZED TRANSLATION DECISION
                        // ===========================================

                        // Safety check: If rules engine not initialized, skip translation logic
                        if (!translationRules) {
                            logger.error('❌ Translation rules engine not initialized!', { clientId });
                            return;
                        }

                        const decision = translationRules.shouldTranslate({
                            text: transcript,
                            isFinal: isFinal,
                            timeSinceLastChange: textChanged ? 0 : (Date.now() - (lastTextChangeTime || Date.now())),
                            trigger: isFinal ? 'final' : 'interim',
                            clientId: clientId
                        });

                        // Update last text change time
                        if (textChanged) {
                            lastTextChangeTime = Date.now();
                        }

                        // ===========================================
                        // ACT ON DECISION
                        // ===========================================

                        if (decision.shouldTranslate) {
                            // Skip if another translation is already in flight (prevents race conditions)
                            if (translationInFlight) {
                                logger.debug('⏳ Translation in flight, deferring', { clientId });
                                // For final results, enqueue — don't overwrite (old single-slot approach
                                // silently dropped every isFinal except the last when speaker talked fast).
                                if (isFinal) {
                                    // Cap queue at MAX_PENDING_QUEUE_DEPTH — if a network spike causes
                                    // translation to back up beyond this, drop the oldest entry (it's
                                    // already stale context) rather than accumulating a flood of out-of-sync output.
                                    if (pendingTranslationQueue.length >= MAX_PENDING_QUEUE_DEPTH) {
                                        const dropped = pendingTranslationQueue.shift();
                                        logger.warn('⚠️ Pending queue at capacity — dropping oldest entry', {
                                            clientId,
                                            dropped: dropped.transcript.substring(0, 60),
                                            queueDepth: pendingTranslationQueue.length
                                        });
                                    }
                                    pendingTranslationQueue.push({ transcript, decision });
                                    logger.info('📋 Queued pending final translation', {
                                        clientId,
                                        preview: transcript.substring(0, 60),
                                        queueDepth: pendingTranslationQueue.length
                                    });
                                }
                            } else {
                            // Acquire lock BEFORE the async gap so a second data event
                            // in the same tick cannot also pass the translationInFlight check.
                            translationInFlight = true;
                            // Clear any pending pause timer - we're translating now
                            if (restartStreamTimer) {
                                clearTimeout(restartStreamTimer);
                                restartStreamTimer = null;
                            }

                            await performTranslation(transcript, decision, true);
                            } // end of translationInFlight guard
                        } else {
                            // Translation rejected - maybe start pause detection timer
                            // Only set pause timer for interim results when max interval not reached
                            if (!isFinal && !restartStreamTimer && textChanged && translationRules) {
                                const pauseMs = translationRules.getConfig().pauseDetectionMs;

                                restartStreamTimer = setTimeout(async () => {
                                    logger.info('⏰ PAUSE timer fired - checking rules engine', { clientId });

                                    // Re-check with rules engine after pause
                                    const pauseDecision = translationRules.shouldTranslate({
                                        text: lastInterimText,
                                        isFinal: false,
                                        timeSinceLastChange: pauseMs,
                                        trigger: 'pause',
                                        clientId: clientId
                                    });

                                    if (pauseDecision.shouldTranslate && sessionActive && !translationInFlight) {
                                        translationInFlight = true;
                                        await performTranslation(lastInterimText, pauseDecision, false);
                                    }

                                    restartStreamTimer = null;
                                }, pauseMs);
                            }

                            logger.debug('⏭️ Translation skipped', {
                                clientId,
                                reason: decision.reason,
                                textPreview: transcript.substring(0, 30),
                                isFinal
                            });
                        }
                    }
                });

            // Set proactive restart timer (290s before Google's ~305s limit)
            if (streamDurationTimer) {
                clearTimeout(streamDurationTimer);
            }
            streamDurationTimer = setTimeout(() => {
                streamDurationTimer = null;
                if (sessionActive && !isRestarting) {
                    logger.info('⏰ Proactive stream restart at 290s', { clientId });
                    scheduleAutoRestart();
                }
            }, STREAM_DURATION_LIMIT_MS);

            // Flush buffered audio from restart gap
            if (audioBufferDuringRestart.length > 0) {
                logger.info('📦 Flushing buffered audio from restart', {
                    clientId,
                    bufferedChunks: audioBufferDuringRestart.length
                });
                for (const audioData of audioBufferDuringRestart) {
                    if (recognizeStream && recognizeStream.writable) {
                        try {
                            const buffer = Buffer.from(audioData);
                            recognizeStream.write(buffer);
                        } catch (e) {
                            logger.warn('⚠️ Error flushing buffered audio chunk', {
                                clientId,
                                error: e.message
                            });
                        }
                    }
                }
                audioBufferDuringRestart = []; // Clear buffer
                audioBufferWarned = false;
            }

            // TOCTOU fix: clear isRestarting AFTER stream is ready and buffer is flushed.
            // Previously this was cleared before createRecognitionStream was called, leaving a
            // window where audio was neither buffered nor written to the new stream.
            isRestarting = false;
            // Reset restart counter — stream opened successfully, so this restart was not a failure.
            // Without this, 10 proactive 290s restarts over ~48 min would hit MAX_RESTART_ATTEMPTS.
            restartAttempts = 0;

            socket.emit('streaming-started', {
                sourceLanguage: currentLanguage,
                targetLanguage
            });

        } catch (error) {
            logger.error('Failed to start streaming', {
                clientId,
                error: error.message
            });
            socket.emit('start-error', { message: error.message });
        }
    }

    // Socket handler for start-streaming event (validates and calls createRecognitionStream)
    socket.on('start-streaming', async ({ sourceLanguage, targetLang, translationInterval: interval, mode, isRestart }) => {
        // Input validation
        const validLanguageCodes = /^[a-z]{2}-[A-Z]{2}$/;
        const validTargetLanguages = /^[a-z]{2}(-[A-Z]{2})?$/;

        if (sourceLanguage && !validLanguageCodes.test(sourceLanguage)) {
            logger.warn('Invalid source language code', { clientId, sourceLanguage });
            socket.emit('start-error', { message: 'Invalid source language code' });
            return;
        }

        if (targetLang && !validTargetLanguages.test(targetLang)) {
            logger.warn('Invalid target language code', { clientId, targetLang });
            socket.emit('start-error', { message: 'Invalid target language code' });
            return;
        }

        let sanitizedInterval = undefined;
        if (interval !== undefined) {
            if (typeof interval === 'number' && !Number.isNaN(interval) && interval >= 1000 && interval <= 60000) {
                sanitizedInterval = interval;
            } else {
                logger.warn('Invalid translation interval provided, falling back to mode default', { clientId, interval });
            }
        }

        const validModes = ['talks', 'earbuds'];
        const selectedMode = mode && validModes.includes(mode) ? mode : 'talks';
        currentMode = selectedMode;

        // Guard: clean up existing gRPC stream before starting a new one.
        // Without this, a duplicate start-streaming event leaks the old stream.
        if (recognizeStream) {
            logger.warn('⚠️ start-streaming while stream active - stopping existing stream', { clientId });
            cleanupStream();
        }

        // Initialize translation rules engine for this session
        translationRules = new TranslationRulesEngine(selectedMode, logger);
        const modeConfig = translationRules.getConfig();

        logger.info('🎯 Translation rules engine initialized', {
            clientId,
            mode: selectedMode,
            config: translationRules.getConfig()
        });

        // Call the extracted function
        await createRecognitionStream(
            sourceLanguage || 'ro-RO',
            targetLang || 'en',
            sanitizedInterval || modeConfig.translationInterval || 6000,
            selectedMode,
            isRestart || false
        );
    });

    // Receive audio data from client
    let audioChunkCount = 0;

    // Rate limiting for audio data
    let audioDataReceived = 0;
    let audioRateLimitWindow = Date.now();
    const MAX_AUDIO_BYTES_PER_SECOND = APP_CONFIG.audio?.maxBytesPerSecond || 1024 * 1024 * 2; // 2MB/sec max

    // Detect audio format once for efficiency
    let audioDataFormat = null;

    socket.on('audio-data', (audioData) => {
        // Buffer audio during restart to prevent gaps
        if (isRestarting && sessionActive) {
            if (audioBufferDuringRestart.length < MAX_AUDIO_BUFFER_SIZE) {
                audioBufferDuringRestart.push(audioData);
            } else if (!audioBufferWarned) {
                logger.warn('⚠️ Audio buffer full during restart - dropping chunks', {
                    clientId,
                    bufferSize: MAX_AUDIO_BUFFER_SIZE
                });
                audioBufferWarned = true;
            }
            // Still update activity during restart
            updateActivity();
            return;
        }

        if (recognizeStream && sessionActive && !recognizeStream.destroyed && recognizeStream.writable) {
            try {
                updateActivity(); // Reset inactivity timer on audio
                audioChunkCount++;

                // Detect format once, reuse for all subsequent chunks
                if (!audioDataFormat) {
                    if (audioData instanceof Buffer) {
                        audioDataFormat = 'buffer';
                    } else if (audioData instanceof ArrayBuffer) {
                        audioDataFormat = 'arraybuffer';
                    } else if (audioData.buffer) {
                        audioDataFormat = 'typed-array';
                    } else {
                        audioDataFormat = 'unknown';
                    }
                    logger.info(`📊 Audio format detected: ${audioDataFormat}`, { clientId });
                }

                // Fast path based on detected format
                let buffer;
                switch (audioDataFormat) {
                    case 'buffer':
                        buffer = audioData;
                        break;
                    case 'arraybuffer':
                        buffer = Buffer.from(audioData);
                        break;
                    case 'typed-array':
                        buffer = Buffer.from(audioData.buffer);
                        break;
                    default:
                        buffer = Buffer.from(audioData);
                }

                // Validate chunk size to prevent DoS attacks
                if (buffer.length > MAX_AUDIO_CHUNK_SIZE) {
                    logger.warn('Audio chunk exceeds maximum size', {
                        clientId,
                        chunkSize: buffer.length,
                        maxSize: MAX_AUDIO_CHUNK_SIZE
                    });
                    socket.emit('recognition-error', {
                        message: 'Audio chunk too large',
                        code: 'CHUNK_TOO_LARGE'
                    });
                    return;
                }

                // Rate limiting: check if client is sending too much data
                const now = Date.now();
                if (now - audioRateLimitWindow >= 1000) {
                    // Reset window every second
                    audioDataReceived = 0;
                    audioRateLimitWindow = now;
                }

                audioDataReceived += buffer.length;

                if (audioDataReceived > MAX_AUDIO_BYTES_PER_SECOND) {
                    logger.warn('Audio data rate limit exceeded', {
                        clientId,
                        bytesPerSecond: audioDataReceived,
                        maxBytes: MAX_AUDIO_BYTES_PER_SECOND
                    });
                    socket.emit('recognition-error', {
                        message: 'Audio data rate limit exceeded',
                        code: 'RATE_LIMIT_EXCEEDED'
                    });
                    return;
                }

                if (buffer.length === 0) {
                    logger.warn('Empty audio chunk received', { clientId });
                    return;
                }

                if (audioChunkCount === 1 || audioChunkCount === 5 || audioChunkCount === 10) {
                    // Log chunks with sample data for debugging
                    const samples = [];
                    for (let i = 0; i < Math.min(10, buffer.length / 2); i++) {
                        samples.push(buffer.readInt16LE(i * 2));
                    }
                    const allZeros = samples.every(s => s === 0);
                    const hasAudio = samples.some(s => Math.abs(s) > 100);
                    logger.info(`📊 Audio chunk #${audioChunkCount} received`, {
                        clientId,
                        byteLength: buffer.length,
                        firstSamples: samples,
                        allZeros,
                        hasAudio
                    });
                } else if (audioChunkCount % 50 === 0) {
                    logger.info('📊 Audio data received', {
                        clientId,
                        chunkNumber: audioChunkCount,
                        byteLength: buffer.length
                    });
                }

                const writeSuccess = recognizeStream.write(buffer);
                if (audioChunkCount === 1) {
                    logger.info('📤 First chunk written to Google Cloud', {
                        clientId,
                        writeSuccess,
                        streamWritable: recognizeStream.writable,
                        streamReadable: recognizeStream.readable
                    });
                }
            } catch (error) {
                logger.error('Error writing audio data', {
                    clientId,
                    error: error.message,
                    code: error.code,
                    stack: error.stack
                });

                // If stream is destroyed, notify client
                if (error.code === 'ERR_STREAM_DESTROYED') {
                    recognizeStream = null;
                    socket.emit('recognition-error', {
                        message: 'Stream destroyed - please restart recording',
                        code: 'STREAM_DESTROYED'
                    });
                }
            }
        } else if (recognizeStream && !recognizeStream.writable && sessionActive) {
            // Stream exists but is not writable - notify client once
            logger.warn('⚠️ Attempted to write to non-writable stream', { clientId });
            recognizeStream = null;
            socket.emit('recognition-error', {
                message: 'Stream no longer writable - please restart recording',
                code: 'STREAM_NOT_WRITABLE'
            });
        }
    });

    // Stop streaming
    socket.on('stop-streaming', () => {
        logger.info('⏹️ Stopping speech recognition stream', {
            clientId,
            translationCount,
            accumulatedLength: accumulatedText.length
        });

        sessionActive = false;

        // Clear forced translation timer
        if (restartStreamTimer) {
            clearTimeout(restartStreamTimer);
            restartStreamTimer = null;
        }

        // Clear inactivity timer
        if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
        }

        cleanupStream();

        socket.emit('streaming-stopped', {
            translationCount,
            accumulatedText
        });
    });

    // Disconnect
    socket.on('disconnect', () => {
        activeConnections--;
        sessionActive = false;

        // Decrement IP connection count
        const currentIpConnections = connectionsByIp.get(clientIp) || 1;
        if (currentIpConnections <= 1) {
            connectionsByIp.delete(clientIp);
        } else {
            connectionsByIp.set(clientIp, currentIpConnections - 1);
        }

        // Clear forced translation timer
        if (restartStreamTimer) {
            clearTimeout(restartStreamTimer);
            restartStreamTimer = null;
        }

        // Clear inactivity timer
        if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
        }

        cleanupStream();

        logger.info('❌ Client disconnected', {
            socketId: socket.id,
            clientIp,
            remainingConnections: activeConnections,
            translationCount
        });
    });
});

// ===== START SERVER =====
server.listen(PORT, async () => {
    logger.info('═══════════════════════════════════════');
    logger.info('🎉 GTranslate V4 - Google Cloud Speech');
    logger.info('═══════════════════════════════════════');
    logger.info(`🌐 Server: http://localhost:${PORT}`);
    logger.info('🎤 Speech Recognition: Google Cloud (No timeout)');
    logger.info('🌍 Translation: Google Cloud');
    logger.info(`📝 Logging: ${path.relative(__dirname, LOG_FILE)}`);
    logger.info('═══════════════════════════════════════');

    // Initialize billing database
    const dbInitialized = billingDb.initializeDatabase(logger);
    if (dbInitialized) {
        await billingDb.createSchema(logger);

        // Purge old billing data (older than 90 days)
        await billingDb.purgeOldData(90, logger);

        // Schedule daily purge at 2 AM
        const scheduleDailyPurge = () => {
            const now = new Date();
            const next2AM = new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate() + 1,
                2, 0, 0
            );
            const timeUntil2AM = next2AM.getTime() - now.getTime();

            setTimeout(async () => {
                await billingDb.purgeOldData(90, logger);
                // Schedule next purge
                setInterval(() => {
                    billingDb.purgeOldData(90, logger);
                }, 24 * 60 * 60 * 1000); // Every 24 hours
            }, timeUntil2AM);
        };

        scheduleDailyPurge();
        logger.info('🗑️ Scheduled daily purge of billing data older than 90 days');

        // Schedule meeting log captures (Europe/Bucharest = EET/EEST)
        // Sun 13:50, Sun 14:40, Thu 19:50, Thu 20:45
        const meetingSchedules = [
            { cron: '50 13 * * 0', label: 'sun-1350' },
            { cron: '40 14 * * 0', label: 'sun-1440' },
            { cron: '50 19 * * 4', label: 'thu-1950' },
            { cron: '45 20 * * 4', label: 'thu-2045' },
        ];
        for (const { cron: schedule, label } of meetingSchedules) {
            if (!cron.validate(schedule)) {
                throw new Error(`Invalid cron expression for label="${label}": "${schedule}"`);
            }
            cron.schedule(schedule, async () => {
                try {
                    logger.info(`[snapshot] Auto-capturing meeting log: ${label}`);
                    const count = await billingDb.captureSnapshot(label);
                    logger.info(`[snapshot] Saved ${count} rows, label="${label}"`);
                } catch (err) {
                    logger.error(`[snapshot] Failed for label="${label}": ${err.message}`, { stack: err.stack });
                }
            }, { timezone: 'Europe/Bucharest' });
        }
        logger.info(`[scheduler] Registered ${meetingSchedules.length} cron jobs for meeting log capture (Europe/Bucharest)`);
    }

    logger.info('✅ Ready to receive connections');
});

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');
    await billingDb.closeDatabase(logger);
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});

process.on('SIGTERM', async () => {
    logger.info('Shutting down gracefully (SIGTERM)...');
    await billingDb.closeDatabase(logger);
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});

// Safety net: log unhandled rejections without crashing.
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection (non-fatal):', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined
    });
});
