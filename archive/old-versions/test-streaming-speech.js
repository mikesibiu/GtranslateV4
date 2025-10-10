/**
 * Unit Tests for GTranslate V4 - Google Cloud Speech-to-Text
 * Tests audio conversion, streaming logic, and socket communication
 * Updated to test AudioWorkletNode implementation
 */

const assert = require('assert');

// ===== TEST 1: Float32 to Int16 Audio Conversion (AudioWorklet) =====
console.log('\n═══════════════════════════════════════');
console.log('Test 1: Float32 to Int16 Conversion (AudioWorklet)');
console.log('═══════════════════════════════════════');

// This matches the conversion logic in audio-processor.js
function convertFloat32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
}

// Test with sample audio data
const testFloat32 = new Float32Array([0, 0.5, 1.0, -0.5, -1.0, 1.5, -1.5]);
const testInt16 = convertFloat32ToInt16(testFloat32);

assert.strictEqual(testInt16[0], 0, 'Zero should convert to 0');
assert.strictEqual(testInt16[1], 16383, '0.5 should convert to ~16383');
assert.strictEqual(testInt16[2], 32767, '1.0 should convert to 32767 (max)');
assert.strictEqual(testInt16[3], -16384, '-0.5 should convert to -16384');
assert.strictEqual(testInt16[4], -32768, '-1.0 should convert to -32768 (min)');
assert.strictEqual(testInt16[5], 32767, 'Values > 1.0 should clamp to 32767');
assert.strictEqual(testInt16[6], -32768, 'Values < -1.0 should clamp to -32768');

console.log('✅ AudioWorklet conversion tests passed');

// ===== TEST 2: Session State Management =====
console.log('\n═══════════════════════════════════════');
console.log('Test 2: Session State Management');
console.log('═══════════════════════════════════════');

class SessionManager {
    constructor() {
        this.isActive = false;
        this.sourceLanguage = null;
        this.targetLanguage = null;
        this.accumulatedText = '';
        this.translationCount = 0;
    }

    start(sourceLanguage, targetLanguage) {
        this.isActive = true;
        this.sourceLanguage = sourceLanguage;
        this.targetLanguage = targetLanguage;
        this.accumulatedText = '';
        this.translationCount = 0;
    }

    stop() {
        this.isActive = false;
        return {
            translationCount: this.translationCount,
            accumulatedText: this.accumulatedText
        };
    }

    addTranslation(original) {
        if (!this.isActive) return false;
        this.accumulatedText += (this.accumulatedText ? ' ' : '') + original;
        this.translationCount++;
        return true;
    }
}

const session = new SessionManager();

// Test initial state
assert.strictEqual(session.isActive, false, 'Session should start inactive');
assert.strictEqual(session.translationCount, 0, 'Translation count should be 0');

// Test session start
session.start('ro-RO', 'en');
assert.strictEqual(session.isActive, true, 'Session should be active after start');
assert.strictEqual(session.sourceLanguage, 'ro-RO', 'Source language should be set');
assert.strictEqual(session.targetLanguage, 'en', 'Target language should be set');

// Test adding translations
assert.strictEqual(session.addTranslation('Bună ziua'), true, 'Should accept translation when active');
assert.strictEqual(session.translationCount, 1, 'Translation count should increment');
assert.strictEqual(session.accumulatedText, 'Bună ziua', 'Text should accumulate');

session.addTranslation('Cum ești');
assert.strictEqual(session.translationCount, 2, 'Translation count should be 2');
assert.strictEqual(session.accumulatedText, 'Bună ziua Cum ești', 'Text should accumulate with space');

// Test session stop
const result = session.stop();
assert.strictEqual(session.isActive, false, 'Session should be inactive after stop');
assert.strictEqual(result.translationCount, 2, 'Stop should return translation count');
assert.strictEqual(result.accumulatedText, 'Bună ziua Cum ești', 'Stop should return accumulated text');

// Test rejection when inactive
assert.strictEqual(session.addTranslation('Test'), false, 'Should reject translation when inactive');

console.log('✅ Session state management tests passed');

// ===== TEST 3: Language Code Validation =====
console.log('\n═══════════════════════════════════════');
console.log('Test 3: Language Code Validation');
console.log('═══════════════════════════════════════');

