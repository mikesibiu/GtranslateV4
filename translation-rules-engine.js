/**
 * Translation Rules Engine
 * Centralized decision-making for when to translate
 * Ensures consistent behavior across all translation triggers and modes
 *
 * v144 improvements:
 * - Word-level prefix matching in getNewText() — tolerates punctuation differences
 *   between Google STT interim and final results (e.g. "hello world" vs "Hello, world.")
 * - pauseDetectionMs reduced 4000→2500 for faster natural-pause response
 * - isTranslationDuplicate word-overlap threshold raised 80%→87% to reduce false positives
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

        // Post-translation duplicate detection (CRITICAL FIX)
        this.recentTranslations = []; // Array of {text, timestamp}
        this.TRANSLATION_DEDUP_WINDOW = 30000; // 30 seconds

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
                translationInterval: 8000,   // 8 seconds max between translations
                pauseDetectionMs: 2500,      // 2.5 second pause (was 4s — faster natural-pause response)
                requireSentenceEnding: false,
                minWords: 3,
                enableTTS: false,
                displayVisualCards: true,
                enableSummary: false
            },
            earbuds: {
                name: 'EarBuds',
                translationInterval: 8000,   // 8 seconds max
                pauseDetectionMs: 2500,      // 2.5 second pause
                requireSentenceEnding: false,
                minWords: 3,
                enableTTS: true,
                displayVisualCards: false,
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

        // Priority 2: Maximum interval reached (force translation for fast speakers)
        if (elapsedSinceLastTranslation >= this.modeConfig.translationInterval) {
            if (qualityCheck.meetsMinimum) {
                return this.approveTranslation(newText, 'max_interval', 0.9, context.clientId, context.text);
            } else {
                return this.rejectTranslation('max_interval_poor_quality', newText);
            }
        }

        // Priority 3: Final result from Google (with quality validation)
        if (context.isFinal) {
            if (qualityCheck.meetsMinimum && !qualityCheck.isFillerOnly) {
                return this.approveTranslation(newText, 'final_result', 0.8, context.clientId, context.text);
            } else {
                this.logger.info('⏭️ Skipping low-quality final result', {
                    clientId: context.clientId,
                    text: newText.substring(0, 30),
                    reason: qualityCheck.reason
                });
                return this.rejectTranslation(qualityCheck.reason, newText);
            }
        }

        // Priority 4: Pause detection (handled by timer in server, not here)
        if (context.timeSinceLastChange >= this.modeConfig.pauseDetectionMs) {
            if (qualityCheck.meetsMinimum) {
                return this.approveTranslation(newText, 'pause_detected', 0.7, context.clientId, context.text);
            }
        }

        // Default: Wait for one of the above conditions
        return this.rejectTranslation('waiting_for_trigger', newText);
    }

    /**
     * Normalize a single word for comparison:
     * lowercase, strip leading/trailing punctuation so that
     * "world" === "world," === "world." === "World"
     */
    _normWord(w) {
        return w
            .toLowerCase()
            .replace(/^["""''«»(\[\]{]+/, '')      // leading quotes/brackets (escaped [ )
            .replace(/[.,!?;:"""''«»)\]{}…-]+$/g, ''); // trailing punctuation
    }

    /**
     * Extract new text that hasn't been translated yet.
     *
     * v144: Uses word-level prefix matching instead of character-level startsWith.
     * This is robust against punctuation differences between interim and final results
     * (e.g. interim "hello world" → final "Hello, world." — same words, different punctuation).
     *
     * Algorithm:
     *   1. Split both texts into words.
     *   2. Find the longest prefix of lastTranslatedText that matches the start of fullText
     *      (word-by-word, punctuation-stripped).
     *   3. If ≥ 85% of lastTranslatedText words match → continuation, return remaining words.
     *   4. If current text is a subset of last (speaker said less) → duplicate, return ''.
     *   5. If >65% word overlap → likely duplicate, return ''.
     *   6. Otherwise → new utterance, return full text.
     */
    getNewText(fullText) {
        if (!this.lastTranslatedText) {
            this.logger.debug('🔍 getNewText: No previous translation, returning full text');
            return fullText.trim();
        }

        const trimmedFull = fullText.trim();
        const trimmedLast = this.lastTranslatedText.trim();

        if (trimmedFull.length === 0) return '';

        this.logger.debug('🔍 getNewText comparing:', {
            current: trimmedFull.substring(0, 80),
            last: trimmedLast.substring(0, 80)
        });

        const fullWords = trimmedFull.split(/\s+/).filter(Boolean);
        const lastWords = trimmedLast.split(/\s+/).filter(Boolean);

        if (lastWords.length === 0) return trimmedFull;

        // --- Case 1: Count shared word-level prefix ---
        let matchCount = 0;
        const minLen = Math.min(fullWords.length, lastWords.length);
        for (let i = 0; i < minLen; i++) {
            if (this._normWord(fullWords[i]) === this._normWord(lastWords[i])) {
                matchCount++;
            } else {
                break;
            }
        }

        // Continuation: ≥85% of committed words match as a prefix.
        // QA fix: use Math.ceil(... * 0.85) so the threshold is actually exercised
        // (the previous `matchCount === lastWords.length` made it 100%-only).
        if (matchCount >= Math.ceil(lastWords.length * 0.85)) {
            const remaining = fullWords.slice(matchCount).join(' ');
            this.logger.debug('📝 Word-level prefix match (continuation)', {
                matchedWords: matchCount,
                totalCommitted: lastWords.length,
                matchPct: Math.round((matchCount / lastWords.length) * 100),
                remaining: remaining.substring(0, 60)
            });
            return remaining;
        }

        // Shared overlap check — compute once, reuse in Cases 2 and 3.
        const overlap = this.calculateOverlap(trimmedLast, trimmedFull);

        // --- Case 2: Current is subset of last (speaker corrected / re-stated shorter phrase) ---
        if (fullWords.length <= lastWords.length && overlap > 0.65) {
            this.logger.info('⛔ DUPLICATE DETECTED: Current is subset/overlap of last');
            return '';
        }

        // --- Case 3: General overlap dedup (>65% shared words = too similar) ---
        this.logger.debug(`📊 Overlap: ${(overlap * 100).toFixed(1)}%`);
        if (overlap > 0.65) {
            this.logger.info(`⛔ DUPLICATE DETECTED: ${(overlap * 100).toFixed(1)}% overlap (threshold: 65%)`);
            return '';
        }

        // --- Case 4: New utterance ---
        this.logger.debug('✅ New utterance detected, no duplication');
        return trimmedFull;
    }

    /**
     * Calculate word overlap between two texts (0.0 to 1.0).
     * Uses _normWord so punctuation differences don't inflate uniqueness scores
     * (e.g. "world," and "world" are treated as the same word).
     */
    calculateOverlap(text1, text2) {
        const words1 = new Set(
            text1.split(/\s+/).filter(Boolean).map(w => this._normWord(w))
        );
        const words2 = new Set(
            text2.split(/\s+/).filter(Boolean).map(w => this._normWord(w))
        );

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
     * CRITICAL FIX: Check if translation output is a duplicate
     * This catches cases where different source texts translate to identical output.
     *
     * v144: Raised word-overlap threshold 80% → 87% to reduce false positives
     * (legitimate new content that shares many words with previous was being blocked).
     *
     * @param {string} translation - The translated text to check
     * @returns {boolean} True if this translation was recently shown
     */
    isTranslationDuplicate(translation) {
        const normalized = translation.toLowerCase().trim();
        const now = Date.now();

        // Clean old entries (older than 30s)
        this.recentTranslations = this.recentTranslations.filter(
            entry => now - entry.timestamp < this.TRANSLATION_DEDUP_WINDOW
        );

        for (const entry of this.recentTranslations) {
            const entryNormalized = entry.text.toLowerCase().trim();

            // Exact match (case-insensitive)
            if (entryNormalized === normalized) {
                this.logger.info('🚫 POST-TRANSLATION DUPLICATE: Exact match', {
                    translation: normalized.substring(0, 50)
                });
                return true;
            }

            // Substring check (one contains the other with ≥80% length ratio)
            // 80% means B can be at most 25% longer than A — clearly a subset
            if (entryNormalized.includes(normalized) || normalized.includes(entryNormalized)) {
                const overlap = Math.min(entryNormalized.length, normalized.length) /
                               Math.max(entryNormalized.length, normalized.length);
                if (overlap >= 0.8) {
                    this.logger.info(`🚫 POST-TRANSLATION DUPLICATE: ${(overlap * 100).toFixed(1)}% substring overlap`, {
                        translation: normalized.substring(0, 50)
                    });
                    return true;
                }
            }

            // Word overlap check — raised to 87% (was 80%) to reduce false positives
            const wordOverlap = this.calculateOverlap(entryNormalized, normalized);
            if (wordOverlap >= 0.87) {
                this.logger.info(`🚫 POST-TRANSLATION DUPLICATE: ${(wordOverlap * 100).toFixed(1)}% word overlap (threshold: 87%)`, {
                    translation: normalized.substring(0, 50)
                });
                return true;
            }
        }

        return false;
    }

    /**
     * Record a translation output for duplicate detection
     */
    recordTranslatedOutput(translation) {
        const now = Date.now();

        this.recentTranslations.push({
            text: translation,
            timestamp: now
        });

        // Keep only last 30 seconds
        this.recentTranslations = this.recentTranslations.filter(
            entry => now - entry.timestamp < this.TRANSLATION_DEDUP_WINDOW
        );

        this.logger.debug('📝 Recorded translation output', {
            translation: translation.substring(0, 50),
            queueSize: this.recentTranslations.length
        });
    }

    /**
     * Check text quality (minimum words, characters, filler detection)
     */
    checkQuality(text, isFinal = false) {
        const trimmedText = text.trim();

        if (trimmedText.length === 0) {
            return { meetsMinimum: false, isFillerOnly: false, reason: 'empty_text' };
        }

        const words = trimmedText.split(/\s+/).filter(w => w.length > 0);
        if (words.length < this.MIN_WORDS_FOR_TRANSLATION) {
            return { meetsMinimum: false, isFillerOnly: false, reason: 'too_few_words' };
        }

        const nonFillerWords = words.filter(word => {
            const lowerWord = word.toLowerCase().replace(/[.,!?;:]/g, '');
            return !this.FILLER_WORDS.has(lowerWord);
        });

        if (nonFillerWords.length === 0) {
            return { meetsMinimum: false, isFillerOnly: true, reason: 'filler_words_only' };
        }

        if (trimmedText.length < this.MIN_CHARS_FOR_TRANSLATION) {
            return { meetsMinimum: false, isFillerOnly: false, reason: 'too_short' };
        }

        return { meetsMinimum: true, isFillerOnly: false, reason: 'quality_ok' };
    }

    /**
     * Reset state for a new utterance (used by tests and server resets)
     */
    resetForNewUtterance() {
        this.lastTranslatedText = '';
        this.accumulatedText = '';
        this.translationCount = 0;
        this.recentTranslations = [];
    }

    /**
     * Detect sentence endings (. ! ? and regional variants)
     */
    detectSentenceEnding(text) {
        const trimmedText = text.trim();
        const hasPunctuation = /[.!?。！？]\s*$/.test(trimmedText);
        const hasEllipsis = /\.{2,}\s*$/.test(trimmedText);
        return hasPunctuation && !hasEllipsis;
    }

    /**
     * Approve translation (update state and metrics)
     */
    approveTranslation(newText, reason, confidence, clientId, fullText) {
        this.metrics.translationsApproved++;
        const prevTranslationTime = this.lastTranslationTime;
        this.lastTranslationTime = Date.now();

        // CRITICAL: Update lastTranslatedText IMMEDIATELY to prevent race conditions
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
            elapsedMs: prevTranslationTime ? this.lastTranslationTime - prevTranslationTime : 0,
            trackedText: this.lastTranslatedText.substring(0, 50)
        });

        return {
            shouldTranslate: true,
            reason,
            confidence,
            newText,
            isComplete: reason === 'sentence_ending' ||
                       reason === 'final_result' ||
                       reason === 'max_interval' ||
                       reason === 'pause_detected'
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
        this.accumulatedText += (this.accumulatedText ? ' ' : '') + translatedText;
        this.translationCount++;
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
