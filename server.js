/**
 * GTranslate V4 Server
 * Real-time speech translation using Google Cloud Speech-to-Text API
 * Stream proactively restarts at 290s (Google Cloud limit is ~305s)
 */

// Sentry must be imported before everything else (v8 requirement)
require('./instrument.js');

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const speech = require('@google-cloud/speech');
const { TranslationServiceClient } = require('@google-cloud/translate').v3;
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const winston = require('winston');
const path = require('path');
const fs = require('fs');
const billingDb = require('./billing-db');
const TranslationRulesEngine = require('./translation-rules-engine');
const Sentry = require('@sentry/node');

// ===== CONFIGURATION =====
// Load environment variables if .env file exists
try {
    require('dotenv').config();
} catch (e) {
    // dotenv not installed, use defaults
}

const PORT = process.env.PORT || 3003;
const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS || '50');
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP || '5');
const INACTIVITY_TIMEOUT = parseInt(process.env.INACTIVITY_TIMEOUT || String(30 * 60 * 1000));
const MAX_AUDIO_CHUNK_SIZE = 1024 * 1024; // 1MB per chunk
const STREAM_DURATION_LIMIT_MS = 290000; // Proactive restart at 290s (Google limit is ~305s)

/**
 * Capture an exception to Sentry (no-op if SENTRY_DSN not configured)
 */
function captureError(error, context = {}) {
    if (!process.env.SENTRY_DSN) return;
    Sentry.withScope(scope => {
        Object.entries(context).forEach(([k, v]) => scope.setExtra(k, String(v)));
        Sentry.captureException(error);
    });
}

const TTS_VOICE_MAP = {
    'ro': { languageCode: 'ro-RO', name: 'ro-RO-Neural2-A', ssmlGender: 'FEMALE' },
    'en': { languageCode: 'en-US', name: 'en-US-Neural2-J', ssmlGender: 'MALE' },
    'fr': { languageCode: 'fr-FR', name: 'fr-FR-Neural2-A', ssmlGender: 'FEMALE' },
    'de': { languageCode: 'de-DE', name: 'de-DE-Neural2-A', ssmlGender: 'FEMALE' },
    'es': { languageCode: 'es-ES', name: 'es-ES-Neural2-A', ssmlGender: 'FEMALE' },
    'it': { languageCode: 'it-IT', name: 'it-IT-Neural2-A', ssmlGender: 'FEMALE' },
    'hu': { languageCode: 'hu-HU', name: 'hu-HU-Neural2-A', ssmlGender: 'FEMALE' },
    '_default': { languageCode: 'en-US', name: 'en-US-Neural2-J', ssmlGender: 'MALE' }
};

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