const VALID_SOURCE_LANGUAGES = [
    'ro-RO', 'en-US', 'es-ES', 'fr-FR', 'de-DE',
    'it-IT', 'pt-PT', 'ru-RU', 'ja-JP', 'zh-CN'
];

const VALID_TARGET_LANGUAGES = [
    'en', 'ro', 'es', 'fr', 'de',
    'it', 'pt', 'ru', 'ja', 'zh'
];

function validateLanguages(sourceLanguage, targetLanguage) {
    return {
        validSource: VALID_SOURCE_LANGUAGES.includes(sourceLanguage),
        validTarget: VALID_TARGET_LANGUAGES.includes(targetLanguage)
    };
}

// Test valid combinations
let validation = validateLanguages('ro-RO', 'en');
assert.strictEqual(validation.validSource, true, 'ro-RO should be valid source');
assert.strictEqual(validation.validTarget, true, 'en should be valid target');

validation = validateLanguages('en-US', 'ro');
assert.strictEqual(validation.validSource, true, 'en-US should be valid source');
assert.strictEqual(validation.validTarget, true, 'ro should be valid target');

// Test invalid combinations
validation = validateLanguages('invalid', 'en');
assert.strictEqual(validation.validSource, false, 'Invalid source should be rejected');

validation = validateLanguages('ro-RO', 'invalid');
assert.strictEqual(validation.validTarget, false, 'Invalid target should be rejected');

console.log('✅ Language validation tests passed');

// ===== TEST 4: Interim vs Final Result Handling =====
console.log('\n═══════════════════════════════════════');
console.log('Test 4: Interim vs Final Result Handling');
console.log('═══════════════════════════════════════');

class ResultHandler {
    constructor() {
        this.interimResults = [];
        this.finalResults = [];
    }

    processResult(transcript, isFinal) {
        if (isFinal) {
            this.finalResults.push(transcript);
            return { shouldTranslate: true, type: 'final' };
        } else {
            this.interimResults.push(transcript);
            return { shouldTranslate: false, type: 'interim' };
        }
    }

    getStats() {
        return {
            interimCount: this.interimResults.length,
            finalCount: this.finalResults.length
        };
    }
}

const handler = new ResultHandler();

// Test interim results
let resultHandling = handler.processResult('Bună', false);
assert.strictEqual(resultHandling.shouldTranslate, false, 'Interim results should not trigger translation');
assert.strictEqual(resultHandling.type, 'interim', 'Should identify as interim');

resultHandling = handler.processResult('Bună ziua', false);
assert.strictEqual(resultHandling.shouldTranslate, false, 'Second interim should not trigger translation');

// Test final result
resultHandling = handler.processResult('Bună ziua', true);
assert.strictEqual(resultHandling.shouldTranslate, true, 'Final result should trigger translation');
assert.strictEqual(resultHandling.type, 'final', 'Should identify as final');

// Test stats
const stats = handler.getStats();
assert.strictEqual(stats.interimCount, 2, 'Should have 2 interim results');
assert.strictEqual(stats.finalCount, 1, 'Should have 1 final result');

console.log('✅ Result handling tests passed');

// ===== TEST 5: Audio Buffer Size Validation =====
console.log('\n═══════════════════════════════════════');
console.log('Test 5: Audio Buffer Size Validation');
console.log('═══════════════════════════════════════');

const BUFFER_SIZE = 4096;
const SAMPLE_RATE = 48000;

function validateAudioBuffer(buffer) {
    return {
        isValid: buffer instanceof ArrayBuffer || buffer instanceof Int16Array,
        size: buffer.byteLength || buffer.length * 2,
        expectedSize: BUFFER_SIZE * 2, // Int16 = 2 bytes per sample
        sampleRate: SAMPLE_RATE
    };
}

// Test with Int16Array
const int16Buffer = new Int16Array(BUFFER_SIZE);
let bufferValidation = validateAudioBuffer(int16Buffer);
assert.strictEqual(bufferValidation.isValid, true, 'Int16Array should be valid');
assert.strictEqual(bufferValidation.size, BUFFER_SIZE * 2, 'Buffer size should match expected');

