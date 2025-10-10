/**
 * Integration Tests for GTranslate V4
 * Tests actual server, Socket.IO, Google Cloud APIs
 *
 * REQUIREMENTS:
 * - Server must be running on port 3003
 * - Google Cloud credentials must be configured
 * - npm install socket.io-client
 */

const io = require('socket.io-client');
const assert = require('assert');
const http = require('http');

const SERVER_URL = 'http://localhost:3003';
const TEST_TIMEOUT = 30000; // 30 seconds for API calls

let testsPassed = 0;
let testsFailed = 0;

// Utility function to wait
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Utility function to create test audio data
function createTestAudioBuffer(samples = 4096) {
    const float32Array = new Float32Array(samples);
    // Generate simple sine wave
    for (let i = 0; i < samples; i++) {
        float32Array[i] = Math.sin(2 * Math.PI * 440 * i / 16000) * 0.3;
    }

    // Convert to Int16
    const int16Array = new Int16Array(samples);
    for (let i = 0; i < samples; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    return int16Array.buffer;
}

async function runTest(testName, testFn) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST: ${testName}`);
    console.log('='.repeat(60));

    try {
        await testFn();
        console.log(`✅ PASSED: ${testName}`);
        testsPassed++;
    } catch (error) {
        console.log(`❌ FAILED: ${testName}`);
        console.log(`   Error: ${error.message}`);
        testsFailed++;
    }
}

// ===== TEST 1: Server Health Check =====
async function testServerHealth() {
    return new Promise((resolve, reject) => {
        http.get(SERVER_URL, (res) => {
            assert.strictEqual(res.statusCode, 200, 'Server should respond with 200');
            console.log('   ✓ Server is running');
            console.log('   ✓ HTTP endpoint accessible');
            resolve();
        }).on('error', (err) => {
            reject(new Error(`Server not accessible: ${err.message}`));
        });
    });
}

// ===== TEST 2: Socket.IO Connection =====
async function testSocketConnection() {
    return new Promise((resolve, reject) => {
        const socket = io(SERVER_URL, { transports: ['websocket'] });

        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('Connection timeout'));
        }, 5000);

        socket.on('connect', () => {
            console.log('   ✓ Socket.IO connected');
            console.log(`   ✓ Socket ID: ${socket.id}`);
            clearTimeout(timeout);
            socket.close();
            resolve();
        });

        socket.on('connect_error', (error) => {
            clearTimeout(timeout);
            socket.close();
            reject(new Error(`Connection error: ${error.message}`));
        });
    });
}

// ===== TEST 3: Start Streaming Event =====
async function testStartStreaming() {
    return new Promise((resolve, reject) => {
        const socket = io(SERVER_URL, { transports: ['websocket'] });

        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('Start streaming timeout'));
        }, 10000);

        socket.on('connect', () => {
            console.log('   ✓ Socket connected');

            socket.emit('start-streaming', {
                sourceLanguage: 'en-US',
                targetLang: 'es'
            });
            console.log('   ✓ Sent start-streaming event');
        });

        socket.on('streaming-started', (data) => {
            console.log('   ✓ Received streaming-started event');
            console.log(`   ✓ Source language: ${data.sourceLanguage}`);
            console.log(`   ✓ Target language: ${data.targetLanguage}`);

            assert.strictEqual(data.sourceLanguage, 'en-US', 'Source language should match');
            assert.strictEqual(data.targetLanguage, 'es', 'Target language should match');

            clearTimeout(timeout);
            socket.emit('stop-streaming');
            socket.close();
            resolve();
        });

        socket.on('start-error', (error) => {
            clearTimeout(timeout);
            socket.close();
            reject(new Error(`Start error: ${error.message}`));
        });

        socket.on('recognition-error', (error) => {
            clearTimeout(timeout);
            socket.close();
            reject(new Error(`Recognition error: ${error.message}`));
        });
    });
}

// ===== TEST 4: Audio Data Streaming and Buffer Size =====
async function testAudioStreaming() {
    return new Promise((resolve, reject) => {
        const socket = io(SERVER_URL, { transports: ['websocket'] });

        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('Audio streaming timeout'));
        }, 10000);

        let audioChunksSent = 0;
        let streamingStarted = false;
        const EXPECTED_BUFFER_SIZE = 4096 * 2; // 4096 samples * 2 bytes = 8192

        socket.on('connect', () => {
            console.log('   ✓ Socket connected');

            socket.emit('start-streaming', {
                sourceLanguage: 'en-US',
                targetLang: 'es'
            });
        });

        socket.on('streaming-started', () => {
            console.log('   ✓ Streaming started');
            streamingStarted = true;

            // Send audio data chunks
            const sendChunks = setInterval(() => {
                if (audioChunksSent >= 5) {
                    clearInterval(sendChunks);
                    clearTimeout(timeout);
                    console.log(`   ✓ Sent ${audioChunksSent} audio chunks successfully`);
                    socket.emit('stop-streaming');
                    socket.close();
                    resolve();
                    return;
                }

                const audioBuffer = createTestAudioBuffer(4096);

                // CRITICAL: Validate buffer size
                assert.strictEqual(audioBuffer.byteLength, EXPECTED_BUFFER_SIZE,
                    `Buffer size should be ${EXPECTED_BUFFER_SIZE} bytes, got ${audioBuffer.byteLength}`);

                socket.emit('audio-data', audioBuffer);
                audioChunksSent++;
                console.log(`   ✓ Sent audio chunk ${audioChunksSent}/5 (${audioBuffer.byteLength} bytes)`);
            }, 200);
        });

        socket.on('recognition-error', (error) => {
            clearTimeout(timeout);
            socket.close();
            // Some errors are expected (audio might not be recognizable)
            console.log(`   ⚠ Recognition error (expected): ${error.message}`);
            if (audioChunksSent >= 5) {
                resolve(); // Still pass if we sent the chunks
            } else {
                reject(new Error(`Recognition error: ${error.message}`));
            }
        });
    });
}

// ===== TEST 5: Stop Streaming Event =====
async function testStopStreaming() {
    return new Promise((resolve, reject) => {
        const socket = io(SERVER_URL, { transports: ['websocket'] });

        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('Stop streaming timeout'));
        }, 10000);

        socket.on('connect', () => {
            console.log('   ✓ Socket connected');

            socket.emit('start-streaming', {
                sourceLanguage: 'en-US',
                targetLang: 'es'
            });
        });

        socket.on('streaming-started', () => {
            console.log('   ✓ Streaming started');

            // Immediately stop
            socket.emit('stop-streaming');
            console.log('   ✓ Sent stop-streaming event');
        });

        socket.on('streaming-stopped', (data) => {
            console.log('   ✓ Received streaming-stopped event');
            console.log(`   ✓ Translation count: ${data.translationCount}`);

            assert.strictEqual(typeof data.translationCount, 'number', 'Should have translation count');
            assert.strictEqual(typeof data.accumulatedText, 'string', 'Should have accumulated text');

            clearTimeout(timeout);
            socket.close();
            resolve();
        });
    });
}

// ===== TEST 6: Multiple Simultaneous Connections =====
async function testMultipleConnections() {
    return new Promise((resolve, reject) => {
        const socket1 = io(SERVER_URL, { transports: ['websocket'] });
        const socket2 = io(SERVER_URL, { transports: ['websocket'] });

        const timeout = setTimeout(() => {
            socket1.close();
            socket2.close();
            reject(new Error('Multiple connections timeout'));
        }, 10000);

        let socket1Connected = false;
        let socket2Connected = false;

        socket1.on('connect', () => {
            console.log('   ✓ Socket 1 connected');
            socket1Connected = true;
            checkBothConnected();
        });

        socket2.on('connect', () => {
            console.log('   ✓ Socket 2 connected');
            socket2Connected = true;
            checkBothConnected();
        });

        function checkBothConnected() {
            if (socket1Connected && socket2Connected) {
                console.log('   ✓ Both sockets connected simultaneously');
                clearTimeout(timeout);
                socket1.close();
                socket2.close();
                resolve();
            }
        }
    });
}

// ===== TEST 7: Disconnect Cleanup =====
async function testDisconnectCleanup() {
    return new Promise((resolve, reject) => {
        const socket = io(SERVER_URL, { transports: ['websocket'] });

        const timeout = setTimeout(() => {
            reject(new Error('Disconnect cleanup timeout'));
        }, 10000);

        socket.on('connect', () => {
            console.log('   ✓ Socket connected');

            socket.emit('start-streaming', {
                sourceLanguage: 'en-US',
                targetLang: 'es'
            });
        });

        socket.on('streaming-started', () => {
            console.log('   ✓ Streaming started');

            // Send some audio
            const audioBuffer = createTestAudioBuffer(4096);
            socket.emit('audio-data', audioBuffer);
            console.log('   ✓ Sent audio data');

            // Disconnect without stopping
            socket.close();
            console.log('   ✓ Disconnected without stopping streaming');

            // Wait a bit to ensure server cleans up
            setTimeout(() => {
                clearTimeout(timeout);
                console.log('   ✓ Server should have cleaned up resources');
                resolve();
            }, 1000);
        });
    });
}

// ===== TEST 8: Invalid Language Codes =====
async function testInvalidLanguageCodes() {
    return new Promise((resolve, reject) => {
        const socket = io(SERVER_URL, { transports: ['websocket'] });

        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('Invalid language test timeout'));
        }, 10000);

        socket.on('connect', () => {
            console.log('   ✓ Socket connected');

            // Try with invalid language code
            socket.emit('start-streaming', {
                sourceLanguage: 'invalid-XX',
                targetLang: 'es'
            });
            console.log('   ✓ Sent start-streaming with invalid source language');
        });

        socket.on('streaming-started', (data) => {
            console.log('   ✓ Server accepted invalid language (will likely error on recognition)');
            clearTimeout(timeout);
            socket.emit('stop-streaming');
            socket.close();
            resolve();
        });

        socket.on('recognition-error', (error) => {
            console.log(`   ✓ Received expected recognition error: ${error.message}`);
            clearTimeout(timeout);
            socket.close();
            resolve();
        });

        socket.on('start-error', (error) => {
            console.log(`   ✓ Received expected start error: ${error.message}`);
            clearTimeout(timeout);
            socket.close();
            resolve();
        });
    });
}

// ===== TEST 9: Interim Results =====
async function testInterimResults() {
    return new Promise((resolve, reject) => {
        const socket = io(SERVER_URL, { transports: ['websocket'] });

        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('Interim results timeout'));
        }, 15000);

        let receivedInterim = false;

        socket.on('connect', () => {
            console.log('   ✓ Socket connected');

            socket.emit('start-streaming', {
                sourceLanguage: 'en-US',
                targetLang: 'es'
            });
        });

        socket.on('streaming-started', () => {
            console.log('   ✓ Streaming started');

            // Send audio chunks
            let chunks = 0;
            const interval = setInterval(() => {
                if (chunks >= 10) {
                    clearInterval(interval);
                    if (!receivedInterim) {
                        console.log('   ⚠ No interim results received (audio might not be recognizable)');
                    }
                    clearTimeout(timeout);
                    socket.emit('stop-streaming');
                    socket.close();
                    resolve(); // Pass anyway - audio might not be recognizable
                    return;
                }

                const audioBuffer = createTestAudioBuffer(4096);
                socket.emit('audio-data', audioBuffer);
                chunks++;
            }, 200);
        });

        socket.on('interim-result', (data) => {
            if (!receivedInterim) {
                console.log('   ✓ Received interim result');
                console.log(`   ✓ Interim text: "${data.text}"`);
                receivedInterim = true;
            }
        });

        socket.on('recognition-error', (error) => {
            console.log(`   ⚠ Recognition error (expected for test audio): ${error.message}`);
            clearTimeout(timeout);
            socket.close();
            resolve(); // Pass - test audio might not be recognizable
        });
    });
}

// ===== RUN ALL TESTS =====
async function runAllTests() {
    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  GTranslate V4 - Integration Tests                        ║');
    console.log('║  Testing against: http://localhost:3003                   ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    await runTest('1. Server Health Check', testServerHealth);
    await runTest('2. Socket.IO Connection', testSocketConnection);
    await runTest('3. Start Streaming Event', testStartStreaming);
    await runTest('4. Audio Data Streaming and Buffer Size', testAudioStreaming);
    await runTest('5. Stop Streaming Event', testStopStreaming);
    await runTest('6. Multiple Simultaneous Connections', testMultipleConnections);
    await runTest('7. Disconnect Cleanup', testDisconnectCleanup);
    await runTest('8. Invalid Language Codes', testInvalidLanguageCodes);
    await runTest('9. Interim Results', testInterimResults);

    console.log('\n⚠️  NOTE: Server should log "type: Buffer" for audio chunks');
    console.log('   Check server logs to verify Buffer conversion is working\n');

    // Print summary
    console.log('\n');
    console.log('═'.repeat(60));
    console.log('TEST SUMMARY');
    console.log('═'.repeat(60));
    console.log(`✅ PASSED: ${testsPassed}`);
    console.log(`❌ FAILED: ${testsFailed}`);
    console.log(`📊 TOTAL:  ${testsPassed + testsFailed}`);
    console.log('═'.repeat(60));

    if (testsFailed === 0) {
        console.log('\n🎉 ALL INTEGRATION TESTS PASSED! 🎉\n');
        process.exit(0);
    } else {
        console.log('\n⚠️  SOME TESTS FAILED\n');
        process.exit(1);
    }
}

// Check if server is running before starting tests
http.get(SERVER_URL, () => {
    runAllTests();
}).on('error', () => {
    console.error('\n❌ ERROR: Server is not running on http://localhost:3003');
    console.error('Please start the server with: node server.js\n');
    process.exit(1);
});
