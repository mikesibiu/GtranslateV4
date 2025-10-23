/**
 * GTranslate V4 Server
 * Real-time speech translation using Google Cloud Speech-to-Text API
 * No timeout limitations, better accuracy
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const speech = require('@google-cloud/speech');
const { Translate } = require('@google-cloud/translate').v2;
const winston = require('winston');
const path = require('path');
const fs = require('fs');

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

// ===== LOGGING SETUP =====
// Initialize logger FIRST before using it
const logger = winston.createLogger({
    level: 'debug',  // Enable debug logging
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : '';
            return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'gtranslate-v4.log' })
    ]
});

// ===== GOOGLE CLOUD CREDENTIALS SETUP =====
// Support both file-based (local/Docker) and environment variable (Heroku) credentials
let googleCredentials;
let CREDENTIALS_PATH;

if (process.env.GOOGLE_CREDENTIALS_JSON) {
    // Heroku/Cloud deployment: credentials from environment variable
    try {
        googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
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

    // Only allow credentials files within the application directory or standard system paths
    if (credPath.startsWith(appDir) || credPath.startsWith('/usr/') || credPath.startsWith('/etc/')) {
        CREDENTIALS_PATH = credPath;
    } else {
        logger.error('❌ Credentials path outside allowed directories', { credPath });
        process.exit(1);
    }
} else {
    // Local development: credentials from default file
    CREDENTIALS_PATH = path.join(__dirname, 'google-credentials.json');
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
    ? new Translate({ credentials: googleCredentials })
    : new Translate();

logger.info('✅ Google Cloud Speech-to-Text client initialized');
logger.info('✅ Google Cloud Translation client initialized');

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

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ===== HELPER FUNCTIONS =====

/**
 * Translation with exponential backoff retry logic
 * Handles transient failures (503, 429, network errors)
 */
