/**
 * GTranslate V4 Server - HTTPS Version
 * For mobile access requiring secure connection
 */

const express = require('express');
const https = require('https');
const socketIo = require('socket.io');
const speech = require('@google-cloud/speech');
const { Translate } = require('@google-cloud/translate').v2;
const winston = require('winston');
const path = require('path');
const fs = require('fs');

// ===== CONFIGURATION =====
const PORT = 3003;
const CREDENTIALS_PATH = path.join(__dirname, 'google-credentials.json');

// SSL Certificate paths
const SSL_KEY = path.join(__dirname, 'key.pem');
const SSL_CERT = path.join(__dirname, 'cert.pem');

// ===== LOGGING SETUP =====
const logger = winston.createLogger({
    level: 'debug',
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

// ===== CHECK CREDENTIALS =====
if (!fs.existsSync(CREDENTIALS_PATH)) {
    logger.error('❌ Credentials file not found!');
    logger.error(`Looking for: ${CREDENTIALS_PATH}`);
    logger.error('Please follow SETUP.md to create and download google-credentials.json');
    process.exit(1);
}

// ===== CHECK SSL CERTIFICATES =====
if (!fs.existsSync(SSL_KEY) || !fs.existsSync(SSL_CERT)) {
    logger.error('❌ SSL certificates not found!');
    logger.error('Run: bash generate-cert.sh');
    logger.error(`Looking for: ${SSL_KEY} and ${SSL_CERT}`);
    process.exit(1);
}

// Set credentials environment variable
process.env.GOOGLE_APPLICATION_CREDENTIALS = CREDENTIALS_PATH;

// ===== INITIALIZE GOOGLE CLOUD CLIENTS =====
const speechClient = new speech.SpeechClient();
const translateClient = new Translate();

logger.info('✅ Google Cloud Speech-to-Text client initialized');
logger.info('✅ Google Cloud Translation client initialized');

// ===== EXPRESS SETUP WITH HTTPS =====
const app = express();

// Read SSL certificates
const httpsOptions = {
    key: fs.readFileSync(SSL_KEY),
    cert: fs.readFileSync(SSL_CERT)
};

const server = https.createServer(httpsOptions, app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ===== SOCKET.IO CONNECTION HANDLING =====
// (Copy all socket.io code from server.js - same as before)
let activeConnections = 0;

io.on('connection', (socket) => {
    activeConnections++;
    const clientId = socket.id.substring(0, 8);

    logger.info('✅ Client connected', {
        socketId: socket.id,
        totalConnections: activeConnections
    });

    let recognizeStream = null;
    let currentLanguage = 'ro-RO';
    let targetLanguage = 'en';
    let accumulatedText = '';
    let translationCount = 0;
    let sessionActive = false;
    let restartStreamTimer = null;
    let lastInterimText = '';
    let lastTranslatedText = '';

    socket.on('start-streaming', async ({ sourceLanguage, targetLang }) => {
        try {
            currentLanguage = sourceLanguage || 'ro-RO';
            targetLanguage = targetLang || 'en';
            accumulatedText = '';
            translationCount = 0;
            sessionActive = true;

            logger.info('🎤 Starting speech recognition stream', {
                clientId,
                sourceLanguage: currentLanguage,
                targetLanguage
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
                    enableSpeakerDiarization: false
                },
                interimResults: true,
                singleUtterance: false
            };

            recognizeStream = speechClient
                .streamingRecognize(request)
                .on('error', (error) => {
                    logger.error('Speech recognition error', {
                        clientId,
                        error: error.message,
                        code: error.code,
                        stack: error.stack
                    });
                    socket.emit('recognition-error', {
                        message: error.message,
                        code: error.code
                    });
                })
                .on('end', () => {
                    logger.info('Recognition stream ended', { clientId });
                })
                .on('data', async (data) => {
                    const result = data.results[0];
                    if (!result) return;

                    const transcript = result.alternatives[0].transcript;
                    const isFinal = result.isFinal;

                    if (sessionActive) {
                        socket.emit('interim-result', {
                            text: transcript,
                            isFinal
                        });

                        if (!isFinal) {
                            lastInterimText = transcript;

                            if (!restartStreamTimer) {
                                restartStreamTimer = setTimeout(async () => {
                                    if (lastInterimText.trim().length > 0 && sessionActive) {
                                        const newText = lastInterimText.substring(lastTranslatedText.length).trim();

                                        if (newText.length > 0) {
                                            accumulatedText += (accumulatedText ? ' ' : '') + newText;

                                            try {
                                                const [translation] = await translateClient.translate(
                                                    newText,
                                                    targetLanguage
                                                );

                                                translationCount++;

                                                socket.emit('translation-result', {
                                                    original: newText,
                                                    translated: translation,
                                                    accumulated: accumulatedText,
                                                    count: translationCount,
                                                    isInterim: true
                                                });

                                                lastTranslatedText = lastInterimText;
                                                restartStreamTimer = null;
                                            } catch (error) {
                                                logger.error('Forced translation error', {
                                                    clientId,
                                                    error: error.message
                                                });
                                                restartStreamTimer = null;
                                            }
                                        } else {
                                            restartStreamTimer = null;
                                        }
                                    } else {
                                        restartStreamTimer = null;
                                    }
                                }, 10000);
                            }
                        }
                    }

                    if (isFinal && transcript.trim().length > 0) {
                        if (restartStreamTimer) {
                            clearTimeout(restartStreamTimer);
                            restartStreamTimer = null;
                        }

                        accumulatedText += (accumulatedText ? ' ' : '') + transcript;
                        lastInterimText = '';
                        lastTranslatedText = '';

                        try {
                            const [translation] = await translateClient.translate(
                                transcript,
                                targetLanguage
                            );

                            translationCount++;

                            socket.emit('translation-result', {
                                original: transcript,
                                translated: translation,
                                accumulated: accumulatedText,
                                count: translationCount,
                                isInterim: false
                            });

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
    });

    let audioChunkCount = 0;
    socket.on('audio-data', (audioData) => {
        if (recognizeStream && sessionActive) {
            try {
                audioChunkCount++;

                let buffer;
                if (audioData instanceof Buffer) {
                    buffer = audioData;
                } else if (audioData instanceof ArrayBuffer) {
                    buffer = Buffer.from(audioData);
                } else if (audioData.buffer) {
                    buffer = Buffer.from(audioData.buffer);
                } else {
                    buffer = Buffer.from(audioData);
                }

                recognizeStream.write(buffer);
            } catch (error) {
                logger.error('Error writing audio data', {
                    clientId,
                    error: error.message,
                    stack: error.stack
                });
            }
        }
    });

    socket.on('stop-streaming', () => {
        logger.info('⏹️ Stopping speech recognition stream', {
            clientId,
            translationCount,
            accumulatedLength: accumulatedText.length
        });

        sessionActive = false;

        if (restartStreamTimer) {
            clearTimeout(restartStreamTimer);
            restartStreamTimer = null;
        }

        if (recognizeStream) {
            recognizeStream.end();
            recognizeStream = null;
        }

        socket.emit('streaming-stopped', {
            translationCount,
            accumulatedText
        });
    });

    socket.on('disconnect', () => {
        activeConnections--;
        sessionActive = false;

        if (restartStreamTimer) {
            clearTimeout(restartStreamTimer);
            restartStreamTimer = null;
        }

        if (recognizeStream) {
            recognizeStream.end();
            recognizeStream = null;
        }

        logger.info('❌ Client disconnected', {
            socketId: socket.id,
            remainingConnections: activeConnections,
            translationCount
        });
    });
});

// ===== START HTTPS SERVER =====
server.listen(PORT, () => {
    logger.info('═══════════════════════════════════════');
    logger.info('🎉 GTranslate V4 - HTTPS Server');
    logger.info('═══════════════════════════════════════');
    logger.info(`🌐 Server: https://localhost:${PORT}`);
    logger.info(`📱 Local IP: https://<your-local-ip>:${PORT}`);
    logger.info('🔒 HTTPS Enabled (Self-signed certificate)');
    logger.info('🎤 Speech Recognition: Google Cloud (No timeout)');
    logger.info('🌍 Translation: Google Cloud');
    logger.info('📝 Logging: gtranslate-v4.log');
    logger.info('═══════════════════════════════════════');
    logger.info('✅ Ready to receive connections');
    logger.info('⚠️  Accept security warning in browser for self-signed cert');
});

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGINT', () => {
    logger.info('Shutting down gracefully...');
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});
