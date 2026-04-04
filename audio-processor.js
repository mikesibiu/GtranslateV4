/**
 * AudioWorkletProcessor for capturing and converting microphone audio
 * Accumulates audio chunks to send larger buffers to Google Cloud API
 * Includes automatic gain control (AGC) to maintain optimal audio levels
 */

class AudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.isRecording = true;
        this.bufferSize = 4096; // Accumulate to 4096 samples before sending
        this.buffer = new Float32Array(this.bufferSize); // Pre-allocated typed array
        this.bufferIndex = 0;
        this.gain = 10.0; // Current gain (manual or auto-adjusted)

        // Auto-gain control state
        this.autoGain = false;      // AGC disabled by default (Google STT handles audio levels)
        this.targetLevel = 0.35;    // Target peak level (35% of max — ideal for STT)
        this.baseTargetLevel = 0.35; // Default target before adaptive adjustment
        this.minGain = 1.0;         // Don't make quieter than raw mic
        this.maxGain = 60.0;        // Upper limit to avoid noise amplification
        this.attackCoeff = 0.15;    // Fast attack — reduce gain quickly when too loud
        this.releaseCoeff = 0.005;  // Slow release — increase gain gradually when quiet
        this.levelSmooth = 0.0;     // Smoothed peak level for AGC decisions
        this.clipCount = 0;         // Clipped samples in current buffer (for detection)

        // Listen for messages from main thread
        this.port.onmessage = (event) => {
            if (event.data.command === 'stop') {
                this.isRecording = false;
            } else if (event.data.command === 'setGain') {
                this.gain = event.data.value;
                this.autoGain = false; // Manual gain overrides auto
            } else if (event.data.command === 'setAutoGain') {
                this.autoGain = event.data.value;
                if (this.autoGain) {
                    // Start from current gain when switching to auto
                    this.levelSmooth = 0.0;
                }
            }
        };
    }

    process(inputs, outputs, parameters) {
        if (!this.isRecording) {
            return false; // Stop processing
        }

        const input = inputs[0];
        if (!input || !input[0]) {
            return true;
        }

        const inputData = input[0]; // First channel (mono)

        // Accumulate samples into pre-allocated buffer
        for (let i = 0; i < inputData.length; i++) {
            this.buffer[this.bufferIndex++] = inputData[i];

            // Send when buffer is full
            if (this.bufferIndex >= this.bufferSize) {
                this.sendBuffer();
                this.bufferIndex = 0; // Reset index
            }
        }

        return true; // Keep processor alive
    }

    sendBuffer() {
        // First pass (AGC only): measure raw peak level before gain
        if (this.autoGain) {
            let rawPeak = 0;
            for (let i = 0; i < this.bufferSize; i++) {
                const abs = Math.abs(this.buffer[i]);
                if (abs > rawPeak) rawPeak = abs;
            }

            // Smooth the peak measurement to avoid reacting to single spikes
            this.levelSmooth = this.levelSmooth * 0.9 + rawPeak * 0.1;

            // Adaptive target: adjust target level based on input characteristics
            if (this.levelSmooth < 0.05) {
                // Very quiet input (whispered speech) — raise target for better STT
                this.targetLevel = Math.min(this.baseTargetLevel + 0.10, 0.50);
            } else if (this.levelSmooth > 0.50) {
                // Very loud input — lower target to avoid clipping
                this.targetLevel = Math.max(this.baseTargetLevel - 0.10, 0.20);
            } else {
                // Normal range — use base target
                this.targetLevel = this.baseTargetLevel;
            }

            // Adjust gain based on smoothed level vs target
            if (this.levelSmooth > 0.001) { // Only adjust if there's actual audio
                const desiredGain = this.targetLevel / this.levelSmooth;

                // Use asymmetric smoothing: fast attack (reduce), slow release (increase)
                if (desiredGain < this.gain) {
                    // Too loud — reduce gain quickly
                    this.gain += (desiredGain - this.gain) * this.attackCoeff;
                } else {
                    // Too quiet — increase gain slowly
                    this.gain += (desiredGain - this.gain) * this.releaseCoeff;
                }

                // Clamp to safe range
                if (this.gain < this.minGain) this.gain = this.minGain;
                if (this.gain > this.maxGain) this.gain = this.maxGain;
            }
        }

        // Second pass: apply gain, calculate output level, convert to Int16
        let maxLevel = 0;
        this.clipCount = 0;
        const int16Data = new Int16Array(this.bufferSize);

        for (let i = 0; i < this.bufferSize; i++) {
            // Apply gain amplification
            const amplifiedSample = this.buffer[i] * this.gain;
            const absSample = Math.abs(amplifiedSample);

            // Update max level (avoid function call overhead)
            if (absSample > maxLevel) {
                maxLevel = absSample;
            }

            // Track clipping (sample exceeds [-1, 1] before clamping)
            if (absSample > 1.0) {
                this.clipCount++;
            }

            // Convert to Int16 (clamp inline for performance)
            const clamped = amplifiedSample < -1 ? -1 : (amplifiedSample > 1 ? 1 : amplifiedSample);
            int16Data[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
        }

        // Build message with optional clipping warning
        const message = {
            audioData: int16Data.buffer,
            level: maxLevel,  // 0.0 to 1.0
            currentGain: this.gain  // So UI can show current auto-gain value
        };

        // Warn if >5% of samples are clipped — audio quality is degrading
        if (this.clipCount > this.bufferSize * 0.05) {
            message.clipping = true;
            message.clipRatio = this.clipCount / this.bufferSize;
        }

        // Send audio data, level, and current gain to main thread
        this.port.postMessage(message, [int16Data.buffer]); // Transfer ownership for performance
    }
}

registerProcessor('audio-processor', AudioProcessor);
