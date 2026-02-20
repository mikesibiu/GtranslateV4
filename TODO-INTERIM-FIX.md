# TODO: Review Interim Display Fix (REVERTED)

## Changes Made in Commit 7c87ed6 (REVERTED - caused single-word translations)

### Problem We Were Trying to Solve
1. Interim box showed source language (English) instead of target language (Romanian) for listener
2. Translation cards appeared every 1-2 seconds instead of 15 seconds
3. Behavior not unified across language directions

### Changes Made

#### 1. index.html - Added Translation Tracking (lines 852-854)
```javascript
// Translation display tracking (for showing target language in interim box)
this.lastTranslation = ''; // Last translation received (for listener interim display)
this.lastTranslationTime = 0; // Timestamp of last translation
```

#### 2. index.html - Updated interim-result Handler (lines 1222-1237)
```javascript
this.socket.on('interim-result', (data) => {
    const sourceText = sanitizeText(data.text);

    // Listener modes: Show target language (last translation) instead of source
    if (this.ttsEnabled || this.currentMode === 'earbuds') {
        // Show last translation if we have one from the last 20 seconds
        if (this.lastTranslation && (Date.now() - this.lastTranslationTime < 20000)) {
            this.interimText.textContent = this.lastTranslation + '...';
        } else {
            this.interimText.textContent = 'Listening...';
        }
    } else {
        // Speaker mode: Show source language (STT feedback)
        this.interimText.textContent = sourceText || 'Listening...';
    }
});
```

#### 3. index.html - Updated translation-result Handler (lines 1239-1262)
```javascript
this.socket.on('translation-result', (data) => {
    console.log('📥 TRANSLATION RECEIVED!', data);

    // Store last translation for interim display (listener modes)
    if (data.translated) {
        this.lastTranslation = data.translated;
        this.lastTranslationTime = Date.now();
    }

    this.addTranslation(data);
    // ... rest of billing code
});
```

#### 4. server.js - Changed isInterim Flags (lines 752, 811, 853)
Changed from `isInterim: true` to `isInterim: false` for:
- Sentence ending translations (line 752)
- Max interval translations (line 811)
- Pause detection translations (line 853)

### Why It Failed
- Changing `isInterim: false` for ALL translations caused Google's `isFinal` results to bypass quality checks
- Google STT sends `isFinal: true` for single words during natural pauses
- Server immediately translated single words without checking:
  - Minimum word count
  - Sentence endings
  - Time intervals
- Result: Single-word translations ("pair" → "vezi") flooding screen

### App-Code-Reviewer's Recommended Fix
The real fix requires filtering Google's `isFinal` results (lines 871-906 in server.js):

```javascript
if (isFinal && transcript.trim().length > 0) {
    // Add quality checks:
    const MIN_WORDS_FOR_FINAL = 3;
    const wordCount = transcript.trim().split(/\s+/).length;
    const hasSentenceEnding = /[.!?。！？]\s*$/.test(transcript.trim());
    const elapsedSinceLastTranslation = lastTranslationTime ? (Date.now() - lastTranslationTime) : intervalMs;

    const shouldTranslate = hasSentenceEnding ||
                           wordCount >= MIN_WORDS_FOR_FINAL ||
                           elapsedSinceLastTranslation >= intervalMs;

    if (shouldTranslate) {
        // Translate...
    } else {
        // Skip short final results
        lastInterimText = transcript;
    }
}
```

## Next Steps to Review Later

1. **Test the app-code-reviewer's recommended fix** for filtering Google's `isFinal` results
2. **Keep the interim display logic** (showing target language for listener) - this was correct
3. **Keep the isInterim: false changes** for lines 752, 811, 853 - these were correct
4. **Add minimum word count check** for Google's `isFinal` results in lines 871-906

## User's Original Complaints (Still Need to Address)

1. ✅ Interim should show target language for listener (our fix was correct)
2. ✅ Translation cards should appear every 15s max, not 1-2s (our isInterim: false was correct)
3. ❌ Need to prevent single-word translations from Google's isFinal results
4. ❌ Need to verify Q&A mode and EarBuds mode work correctly

## Testing Required After Fix

- [ ] Test Romanian→English in Q&A mode
- [ ] Test English→Romanian in Q&A mode
- [ ] Test both directions in EarBuds mode
- [ ] Verify interim shows target language for listener
- [ ] Verify translation cards appear every 15s max
- [ ] Verify NO single-word translations

## Future Improvements

- Evaluate forcing browser/audio-worklet AGC off and rely solely on server-side/VAD gain control to avoid level swings noted in production (user report).