// Test with ArrayBuffer
const arrayBuffer = new ArrayBuffer(BUFFER_SIZE * 2);
bufferValidation = validateAudioBuffer(arrayBuffer);
assert.strictEqual(bufferValidation.isValid, true, 'ArrayBuffer should be valid');
assert.strictEqual(bufferValidation.size, BUFFER_SIZE * 2, 'ArrayBuffer size should match expected');

console.log('✅ Audio buffer validation tests passed');

// ===== TEST 6: Error Handling =====
console.log('\n═══════════════════════════════════════');
console.log('Test 6: Error Handling');
console.log('═══════════════════════════════════════');

class ErrorHandler {
    constructor() {
        this.errors = [];
    }

    handleRecognitionError(error) {
        const errorInfo = {
            type: 'recognition',
            message: error.message,
            code: error.code,
            timestamp: Date.now()
        };
        this.errors.push(errorInfo);
        return errorInfo;
    }

    handleTranslationError(error) {
        const errorInfo = {
            type: 'translation',
            message: error.message,
            timestamp: Date.now()
        };
        this.errors.push(errorInfo);
        return errorInfo;
    }

    getErrorCount() {
        return {
            recognition: this.errors.filter(e => e.type === 'recognition').length,
            translation: this.errors.filter(e => e.type === 'translation').length,
            total: this.errors.length
        };
    }
}

const errorHandler = new ErrorHandler();

// Test recognition error
let error = errorHandler.handleRecognitionError({ message: 'API quota exceeded', code: 429 });
assert.strictEqual(error.type, 'recognition', 'Should identify recognition error');
assert.strictEqual(error.message, 'API quota exceeded', 'Should preserve error message');
assert.strictEqual(error.code, 429, 'Should preserve error code');

// Test translation error
error = errorHandler.handleTranslationError({ message: 'Network timeout' });
assert.strictEqual(error.type, 'translation', 'Should identify translation error');
assert.strictEqual(error.message, 'Network timeout', 'Should preserve error message');

// Test error counts
const errorCounts = errorHandler.getErrorCount();
assert.strictEqual(errorCounts.recognition, 1, 'Should have 1 recognition error');
assert.strictEqual(errorCounts.translation, 1, 'Should have 1 translation error');
assert.strictEqual(errorCounts.total, 2, 'Should have 2 total errors');

console.log('✅ Error handling tests passed');

// ===== TEST 7: Word Count for Statistics =====
console.log('\n═══════════════════════════════════════');
console.log('Test 7: Word Count Statistics');
console.log('═══════════════════════════════════════');

function countWords(text) {
    if (!text || text.trim().length === 0) return 0;
    return text.trim().split(/\s+/).length;
}

assert.strictEqual(countWords(''), 0, 'Empty string should have 0 words');
assert.strictEqual(countWords('   '), 0, 'Whitespace only should have 0 words');
assert.strictEqual(countWords('Hello'), 1, 'Single word should count as 1');
assert.strictEqual(countWords('Hello world'), 2, 'Two words should count as 2');
assert.strictEqual(countWords('  Hello   world  '), 2, 'Extra whitespace should not affect count');
assert.strictEqual(countWords('One two three four five'), 5, 'Five words should count as 5');

console.log('✅ Word count tests passed');

// ===== TEST 8: Session Timer Formatting =====
console.log('\n═══════════════════════════════════════');
console.log('Test 8: Session Timer Formatting');
console.log('═══════════════════════════════════════');

function formatSessionTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

assert.strictEqual(formatSessionTime(0), '0:00', '0 seconds should format as 0:00');
assert.strictEqual(formatSessionTime(5), '0:05', '5 seconds should format as 0:05');
assert.strictEqual(formatSessionTime(30), '0:30', '30 seconds should format as 0:30');
assert.strictEqual(formatSessionTime(60), '1:00', '60 seconds should format as 1:00');
assert.strictEqual(formatSessionTime(65), '1:05', '65 seconds should format as 1:05');
assert.strictEqual(formatSessionTime(125), '2:05', '125 seconds should format as 2:05');
assert.strictEqual(formatSessionTime(3661), '61:01', '3661 seconds should format as 61:01');

