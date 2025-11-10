/**
 * Translation Rules Engine
 * Centralized decision-making for when to translate
 * Ensures consistent behavior across all translation triggers and modes
 */

class TranslationRulesEngine {
    constructor(mode = 'talks', logger = console) {
        this.mode = mode;
        this.logger = logger;
        this.modeConfig = this.getModeConfig(mode);

        // State tracking
        this.lastTranslationTime = null;
        this.lastTextChangeTime = Date.now();
        this.lastTranslatedText = '';
        this.accumulatedText = '';
        this.translationCount = 0;

        // Decision metrics
        this.metrics = {
            totalChecks: 0,
            translationsApproved: 0,
            translationsBlocked: 0,
            blockReasons: {}
        };

        // Quality thresholds
        this.MIN_WORDS_FOR_TRANSLATION = 3;
        this.MIN_CHARS_FOR_TRANSLATION = 10;

        // Filler words to ignore (language-agnostic common fillers)
        this.FILLER_WORDS = new Set([
            // English
            'uh', 'um', 'ah', 'hmm', 'eh', 'er', 'like', 'you know',
            // Romanian
            'ă', 'e', 'ei', 'păi', 'deci', 'adică'
        ]);
    }

    /**
     * Get mode-specific configuration
     */
    getModeConfig(mode) {
        const configs = {
            talks: {
                name: 'Talks',
                translationInterval: 10000,  // 10 seconds
                pauseDetectionMs: 3000,      // 3 second pause
                requireSentenceEnding: false, // Translate even without sentence endings
                minWords: 3,
                enableTTS: false,            // Manual TTS control
                displayVisualCards: true,    // Show translation cards
                enableSummary: false
            },
            qna: {
                name: 'Q&A',
                translationInterval: 8000,   // 8 seconds (faster for questions)
                pauseDetectionMs: 3000,      // 3 second pause
                requireSentenceEnding: false,
                minWords: 3,
                enableTTS: false,            // Manual TTS control
                displayVisualCards: true,    // Show translation cards
                enableSummary: true,         // Enable summaries
                summaryInterval: 30000       // 30 second summaries
            },
            earbuds: {
                name: 'EarBuds',
                translationInterval: 15000,  // 15 seconds (audio-first)
                pauseDetectionMs: 3000,      // 3 second pause
                requireSentenceEnding: false,
                minWords: 3,
                enableTTS: true,             // Always enable TTS
                displayVisualCards: false,   // Hide translation cards (audio-only)
                enableSummary: false
            }
        };

        return configs[mode] || configs.talks;
    }

