/**
 * AudioWorkletProcessor for capturing and converting microphone audio
 * Accumulates audio chunks to send larger buffers to Google Cloud API
 */

class AudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.isRecording = true;
        this.buffer = [];
        this.bufferSize = 4096; // Accumulate to 4096 samples before sending

        // Listen for messages from main thread
        this.port.onmessage = (event) => {
            if (event.data.command === 'stop') {
                this.isRecording = false;
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

        // Accumulate samples
        for (let i = 0; i < inputData.length; i++) {
            this.buffer.push(inputData[i]);
        }

        // Send when buffer is full
        if (this.buffer.length >= this.bufferSize) {
            // Calculate audio level for visualization
            let maxLevel = 0;
            for (let i = 0; i < this.buffer.length; i++) {
                maxLevel = Math.max(maxLevel, Math.abs(this.buffer[i]));
            }

            // Convert Float32 to Int16
            const int16Data = new Int16Array(this.buffer.length);
            for (let i = 0; i < this.buffer.length; i++) {
                const s = Math.max(-1, Math.min(1, this.buffer[i]));
                int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }

            // Send audio data and level to main thread
            this.port.postMessage({
                audioData: int16Data.buffer,
                level: maxLevel  // 0.0 to 1.0
            }, [int16Data.buffer]); // Transfer ownership for performance

            // Clear buffer
            this.buffer = [];
        }

        return true; // Keep processor alive
    }
}

registerProcessor('audio-processor', AudioProcessor);
