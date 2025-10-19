/**
 * AudioWorkletProcessor for capturing and converting microphone audio
 * Accumulates audio chunks to send larger buffers to Google Cloud API
 */

class AudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.isRecording = true;
        this.bufferSize = 4096; // Accumulate to 4096 samples before sending
        this.buffer = new Float32Array(this.bufferSize); // Pre-allocated typed array
        this.bufferIndex = 0;
        this.gain = 10.0; // Default gain (will be updated from main thread)

        // Listen for messages from main thread
        this.port.onmessage = (event) => {
            if (event.data.command === 'stop') {
                this.isRecording = false;
            } else if (event.data.command === 'setGain') {
                this.gain = event.data.value;
                console.log(`AudioWorklet gain set to ${this.gain}x`);
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
        // Single-pass: apply gain, calculate level AND convert to Int16
        let maxLevel = 0;
        const int16Data = new Int16Array(this.bufferSize);

        for (let i = 0; i < this.bufferSize; i++) {
            // Apply gain amplification
            const amplifiedSample = this.buffer[i] * this.gain;
            const absSample = Math.abs(amplifiedSample);

            // Update max level (avoid function call overhead)
            if (absSample > maxLevel) {
                maxLevel = absSample;
            }

            // Convert to Int16 (clamp inline for performance)
            const clamped = amplifiedSample < -1 ? -1 : (amplifiedSample > 1 ? 1 : amplifiedSample);
            int16Data[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
        }

        // Send audio data and level to main thread
        this.port.postMessage({
            audioData: int16Data.buffer,
            level: maxLevel  // 0.0 to 1.0
        }, [int16Data.buffer]); // Transfer ownership for performance
    }
}

registerProcessor('audio-processor', AudioProcessor);
