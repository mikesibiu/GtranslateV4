#!/bin/bash
# Script to apply the data handler refactoring
# Replaces lines 705-925 in server.js with centralized rules engine logic

cd /Users/mfarace/ClaudeProjects/GtranslateV4

# Create backup
cp server.js server.js.pre-refactor

# Extract before section (lines 1-704)
sed -n '1,704p' server.js > server-new.js

# Add the new centralized data handler logic
cat >> server-new.js << 'DATAHANDLER'

                    // Send interim results to client for visual feedback
                    if (sessionActive) {
                        socket.emit('interim-result', {
                            text: transcript,
                            isFinal
                        });

                        // Update activity timestamp
                        updateActivity();

                        // Track text changes for pause detection
                        const previousInterimText = lastInterimText;
                        lastInterimText = transcript;
                        const textChanged = previousInterimText !== transcript;

                        // Clear pause detection timer if text is still changing
                        if (textChanged && restartStreamTimer) {
                            clearTimeout(restartStreamTimer);
                            restartStreamTimer = null;
                        }

                        // ===========================================
                        // CENTRALIZED TRANSLATION DECISION
                        // ===========================================

                        const decision = translationRules.shouldTranslate({
                            text: transcript,
                            isFinal: isFinal,
                            timeSinceLastChange: textChanged ? 0 : (Date.now() - (lastTextChangeTime || Date.now())),
                            trigger: isFinal ? 'final' : 'interim',
                            clientId: clientId
                        });

                        // Update last text change time
                        if (textChanged) {
                            lastTextChangeTime = Date.now();
                        }

                        // ===========================================
                        // ACT ON DECISION
                        // ===========================================

                        if (decision.shouldTranslate) {
                            // Clear any pending pause timer - we're translating now
                            if (restartStreamTimer) {
                                clearTimeout(restartStreamTimer);
                                restartStreamTimer = null;
                            }

                            const newText = decision.newText;

                            if (newText.length > 0) {
                                accumulatedText = translationRules.accumulatedText;

                                try {
                                    const translation = await translateWithRetry(
                                        newText,
                                        targetLanguage,
                                        currentLanguage,
                                        clientId
                                    );

                                    translationCount++;

                                    logger.info('✅ Translation completed', {
                                        clientId,
                                        reason: decision.reason,
                                        confidence: decision.confidence,
                                        original: newText.substring(0, 50),
                                        translated: translation.substring(0, 50),
                                        count: translationCount,
                                        isComplete: decision.isComplete
                                    });

                                    // Record translation in rules engine
                                    translationRules.recordTranslation(transcript, translation);

                                    socket.emit('translation-result', {
                                        original: newText,
                                        translated: translation,
                                        accumulated: accumulatedText,
                                        count: translationCount,
                                        isInterim: !decision.isComplete,  // Use rules engine's determination
                                        reason: decision.reason  // Include reasoning for debugging
                                    });

                                    // Update tracking variables
                                    lastTranslatedText = transcript;
                                    lastTranslationTime = Date.now();

                                    // Reset for new utterance if this was a final/complete result
                                    if (decision.isComplete) {
                                        translationRules.resetForNewUtterance();
                                        lastInterimText = '';
                                        lastTranslatedText = '';
                                    }

                                } catch (error) {
                                    logger.error('Translation error', {
                                        clientId,
                                        reason: decision.reason,
                                        error: error.message
                                    });
                                    socket.emit('translation-error', {
                                        message: error.message
                                    });
                                }
                            }
                        } else {
                            // Translation rejected - maybe start pause detection timer
                            // Only set pause timer for interim results when max interval not reached
                            if (!isFinal && !restartStreamTimer && textChanged) {
                                const pauseMs = translationRules.getConfig().pauseDetectionMs;

                                restartStreamTimer = setTimeout(async () => {
                                    logger.info('⏰ PAUSE timer fired - checking rules engine', { clientId });

                                    // Re-check with rules engine after pause
                                    const pauseDecision = translationRules.shouldTranslate({
                                        text: lastInterimText,
                                        isFinal: false,
                                        timeSinceLastChange: pauseMs,
                                        trigger: 'pause',
                                        clientId: clientId
                                    });

                                    if (pauseDecision.shouldTranslate && sessionActive) {
                                        const newText = pauseDecision.newText;

                                        if (newText.length > 0) {
                                            accumulatedText = translationRules.accumulatedText;

                                            try {
                                                const translation = await translateWithRetry(
                                                    newText,
                                                    targetLanguage,
                                                    currentLanguage,
                                                    clientId
                                                );

                                                translationCount++;

                                                logger.info('✅ PAUSE translation completed', {
                                                    clientId,
                                                    original: newText.substring(0, 50),
                                                    translated: translation.substring(0, 50),
                                                    count: translationCount
                                                });

                                                translationRules.recordTranslation(lastInterimText, translation);

                                                socket.emit('translation-result', {
                                                    original: newText,
                                                    translated: translation,
                                                    accumulated: accumulatedText,
                                                    count: translationCount,
                                                    isInterim: !pauseDecision.isComplete,
                                                    reason: pauseDecision.reason
                                                });

                                                lastTranslatedText = lastInterimText;
                                                lastTranslationTime = Date.now();

                                            } catch (error) {
                                                logger.error('PAUSE translation error', { clientId, error: error.message });
                                            }
                                        }
                                    }

                                    restartStreamTimer = null;
                                }, pauseMs);
                            }

                            logger.debug('⏭️ Translation skipped', {
                                clientId,
                                reason: decision.reason,
                                textPreview: transcript.substring(0, 30),
                                isFinal
                            });
                        }
                    }
DATAHANDLER

# Extract after section (lines 926 to end)
sed -n '926,$p' server.js >> server-new.js

# Replace original with new version
mv server-new.js server.js

echo "✅ Data handler refactoring applied successfully"
echo "📁 Backup saved as: server.js.pre-refactor"
