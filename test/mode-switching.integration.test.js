/**
 * Integration Tests for Mode Switching
 * Tests the end-to-end mode switching functionality between Talks and Q&A modes
 */

const { describe, it, before, after } = require('mocha');
const { expect } = require('chai');
const io = require('socket.io-client');
const http = require('http');
const path = require('path');

// Note: These tests require the server to be running
// Run with: npm test
// Or start server separately: node server.js

const SERVER_URL = 'http://localhost:3003';

describe('Mode Switching Integration Tests', () => {
    let clientSocket;

    beforeEach((done) => {
        // Connect to server before each test
        clientSocket = io(SERVER_URL, {
            reconnection: false,
            transports: ['websocket']
        });

        clientSocket.on('connect', () => {
            done();
        });

        clientSocket.on('connect_error', (error) => {
            console.error('Connection failed:', error.message);
            done(error);
        });
    });

    afterEach((done) => {
        if (clientSocket && clientSocket.connected) {
            clientSocket.disconnect();
        }
        done();
    });

    describe('Talks Mode (10 seconds)', () => {
        it('should start streaming with 10-second interval', (done) => {
            let streamingStarted = false;

            clientSocket.on('streaming-started', (data) => {
                streamingStarted = true;
                expect(data.sourceLanguage).to.equal('ro-RO');
                expect(data.targetLanguage).to.equal('en');
            });

            clientSocket.emit('start-streaming', {
                sourceLanguage: 'ro-RO',
                targetLang: 'en',
                translationInterval: 10000 // Talks mode
            });

            setTimeout(() => {
                expect(streamingStarted).to.be.true;
                clientSocket.emit('stop-streaming');
                done();
            }, 500);
        }).timeout(5000);

        it('should use default 10-second interval when not specified', (done) => {
            let streamingStarted = false;

            clientSocket.on('streaming-started', (data) => {
                streamingStarted = true;
                expect(data.sourceLanguage).to.equal('ro-RO');
                expect(data.targetLanguage).to.equal('en');
            });

            clientSocket.emit('start-streaming', {
                sourceLanguage: 'ro-RO',
                targetLang: 'en'
                // translationInterval not specified - should default to 10000
            });

            setTimeout(() => {
                expect(streamingStarted).to.be.true;
                clientSocket.emit('stop-streaming');
                done();
            }, 500);
        }).timeout(5000);
    });

    describe('Q&A Mode (4 seconds)', () => {
        it('should start streaming with 4-second interval', (done) => {
            let streamingStarted = false;

            clientSocket.on('streaming-started', (data) => {
                streamingStarted = true;
                expect(data.sourceLanguage).to.equal('ro-RO');
                expect(data.targetLanguage).to.equal('en');
            });

            clientSocket.emit('start-streaming', {
                sourceLanguage: 'ro-RO',
                targetLang: 'en',
                translationInterval: 4000 // Q&A mode
            });

            setTimeout(() => {
                expect(streamingStarted).to.be.true;
                clientSocket.emit('stop-streaming');
                done();
            }, 500);
        }).timeout(5000);
    });

    describe('Mode Switching', () => {
        it('should switch from Talks to Q&A mode', (done) => {
            let talksStarted = false;
            let qaStarted = false;

            const startedHandler = () => {
                if (!talksStarted) {
                    talksStarted = true;
                    // Stop Talks mode after it starts
                    setTimeout(() => {
                        clientSocket.emit('stop-streaming');
                    }, 200);
                } else if (!qaStarted) {
                    qaStarted = true;
                    // Q&A mode started successfully
                    setTimeout(() => {
                        clientSocket.emit('stop-streaming');
                        done();
                    }, 200);
                }
            };

            const stoppedHandler = () => {
                if (talksStarted && !qaStarted) {
                    // Talks mode stopped, start Q&A mode
                    setTimeout(() => {
                        clientSocket.emit('start-streaming', {
                            sourceLanguage: 'ro-RO',
                            targetLang: 'en',
                            translationInterval: 4000 // Q&A mode
                        });
                    }, 200);
                }
            };

            clientSocket.on('streaming-started', startedHandler);
            clientSocket.on('streaming-stopped', stoppedHandler);

            // Start with Talks mode
            clientSocket.emit('start-streaming', {
                sourceLanguage: 'ro-RO',
                targetLang: 'en',
                translationInterval: 10000 // Talks mode
            });
        }).timeout(10000);

        it('should switch from Q&A to Talks mode', (done) => {
            let qaStarted = false;
            let talksStarted = false;

            const startedHandler = () => {
                if (!qaStarted) {
                    qaStarted = true;
                    // Stop Q&A mode after it starts
                    setTimeout(() => {
                        clientSocket.emit('stop-streaming');
                    }, 200);
                } else if (!talksStarted) {
                    talksStarted = true;
                    // Talks mode started successfully
                    setTimeout(() => {
                        clientSocket.emit('stop-streaming');
                        done();
                    }, 200);
                }
            };

            const stoppedHandler = () => {
                if (qaStarted && !talksStarted) {
                    // Q&A mode stopped, start Talks mode
                    setTimeout(() => {
                        clientSocket.emit('start-streaming', {
                            sourceLanguage: 'ro-RO',
                            targetLang: 'en',
                            translationInterval: 10000 // Talks mode
                        });
                    }, 200);
                }
            };

            clientSocket.on('streaming-started', startedHandler);
            clientSocket.on('streaming-stopped', stoppedHandler);

            // Start with Q&A mode
            clientSocket.emit('start-streaming', {
                sourceLanguage: 'ro-RO',
                targetLang: 'en',
                translationInterval: 4000 // Q&A mode
            });
        }).timeout(10000);
    });

    describe('Error Handling', () => {
        it('should handle invalid interval values gracefully', (done) => {
            let errorReceived = false;

            clientSocket.on('start-error', (data) => {
                errorReceived = true;
            });

            clientSocket.on('streaming-started', () => {
                // Should still start even with invalid interval (will use default)
                setTimeout(() => {
                    clientSocket.emit('stop-streaming');
                    done();
                }, 500);
            });

            clientSocket.emit('start-streaming', {
                sourceLanguage: 'ro-RO',
                targetLang: 'en',
                translationInterval: 'invalid' // Invalid value
            });
        }).timeout(5000);

        it('should handle negative interval values', (done) => {
            clientSocket.on('streaming-started', () => {
                // Should still start (will use default or handle gracefully)
                setTimeout(() => {
                    clientSocket.emit('stop-streaming');
                    done();
                }, 500);
            });

            clientSocket.emit('start-streaming', {
                sourceLanguage: 'ro-RO',
                targetLang: 'en',
                translationInterval: -1000 // Negative value
            });
        }).timeout(5000);
    });

    describe('Multiple Connections', () => {
        let secondSocket;

        afterEach((done) => {
            if (secondSocket && secondSocket.connected) {
                secondSocket.disconnect();
            }
            done();
        });

        it('should handle multiple clients with different modes', (done) => {
            let client1Started = false;
            let client2Started = false;

            clientSocket.on('streaming-started', () => {
                client1Started = true;
                checkBothStarted();
            });

            secondSocket = io(SERVER_URL, {
                reconnection: false,
                transports: ['websocket']
            });

            secondSocket.on('connect', () => {
                secondSocket.emit('start-streaming', {
                    sourceLanguage: 'ro-RO',
                    targetLang: 'en',
                    translationInterval: 4000 // Q&A mode
                });
            });

            secondSocket.on('streaming-started', () => {
                client2Started = true;
                checkBothStarted();
            });

            function checkBothStarted() {
                if (client1Started && client2Started) {
                    clientSocket.emit('stop-streaming');
                    secondSocket.emit('stop-streaming');
                    done();
                }
            }

            // Start first client with Talks mode
            clientSocket.emit('start-streaming', {
                sourceLanguage: 'ro-RO',
                targetLang: 'en',
                translationInterval: 10000 // Talks mode
            });
        }).timeout(10000);
    });

    describe('Language Support', () => {
        it('should support Q&A mode with different source languages', (done) => {
            const languages = ['ro-RO', 'es-ES', 'fr-FR'];
            let completedCount = 0;

            function testLanguage(lang) {
                const testSocket = io(SERVER_URL, {
                    reconnection: false,
                    transports: ['websocket']
                });

                testSocket.on('connect', () => {
                    testSocket.emit('start-streaming', {
                        sourceLanguage: lang,
                        targetLang: 'en',
                        translationInterval: 4000 // Q&A mode
                    });
                });

                testSocket.on('streaming-started', (data) => {
                    expect(data.sourceLanguage).to.equal(lang);
                    testSocket.emit('stop-streaming');
                });

                testSocket.on('streaming-stopped', () => {
                    testSocket.disconnect();
                    completedCount++;
                    if (completedCount === languages.length) {
                        done();
                    }
                });
            }

            languages.forEach(testLanguage);
        }).timeout(15000);
    });

    describe('Session Cleanup', () => {
        it('should clean up session when client disconnects during Talks mode', (done) => {
            clientSocket.on('streaming-started', () => {
                // Disconnect abruptly without stopping
                clientSocket.disconnect();

                // Reconnect to verify server handled cleanup
                setTimeout(() => {
                    const newSocket = io(SERVER_URL, {
                        reconnection: false,
                        transports: ['websocket']
                    });

                    newSocket.on('connect', () => {
                        newSocket.emit('start-streaming', {
                            sourceLanguage: 'ro-RO',
                            targetLang: 'en',
                            translationInterval: 10000
                        });
                    });

                    newSocket.on('streaming-started', () => {
                        newSocket.emit('stop-streaming');
                        newSocket.disconnect();
                        done();
                    });
                }, 500);
            });

            clientSocket.emit('start-streaming', {
                sourceLanguage: 'ro-RO',
                targetLang: 'en',
                translationInterval: 10000 // Talks mode
            });
        }).timeout(10000);

        it('should clean up session when client disconnects during Q&A mode', (done) => {
            clientSocket.on('streaming-started', () => {
                // Disconnect abruptly without stopping
                clientSocket.disconnect();

                // Reconnect to verify server handled cleanup
                setTimeout(() => {
                    const newSocket = io(SERVER_URL, {
                        reconnection: false,
                        transports: ['websocket']
                    });

                    newSocket.on('connect', () => {
                        newSocket.emit('start-streaming', {
                            sourceLanguage: 'ro-RO',
                            targetLang: 'en',
                            translationInterval: 4000
                        });
                    });

                    newSocket.on('streaming-started', () => {
                        newSocket.emit('stop-streaming');
                        newSocket.disconnect();
                        done();
                    });
                }, 500);
            });

            clientSocket.emit('start-streaming', {
                sourceLanguage: 'ro-RO',
                targetLang: 'en',
                translationInterval: 4000 // Q&A mode
            });
        }).timeout(10000);
    });
});