    /**
     * Central decision point: Should we translate now?
     *
     * @param {Object} context - Translation context
     * @param {string} context.text - Current text from STT
     * @param {boolean} context.isFinal - Is this a final result from Google?
     * @param {number} context.timeSinceLastChange - Time since text last changed (ms)
     * @param {string} context.trigger - What triggered this check? ('interim', 'final', 'timer')
     * @param {string} context.clientId - Client ID for logging
     *
     * @returns {Object} Decision with reasoning
     */
    shouldTranslate(context) {
        this.metrics.totalChecks++;
        const now = Date.now();

        // Initialize translation time on first check
        if (!this.lastTranslationTime) {
            this.lastTranslationTime = now;
        }

        // Calculate elapsed time since last translation
        const elapsedSinceLastTranslation = now - this.lastTranslationTime;

        // Extract new text that hasn't been translated yet
        const newText = this.getNewText(context.text);

        // Run quality checks
        const qualityCheck = this.checkQuality(newText, context.isFinal);

        // Detect sentence endings
        const hasSentenceEnding = this.detectSentenceEnding(context.text);

        // DECISION LOGIC (Priority Order):

        // Priority 1: Sentence ending (immediate translation)
        if (hasSentenceEnding && qualityCheck.meetsMinimum) {
            return this.approveTranslation(newText, 'sentence_ending', 1.0, context.clientId, context.text);
        }

        // Priority 2: Maximum interval reached (force translation)
        if (elapsedSinceLastTranslation >= this.modeConfig.translationInterval) {
            if (qualityCheck.meetsMinimum) {
                return this.approveTranslation(newText, 'max_interval', 0.9, context.clientId, context.text);
            } else {
                // Max interval reached but text doesn't meet quality - still skip
                return this.rejectTranslation('max_interval_poor_quality', newText);
            }
        }

        // Priority 3: Final result from Google (with quality validation)
        if (context.isFinal) {
            if (qualityCheck.meetsMinimum && !qualityCheck.isFillerOnly) {
                return this.approveTranslation(newText, 'final_result', 0.8, context.clientId, context.text);
            } else {
                // Final result but poor quality - DO NOT update lastTranslatedText
                // Only approveTranslation() should update it to prevent duplicate tracking bugs
                this.logger.info('⏭️ Skipping low-quality final result', {
                    clientId: context.clientId,
                    text: newText.substring(0, 30),
                    reason: qualityCheck.reason
                });
                return this.rejectTranslation(qualityCheck.reason, newText);
            }
        }

        // Priority 4: Pause detection (handled by timer in server, not here)
        // This check is only reached for interim results - wait for pause timer
        if (context.timeSinceLastChange >= this.modeConfig.pauseDetectionMs) {
            if (qualityCheck.meetsMinimum) {
                return this.approveTranslation(newText, 'pause_detected', 0.7, context.clientId, context.text);
            }
        }

        // Default: Wait for one of the above conditions
        return this.rejectTranslation('waiting_for_trigger', newText);
    }

    /**
     * Extract new text that hasn't been translated yet
     */
    getNewText(fullText) {
        if (!this.lastTranslatedText) {
            return fullText.trim();
        }

        const trimmedFull = fullText.trim();
        const trimmedLast = this.lastTranslatedText.trim();

        // Normalize for case-insensitive comparison (preserves original for extraction)
        const normalizedFull = trimmedFull.toLowerCase();
        const normalizedLast = trimmedLast.toLowerCase();

        // Check if we've already translated this exact text (case-insensitive)
        if (normalizedFull === normalizedLast) {
            return ''; // Already translated, no new text
        }

        // Check if last translation contains the current text (subset/duplicate)
        // Example: last="Depression and Anxiety", current="depression" → skip
        if (normalizedLast.includes(normalizedFull)) {
            return ''; // Current text is subset of what we already translated
        }

        // Check if current text starts with last translation (continuation)
        // Example: last="Depression", current="Depression and Anxiety" → extract "and Anxiety"
        if (normalizedFull.startsWith(normalizedLast)) {
            return trimmedFull.substring(trimmedLast.length).trim();
        }

        // Check if texts have significant overlap (>60% similarity)
        // Lowered from 70% to catch more duplicates like "hrănește ceea ce suntem" vs "hrănește ceea ce suntem în interior"
        const overlap = this.calculateOverlap(trimmedLast, trimmedFull);
        if (overlap > 0.6) {
            return ''; // Too similar, likely duplicate
        }

        // Text doesn't match previous - return full text (new utterance)
        return trimmedFull;
    }

    /**
     * Calculate word overlap between two texts (0.0 to 1.0)
     */
    calculateOverlap(text1, text2) {
        const words1 = new Set(text1.toLowerCase().split(/\s+/));
        const words2 = new Set(text2.toLowerCase().split(/\s+/));

        let commonWords = 0;
        for (const word of words1) {
            if (words2.has(word)) {
                commonWords++;
            }
        }

        const totalWords = Math.max(words1.size, words2.size);
        return totalWords > 0 ? commonWords / totalWords : 0;
    }