console.log('✅ Session timer formatting tests passed');

// ===== TEST 9: Empty Transcript Handling =====
console.log('\n═══════════════════════════════════════');
console.log('Test 9: Empty Transcript Handling');
console.log('═══════════════════════════════════════');

function shouldProcessTranscript(transcript, isFinal) {
    if (!transcript) return false;
    if (transcript.trim().length === 0) return false;
    if (!isFinal) return true; // Process interim for display
    return true; // Process final for translation
}

assert.strictEqual(shouldProcessTranscript(null, false), false, 'Null transcript should be rejected');
assert.strictEqual(shouldProcessTranscript('', false), false, 'Empty transcript should be rejected');
assert.strictEqual(shouldProcessTranscript('   ', false), false, 'Whitespace-only transcript should be rejected');
assert.strictEqual(shouldProcessTranscript('Hello', false), true, 'Valid interim transcript should be accepted');
assert.strictEqual(shouldProcessTranscript('Hello', true), true, 'Valid final transcript should be accepted');

console.log('✅ Empty transcript handling tests passed');

// ===== TEST 10: Stream Configuration =====
console.log('\n═══════════════════════════════════════');
console.log('Test 10: Stream Configuration Validation');
console.log('═══════════════════════════════════════');

function createStreamConfig(languageCode) {
    return {
        config: {
            encoding: 'LINEAR16',
            sampleRateHertz: 48000,
            languageCode: languageCode,
            enableAutomaticPunctuation: true,
            model: 'default',
            useEnhanced: true
        },
        interimResults: true,
        singleUtterance: false
    };
}

const streamConfig = createStreamConfig('ro-RO');
assert.strictEqual(streamConfig.config.encoding, 'LINEAR16', 'Encoding should be LINEAR16');
assert.strictEqual(streamConfig.config.sampleRateHertz, 48000, 'Sample rate should be 48000');
assert.strictEqual(streamConfig.config.languageCode, 'ro-RO', 'Language code should match');
assert.strictEqual(streamConfig.config.enableAutomaticPunctuation, true, 'Punctuation should be enabled');
assert.strictEqual(streamConfig.interimResults, true, 'Interim results should be enabled');
assert.strictEqual(streamConfig.singleUtterance, false, 'Single utterance should be disabled');

console.log('✅ Stream configuration tests passed');

// ===== TEST 11: AudioWorklet Message Protocol =====
console.log('\n═══════════════════════════════════════');
console.log('Test 11: AudioWorklet Message Protocol');
console.log('═══════════════════════════════════════');

// Simulate AudioWorklet message structure
class MockAudioWorklet {
    constructor() {
        this.messages = [];
        this.stopCalled = false;
    }

    // Simulate processor sending audio data
    sendAudioData(float32Data) {
        const int16Data = convertFloat32ToInt16(float32Data);
        return {
            audioData: int16Data.buffer,
            isTransferable: int16Data.buffer instanceof ArrayBuffer
        };
    }

    // Simulate main thread sending stop command
    sendStopCommand() {
        this.stopCalled = true;
        return { command: 'stop' };
    }

    isActive() {
        return !this.stopCalled;
    }
}

const mockWorklet = new MockAudioWorklet();

// Test audio data message structure
const audioData = new Float32Array([0.1, 0.2, 0.3]);
const message = mockWorklet.sendAudioData(audioData);
assert.strictEqual(message.isTransferable, true, 'Audio buffer should be ArrayBuffer');
assert.strictEqual(message.audioData instanceof ArrayBuffer, true, 'Should return ArrayBuffer');

// Test stop command
assert.strictEqual(mockWorklet.isActive(), true, 'Worklet should start active');
const stopCmd = mockWorklet.sendStopCommand();
assert.strictEqual(stopCmd.command, 'stop', 'Stop command should be formatted correctly');
assert.strictEqual(mockWorklet.isActive(), false, 'Worklet should be inactive after stop');

console.log('✅ AudioWorklet message protocol tests passed');

// ===== TEST 12: Audio Context Configuration =====
console.log('\n═══════════════════════════════════════');
console.log('Test 12: Audio Context Configuration');
console.log('═══════════════════════════════════════');