if (process.env.GOOGLE_CREDENTIALS_JSON) {
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
const { SpeechClient: SpeechClientV2 } = require('@google-cloud/speech').v2;
const speechClient = googleCredentials
    ? new SpeechClientV2({ credentials: googleCredentials })
    : new SpeechClientV2();

const translateClient = googleCredentials
    ? new TranslationServiceClient({ credentials: googleCredentials })
    : new TranslationServiceClient();

const ttsClient = googleCredentials
    ? new TextToSpeechClient({ credentials: googleCredentials })
    : new TextToSpeechClient();

// Get project ID and location for v3 API
const projectId = googleCredentials?.project_id || credentialsProjectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const parent = projectId ? `projects/${projectId}/locations/${location}` : null;
const glossaryId = 'ro-en-religious-terms';
const glossaryPath = parent ? `${parent}/glossaries/${glossaryId}` : null;
const glossaryEnabled = process.env.GLOSSARY_ENABLED === 'true';
const translationModel = process.env.TRANSLATION_MODEL || 'advanced';

if (!projectId) {
    logger.error('❌ No Google Cloud project ID found - translations will fail');
    logger.error('Set project ID via:');
    logger.error('  1. GOOGLE_CLOUD_PROJECT environment variable');
    logger.error('  2. GCP_PROJECT environment variable');
    logger.error('  3. project_id in credentials JSON');
    process.exit(1);
}

logger.info('✅ Google Cloud Speech-to-Text V2 (Chirp) client initialized');
logger.info('✅ Google Cloud Translation v3 client initialized', {
    projectId,
    location,
    translationModel,
    glossaryEnabled,
    glossaryPath: glossaryEnabled ? glossaryPath : 'disabled'
});
logger.info('✅ Google Cloud Text-to-Speech client initialized');

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

// Strengthen CORS configuration
const io = socketIo(server, {
    cors: {
        origin: (origin, callback) => {
            // Allow same-origin requests (no origin header)
            if (!origin) return callback(null, true);

            // Whitelist of allowed origins
            const allowedOrigins = [
                'http://localhost:3003',
                'http://127.0.0.1:3003',
                'https://gtranslate-v4-96dfeefd9842.herokuapp.com'
            ];

            // Also allow Heroku app URL from environment
            if (process.env.HEROKU_APP_NAME) {
                allowedOrigins.push(`https://${process.env.HEROKU_APP_NAME}.herokuapp.com`);
            }

            if (allowedOrigins.includes(origin)) {
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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/billing', (req, res) => {
    res.sendFile(path.join(__dirname, 'billing.html'));
});

app.get('/audio-processor.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'audio-processor.js'));
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        connections: activeConnections,
        env: NODE_ENV
    });
});

// ===== BILLING API ENDPOINTS =====

// Track usage (called from client)
app.post('/api/billing/track', express.json(), async (req, res) => {
    try {
        const { type, amount, language } = req.body;

        // Validate input
        if (!type || !amount || !language) {
            return res.status(400).json({ error: 'Missing required fields: type, amount, language' });
        }

        if (!['stt', 'translation', 'glossary', 'tts'].includes(type)) {
            return res.status(400).json({ error: 'Invalid type. Must be: stt, translation, glossary, or tts' });
        }

        if (typeof amount !== 'number' || amount < 0) {
            return res.status(400).json({ error: 'Amount must be a positive number' });
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
app.get('/api/billing/summary', async (req, res) => {
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
app.get('/api/billing/daily', async (req, res) => {
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

// Sentry Express error handler — must be after all routes, before other error middleware
if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
}

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

    let useGlossary = glossaryEnabled && glossaryPath;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Extract language code (e.g., 'ro' from 'ro-RO')
            const sourceLangCode = sourceLanguage.includes('-')
                ? sourceLanguage.split('-')[0]
                : sourceLanguage;

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

            // Add glossary if enabled and available (for domain-specific terms like religious terminology)
            if (useGlossary) {
                request.glossaryConfig = {
                    glossary: glossaryPath,
                    ignoreCase: true  // Case-insensitive for Romanian religious terms (Dumnezeu vs dumnezeu)
                };
                logger.debug('Using glossary for translation', { glossaryPath, clientId });
            }

            const [response] = await translateClient.translateText(request);
            const translation = response.translations[0].translatedText;

            return translation;
        } catch (error) {
            const errorCode = error.code ? String(error.code) : '';
            const errorMessage = error.message || '';

            // Check if this is a glossary-related error
            const isGlossaryError = errorMessage.includes('glossary') ||
                                   errorMessage.includes('NOT_FOUND') ||
                                   errorCode === '5'; // NOT_FOUND code

            // If glossary error on first attempt with glossary, retry without glossary
            if (isGlossaryError && useGlossary) {
                logger.warn('Glossary not found or error, retrying without glossary', {
                    clientId,
                    glossaryPath,
                    error: errorMessage
                });
                useGlossary = false;
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
                    usedGlossary: useGlossary
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
    // Get client IP address
    const clientIp = socket.handshake.address || socket.conn.remoteAddress;

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
    let lastTranslatedText = ''; // Track what we've already translated
    let translationInterval = 6000; // Store translation interval for restarts
    let lastActivityTime = Date.now();
    let inactivityTimer = null;
    const INACTIVITY_TIMEOUT_MS = INACTIVITY_TIMEOUT; // Use config value
    let isRestarting = false; // Prevent race conditions during auto-restart
    let translationInFlight = false; // Prevent concurrent translations (race condition fix)
    let restartTimeout = null; // Track the scheduled restart timeout
    let restartAttempts = 0; // Track restart attempts
    const MAX_RESTART_ATTEMPTS = 10; // Maximum auto-restart attempts
    let audioBufferDuringRestart = []; // Buffer audio during stream restarts
    let audioBufferWarned = false; // Flag to log buffer-full warning only once
    let streamDurationTimer = null; // Proactive restart timer (290s)
    const MAX_AUDIO_BUFFER_SIZE = 50; // Max chunks to buffer (prevent memory issues)
    let translationRules = null; // Centralized translation rules engine
    let currentMode = 'talks'; // Persist selected mode across restarts
    let lastTextChangeTime = Date.now(); // Track when text last changed for pause detection

    // Re-translation state: translate full text, diff against what was already spoken
    let committedTranslation = ''; // What TTS has already spoken (permanent until stream restart)
    let lastFullTranslation = ''; // Previous full translation for reference

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
        committedTranslation = ''; // Reset re-translation state
        lastFullTranslation = '';

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

        // Clean up old stream before scheduling restart
        recognizeStream = null;

        restartTimeout = setTimeout(() => {
            restartTimeout = null;
            if (sessionActive && isRestarting) {
                isRestarting = false;
                createRecognitionStream(currentLanguage, targetLanguage, translationInterval, currentMode, true)
                    .catch((error) => {
                        logger.error('Failed to restart stream', { clientId, error: error.message });
                        isRestarting = false;
                    });
            } else {
                isRestarting = false;
            }
        }, 0); // No delay - restart immediately
    }

    /**
     * Extract new translated content by diffing against what was already spoken.
     * Uses word-level Longest Common Prefix (LCP) matching.
     *
     * @param {string} newFullTranslation - The full translation of current STT transcript
     * @param {string} committed - What TTS has already spoken
     * @returns {string} Only the new words to speak
     */
    function extractNewTranslatedContent(newFullTranslation, committed) {
        const newTrimmed = newFullTranslation.trim();
        const committedTrimmed = committed.trim();

        // No committed text yet - everything is new
        if (!committedTrimmed) {
            return newTrimmed;
        }

        // Exact match - nothing new
        if (newTrimmed === committedTrimmed) {
            return '';
        }

        // Check if new translation starts with committed text (most common case)
        if (newTrimmed.startsWith(committedTrimmed)) {
            const newContent = newTrimmed.substring(committedTrimmed.length).trim();
            logger.debug('📊 LCP match (string prefix)', {
                clientId,
                committedLen: committedTrimmed.length,
                newContentLen: newContent.length,
                newContent: newContent.substring(0, 60)
            });
            return newContent;
        }

        // Word-level LCP: find how many leading words match
        const newWords = newTrimmed.split(/\s+/);
        const committedWords = committedTrimmed.split(/\s+/);

        let matchCount = 0;
        const minLen = Math.min(newWords.length, committedWords.length);
        for (let i = 0; i < minLen; i++) {
            if (newWords[i].toLowerCase() === committedWords[i].toLowerCase()) {
                matchCount++;
            } else {
                break;
            }
        }

        if (matchCount > 0 && matchCount >= committedWords.length * 0.5) {
            // Good word-level prefix match - emit words after the match
            const newContent = newWords.slice(matchCount).join(' ');
            logger.debug('📊 LCP match (word-level)', {
                clientId,
                matchedWords: matchCount,
                totalCommitted: committedWords.length,
                newContent: newContent.substring(0, 60)
            });
            return newContent;
        }

        // Translation shifted significantly (e.g., after stream restart or new utterance)
        // Treat as entirely new content
        logger.info('📊 No LCP match - treating as new utterance', {
            clientId,
            matchedWords: matchCount,
            committedPreview: committedTrimmed.substring(0, 40),
            newPreview: newTrimmed.substring(0, 40)
        });
        return newTrimmed;
    }

    /**
     * Shared translation logic: translate fullText, diff against committed, emit result.
     * @param {string} fullText - Full text to translate (transcript or lastInterimText)
     * @param {Object} decision - Decision object from shouldTranslate()
     * @param {boolean} clearInterim - If true, clear lastInterimText after a complete translation
     */
    async function performTranslation(fullText, decision, clearInterim = false) {
        const newText = decision.newText;
        if (newText.length === 0) return;

        translationInFlight = true;
        try {
            // Detect new utterance: if getNewText returned the full text, reset committed
            const isNewUtterance = newText === fullText.trim();
            if (isNewUtterance && committedTranslation) {
                logger.info('🆕 New utterance detected - resetting committedTranslation', { clientId });
                committedTranslation = '';
                lastFullTranslation = '';
            }

            logger.debug('🔤 Re-translation: translating full text', {
                clientId,
                fullText: fullText.substring(0, 80),
                committed: committedTranslation.substring(0, 40)
            });

            const fullTranslation = await translateWithRetry(
                fullText,
                targetLanguage,
                currentLanguage,
                clientId
            );

            // Extract only the new content via word-level diffing
            const newContent = extractNewTranslatedContent(fullTranslation, committedTranslation);

            logger.debug('📊 New content extracted', {
                clientId,
                fullTranslation: fullTranslation.substring(0, 80),
                newContent: newContent.substring(0, 60),
                committedLen: committedTranslation.length
            });

            if (!newContent || newContent.trim().length === 0) {
                logger.info('⏭️ No new content after diffing - skipping', { clientId });
                lastTranslatedText = fullText;
                lastTranslationTime = Date.now();
            } else {
                // Check for post-translation duplicates on new content only
                const isDuplicate = translationRules.isTranslationDuplicate(newContent);

                if (isDuplicate) {
                    logger.info('🚫 POST-TRANSLATION DUPLICATE detected - skipping emit', {
                        clientId,
                        newContent: newContent.substring(0, 200)
                    });
                }

                // Record the new content for duplicate detection
                translationRules.recordTranslatedOutput(newContent);

                lastTranslatedText = fullText;
                lastTranslationTime = Date.now();

                if (!isDuplicate) {
                    committedTranslation = fullTranslation;
                    lastFullTranslation = fullTranslation;

                    accumulatedText += (accumulatedText ? ' ' : '') + newContent;
                    translationCount++;

                    logger.info('✅ Translation completed', {
                        clientId,
                        reason: decision.reason,
                        confidence: decision.confidence,
                        newContent: newContent.substring(0, 200),
                        fullTranslation: fullTranslation.substring(0, 200),
                        count: translationCount,
                        isComplete: decision.isComplete
                    });

                    translationRules.recordTranslation(fullText, newContent);

                    socket.emit('translation-result', {
                        original: newText,
                        translated: newContent,
                        accumulated: accumulatedText,
                        count: translationCount,
                        isInterim: !decision.isComplete,
                        reason: decision.reason,
                        committedTranslation  // Client echoes this back on reconnect to restore state
                    });

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
            captureError(error, { clientId, reason: decision.reason });
            socket.emit('translation-error', {
                message: error.message
            });
        } finally {
            translationInFlight = false;
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

            sessionActive = true;
            updateActivity(); // Start inactivity timer

            logger.info('🎤 Starting speech recognition stream', {
                clientId,
                sourceLanguage: currentLanguage,
                targetLanguage,
                receivedInterval: translationInterval,
                finalIntervalMs: intervalMs
            });

            // V2 / Chirp config — sent as the first write on the bidirectional stream
            const recognizerPath = `projects/${projectId}/locations/us-central1/recognizers/_`;
            const v2StreamingConfig = {
                config: {
                    explicitDecodingConfig: {
                        encoding: 'LINEAR16',
                        sampleRateHertz: 48000,
                        audioChannelCount: 1
                    },
                    languageCodes: [currentLanguage],
                    model: 'chirp_2',
                    features: {
                        enableAutomaticPunctuation: true,
                        maxAlternatives: 1
                    }
                },
                streamingFeatures: {
                    interimResults: true
                }
            };

            recognizeStream = speechClient
                .streamingRecognize()
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

                    if (isStreamTimeout && sessionActive) {
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

                        // B1 guard: skip short isFinal results (Google sends these during
                        // natural pauses — single words / two-word bursts with no sentence ending).
                        // The rules engine also checks quality, but this explicit pre-filter
                        // operates on the full transcript (not just new words) for clarity.
                        if (isFinal) {
                            const wordCount = transcript.trim().split(/\s+/).filter(w => w.length > 0).length;
                            const hasSentenceEnd = /[.!?。！？]\s*$/.test(transcript.trim());
                            if (wordCount < 3 && !hasSentenceEnd) {
                                logger.debug('⏭️ Short isFinal skipped (< 3 words, no sentence ending)', {
                                    clientId, wordCount, transcript: transcript.substring(0, 30)
                                });
                                return;
                            }
                        }

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
                            } else {
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

            // V2: send config as the first message on the bidirectional stream (before any audio)
            recognizeStream.write({
                recognizer: recognizerPath,
                streamingConfig: v2StreamingConfig
            });
            logger.info('🎤 V2 streaming config sent', {
                clientId,
                recognizer: recognizerPath,
                languageCodes: v2StreamingConfig.config.languageCodes,
                model: v2StreamingConfig.config.model
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
                            recognizeStream.write({ audio: buffer });
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

            socket.emit('streaming-started', {
                sourceLanguage: currentLanguage,
                targetLanguage
            });

        } catch (error) {
            logger.error('Failed to start streaming', {
                clientId,
                error: error.message
            });
            captureError(error, { clientId });
            socket.emit('start-error', { message: error.message });
        }
    }

    // Socket handler for start-streaming event (validates and calls createRecognitionStream)
    socket.on('start-streaming', async ({ sourceLanguage, targetLang, translationInterval: interval, mode, isRestart, lastCommittedTranslation }) => {
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

        // Initialize translation rules engine for this session
        translationRules = new TranslationRulesEngine(selectedMode, logger);
        const modeConfig = translationRules.getConfig();

        // Restore committed translation state from client to prevent duplicate cards on reconnect
        if (lastCommittedTranslation && typeof lastCommittedTranslation === 'string') {
            committedTranslation = lastCommittedTranslation.substring(0, 5000); // Safety cap
            lastTranslatedText = committedTranslation; // Align rules engine dedup state
            logger.info('📋 Restored committedTranslation from client on reconnect', {
                clientId, chars: committedTranslation.length
            });
        }

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
    const MAX_AUDIO_BYTES_PER_SECOND = 1024 * 1024 * 2; // 2MB/sec max

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

                const writeSuccess = recognizeStream.write({ audio: buffer });
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

    // TTS Synthesis
    socket.on('tts-synthesize', async ({ text, targetLang, rate = 1.0 }) => {
        if (!text || typeof text !== 'string' || text.trim().length === 0) return;
        if (text.length > 5000) {
            socket.emit('tts-error', { message: 'Text too long for TTS' });
            return;
        }
        const langCode = (targetLang || 'en').split('-')[0].toLowerCase();
        const voice = TTS_VOICE_MAP[langCode] || TTS_VOICE_MAP['_default'];
        try {
            const [response] = await ttsClient.synthesizeSpeech({
                input: { text: text.trim() },
                voice: { languageCode: voice.languageCode, name: voice.name, ssmlGender: voice.ssmlGender },
                audioConfig: { audioEncoding: 'MP3', speakingRate: Math.max(0.5, Math.min(2.0, rate)) }
            });
            socket.emit('tts-result', { audio: response.audioContent, charCount: text.length });
            logger.debug('🔊 TTS synthesized', { clientId, lang: voice.languageCode, voice: voice.name, chars: text.length });
        } catch (error) {
            logger.error('TTS synthesis error', { clientId, error: error.message });
            captureError(error, { clientId, targetLang, textLength: text.length });
            socket.emit('tts-error', { message: error.message });
        }
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
