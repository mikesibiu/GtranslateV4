// NovaTranslate audio methods — wake lock, recording, audio level
// Requires: client.js loaded before this script

Object.assign(GTranslateV4Client.prototype, {
    async requestWakeLock() {
        // Release any existing sentinel before acquiring a new one (prevents double-sentinel leak)
        await this.releaseWakeLock();

        // Request screen wake lock to keep screen on during recording
        // Critical for mobile EarBuds mode where user listens with screen off
        if ('wakeLock' in navigator) {
            try {
                this.wakeLock = await navigator.wakeLock.request('screen');
                console.log('🔒 Screen wake lock acquired - screen will stay on');
                this.startWakeLockHeartbeat();

                // Re-acquire wake lock automatically if it's released
                this.wakeLock.addEventListener('release', async () => {
                    console.log('🔓 Wake lock released - attempting to re-acquire');

                    // Only re-acquire if we're still recording
                    if (this.isRecording) {
                        try {
                            await this.requestWakeLock();
                            console.log('🔒 Wake lock re-acquired successfully');
                        } catch (err) {
                            console.warn('⚠️ Could not re-acquire wake lock:', err.message);
                        }
                    }
                });
            } catch (err) {
                console.warn('⚠️ Could not acquire wake lock:', err.message);
                // Non-fatal - continue without wake lock

                // Warn user on mobile if wake lock fails
                if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
                    this.updateStatus('⚠️ Screen may turn off - keep phone unlocked', 'warning');
                }
            }
        } else {
            console.log('ℹ️ Wake Lock API not supported on this device');

            // Warn mobile users that screen must stay on
            if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
                this.updateStatus('⚠️ Keep screen on - app will stop if screen locks', 'warning');
                setTimeout(() => {
                    this.updateStatus('Listening...', 'listening');
                }, 5000);
            }
        }
    },

    startWakeLockHeartbeat() {
        if (this.wakeLockHeartbeat || !('wakeLock' in navigator)) {
            return;
        }

        this.wakeLockHeartbeat = setInterval(async () => {
            if (!this.isRecording) {
                this.stopWakeLockHeartbeat();
                return;
            }

            if (!this.wakeLock) {
                try {
                    await this.requestWakeLock();
                } catch (err) {
                    console.warn('⚠️ Wake lock heartbeat failed:', err.message);
                }
            }
        }, 45000); // Retry roughly every 45 seconds
    },

    stopWakeLockHeartbeat() {
        if (this.wakeLockHeartbeat) {
            clearInterval(this.wakeLockHeartbeat);
            this.wakeLockHeartbeat = null;
        }
    },

    async releaseWakeLock() {
        if (this.wakeLock) {
            try {
                await this.wakeLock.release();
                this.wakeLock = null;
                console.log('🔓 Screen wake lock released - screen can turn off');
            } catch (err) {
                console.warn('⚠️ Error releasing wake lock:', err);
            }
        }

        this.stopWakeLockHeartbeat();
    },

    async startRecording() {
        try {
            // Request wake lock to keep screen on (critical for mobile EarBuds mode)
            await this.requestWakeLock();

            // Validate inputs before starting
            const sourceLanguage = this.sourceLanguage.value;
            const targetLang = this.targetLanguage.value;
            const audioSourceType = this.audioSource.value;

            // Input validation
            if (!sourceLanguage || !targetLang) {
                throw new Error('Please select both source and target languages');
            }

            const validLanguageCodes = /^[a-z]{2}-[A-Z]{2}$/;
            const validTargetLanguages = /^[a-z]{2}(-[A-Z]{2})?$/;

            if (!validLanguageCodes.test(sourceLanguage)) {
                throw new Error('Invalid source language code');
            }

            if (!validTargetLanguages.test(targetLang)) {
                throw new Error('Invalid target language code');
            }

            if (typeof this.translationInterval !== 'number' || this.translationInterval < 1000 || this.translationInterval > 60000) {
                throw new Error('Invalid translation interval');
            }

            if (audioSourceType !== 'microphone') {
                throw new Error('Invalid audio source');
            }

            // Check browser support
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('Your browser does not support audio capture. Please use Chrome, Safari, or Firefox.');
            }

            {
                // Capture microphone
                // Enable echo cancellation + noise suppression for mic:
                // Without EC, TTS audio playing through speakers feeds back into Deepgram,
                // causing garbled Romanian transcription (Deepgram hears speech + English TTS).
                // autoGainControl disabled so our custom AudioWorklet AGC has full control.
                try {
                    this.mediaStream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: false,  // Custom AGC in AudioWorklet
                            sampleRate: 48000,
                            channelCount: 1
                        }
                    });
                    console.log('🎤 Microphone access granted');
                } catch (micError) {
                    // Handle specific permission errors
                    if (micError.name === 'NotAllowedError') {
                        throw new Error('Microphone permission denied. Please allow microphone access in your browser settings and try again.');
                    } else if (micError.name === 'NotFoundError') {
                        throw new Error('No microphone found. Please connect a microphone and try again.');
                    } else if (micError.name === 'NotReadableError') {
                        throw new Error('Microphone is already in use by another application. Please close other apps using the microphone and try again.');
                    } else {
                        throw micError;
                    }
                }
            }

            console.log('   Audio tracks:', this.mediaStream.getAudioTracks().length);
            console.log('   Track enabled:', this.mediaStream.getAudioTracks()[0]?.enabled);
            console.log('   Track settings:', this.mediaStream.getAudioTracks()[0]?.getSettings());

            // Create audio context
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

            console.log('🎧 Audio context created');
            console.log('   Sample rate:', this.audioContext.sampleRate);
            console.log('   State:', this.audioContext.state);

            // Fix Safari AudioContext suspended state
            if (this.audioContext.state === 'suspended') {
                console.log('⚠️ AudioContext is suspended, resuming...');
                await this.audioContext.resume();
                console.log('✅ AudioContext resumed, state:', this.audioContext.state);
            }

            // Try AudioWorklet first, fallback to ScriptProcessor for older Safari
            const source = this.audioContext.createMediaStreamSource(this.mediaStream);
            console.log('🎤 Media stream source created');

            // Create gain node to store gain value (used by ScriptProcessor fallback)
            // Note: Not connected to audio graph for AudioWorklet (gain applied inside worklet)
            this.gainNode = this.audioContext.createGain();
            const gainValue = this.micGainSlider && this.micGainSlider.value ?
                              parseFloat(this.micGainSlider.value) : 10.0;
            this.gainNode.gain.value = gainValue;
            console.log(`🎤 Gain value set to ${gainValue.toFixed(1)}x`);

            // Try AudioWorklet, fallback to ScriptProcessor
            let usingWorklet = false;
            if (this.audioContext.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
                try {
                    // Load AudioWorklet module only once (prevents memory leak)
                    if (!this.audioWorkletLoaded) {
                        await this.audioContext.audioWorklet.addModule('/audio-processor.js');
                        this.audioWorkletLoaded = true;
                        console.log('✅ AudioWorklet module loaded');
                    } else {
                        console.log('✅ AudioWorklet module already loaded (reusing)');
                    }

                    // Create AudioWorkletNode
                    this.processor = new AudioWorkletNode(this.audioContext, 'audio-processor');
                    usingWorklet = true;

                    // Send gain settings to AudioWorklet
                    const autoGainOn = this.autoGainToggle && this.autoGainToggle.checked;
                    if (autoGainOn) {
                        this.processor.port.postMessage({ command: 'setAutoGain', value: true });
                    } else {
                        const gainValue = this.micGainSlider && this.micGainSlider.value ?
                                          parseFloat(this.micGainSlider.value) : 10.0;
                        this.processor.port.postMessage({ command: 'setGain', value: gainValue });
                    }

                    console.log(`✅ Using AudioWorklet for audio processing (autoGain: ${autoGainOn})`);
                } catch (workletError) {
                    console.warn('⚠️ AudioWorklet failed, falling back to ScriptProcessor:', workletError);
                }
            }

            // Fallback to ScriptProcessor for Safari < 14.1
            // (includes simple AGC for the fallback path)
            if (!usingWorklet) {
                console.log('⚠️ Using ScriptProcessor fallback (deprecated but widely supported)');
                this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

                // AGC state for ScriptProcessor fallback
                let spGain = this.gainNode ? this.gainNode.gain.value : 10.0;
                let spLevelSmooth = 0.0;
                const spTarget = 0.35;

                this.processor.onaudioprocess = (event) => {
                    if (!this.isRecording) return;

                    const inputData = event.inputBuffer.getChannelData(0);

                    // AGC: measure raw peak and adjust gain
                    if (this.autoGainToggle && this.autoGainToggle.checked) {
                        let rawPeak = 0;
                        for (let i = 0; i < inputData.length; i++) {
                            const abs = Math.abs(inputData[i]);
                            if (abs > rawPeak) rawPeak = abs;
                        }
                        spLevelSmooth = spLevelSmooth * 0.9 + rawPeak * 0.1;
                        if (spLevelSmooth > 0.001) {
                            const desired = spTarget / spLevelSmooth;
                            const coeff = desired < spGain ? 0.15 : 0.005;
                            spGain += (desired - spGain) * coeff;
                            spGain = Math.max(1.0, Math.min(60.0, spGain));
                        }
                    } else {
                        spGain = this.gainNode ? this.gainNode.gain.value : 10.0;
                    }

                    // Apply gain, calculate level, convert to Int16
                    let maxLevel = 0;
                    const int16Data = new Int16Array(inputData.length);

                    for (let i = 0; i < inputData.length; i++) {
                        const amplifiedSample = inputData[i] * spGain;
                        const absSample = Math.abs(amplifiedSample);
                        if (absSample > maxLevel) maxLevel = absSample;
                        const clamped = amplifiedSample < -1 ? -1 : (amplifiedSample > 1 ? 1 : amplifiedSample);
                        int16Data[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
                    }

                    // Update gain display
                    if (this.autoGainToggle && this.autoGainToggle.checked) {
                        this.micGainValue.textContent = spGain.toFixed(1);
                    }

                    this.updateAudioLevel(maxLevel);
                    this.socket.emit('audio-data', int16Data.buffer);
                };
            }

            // Only setup port message handler for AudioWorklet
            if (usingWorklet) {
                let messageCount = 0;
                this.processor.port.onmessage = (event) => {
                    if (!this.isRecording) return;

                    const audioData = event.data.audioData;
                    const level = event.data.level;

                    // Debug first few messages
                    messageCount++;
                    if (messageCount <= 5) {
                        const buffer = new Int16Array(audioData);
                        const samples = Array.from(buffer.slice(0, 10));
                        const maxSample = Math.max(...samples.map(s => Math.abs(s)));
                        const hasAudio = maxSample > 100;
                        console.log(`📊 AudioWorklet message #${messageCount}:`, {
                            byteLength: audioData.byteLength,
                            firstSamples: samples,
                            maxSample,
                            levelFloat: level.toFixed(4),
                            hasAudio,
                            recommendation: hasAudio ? '✅ Good' : '⚠️ TOO QUIET - Speak louder or check mic volume'
                        });
                    }

                    // Update visual level meter
                    this.updateAudioLevel(level);

                    // Update gain display when auto-gain is active
                    if (event.data.currentGain !== undefined && this.autoGainToggle && this.autoGainToggle.checked) {
                        const g = event.data.currentGain;
                        this.micGainValue.textContent = g.toFixed(1);
                        this.micGainSlider.value = Math.min(g, parseFloat(this.micGainSlider.max));
                    }

                    // Send audio data to server
                    this.socket.emit('audio-data', audioData);
                };
            }

            // Force stereo output so TTS plays in both ears
            // Without this, mono processor → destination can put iOS audio session in mono mode
            this.audioContext.destination.channelCount = 2;

            // Connect audio graph based on processor type
            if (usingWorklet) {
                // AudioWorklet: source → processor (gain applied inside worklet) → silent output
                // Do NOT use Web Audio gainNode - would apply gain twice (10x × 10x = 100x!)
                source.connect(this.processor);

                // CRITICAL: Connect processor to a GainNode set to 0.001 then to destination
                // This keeps the AudioWorklet alive without actually outputting audible sound
                // If we don't connect to destination, browser may stop processing audio
                // Note: 0.001 is imperceptible even at max volume, but not optimized away by browser
                const silentGain = this.audioContext.createGain();
                silentGain.gain.value = 0.001; // Nearly silent (avoids browser optimization)
                silentGain.channelCount = 2;
                silentGain.channelCountMode = 'explicit';
                silentGain.channelInterpretation = 'speakers'; // Upmix mono → stereo
                this.processor.connect(silentGain);
                silentGain.connect(this.audioContext.destination);

                console.log('🔇 AudioWorklet connected: source → processor → stereo silent output (0.001x)');
            } else {
                // ScriptProcessor: source → processor (gain applied inside processor code)
                // Gain is applied manually in onaudioprocess handler
                source.connect(this.processor);

                const silentStereo = this.audioContext.createGain();
                silentStereo.channelCount = 2;
                silentStereo.channelCountMode = 'explicit';
                silentStereo.channelInterpretation = 'speakers';
                silentStereo.gain.value = 0; // Prevent mic audio from playing through speakers
                this.processor.connect(silentStereo);
                silentStereo.connect(this.audioContext.destination);

                console.log('🔇 ScriptProcessor connected: source → processor → silent stereo output');
            }

            // Start streaming on server (with validated inputs and mode)
            console.log('📤 CLIENT: Sending mode:', this.currentMode, 'interval:', this.translationInterval, 'ms');
            this.socket.emit('start-streaming', {
                sourceLanguage: sourceLanguage,
                targetLang: targetLang,
                translationInterval: this.translationInterval,
                mode: this.currentMode,  // Send mode to server for centralized rules
                sampleRate: this.audioContext ? this.audioContext.sampleRate : 48000
            });

            this.isRecording = true;
            this.translationCount = 0;
            this.wordsTranslated = 0;
            this.resultsContainer.innerHTML = '';
            this.startBtn.disabled = true;
            this.stopBtn.disabled = false;
            this.audioSource.disabled = true;
            this.sourceLanguage.disabled = true;
            this.targetLanguage.disabled = true;

            this.startSessionTimer();

        } catch (error) {
            console.error('Failed to start recording:', error);
            this.updateStatus(`Error: ${error.message}`, 'error');
        }
    },

    stopRecording() {
        this.isRecording = false;

        // Track STT usage for billing
        if (this.sttStartTime && this.currentSourceLanguage) {
            const sttDurationMs = Date.now() - this.sttStartTime;
            const sttMinutes = sttDurationMs / 60000;
            this.trackBilling('stt', sttMinutes, this.currentSourceLanguage);
            this.sttStartTime = null;
        }

        // Release wake lock - screen can turn off now
        this.releaseWakeLock();

        if (this.gainNode) {
            this.gainNode.disconnect();
            this.gainNode = null;
        }

        if (this.processor) {
            // Send stop message to AudioWorklet (only if it has a port)
            if (this.processor.port) {
                this.processor.port.postMessage({ command: 'stop' });
            }
            this.processor.disconnect();
            this.processor = null;
        }

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
            this.audioWorkletLoaded = false; // Reset flag so new AudioContext can load module
        }

        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }

        this.audioChunkBuffer = [];

        this.socket.emit('stop-streaming');

        this.startBtn.disabled = false;
        this.stopBtn.disabled = true;
        this.audioSource.disabled = false;
        this.sourceLanguage.disabled = false;
        this.targetLanguage.disabled = false;

        this.stopSessionTimer();
        this.updateStatus('Ready to start', 'ready');
        this.interimText.textContent = 'Waiting for speech...';
        this.lastTranslation = '';
        this.lastTranslationTime = 0;

        // Stop any playing speech and clear queue
        if (this.speechSynthesis) {
            this.speechSynthesis.cancel();
            this.ttsQueue = []; // Clear pending translations
            this.isSpeaking = false;
            console.log('🔇 TTS stopped and queue cleared');
        }
    },


    updateAudioLevel(level) {
        // level is 0.0 to 1.0
        const percentage = Math.round(level * 100);
        this.audioLevelBar.style.width = `${percentage}%`;
        this.audioLevelText.textContent = `${percentage}%`;

        // Change color based on level
        if (level < 0.01) {
            this.audioLevelText.style.color = '#999'; // Too quiet
        } else if (level < 0.1) {
            this.audioLevelText.style.color = '#ff9800'; // Weak
        } else {
            this.audioLevelText.style.color = '#4caf50'; // Good
        }
    }
});