    /**
     * Check text quality (minimum words, characters, filler detection)
     */
    checkQuality(text, isFinal = false) {
        const trimmedText = text.trim();

        if (trimmedText.length === 0) {
            return {
                meetsMinimum: false,
                isFillerOnly: false,
                reason: 'empty_text'
            };
        }

        // Word count check (most specific - check first)
        const words = trimmedText.split(/\s+/).filter(w => w.length > 0);
        if (words.length < this.MIN_WORDS_FOR_TRANSLATION) {
            return {
                meetsMinimum: false,
                isFillerOnly: false,
                reason: 'too_few_words'
            };
        }

        // Filler word detection (check content quality)
        const nonFillerWords = words.filter(word => {
            const lowerWord = word.toLowerCase().replace(/[.,!?;:]/g, '');
            return !this.FILLER_WORDS.has(lowerWord);
        });

        if (nonFillerWords.length === 0) {
            return {
                meetsMinimum: false,
                isFillerOnly: true,
                reason: 'filler_words_only'
            };
        }

        // Character count check (sanity check - least specific)
        if (trimmedText.length < this.MIN_CHARS_FOR_TRANSLATION) {
            return {
                meetsMinimum: false,
                isFillerOnly: false,
                reason: 'too_short'
            };
        }

        // All checks passed
        return {
            meetsMinimum: true,
            isFillerOnly: false,
            reason: 'quality_ok'
        };
    }

    /**
     * Detect sentence endings (. ! ? and regional variants)
     */
    detectSentenceEnding(text) {
        const trimmedText = text.trim();

        // Check for sentence-ending punctuation
        const hasPunctuation = /[.!?。！？]\s*$/.test(trimmedText);

        // Exclude ellipsis (not a real sentence ending)
        const hasEllipsis = /\.{2,}\s*$/.test(trimmedText);

        return hasPunctuation && !hasEllipsis;
    }

    /**
     * Approve translation (update state and metrics)
     */
    approveTranslation(newText, reason, confidence, clientId, fullText) {
        this.metrics.translationsApproved++;
        this.lastTranslationTime = Date.now();

        // CRITICAL: Update lastTranslatedText IMMEDIATELY to prevent race conditions
        // Multiple final results from Google can arrive before first translation completes
        if (fullText) {
            this.lastTranslatedText = fullText;
        }

        this.logger.info('✅ Translation APPROVED', {
            clientId,
            reason,
            confidence,
            mode: this.mode,
            textPreview: newText.substring(0, 50),
            wordCount: newText.split(/\s+/).length,
            elapsedMs: Date.now() - this.lastTranslationTime,
            trackedText: this.lastTranslatedText.substring(0, 50)
        });

        return {
            shouldTranslate: true,
            reason,
            confidence,
            newText,
            isComplete: reason === 'sentence_ending' || reason === 'final_result'
        };
    }

    /**
     * Reject translation (update metrics only)
     */
    rejectTranslation(reason, newText) {
        this.metrics.translationsBlocked++;
        this.metrics.blockReasons[reason] = (this.metrics.blockReasons[reason] || 0) + 1;

        return {
            shouldTranslate: false,
            reason,
            confidence: 0,
            newText,
            isComplete: false
        };
    }

    /**
     * Update state after successful translation
     */
    recordTranslation(originalText, translatedText) {
        // NOTE: DO NOT update lastTranslatedText here!
        // It's already set in approveTranslation() to prevent race conditions.
        // Setting it here would overwrite newer values when translations complete out of order.

        this.accumulatedText += (this.accumulatedText ? ' ' : '') + translatedText;
        this.translationCount++;
    }

    /**
     * Reset state for new utterance (after final result)
     */
    resetForNewUtterance() {
        this.lastTranslatedText = '';
        this.lastTextChangeTime = Date.now();
    }

    /**
     * Get current mode configuration
     */
    getConfig() {
        return this.modeConfig;
    }

    /**
     * Get decision metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            mode: this.mode,
            translationCount: this.translationCount,
            approvalRate: this.metrics.totalChecks > 0
                ? this.metrics.translationsApproved / this.metrics.totalChecks
                : 0
        };
    }
}

module.exports = TranslationRulesEngine;
