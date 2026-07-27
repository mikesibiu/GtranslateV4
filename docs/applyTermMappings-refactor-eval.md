# Evaluation — refactoring `applyTermMappings`

_Prepared 2026-07-27. Scope: whether/how to restructure the ~836-line
`applyTermMappings` function in `translation-post-processor.js`._

## 1. Current state (measured, not estimated)

| Metric | Value |
|---|---|
| Function length | ~836 lines (`translation-post-processor.js:24`–~860) |
| Clean data-driven rules (`mappings[]` + loop at line 57) | 12 entries |
| Inline `result.replace(...)` calls | 203 |
| — of those, case-preserving **function** replacements | 12 |
| Source-gated `if (/…/.test(source…))` blocks | 68 |
| Batch/section header comments | 1 |
| Tests exercising the function | 375 `it()` cases |
| Parallel hand-maintained port | `PhraseTranslation/translation_engine_v2.py` (Python) |

**Reading of the data:** the function already contains the *right* pattern — a
`mappings[]` array applied by a single `for…of` loop (line 57) — but only 12 of
~215 rules use it. The other 203 are flat, order-dependent `result.replace()`
statements appended over time (essentially one batch per meeting), with almost
no sectioning. It is not broken — 375 tests pass — but it has three real costs:

1. **Cognitive load / discoverability.** With 203 sequential replaces and no
   categories, answering "is there already a rule for X?" or "what touches the
   word _slave_?" means scanning the whole function. This directly caused a
   near-miss tonight (the `faithfully` gate was over-broad; QA had to catch it).
2. **Ordering fragility.** Any rule can clobber a later rule's input. Ordering
   is implicit (source order) with no contract. The `preserveSourceNumbers`
   positional bug and the `faithfully`/`differently` scoping issues fixed this
   session are all symptoms of "hard to reason about interactions."
3. **Cross-language duplication.** Every non-STT rule must be hand-ported from
   JS to Python for PhraseTranslation. I did exactly this earlier tonight
   (v210–v217 → `translation_engine_v2.py`), by hand, rule by rule. That is
   error-prone and unbounded — it grows every meeting.

## 2. Options

### Option A — Sectioning only (low effort, ~zero risk)
Add a table-of-contents header and labeled `// ── <category> ──` dividers,
grouping the existing rules in place (verb-agreement, possessives,
JW-terminology, STT-garbles, scripture-citations, source-gated). No logic
change, or at most trivial adjacent reordering within a category.

- **Effort:** 2–3 hours, mechanical.
- **Risk:** negligible (comments; run the 375 tests after any move).
- **Fixes:** #1 (discoverability). Does **not** address ordering or duplication.

### Option B — Data-driven rule table in JS (medium effort, medium risk)
Extend the existing `mappings[]` pattern to cover (most of) the 203 inline
rules. Each rule becomes:

```js
{
  id: 'jehovah-servants-possessive',
  category: 'possessive',
  pattern: /\bJehovah\s+(servants?)\b/g,
  replacement: "Jehovah's $1",      // string ($n backrefs) OR (m, …) => string
  gate: (s) => true,                 // optional: (sourceNorm, sourceText) => bool
  since: 'v217',
  note: 'MT drops the apostrophe-s',
}
```

A single engine applies them in array order. Ordering becomes **explicit and
documentable**; categories are filterable; duplicate/overlapping rules become
detectable. The 12 existing function-replacements mean `replacement` must accept
a string **or** a function — a minor engine detail, not a blocker. The 68 gates
map cleanly to an optional per-rule (or per-group) `gate` predicate.

- **Effort:** 1–2 focused days to convert 203 replaces + 68 gates, migrating
  **category by category** with the 375 tests green at every step.
- **Risk:** medium. The refactor must preserve exact ordering and gate
  semantics. The 375 tests are a strong but not total safety net — they assert
  input→output, so any ordering interaction not covered by a test could regress
  silently. Mitigate by migrating in small commits and diffing behavior on a
  corpus (see §4).
- **Fixes:** #1 and #2. Enables — but does not itself deliver — #3.

### Option C — Shared cross-language rule spec (high effort, low return)
Extract rules to a language-neutral spec (JSON) consumed by both the JS engine
and the Python one, killing the hand-port duplication at the source.

- **Blocker:** JS and Python regex dialects are **not** interchangeable. Named
  groups, look-behind, Unicode property escapes (`\p{L}`), and the
  case-preserving replacement callbacks all differ between `RegExp` and Python
  `re`. A shared spec would need a portable regex subset + two replacement
  implementations — most of the rules would need per-language escape hatches
  anyway.
- **Effort:** several days; **Risk:** high (two runtimes to validate, subtle
  dialect bugs). **Return:** low once you account for the escape hatches.
- **Verdict:** not worth it.

## 3. Recommendation

**Do Option A now; adopt Option B incrementally only if the porting pain
continues; skip Option C.**

Rationale: the monolith works and is well-tested, and it sits on the live hot
path — a big-bang rewrite is unjustified risk. Sectioning (A) is a free
readability win that would have made tonight's `faithfully` near-miss obvious.
Option B is the correct end-state for ordering-safety and is *enabled* by the
`mappings[]` pattern already present, but it should be earned incrementally
(category-by-category, tests green each step), not done in one sitting.

## 4. Cheapest high-value mitigation for the duplication (#3)

Independently of A/B/C: add a **shared golden corpus** — a plain data file of
`{ sourceText, input, expected }` cases — checked into both repos (or one repo,
read by both test suites). The GTranslate mocha suite and the PhraseTranslation
pytest suite both assert their implementation reproduces the corpus. This does
**not** unify the regex engines, but it makes JS↔Python drift a **test failure**
instead of a silent divergence discovered in a live meeting. Low cost
(a few hours), high value, and it makes any future Option B/C migration
safe to verify.

## 5. Suggested sequencing

1. **Option A** (sectioning + TOC) — 2–3 h, do first.
2. **Golden corpus parity test** across GTranslate ↔ PhraseTranslation — few h.
3. **Option B**, incremental, one category per PR, tests green — only if the
   monthly porting cost keeps hurting.
4. Fold the deferred "hoist regex literals" micro-opt into step 3 (module-level
   compiled patterns fall out naturally from the rule table).

## 6. Not recommended
- Big-bang rewrite of all 203 rules at once (unjustified risk on a live path).
- Option C shared regex spec (dialect differences defeat the purpose).
