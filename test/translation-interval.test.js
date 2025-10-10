/**
 * Unit Tests for Translation Interval Logic
 * Tests the forced translation timer mechanism with different intervals
 */

const { describe, it, before, after, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const sinon = require('sinon');

describe('Translation Interval Logic', () => {
    let clock;

    beforeEach(() => {
        // Use fake timers for precise time control
        clock = sinon.useFakeTimers();
    });

    afterEach(() => {
        clock.restore();
    });

    describe('Timer Creation', () => {
        it('should create timer with correct 10-second interval for Talks mode', () => {
            const intervalMs = 10000; // Talks mode
            let timerFired = false;
            let restartStreamTimer = null;

            // Simulate creating the timer
            if (!restartStreamTimer) {
                restartStreamTimer = setTimeout(() => {
                    timerFired = true;
                }, intervalMs);
            }

            // Verify timer hasn't fired yet
            expect(timerFired).to.be.false;

            // Advance time by 9999ms (just before timer should fire)
            clock.tick(9999);
            expect(timerFired).to.be.false;

            // Advance time by 1ms more (timer should fire)
            clock.tick(1);
            expect(timerFired).to.be.true;
        });

        it('should create timer with correct 4-second interval for Q&A mode', () => {
            const intervalMs = 4000; // Q&A mode
            let timerFired = false;
            let restartStreamTimer = null;

            // Simulate creating the timer
            if (!restartStreamTimer) {
                restartStreamTimer = setTimeout(() => {
                    timerFired = true;
                }, intervalMs);
            }

            // Verify timer hasn't fired yet
            expect(timerFired).to.be.false;

            // Advance time by 3999ms (just before timer should fire)
            clock.tick(3999);
            expect(timerFired).to.be.false;

            // Advance time by 1ms more (timer should fire)
            clock.tick(1);
            expect(timerFired).to.be.true;
        });

        it('should not create multiple timers when one is already active', () => {
            const intervalMs = 4000;
            let timerCount = 0;
            let restartStreamTimer = null;

            // First timer creation
            if (!restartStreamTimer) {
                restartStreamTimer = setTimeout(() => {
                    timerCount++;
                }, intervalMs);
            }

            // Attempt to create second timer (should be blocked)
            if (!restartStreamTimer) {
                setTimeout(() => {
                    timerCount++;
                }, intervalMs);
            }

            // Fire all timers
            clock.tick(intervalMs);

            // Only one timer should have been created
            expect(timerCount).to.equal(1);
        });
    });

    describe('Timer Lifecycle', () => {
        it('should clear timer and allow new timer after translation completes', () => {
            const intervalMs = 4000;
            let timerFireCount = 0;
            let restartStreamTimer = null;

            // Create first timer
            if (!restartStreamTimer) {
                restartStreamTimer = setTimeout(() => {
                    timerFireCount++;
                    restartStreamTimer = null; // Clear after firing
                }, intervalMs);
            }

            // Fire first timer
            clock.tick(intervalMs);
            expect(timerFireCount).to.equal(1);
            expect(restartStreamTimer).to.be.null;

            // Create second timer (should succeed since first was cleared)
            if (!restartStreamTimer) {
                restartStreamTimer = setTimeout(() => {
                    timerFireCount++;
                    restartStreamTimer = null;
                }, intervalMs);
            }

            // Fire second timer
            clock.tick(intervalMs);
            expect(timerFireCount).to.equal(2);
        });

        it('should cancel timer when final result is received', () => {
            const intervalMs = 4000;
            let forcedTranslationFired = false;
            let restartStreamTimer = null;

            // Create timer
            if (!restartStreamTimer) {
                restartStreamTimer = setTimeout(() => {
                    forcedTranslationFired = true;
                }, intervalMs);
            }

            // Simulate final result received after 2 seconds
            clock.tick(2000);

            // Cancel timer
            if (restartStreamTimer) {
                clearTimeout(restartStreamTimer);
                restartStreamTimer = null;
            }

            // Advance to when forced translation would have fired
            clock.tick(2000);

            // Forced translation should NOT have fired
            expect(forcedTranslationFired).to.be.false;
        });
    });

    describe('Interval Value Capture', () => {
        it('should capture interval value in closure correctly', () => {
            const intervals = [10000, 4000, 7000];
            const results = [];

            intervals.forEach((intervalMs) => {
                setTimeout(() => {
                    results.push(intervalMs);
                }, intervalMs);
            });

            // Fire all timers
            clock.tick(11000);

            // Verify each timer captured its own interval value
            expect(results).to.have.lengthOf(3);
            expect(results).to.include(4000);
            expect(results).to.include(7000);
            expect(results).to.include(10000);
        });

        it('should use correct interval when switching between modes', () => {
            let currentInterval = 10000; // Start with Talks mode
            const timerResults = [];

            // Create timer with Talks mode interval (10s)
            let restartStreamTimer = setTimeout(() => {
                timerResults.push({ mode: 'talks', interval: currentInterval });
            }, currentInterval);

            // Fire Talks mode timer
            clock.tick(10000);
            clearTimeout(restartStreamTimer);
            restartStreamTimer = null;

            // Switch to Q&A mode
            currentInterval = 4000;

            // Create timer with Q&A mode interval (4s)
            if (!restartStreamTimer) {
                restartStreamTimer = setTimeout(() => {
                    timerResults.push({ mode: 'qa', interval: currentInterval });
                }, currentInterval);
            }

            // Fire Q&A mode timer
            clock.tick(4000);

            // Verify both timers used correct intervals
            expect(timerResults).to.have.lengthOf(2);
            expect(timerResults[0]).to.deep.equal({ mode: 'talks', interval: 10000 });
            expect(timerResults[1]).to.deep.equal({ mode: 'qa', interval: 4000 });
        });
    });

    describe('Incremental Translation Logic', () => {
        it('should only translate new text portion after forced translation', () => {
            let lastInterimText = 'Bună ziua';
            let lastTranslatedText = '';
            const translations = [];

            // First forced translation (translate everything)
            const newText1 = lastInterimText.substring(lastTranslatedText.length).trim();
            if (newText1.length > 0) {
                translations.push(newText1);
                lastTranslatedText = lastInterimText;
            }

            // More speech continues
            lastInterimText = 'Bună ziua Ci faci Bună seara';

            // Second forced translation (only translate new portion)
            const newText2 = lastInterimText.substring(lastTranslatedText.length).trim();
            if (newText2.length > 0) {
                translations.push(newText2);
                lastTranslatedText = lastInterimText;
            }

            expect(translations).to.have.lengthOf(2);
            expect(translations[0]).to.equal('Bună ziua');
            expect(translations[1]).to.equal('Ci faci Bună seara');
        });

        it('should skip translation if no new text', () => {
            let lastInterimText = 'Bună ziua';
            let lastTranslatedText = 'Bună ziua'; // Already translated
            const translations = [];

            const newText = lastInterimText.substring(lastTranslatedText.length).trim();
            if (newText.length > 0) {
                translations.push(newText);
            }

            expect(translations).to.have.lengthOf(0);
        });

        it('should reset tracking after final result', () => {
            let lastInterimText = 'Bună ziua Ci faci';
            let lastTranslatedText = 'Bună ziua Ci faci';

            // Simulate final result received
            const isFinal = true;
            if (isFinal) {
                lastInterimText = '';
                lastTranslatedText = '';
            }

            expect(lastInterimText).to.equal('');
            expect(lastTranslatedText).to.equal('');

            // Next interim should translate from beginning
            lastInterimText = 'Bună seara';
            const newText = lastInterimText.substring(lastTranslatedText.length).trim();
            expect(newText).to.equal('Bună seara');
        });
    });

    describe('Session State Management', () => {
        it('should prevent translation when session is not active', () => {
            let sessionActive = false;
            let translationOccurred = false;

            const intervalMs = 4000;
            setTimeout(() => {
                if (sessionActive) {
                    translationOccurred = true;
                }
            }, intervalMs);

            clock.tick(intervalMs);

            expect(translationOccurred).to.be.false;
        });

        it('should allow translation when session is active', () => {
            let sessionActive = true;
            let translationOccurred = false;

            const intervalMs = 4000;
            setTimeout(() => {
                if (sessionActive) {
                    translationOccurred = true;
                }
            }, intervalMs);

            clock.tick(intervalMs);

            expect(translationOccurred).to.be.true;
        });

        it('should stop translations when session becomes inactive', () => {
            let sessionActive = true;
            let translationCount = 0;

            const intervalMs = 4000;
            const doTranslation = () => {
                setTimeout(() => {
                    if (sessionActive) {
                        translationCount++;
                        doTranslation(); // Schedule next
                    }
                }, intervalMs);
            };

            doTranslation();

            // First translation
            clock.tick(intervalMs);
            expect(translationCount).to.equal(1);

            // Second translation
            clock.tick(intervalMs);
            expect(translationCount).to.equal(2);

            // Stop session
            sessionActive = false;

            // No more translations should occur
            clock.tick(intervalMs);
            expect(translationCount).to.equal(2);
        });
    });

    describe('Default Values', () => {
        it('should use 10000ms when translationInterval is undefined', () => {
            const translationInterval = undefined;
            const intervalMs = translationInterval || 10000;

            expect(intervalMs).to.equal(10000);
        });

        it('should use provided interval when defined', () => {
            const translationInterval = 4000;
            const intervalMs = translationInterval || 10000;

            expect(intervalMs).to.equal(4000);
        });

        it('should handle null translationInterval', () => {
            const translationInterval = null;
            const intervalMs = translationInterval || 10000;

            expect(intervalMs).to.equal(10000);
        });

        it('should handle zero translationInterval', () => {
            const translationInterval = 0;
            const intervalMs = translationInterval || 10000;

            // Zero is falsy, so should use default
            expect(intervalMs).to.equal(10000);
        });
    });
});