async function translateWithRetry(text, targetLang, clientId, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const [translation] = await translateClient.translate(text, targetLang);
            return translation;
        } catch (error) {
            const errorCode = error.code ? String(error.code) : '';
            const isRetryable = errorCode === '503' ||
                               errorCode === '429' ||
                               error.code === 503 ||
                               error.code === 429 ||
                               error.code === 'ECONNRESET' ||
                               error.code === 'ETIMEDOUT';

            if (!isRetryable || attempt === maxRetries) {
                logger.error('Translation failed (non-retryable or max retries)', {
                    clientId,
                    attempt,
                    error: error.message,
                    code: error.code
                });
                throw error;
            }

            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            logger.warn(`Translation retry ${attempt}/${maxRetries}`, {
                clientId,
                error: error.message,
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
    let lastTranslatedText = ''; // Track what we've already translated
    let translationInterval = 10000; // Store translation interval for restarts
    let lastActivityTime = Date.now();
    let inactivityTimer = null;
    const INACTIVITY_TIMEOUT_MS = INACTIVITY_TIMEOUT; // Use config value
    let isRestarting = false; // Prevent race conditions during auto-restart
    let restartTimeout = null; // Track the scheduled restart timeout
    let restartAttempts = 0; // Track restart attempts
    const MAX_RESTART_ATTEMPTS = 10; // Maximum auto-restart attempts

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
    function scheduleAutoRestart() {
        if (sessionActive && !isRestarting) {
            restartAttempts++;

            if (restartAttempts > MAX_RESTART_ATTEMPTS) {
                logger.error('❌ Maximum restart attempts exceeded', {
                    clientId,
                    attempts: restartAttempts
                });
                sessionActive = false;
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
            isRestarting = true;
            recognizeStream = null;

            restartTimeout = setTimeout(() => {
                restartTimeout = null; // Clear reference
                // Double-check session is still active and we haven't been cancelled
                if (sessionActive && isRestarting) {
                    isRestarting = false;
                    createRecognitionStream(currentLanguage, targetLanguage, translationInterval, true);
                } else {
                    isRestarting = false;
                }
            }, 100);
        } else {
            recognizeStream = null;
        }
    }

    // Extract stream creation logic into separate function (fixes recursive event emission)
    async function createRecognitionStream(sourceLanguage, targetLang, interval, isRestart = false) {
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

            const request = {
                config: {
                    encoding: 'LINEAR16',
                    sampleRateHertz: 48000,  // Match browser's actual sample rate
                    languageCode: currentLanguage,
                    enableAutomaticPunctuation: true,
                    model: 'latest_long',  // Better for continuous speech
                    useEnhanced: true,
                    // More aggressive final result detection
                    maxAlternatives: 1,
                    enableWordTimeOffsets: false,
                    enableWordConfidence: false,
                    enableSpeakerDiarization: false
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
                    const isStreamTimeout = errorCode.includes('STREAM_ENDED') ||
                                          errorCode.includes('STREAM_CLOSED') ||
                                          errorCode.includes('OUT_OF_RANGE') ||
                                          error.message.includes('Exceeded maximum allowed stream duration') ||
                                          error.message.includes('maximum allowed stream duration');

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

                    const transcript = result.alternatives[0].transcript;
                    const isFinal = result.isFinal;

                    logger.debug('📝 Recognition result', {
                        clientId,
                        transcript: transcript.substring(0, 50),
                        isFinal,
                        length: transcript.length,
                        sessionActive
                    });

                    // Send interim results to client (only if session still active)
                    if (sessionActive) {
                        socket.emit('interim-result', {
                            text: transcript,
                            isFinal
                        });

                        // Track interim text for sentence detection
                        if (!isFinal) {
                            lastInterimText = transcript;

                            // Detect sentence endings: period, question mark, exclamation, ellipsis
                            // Also check for natural pauses indicated by Google Cloud (stability/confidence)
                            const hasSentenceEnding = /[.!?。！？]\s*$/.test(transcript.trim());
                            const hasEllipsis = /\.{2,}\s*$/.test(transcript.trim());

                            // Clear existing timer if we detect a sentence ending
                            if (hasSentenceEnding && restartStreamTimer) {
                                logger.info('📍 Sentence ending detected, clearing timer', {
                                    clientId,
                                    text: transcript.substring(0, 50)
                                });
                                clearTimeout(restartStreamTimer);
                                restartStreamTimer = null;
                            }

                            // Translate immediately on sentence ending (unless it's ellipsis indicating continuation)
                            if (hasSentenceEnding && !hasEllipsis) {
                                const newText = lastInterimText.substring(lastTranslatedText.length).trim();

                                if (newText.length > 0) {
                                    logger.info('✅ Sentence complete - translating immediately', {
                                        clientId,
                                        text: newText.substring(0, 50)
                                    });

                                    accumulatedText += (accumulatedText ? ' ' : '') + newText;

                                    try {
                                        const translation = await translateWithRetry(
                                            newText,
                                            targetLanguage,
                                            clientId
                                        );

                                        translationCount++;

                                        logger.info('✅ Sentence-based translation completed', {
                                            clientId,
                                            original: newText.substring(0, 50),
                                            translated: translation.substring(0, 50),
                                            count: translationCount
                                        });

                                        socket.emit('translation-result', {
                                            original: newText,
                                            translated: translation,
                                            accumulated: accumulatedText,
                                            count: translationCount,
                                            isInterim: true  // Sentence-based interim translation
                                        });

                                        lastTranslatedText = lastInterimText; // Remember what we've translated
                                    } catch (error) {
                                        logger.error('Sentence translation error', {
                                            clientId,
                                            error: error.message
                                        });
                                    }
                                }
                            }
                            // Fallback: Start timer for long utterances without sentence endings
                            else if (!restartStreamTimer) {
                                logger.debug(`⏱️ Starting ${intervalMs/1000}-second fallback timer (no sentence ending yet)`, {
                                    clientId,
                                    intervalMs,
                                    text: transcript.substring(0, 50)
                                });

                                restartStreamTimer = setTimeout(async () => {
                                    logger.info(`🔔 FALLBACK TIMER FIRED! Interval was: ${intervalMs}ms`, { clientId });
                                    if (lastInterimText.trim().length > 0 && sessionActive) {
                                        // Only translate the NEW portion (not already translated)
                                        const newText = lastInterimText.substring(lastTranslatedText.length).trim();

                                        if (newText.length > 0) {
                                            logger.info(`⏰ Forcing translation of NEW interim text after ${intervalMs/1000}s (no sentence ending detected)`, {
                                                clientId,
                                                previousLength: lastTranslatedText.length,
                                                newTextLength: newText.length,
                                                newText: newText.substring(0, 50)
                                            });

                                            accumulatedText += (accumulatedText ? ' ' : '') + newText;

                                            try {
                                                const translation = await translateWithRetry(
                                                    newText,
                                                    targetLanguage,
                                                    clientId
                                                );

                                                translationCount++;

                                                logger.info('✅ Fallback translation completed', {
                                                    clientId,
                                                    original: newText.substring(0, 50),
                                                    translated: translation.substring(0, 50),
                                                    count: translationCount
                                                });

                                                socket.emit('translation-result', {
                                                    original: newText,
                                                    translated: translation,
                                                    accumulated: accumulatedText,
                                                    count: translationCount,
                                                    isInterim: true  // Fallback time-based translation
                                                });

                                                lastTranslatedText = lastInterimText; // Remember what we've translated
                                                restartStreamTimer = null; // Clear timer reference
                                            } catch (error) {
                                                logger.error('Fallback translation error', {
                                                    clientId,
                                                    error: error.message
                                                });
                                                restartStreamTimer = null; // Clear timer reference even on error
                                            }
                                        } else {
                                            logger.debug('⏰ No new text to translate, skipping', { clientId });
                                            restartStreamTimer = null;
                                        }
                                    } else {
                                        restartStreamTimer = null;
                                    }
                                }, intervalMs); // Dynamic interval based on mode
                            }
                        }
                    }

                    // Translate on final results (even if session stopped - Google sends final after stop)
                    if (isFinal && transcript.trim().length > 0) {
                        // Cancel forced translation timer since we got a real final result
                        if (restartStreamTimer) {
                            clearTimeout(restartStreamTimer);
                            restartStreamTimer = null;
                        }

                        accumulatedText += (accumulatedText ? ' ' : '') + transcript;
                        lastInterimText = ''; // Clear interim after final
                        lastTranslatedText = ''; // Reset for next segment

                        try {
                            const translation = await translateWithRetry(
                                transcript,
                                targetLanguage,
                                clientId
                            );

                            translationCount++;

                            logger.info('✅ Translation completed', {
                                clientId,
                                original: transcript.substring(0, 50),
                                translated: translation.substring(0, 50),
                                count: translationCount
                            });

                            socket.emit('translation-result', {
                                original: transcript,
                                translated: translation,
                                accumulated: accumulatedText,
                                count: translationCount,
                                isInterim: false  // Final Google Cloud translation
                            });

                            // Reset timer after successful final result
                            if (restartStreamTimer) {
                                clearTimeout(restartStreamTimer);
                                restartStreamTimer = null;
                            }
                        } catch (error) {
                            logger.error('Translation error', {
                                clientId,
                                error: error.message
                            });
                            socket.emit('translation-error', {
                                message: error.message
                            });
                        }
                    }
                });

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
    socket.on('start-streaming', async ({ sourceLanguage, targetLang, translationInterval: interval, isRestart }) => {
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

        if (interval !== undefined && (typeof interval !== 'number' || interval < 1000 || interval > 60000)) {
            logger.warn('Invalid translation interval', { clientId, interval });
            socket.emit('start-error', { message: 'Translation interval must be between 1000 and 60000 ms' });
            return;
        }

        // Call the extracted function
        await createRecognitionStream(
            sourceLanguage || 'ro-RO',
            targetLang || 'en',
            interval || 10000,
            isRestart || false
        );
    });

    // Receive audio data from client
    let audioChunkCount = 0;
    const MAX_AUDIO_CHUNK_SIZE = 1024 * 1024; // 1MB max per chunk

    // Rate limiting for audio data
    let audioDataReceived = 0;
    let audioRateLimitWindow = Date.now();
    const MAX_AUDIO_BYTES_PER_SECOND = 1024 * 1024 * 2; // 2MB/sec max

    // Detect audio format once for efficiency
    let audioDataFormat = null;

    socket.on('audio-data', (audioData) => {
        if (recognizeStream && sessionActive && recognizeStream.writable) {
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
server.listen(PORT, () => {
    logger.info('═══════════════════════════════════════');
    logger.info('🎉 GTranslate V4 - Google Cloud Speech');
    logger.info('═══════════════════════════════════════');
    logger.info(`🌐 Server: http://localhost:${PORT}`);
    logger.info('🎤 Speech Recognition: Google Cloud (No timeout)');
    logger.info('🌍 Translation: Google Cloud');
    logger.info('📝 Logging: gtranslate-v4.log');
    logger.info('═══════════════════════════════════════');
    logger.info('✅ Ready to receive connections');
});

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGINT', () => {
    logger.info('Shutting down gracefully...');
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});