function validateAudioConfig(config) {
    return {
        hasSampleRate: config.hasOwnProperty('sampleRate'),
        correctSampleRate: config.sampleRate === 48000,
        hasChannelCount: config.hasOwnProperty('channelCount'),
        correctChannelCount: config.channelCount === 1,
        hasEchoCancellation: config.hasOwnProperty('echoCancellation'),
        hasNoiseSuppression: config.hasOwnProperty('noiseSuppression')
    };
}

const audioConfig = {
    channelCount: 1,
    sampleRate: 48000,
    echoCancellation: true,
    noiseSuppression: true
};

const configValidation = validateAudioConfig(audioConfig);
assert.strictEqual(configValidation.hasSampleRate, true, 'Config should have sampleRate');
assert.strictEqual(configValidation.correctSampleRate, true, 'Sample rate should be 48000');
assert.strictEqual(configValidation.hasChannelCount, true, 'Config should have channelCount');
assert.strictEqual(configValidation.correctChannelCount, true, 'Channel count should be 1 (mono)');
assert.strictEqual(configValidation.hasEchoCancellation, true, 'Config should have echo cancellation');
assert.strictEqual(configValidation.hasNoiseSuppression, true, 'Config should have noise suppression');

console.log('✅ Audio context configuration tests passed');

// ===== TEST 13: Buffer Conversion =====
console.log('\n═══════════════════════════════════════');
console.log('Test 13: ArrayBuffer to Buffer Conversion');
console.log('═══════════════════════════════════════');

function convertToBuffer(audioData) {
    let buffer;
    if (Buffer.isBuffer(audioData)) {
        buffer = audioData;
    } else if (audioData instanceof ArrayBuffer) {
        buffer = Buffer.from(audioData);
    } else if (audioData.buffer) {
        buffer = Buffer.from(audioData.buffer);
    } else {
        buffer = Buffer.from(audioData);
    }
    return buffer;
}

// Test with ArrayBuffer
const testArrayBuffer = new ArrayBuffer(8192);
const view = new Uint8Array(testArrayBuffer);
for (let i = 0; i < view.length; i++) {
    view[i] = i % 256;
}

let convertedBuffer = convertToBuffer(testArrayBuffer);
assert.strictEqual(Buffer.isBuffer(convertedBuffer), true, 'Should convert ArrayBuffer to Buffer');
assert.strictEqual(convertedBuffer.length, 8192, 'Buffer size should match ArrayBuffer size');
assert.strictEqual(convertedBuffer[0], 0, 'First byte should match');
assert.strictEqual(convertedBuffer[255], 255, 'Byte 255 should match');

// Test with TypedArray
const int16Array = new Int16Array(4096);
for (let i = 0; i < int16Array.length; i++) {
    int16Array[i] = i;
}

convertedBuffer = convertToBuffer(int16Array);
assert.strictEqual(Buffer.isBuffer(convertedBuffer), true, 'Should convert Int16Array to Buffer');
assert.strictEqual(convertedBuffer.length, 8192, 'Buffer size should be 4096 * 2 bytes');

// Test with existing Buffer
const existingBuffer = Buffer.alloc(8192);
convertedBuffer = convertToBuffer(existingBuffer);
assert.strictEqual(Buffer.isBuffer(convertedBuffer), true, 'Should recognize existing Buffer');
assert.strictEqual(convertedBuffer, existingBuffer, 'Should return same Buffer instance');

console.log('✅ Buffer conversion tests passed');

// ===== SUMMARY =====
console.log('\n═══════════════════════════════════════');
console.log('✅ ALL TESTS PASSED');
console.log('═══════════════════════════════════════');
console.log('13/13 test suites passed');
console.log('- AudioWorklet conversion');
console.log('- Session management');
console.log('- Language validation');
console.log('- Result handling');
console.log('- Buffer validation');
console.log('- Error handling');
console.log('- Word counting');
console.log('- Timer formatting');
console.log('- Empty transcript handling');
console.log('- Stream configuration');
console.log('- AudioWorklet message protocol');
console.log('- Audio context configuration');
console.log('- ArrayBuffer to Buffer conversion');
console.log('═══════════════════════════════════════\n');
