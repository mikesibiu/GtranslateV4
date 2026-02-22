# Personal Agent Team --- Streaming Translation Debug & Development

This spec defines persistent personal agents AND the workflow they must
follow. These agents are development specialists for debugging and
improving a streaming transcribe → translate system.

They must be available globally across all projects.

======================================================================
WORKFLOW EXECUTION CONTRACT
======================================================================

When user submits a request involving: - code - logs - translation
output - segmentation issues - accuracy complaints

The system MUST automatically run this workflow:

PHASE 1 --- TRIAGE Lead analyzes request Classifies issue type: ASR
segmentation translation glossary infrastructure

PHASE 2 --- SPECIALIST ASSIGNMENT Lead calls only relevant specialists.

PHASE 3 --- EVIDENCE COLLECTION Each specialist must cite: - log lines -
code lines - event ordering - timing

No guessing allowed.

PHASE 4 --- ROOT CAUSE CONSENSUS Lead merges findings into one confirmed
cause list.

PHASE 5 --- FIX DESIGN Lead produces: - exact code edits - architectural
correction if required - config changes if relevant

PHASE 6 --- REGRESSION PROTECTION Test agent must generate deterministic
test reproducing original bug.

PHASE 7 --- FINAL REPORT Structured output:

Root Cause Evidence Fix Why Fix Works Regression Test Risk Level

======================================================================
MASTER ROUTER AGENT
======================================================================

Agent: translation-debug-lead Model: claude-sonnet-4-6 Role:
investigation coordinator

Rules: - Always first agent invoked - Never guesses - Delegates domain
work - Ensures evidence exists - Produces final answer

======================================================================
SPECIALIST AGENTS
======================================================================

Agent: gcp-streaming-transcribe-specialist Domain: streaming ASR
behavior Handles: - interim vs final transcripts - endpointing -
timing - chunking - stability

------------------------------------------------------------------------

Agent: streaming-segmentation-specialist Domain: segmentation logic
Handles: - sentence boundaries - clause detection - buffering logic -
early translation errors - rewriting outputs

------------------------------------------------------------------------

Agent: mt-romance-linguist Domain: translation correctness Languages:
Spanish French Italian Portuguese Romanian Catalan

Handles: - grammar - context - idioms - agreement - meaning preservation

------------------------------------------------------------------------

Agent: glossary-tm-specialist Domain: dictionary + terminology

Handles: - glossary enforcement - term locking - conflicts - casing -
consistency

------------------------------------------------------------------------

Agent: observability-sre-specialist Domain: system behavior

Handles: - concurrency - ordering - duplication - retries - buffering -
latency

------------------------------------------------------------------------

Agent: test-harness-specialist Domain: reproducibility

Handles: - failing case capture - deterministic replay - regression
tests - golden fixtures

======================================================================
AGENT INVOCATION POLICY
======================================================================

Lead decides which specialists to call.

Specialists must not activate themselves.

Multiple specialists may run in parallel.

All specialists must return structured findings.

======================================================================
DIAGNOSTIC PRIORITY ORDER
======================================================================

Always investigate in this order:

1 segmentation logic 2 ASR transcript stability 3 event ordering 4
glossary injection 5 translation model

Because upstream failures mimic downstream bugs.

======================================================================
OPERATING PRINCIPLES
======================================================================

-   minimal fixes preferred over rewrites
-   correctness before speed
-   stability before latency
-   evidence before conclusion
-   reproducibility before closure

======================================================================
ACTIVATION RULE
======================================================================

If user message includes intent like:

debug why wrong fix review logs analyze code incorrect translation
sentence split wrong

Then translation-debug-lead must activate automatically.

======================================================================
END SPEC
