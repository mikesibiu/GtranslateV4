'use strict';

/**
 * Unit tests for translation-post-processor.js
 *
 * Covers: extractByWordLCP, applyTermMappings, verifyReligiousTerms,
 *         preserveSourceNumbers, preserveDates
 *
 * Each test is named after the real production bug or regression it protects.
 */

const { expect } = require('chai');
const {
    extractByWordLCP,
    applyTermMappings,
    verifyReligiousTerms,
    preserveSourceNumbers,
    preserveDates,
} = require('../translation-post-processor');

// ─────────────────────────────────────────────────────────────────────────────
// extractByWordLCP
// ─────────────────────────────────────────────────────────────────────────────
describe('extractByWordLCP', () => {

    describe('base cases', () => {
        it('returns full text when committedTranslation is empty', () => {
            expect(extractByWordLCP('Hello world today', '')).to.equal('Hello world today');
        });

        it('returns null when translatedFull is empty', () => {
            expect(extractByWordLCP('', 'Hello')).to.be.null;
        });

        it('returns null when translatedFull has no more words than committed', () => {
            // Nothing new to emit
            expect(extractByWordLCP('Hello world', 'Hello world')).to.be.null;
        });

        it('returns null when translated is shorter than committed', () => {
            expect(extractByWordLCP('Hello', 'Hello world')).to.be.null;
        });
    });

    describe('happy path extraction', () => {
        it('extracts tail when prefix matches 100%', () => {
            const result = extractByWordLCP(
                'Hello world today is a great day',
                'Hello world today'
            );
            expect(result).to.equal('is a great day');
        });

        it('preserves original casing and punctuation in tail', () => {
            const result = extractByWordLCP(
                'Hello world. Today is great!',
                'Hello world.'
            );
            expect(result).to.equal('Today is great!');
        });

        it('handles leading/trailing whitespace in inputs', () => {
            const result = extractByWordLCP(
                '  Hello world today  ',
                '  Hello  '
            );
            expect(result).to.equal('world today');
        });
    });

    describe('75% threshold boundary', () => {
        it('returns tail when match ratio is exactly 75% (3 of 4 words)', () => {
            // committed = 4 words: "one two three four"
            // full = "one two three DIFFERENT plus more words"
            // Greedy scan: "one","two","three" match. "four" not found in window [3..5]
            // → skipped. lastMatchedInFull=2, tail starts at full[3] = "DIFFERENT plus more words".
            const result = extractByWordLCP(
                'one two three DIFFERENT plus more words',
                'one two three four'
            );
            expect(result).to.equal('DIFFERENT plus more words');
        });

        it('returns null when match ratio is below 75% (2 of 4 words = 50%)', () => {
            // "one","two" match. "three","four" not found in window → 2/4 = 50% < 75% → null.
            const result = extractByWordLCP(
                'one two completely different sentence here',
                'one two three four'
            );
            expect(result).to.be.null;
        });

        it('returns null when first word does not match (0%)', () => {
            const result = extractByWordLCP('Totally different text here', 'Hello world');
            expect(result).to.be.null;
        });

        it('greedy scan: synonym swap at position 0 absorbed, rest match', () => {
            // "would" not in window → skipped. "be" found at full[1], rest match → 7/8 = 87.5%.
            const committed = 'would be nice to have that feature implemented';
            const full      = 'will be nice to have that feature implemented now';
            const result = extractByWordLCP(full, committed);
            expect(result).to.equal('now');
        });

        it('greedy scan: single synonym swap does not re-emit already-shown content', () => {
            // "would" not found → skipped. "be" matched at full[2] (after "will"). 7/8 = 87.5%.
            const committed = 'It would be nice to have that feature';
            const full      = 'It will be nice to have that feature plus more context';
            const result = extractByWordLCP(full, committed);
            expect(result).to.equal('plus more context');
        });

        it('greedy scan: article insertion in full absorbed by window', () => {
            // full inserts "the" before "maintenance" — window finds "maintenance" 1 ahead.
            const committed = 'maintenance instructors serve as an important point';
            const full      = 'the maintenance instructors serve as an important point of this';
            const result = extractByWordLCP(full, committed);
            expect(result).to.equal('of this');
        });

        it('greedy scan: standalone punctuation tokens in full do not cause index misalignment', () => {
            // Bug: fullOrigWords included "—" but fullNorm filtered it → indices diverge.
            // Fix: both arrays built together, pure-punctuation tokens excluded from both.
            const committed = 'Hello world today';
            const full      = 'Hello — world today more';
            const result = extractByWordLCP(full, committed);
            expect(result).to.equal('more');
        });

        it('greedy scan: three consecutive substitutions fail below 75% (WINDOW does not false-pass)', () => {
            // 13-word committed; if 3 consecutive content words all substituted (not found in window),
            // matchCount = 10, ratio = 10/13 = 76.9% → still passes. Need ≥4 misses to fail.
            // This test uses 8-word committed with 3 consecutive misses → 5/8 = 62.5% < 75% → null.
            const committed = 'one two three four five six seven eight';
            const full      = 'one two ALPHA BETA GAMMA six seven eight extra';
            const result = extractByWordLCP(full, committed);
            // "three","four","five" all not found in their windows (ALPHA/BETA/GAMMA block them)
            // → matchCount ≤ 5, ratio ≤ 62.5% < 75% → null
            expect(result).to.be.null;
        });

        it('greedy scan: multiple scattered diffs (production regression — triple repeat)', () => {
            // Mirrors the screenshot bug: "connection"→"contact" (synonym), "the" inserted,
            // "congregate"→"congregation" (word form) — 3 differences in 13 committed words.
            // Old substitution-budget approach: exhausted after 1st diff → 58% < 75% → null → repeat.
            // Greedy scan: skips "connection" and "congregate" (not found in window), matches
            // "between" and "and" through the window → 11/13 = 84.6% → tail extracted correctly.
            const committed = 'we can look at point of connection between congregate and edify their role';
            const full      = 'we can look at point of contact between the congregation and edify their role plus more content';
            const result = extractByWordLCP(full, committed);
            expect(result).to.equal('plus more content');
        });
    });

    describe('Romanian diacritics (regression: unicode property escapes)', () => {
        it('matches words with ă correctly', () => {
            const result = extractByWordLCP(
                'Frații noștri buni să fie binecuvântați',
                'Frații noștri buni'
            );
            expect(result).to.equal('să fie binecuvântați');
        });

        it('matches words with â, î, ș, ț without stripping them', () => {
            // If unicode property escapes are broken, diacritics get stripped
            // and "Frații" → "" (empty), breaking matching
            const result = extractByWordLCP(
                'Frații buni din congregație sunt acolo',
                'Frații buni din'
            );
            expect(result).to.equal('congregație sunt acolo');
        });

        it('strips punctuation but keeps diacritics for comparison', () => {
            // "Frații," (with comma) should still match "Frații" in committed
            const result = extractByWordLCP(
                'Frații, noștri sunt buni',
                'Frații noștri'
            );
            expect(result).to.equal('sunt buni');
        });
    });

    describe('case-insensitive comparison', () => {
        it('matches committed lowercase against full mixed-case', () => {
            const result = extractByWordLCP('Hello World Today', 'hello world');
            expect(result).to.equal('Today');
        });

        it('matches committed mixed-case against full lowercase', () => {
            const result = extractByWordLCP('hello world today', 'Hello World');
            expect(result).to.equal('today');
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyTermMappings
// ─────────────────────────────────────────────────────────────────────────────
describe('applyTermMappings', () => {

    describe('static mappings (no source needed)', () => {
        it('vestitori → publishers', () => {
            expect(applyTermMappings('The vestitori of Jehovah work hard')).to.equal(
                "The publishers of Jehovah work hard"
            );
        });

        it('Martorii lui Iehova → Jehovah\'s Witnesses', () => {
            expect(applyTermMappings('Martorii lui Iehova are present')).to.equal(
                "Jehovah's Witnesses are present"
            );
        });

        it('congress → convention (singular)', () => {
            expect(applyTermMappings('The annual congress was held')).to.equal(
                'The annual convention was held'
            );
        });

        it('congresses → conventions (plural)', () => {
            expect(applyTermMappings('Three congresses happened this year')).to.equal(
                'Three conventions happened this year'
            );
        });

        it('Bible reference: "Proverbs of 7,3" → "Proverbs 7:3"', () => {
            expect(applyTermMappings('As written in Proverbs of 7,3 we learn')).to.equal(
                'As written in Proverbs 7:3 we learn'
            );
        });

        it('Bible reference: "Matthew of 5.3" → "Matthew 5:3"', () => {
            expect(applyTermMappings('Read Matthew of 5.3 today')).to.equal(
                'Read Matthew 5:3 today'
            );
        });

        it('say me → tell me (grammar fix)', () => {
            expect(applyTermMappings('He wants to say me the truth')).to.equal(
                'He wants to tell me the truth'
            );
        });

        it('says us → tells us (grammar fix)', () => {
            expect(applyTermMappings('The elder says us to study more')).to.equal(
                'The elder tells us to study more'
            );
        });

        it('duplicate 2-word phrase collapsed', () => {
            expect(applyTermMappings("you can't you can't do that")).to.equal(
                "you can't do that"
            );
        });

        it('duplicate 3-word phrase collapsed', () => {
            expect(applyTermMappings('we need to we need to pray')).to.equal(
                'we need to pray'
            );
        });

        it('will Decision → will decide', () => {
            expect(applyTermMappings('We will Decision together')).to.equal(
                'We will decide together'
            );
        });

        it('can Decision → can decide', () => {
            expect(applyTermMappings('You can Decision now')).to.equal(
                'You can decide now'
            );
        });
    });

    describe('source-aware: congregație (with and without diacritics)', () => {
        it('church → congregation when source contains "congregație"', () => {
            expect(applyTermMappings('The church met on Sunday', 'în congregație'))
                .to.equal('The congregation met on Sunday');
        });

        it('church → congregation when source has "congregatie" (no diacritics, Deepgram drop)', () => {
            // Regression: Deepgram sometimes transcribes "congregație" as "congregatie"
            expect(applyTermMappings('Visit our church today', 'la congregatie'))
                .to.equal('Visit our congregation today');
        });

        it('churches → congregations (plural)', () => {
            expect(applyTermMappings('The churches are active', 'în congregație'))
                .to.equal('The congregations are active');
        });

        it('does NOT replace church when source has no congregație', () => {
            expect(applyTermMappings('We visited the church', 'ne-am bucurat mult'))
                .to.equal('We visited the church');
        });
    });

    describe('source-aware: congres beast garble', () => {
        it('beast → convention when source has "congres"', () => {
            expect(applyTermMappings('The beast was large', 'la congres special'))
                .to.equal('The convention was large');
        });

        it('beasts → conventions (plural)', () => {
            expect(applyTermMappings('Two beasts were there', 'la congrese speciale'))
                .to.equal('Two conventions were there');
        });
    });

    describe('source-aware: bunătate → kindness', () => {
        it('money → kindness when source has "bunătate"', () => {
            expect(applyTermMappings('Show money to others', 'bunătate față de toți'))
                .to.equal('Show kindness to others');
        });

        it('money → kindness when source has "bunatate" (diacritic dropped by STT)', () => {
            expect(applyTermMappings('We need money', 'bunatate si iubire'))
                .to.equal('We need kindness');
        });
    });

    describe('source-aware: cu siguranță → certainly', () => {
        it('safety → certainly when source has "cu siguranță"', () => {
            expect(applyTermMappings('This is for our safety', 'cu siguranță vom fi'))
                .to.equal('This is for our certainly');
        });

        it('Safety (capitalized) → Certainly when source has "cu siguranta" (no diacritics)', () => {
            expect(applyTermMappings('Safety is paramount', 'cu siguranta'))
                .to.equal('Certainly is paramount');
        });
    });

    describe('source-aware: conștiință → clean conscience', () => {
        it('cleanse conscience → clean conscience when source has "conștiință"', () => {
            expect(applyTermMappings('We must cleanse conscience always', 'conștiință curată'))
                .to.equal('We must clean conscience always');
        });

        it('works with diacritic-stripped "constiinta" in source', () => {
            expect(applyTermMappings('to cleanse conscience', 'constiinta curata'))
                .to.equal('to clean conscience');
        });
    });

    describe('source-aware: adunare → congregation', () => {
        it('gathering → congregation when source has "adunare"', () => {
            expect(applyTermMappings('The gathering will meet', 'adunare de circuit'))
                .to.equal('The congregation will meet');
        });

        it('gatherings → congregations (plural)', () => {
            expect(applyTermMappings('All gatherings are invited', 'adunare de circuit'))
                .to.equal('All congregations are invited');
        });
    });

    describe('STT mishearing: construction type → circuit assembly', () => {
        it('construction type convention → circuit assembly', () => {
            expect(applyTermMappings("it wasn't until the construction type convention and"))
                .to.equal("it wasn't until the circuit assembly and");
        });

        it('construction type assembly → circuit assembly', () => {
            expect(applyTermMappings('attended the construction type assembly last week'))
                .to.equal('attended the circuit assembly last week');
        });

        it('Construction Type Convention (capitalized) → circuit assembly', () => {
            expect(applyTermMappings('The Construction Type Convention was in Cluj'))
                .to.equal('The circuit assembly was in Cluj');
        });

        it('construction type congress (defensive fallback) → circuit assembly', () => {
            expect(applyTermMappings('the construction type congress next month'))
                .to.equal('the circuit assembly next month');
        });

        it('does not touch unrelated "construction" text', () => {
            expect(applyTermMappings('the construction of the Kingdom Hall'))
                .to.equal('the construction of the Kingdom Hall');
        });
    });

    describe('source-aware: romani → Romani', () => {
        it('Romans → Romani when source has "romani" (people/language)', () => {
            expect(applyTermMappings('The Romans are here', 'frații romani din'))
                .to.equal('The Romani are here');
        });

        it('does NOT replace Romans when source has "cartea Romani" (biblical book)', () => {
            expect(applyTermMappings('As Paul wrote in Romans 5:8', 'cartea Romani'))
                .to.equal('As Paul wrote in Romans 5:8');
        });
    });

    describe('source-aware: Hopa → Jehovah (STT prayer mishear)', () => {
        it('Hopa → Jehovah when source has capitalised "Hopa" (prayer mishear)', () => {
            expect(applyTermMappings('Hopa, be with us', 'Hopa să fi alături de noi'))
                .to.equal('Jehovah, be with us');
        });

        it('does NOT replace lowercase hopa (Romanian exclamation "whoops") — gate is intentionally case-sensitive', () => {
            expect(applyTermMappings('hopa, am căzut', 'hopa, am căzut'))
                .to.equal('hopa, am căzut');
        });
    });

    describe('source-aware: blestemator → blasphemer (1 Tim 1:13)', () => {
        it('curser → blasphemer when source has "blestemator"', () => {
            expect(applyTermMappings('he was a curser and persecutor', 'a fost blestemator persecutor'))
                .to.equal('he was a blasphemer and persecutor');
        });

        it('cursers → blasphemers (plural)', () => {
            expect(applyTermMappings('they were cursers', 'erau blestematori'))
                .to.equal('they were blasphemers');
        });

        it('does NOT replace curser when source has no blestemator', () => {
            expect(applyTermMappings('he was a curser', 'a fost un om rău'))
                .to.equal('he was a curser');
        });
    });

    describe('source-aware: versuri → verses (not lyrics)', () => {
        it('lyrics → verses when source has "versuri"', () => {
            expect(applyTermMappings('organization of lyrics', 'organizarea versurilor'))
                .to.equal('organization of verses');
        });

        it('lyrics → verses when source has "versurilor" (genitive form)', () => {
            expect(applyTermMappings('arrangement of lyrics', 'aranjamentul versurilor'))
                .to.equal('arrangement of verses');
        });

        it('does NOT replace lyrics when source has no versur', () => {
            expect(applyTermMappings('beautiful song lyrics', 'melodie frumoasă'))
                .to.equal('beautiful song lyrics');
        });
    });

    describe('source-aware: sigur → certainly (STT capitalisation fix)', () => {
        it("Sigur's → certainly when source has lowercase sigur", () => {
            expect(applyTermMappings("discuss Sigur's side", 'pe marginea lui sigur'))
                .to.equal('discuss certainly side');
        });

        it('Sigur → certainly when source has lowercase sigur', () => {
            expect(applyTermMappings('as Sigur said', 'cum sigur a spus'))
                .to.equal('as certainly said');
        });

        it('does NOT replace when source has only uppercase Sigur (proper name)', () => {
            expect(applyTermMappings('Sigur spoke today', 'Sigur a vorbit'))
                .to.equal('Sigur spoke today');
        });

        it("does NOT corrupt Sigur's to certainly's (possessive replaced before bare form)", () => {
            const result = applyTermMappings("I read Sigur's notes", 'am citit notele lui sigur');
            expect(result).to.not.include("certainly's");
            expect(result).to.equal("I read certainly notes");
        });
    });

    describe('source-aware: Popa → Jehovah (STT prayer mishear)', () => {
        it('Popa → Jehovah when source has capitalised "Popa"', () => {
            expect(applyTermMappings('his mouth will live on Popa', 'gurița sa va trăi de Popa'))
                .to.equal('his mouth will live on Jehovah');
        });

        it('does NOT replace when source has only lowercase popa (Romanian for priest)', () => {
            expect(applyTermMappings('the priest said', 'popa a spus'))
                .to.equal('the priest said');
        });
    });

    describe('source-aware: franci → brothers (STT mishear of frați)', () => {
        it('"the francs" → "the brothers" when source has "francii"', () => {
            expect(applyTermMappings('I felt with the francs around the world', 'am simțit cu francii în întreaga lume'))
                .to.equal('I felt with the brothers around the world');
        });

        it('"francs" → "brothers" when source has "franci"', () => {
            expect(applyTermMappings('over 450 francs were detained', 'peste 450 de franci au fost reținuți'))
                .to.equal('over 450 brothers were detained');
        });

        it('does NOT replace when source has no franci trigger', () => {
            expect(applyTermMappings('the exchange rate for francs', 'cursul de schimb'))
                .to.equal('the exchange rate for francs');
        });

        it('does NOT fire when source has "Francisc" (proper name — not frați mishear)', () => {
            expect(applyTermMappings('the francs changed hands', 'Francisc a schimbat'))
                .to.equal('the francs changed hands');
        });
    });

    describe('grammar fix: be friendship / consider friendship', () => {
        it('"be friendship with" → "be friends with"', () => {
            expect(applyTermMappings('be friendship with Jehovah', 'fi prieteni cu Iehova'))
                .to.equal('be friends with Jehovah');
        });

        it('"our friendship with" passes through unchanged (valid English, no gate trigger)', () => {
            expect(applyTermMappings('our friendship with Jehovah grows', 'prietenia noastră cu Iehova'))
                .to.equal('our friendship with Jehovah grows');
        });

        it('"consider friendship" → "consider friends" when source has considerăm', () => {
            expect(applyTermMappings('people who we consider friendship', 'persoane pe care le considerăm prieteni'))
                .to.equal('people who we consider friends');
        });

        it('"consider friendship" NOT replaced when no consideră trigger in source', () => {
            expect(applyTermMappings('we must consider friendship as a priority', 'trebuie să avem prietenie'))
                .to.equal('we must consider friendship as a priority');
        });
    });

    describe('source-aware: Boga → Jehovah (STT mishear of Iehova)', () => {
        it('Boga → Jehovah when source has capitalised "Boga"', () => {
            expect(applyTermMappings('the fact that Boga knows', 'faptul că îl cunoaște pe Boga'))
                .to.equal('the fact that Jehovah knows');
        });

        it('does NOT fire when source has only lowercase boga', () => {
            expect(applyTermMappings('Boga spoke', 'boga a vorbit'))
                .to.equal('Boga spoke');
        });
    });

    describe('source-aware: pulberabilă → vulnerable (STT mishear of vulnerabilă)', () => {
        it('"pulverizable" → "vulnerable" when source has "pulberabilă"', () => {
            expect(applyTermMappings('a pulverizable religious minority', 'o minoritate religioasă pulberabilă'))
                .to.equal('a vulnerable religious minority');
        });

        it('"pulverizable" passes through unchanged without pulberabil trigger', () => {
            expect(applyTermMappings('a pulverizable material', 'un material rezistent'))
                .to.equal('a pulverizable material');
        });
    });

    describe('source-aware: iertova → Jehovah (STT mishear of Iehova)', () => {
        it('"Forgiveness" → "Jehovah" when source has "iertova"', () => {
            expect(applyTermMappings('Forgiveness, you alone are the Most High', 'iertova numai tu ești cel preaînalt'))
                .to.equal('Jehovah, you alone are the Most High');
        });

        it('"forgiveness" (lowercase) → "Jehovah" when source has "iertova"', () => {
            expect(applyTermMappings('whose name is forgiveness', 'al cărui Nume este iertova'))
                .to.equal('whose name is Jehovah');
        });

        it('does NOT replace when source has no iertova trigger', () => {
            expect(applyTermMappings('he showed forgiveness', 'el a arătat iertare'))
                .to.equal('he showed forgiveness');
        });
    });

    describe('source-aware: prieteni → friends (not friendship)', () => {
        it('"three friendship" → "three friends" when source has "prieteni"', () => {
            expect(applyTermMappings('three friendship came to him', 'Trei prieteni au venit la el'))
                .to.equal('three friends came to him');
        });

        it('"friendship" → "friends" when source has "prieteni"', () => {
            expect(applyTermMappings('his friendship helped him', 'prietenii lui l-au ajutat'))
                .to.equal('his friends helped him');
        });

        it('does NOT replace when source has no prieteni trigger', () => {
            expect(applyTermMappings('our friendship with Jehovah grows', 'prietenia noastră cu Iehova crește'))
                .to.equal('our friendship with Jehovah grows');
        });
    });

    describe('source-aware: dioxive → difficult (STT garble)', () => {
        it('"dioxyves" → "difficult" when source has "dioxive"', () => {
            expect(applyTermMappings('trials are dioxyves', 'încercări sunt dioxive'))
                .to.equal('trials are difficult');
        });

        it('does NOT replace when source has no dioxive trigger', () => {
            expect(applyTermMappings('trials are dioxyves', 'încercări sunt grele'))
                .to.equal('trials are dioxyves');
        });
    });

    describe('source-aware: Ramură → Branch Committee (STT mishear)', () => {
        it('"Psychiatric committee" → "Branch committee" when source has "Ramură"', () => {
            expect(applyTermMappings(
                'John Preda for the Psychiatric committee',
                'John Preda pentru Comitetul de Ramură'
            )).to.equal('John Preda for the Branch committee');
        });

        it('"psychiatry" → "Branch" when source has "ramură" (lowercase)', () => {
            expect(applyTermMappings(
                'the psychiatry committee',
                'comitetul de ramură'
            )).to.equal('the Branch committee');
        });

        it('does NOT replace when source has no ramur trigger', () => {
            expect(applyTermMappings(
                'the psychiatric ward',
                'secția de psihiatrie'
            )).to.equal('the psychiatric ward');
        });
    });

    describe('source-aware: prevăzător → discreet (Matthew 24:45)', () => {
        it('"cautious slave" → "discreet slave" when source has "prevăzător"', () => {
            expect(applyTermMappings(
                'the faithfully and cautious slave',
                'sclavul fidel și prevăzător'
            )).to.equal('the faithful and discreet slave');
        });

        it('"cautiously" → "discreet" when source has "prevăzător"', () => {
            expect(applyTermMappings(
                'cautiously provide food',
                'prevăzător să ofere hrană'
            )).to.equal('discreet provide food');
        });

        it('does NOT replace when source has no prevăzător trigger', () => {
            expect(applyTermMappings(
                'be cautious in all things',
                'fii atent în toate lucrurile'
            )).to.equal('be cautious in all things');
        });

        it('"faithfully slave" → "faithful slave" when source has "fidel" and output has "slave"', () => {
            expect(applyTermMappings(
                'the faithfully slave',
                'sclavul fidel'
            )).to.equal('the faithful slave');
        });

        it('does NOT change "faithfully" when output has no "slave"', () => {
            expect(applyTermMappings(
                'serve faithfully',
                'slujește fidel'
            )).to.equal('serve faithfully');
        });

        it('only converts the adjectival "faithfully" governing "slave", not an adverb elsewhere', () => {
            // Regression: an unrelated adverbial "faithfully" earlier in a longer
            // utterance must survive even when "slave" appears later.
            expect(applyTermMappings(
                'serving faithfully, we imitate the faithfully and discreet slave',
                'sclavul fidel'
            )).to.equal('serving faithfully, we imitate the faithful and discreet slave');
        });
    });

    describe('source-aware: rugăm → pray (not Please)', () => {
        it('"Please for" → "pray for" when source has "rugăm"', () => {
            expect(applyTermMappings('we continue to Please for you', 'continuăm să ne rugăm pentru voi'))
                .to.equal('we continue to pray for you');
        });
        it('"to Please" → "to pray" when source has "rugăm"', () => {
            expect(applyTermMappings('and Please for his help', 'și să ne rugăm să ne ajute'))
                .to.equal('and pray for his help');
        });
        it('does NOT replace when source has no rugăm trigger', () => {
            expect(applyTermMappings('Please be seated', 'vă rugați să vă așezați'))
                .to.equal('Please be seated');
        });
    });

    describe('source-aware: bucur → glad/happy (not joy)', () => {
        it('"I\'m joy" → "I\'m glad" when source has "bucură"', () => {
            expect(applyTermMappings("I'm joy too", 'Mă bucură și pe mine'))
                .to.equal("I'm glad too");
        });
        it('"makes me joy" → "makes me happy" when source has "bucur"', () => {
            expect(applyTermMappings('that makes me joy', 'asta mă bucură'))
                .to.equal('that makes me happy');
        });
        it('does NOT replace when source has no bucur trigger', () => {
            expect(applyTermMappings("I'm joy", 'sunt fericit'))
                .to.equal("I'm joy");
        });
    });

    describe('source-aware: suplinitori → servants (not substitutes)', () => {
        it('"substitutes of Jehovah" → "servants of Jehovah" when source has "suplinitori"', () => {
            expect(applyTermMappings('2 million substitutes of Jehovah', '2 milioane de suplinitori ai lui Iehova'))
                .to.equal('2 million servants of Jehovah');
        });
        it('does NOT replace when source has no suplinitori trigger', () => {
            expect(applyTermMappings('his substitutes arrived', 'înlocuitorii lui au sosit'))
                .to.equal('his substitutes arrived');
        });
    });

    describe('source-aware: teocratică → theocratic (not democratic)', () => {
        it('"democratic history" → "theocratic history" when source has "teocratică"', () => {
            expect(applyTermMappings('our democratic history', 'istoria noastră de ocratică'))
                .to.equal('our theocratic history');
        });
        it('does NOT replace when source has no teocratic trigger', () => {
            expect(applyTermMappings('our democratic system', 'sistemul nostru democratic'))
                .to.equal('our democratic system');
        });
    });

    describe('source-aware: integri → integrity (not intact)', () => {
        it('"stay intact" → "maintain their integrity" when source has "integri"', () => {
            expect(applyTermMappings('wanted to stay intact', 'au dorit să rămână integri'))
                .to.equal('wanted to maintain their integrity');
        });
        it('"remain intact" → "remain faithful" when source has "integri"', () => {
            expect(applyTermMappings('chose to remain intact', 'au ales să rămână integri'))
                .to.equal('chose to remain faithful');
        });
        it('does NOT replace when source has no integr trigger', () => {
            expect(applyTermMappings('the seal remains intact', 'sigiliul rămâne intact'))
                .to.equal('the seal remains intact');
        });
    });

    describe('source-aware: evanghelizatori → Kingdom Evangelizers\' School', () => {
        it('replaces full school phrase when source has "evanghelizatori"', () => {
            expect(applyTermMappings(
                'the school for evangelizers of the kingdom',
                'școala pentru evanghelizatori ai regatului'
            )).to.equal("Kingdom Evangelizers' School");
        });
        it('does NOT replace when source has no evanghelizatori trigger', () => {
            expect(applyTermMappings(
                'the school for evangelizers of the kingdom',
                'școala misionarilor'
            )).to.equal('the school for evangelizers of the kingdom');
        });
    });

    describe('no source changes when no triggers present', () => {
        it('leaves clean English output unchanged', () => {
            const clean = 'Jehovah blesses those who seek righteousness.';
            expect(applyTermMappings(clean)).to.equal(clean);
        });
    });

    describe('source-aware: evoMAG → Jehovah', () => {
        it('replaces evoMAG with Jehovah when source has "evoMAG"', () => {
            expect(applyTermMappings(
                'people who love evoMAG',
                'oameni care îl iubesc pe evoMAG'
            )).to.equal('people who love Jehovah');
        });
        it('does NOT replace evoMAG when source has no evoMAG trigger', () => {
            expect(applyTermMappings(
                'people who love evoMAG',
                'oameni care îl iubesc pe Iehova'
            )).to.equal('people who love evoMAG');
        });
        it('does NOT replace when source has lowercase evomag (case-sensitive gate)', () => {
            expect(applyTermMappings(
                'love evomag',
                'evomag electronics'
            )).to.equal('love evomag');
        });
    });

    describe('source-aware: omul de ordine → attendant', () => {
        it('replaces "law enforcement officer" when source has "omul de ordine"', () => {
            expect(applyTermMappings(
                'the law enforcement officer directs those present',
                'omul de ordine îi îndrumă pe cei prezenți'
            )).to.equal('the attendant directs those present');
        });
        it('replaces "law enforcement officers" (plural) when source has "oamenii de ordine"', () => {
            expect(applyTermMappings(
                'law enforcement officers coordinate the evacuation',
                'oamenii de ordine coordonează evacuarea'
            )).to.equal('attendants coordinate the evacuation');
        });
        it('replaces "law enforcement people" when source has "oamenii de ordine"', () => {
            expect(applyTermMappings(
                'law enforcement people coordinate the evacuation',
                'oamenii de ordine coordonează evacuarea'
            )).to.equal('attendants coordinate the evacuation');
        });
        it('replaces bare "law enforcement" when source has "omul de ordine"', () => {
            expect(applyTermMappings(
                'law enforcement is responsible',
                'omul de ordine este responsabil'
            )).to.equal('attendant is responsible');
        });
        it('gate covers oblique form "oamenilor de ordine"', () => {
            expect(applyTermMappings(
                'the law enforcement officer',
                'instrucțiunile oamenilor de ordine'
            )).to.equal('the attendant');
        });
        it('does NOT replace when source has no ordine trigger', () => {
            expect(applyTermMappings(
                'the law enforcement officer arrived',
                'polițistul a sosit'
            )).to.equal('the law enforcement officer arrived');
        });
    });

    describe('source-aware: primul ajutor → first aid', () => {
        it('replaces "first help" with "first aid" when source has "primului ajutor" (genitive)', () => {
            expect(applyTermMappings(
                'providing first help to those who need it',
                'acordarea primului ajutor celor care au nevoie'
            )).to.equal('providing first aid to those who need it');
        });
        it('replaces "first help" when source has "primul ajutor" (nominative)', () => {
            expect(applyTermMappings(
                'give first help immediately',
                'dați primul ajutor imediat'
            )).to.equal('give first aid immediately');
        });
        it('replaces "first help" when source has "prim ajutor" (indefinite form)', () => {
            expect(applyTermMappings(
                'courses of first help',
                'cursuri de prim ajutor'
            )).to.equal('courses of first aid');
        });
        it('does NOT replace when source has no ajutor trigger', () => {
            expect(applyTermMappings(
                'first help was appreciated',
                'primul sprijin a fost apreciat'
            )).to.equal('first help was appreciated');
        });
    });

    describe('source-aware: apărarea împotriva incendiilor → fire protection', () => {
        it('replaces "against protection" when source has fire protection phrase', () => {
            expect(applyTermMappings(
                'the against protection regulation',
                'regulamentul privind apărarea împotriva incendiilor'
            )).to.equal('the fire protection regulation');
        });
        it('does NOT replace when source has no fire protection phrase', () => {
            expect(applyTermMappings(
                'the against protection clause',
                'clauza de protecție'
            )).to.equal('the against protection clause');
        });
    });

    describe('source-aware: starea morală → condition of the dead', () => {
        it('replaces "Moral State" when source has "starea morală" (STT garble)', () => {
            expect(applyTermMappings(
                'the truth about the Moral State',
                'adevărul cu privire la Starea morală'
            )).to.equal('the truth about the condition of the dead');
        });
        it('does NOT replace lowercase "moral state" (legitimate output when speaker discusses morality)', () => {
            expect(applyTermMappings(
                'the moral state of the world is declining',
                'starea morală a lumii este în declin'
            )).to.equal('the moral state of the world is declining');
        });
        it('does NOT replace when source has no starea morală trigger', () => {
            expect(applyTermMappings(
                'the moral state of the nation',
                'starea economică a națiunii'
            )).to.equal('the moral state of the nation');
        });
    });

    describe('source-aware: cașul de Cult → Kingdom Hall', () => {
        it('replaces "Worship hut" when source has garbled casa de cult form', () => {
            expect(applyTermMappings(
                'evacuate to the Worship hut',
                'să evacueze la cașul de Cult'
            )).to.equal('evacuate to the Kingdom Hall');
        });
        it('also fires on ungarbled "casa de cult"', () => {
            expect(applyTermMappings(
                'we meet at the Worship hut',
                'ne întâlnim la casa de cult'
            )).to.equal('we meet at the Kingdom Hall');
        });
        it('does NOT replace when source has no cult trigger', () => {
            expect(applyTermMappings(
                'evacuate to the Worship hut',
                'evacuați clădirea'
            )).to.equal('evacuate to the Worship hut');
        });
    });

    describe('source-aware: pe Lot → Lot (not "by lot")', () => {
        it('replaces "by lot" with "Lot" when source has pe Noe + pe Lot (biblical pair)', () => {
            expect(applyTermMappings(
                'did not save Noah by lot the people chosen from Egypt',
                'nu l-a salvat pe Noe pe Lot poporul ales din Egipt'
            )).to.equal('did not save Noah Lot the people chosen from Egypt');
        });
        it('also fires when STT lowercases "lot" (pe Noe + pe lot)', () => {
            expect(applyTermMappings(
                'did not save Noah by lot',
                'nu l-a salvat pe Noe pe lot'
            )).to.equal('did not save Noah Lot');
        });
        it('does NOT replace when source has "lot" without "pe" marker (drawing-of-lots context)', () => {
            expect(applyTermMappings(
                'chosen by lot',
                'ales prin tragere la sorți lot Noe'
            )).to.equal('chosen by lot');
        });
        it('does NOT replace when source has lot without Noe', () => {
            expect(applyTermMappings(
                'chosen by lot',
                'ales prin tragere la sorți'
            )).to.equal('chosen by lot');
        });
    });

    describe('source-aware: Turnul de Vegan → Watchtower', () => {
        it('replaces "tower de Vegan" when source has "Turnul de Vegan"', () => {
            expect(applyTermMappings(
                'the study of the magazine The tower de Vegan',
                'studiul revistei Turnul de Vegan'
            )).to.equal('the study of the magazine The Watchtower');
        });
        it('does NOT replace when source has no Vegan trigger', () => {
            expect(applyTermMappings(
                'the tower de Vegan',
                'studiul revistei Turnul de Veghe'
            )).to.equal('the tower de Vegan');
        });
    });

    describe('source-aware: conferința publică → public talk', () => {
        it('replaces "public conference" when source has "conferința publică"', () => {
            expect(applyTermMappings(
                "today's public conference will begin",
                'conferința publică de astăzi va începe'
            )).to.equal("today's public talk will begin");
        });
        it('does NOT replace when source has no conferinta trigger', () => {
            expect(applyTermMappings(
                'the public conference is held annually',
                'conferința anuală are loc'
            )).to.equal('the public conference is held annually');
        });
    });

    describe('source-aware: rugăm → We pray (extension)', () => {
        it('replaces "We Please" when source has "rugăm"', () => {
            expect(applyTermMappings(
                'We Please to Jehovah in these moments',
                'te rugăm Iehova și în aceste clipe'
            )).to.equal('We pray to Jehovah in these moments');
        });
        it('does NOT replace when source has no rugăm trigger', () => {
            expect(applyTermMappings(
                'We Please to help',
                'dorim să ajutăm'
            )).to.equal('We Please to help');
        });
    });

    describe('grammar fix: "your the X" → "your X" (possessive double article)', () => {
        it('removes spurious "the" after possessive "your"', () => {
            expect(applyTermMappings('your the help', '')).to.equal('your help');
        });
        it('fixes "your the word"', () => {
            expect(applyTermMappings('your the word the Bible', '')).to.equal('your word the Bible');
        });
        it('handles mixed-case "the" (e.g. "your The")', () => {
            expect(applyTermMappings('guide by your The spirit', '')).to.equal('guide by your spirit');
        });
    });

    describe('grammar fix: "holy the spirit" → "Holy Spirit"', () => {
        it('corrects the split possessive+article form', () => {
            expect(applyTermMappings('guide us by your holy the spirit', '')).to.equal('guide us by your Holy Spirit');
        });
        it('does not affect unrelated uses', () => {
            expect(applyTermMappings('the holy city', '')).to.equal('the holy city');
        });
    });

    describe('grammar fix: "exist are" → "there are"', () => {
        it('fixes ungrammatical "exist are"', () => {
            expect(applyTermMappings('exist are many distractions', '')).to.equal('there are many distractions');
        });
        it('is case-insensitive', () => {
            expect(applyTermMappings('Exist Are opportunities', '')).to.equal('there are opportunities');
        });
        it('does not affect "there are"', () => {
            expect(applyTermMappings('there are many things', '')).to.equal('there are many things');
        });
    });

    describe('grammar fix: "pleasant Jehovah" → "pleasing to Jehovah"', () => {
        it('fixes adjective used where verb needed', () => {
            expect(applyTermMappings('this is pleasant Jehovah', '')).to.equal('this is pleasing to Jehovah');
        });
        it('does not affect "pleasing to Jehovah"', () => {
            expect(applyTermMappings('pleasing to Jehovah', '')).to.equal('pleasing to Jehovah');
        });
    });

    describe('source-gated fix: "social networks" → "social media" when source has socializare', () => {
        it('replaces when source contains socializare', () => {
            expect(applyTermMappings('use social networks wisely', 'rețelele de socializare')).to.equal('use social media wisely');
        });
        it('leaves unchanged when source lacks socializare', () => {
            expect(applyTermMappings('social networks exist', 'rețele de comunicare')).to.equal('social networks exist');
        });
    });

    describe('source-gated fix: "common sense" → "good judgment" when source has judecată sănătoasă', () => {
        it('replaces when source contains judecată sănătoasă', () => {
            expect(applyTermMappings('use common sense', 'judecată sănătoasă')).to.equal('use good judgment');
        });
        it('leaves unchanged when source lacks judecată sănătoasă', () => {
            expect(applyTermMappings('common sense matters', 'înțelepciune practică')).to.equal('common sense matters');
        });
        it('leaves unchanged when source has judecată alone (two-word gate required)', () => {
            expect(applyTermMappings('common sense matters', 'judecată dreaptă')).to.equal('common sense matters');
        });
    });

    describe('grammar fix: "continue pressure" → "continuous pressure"', () => {
        it('fixes Romanian adjective form mistaken for verb', () => {
            expect(applyTermMappings('we face continue pressure from the world', '')).to.equal('we face continuous pressure from the world');
        });
        it('does not affect "continuous pressure"', () => {
            expect(applyTermMappings('continuous pressure is difficult', '')).to.equal('continuous pressure is difficult');
        });
    });

    describe('"materials resources" → "material resources"', () => {
        it('fixes noun-as-adjective error', () => {
            expect(applyTermMappings('protect your materials resources', '')).to.equal('protect your material resources');
        });
        it('is case-insensitive', () => {
            expect(applyTermMappings('Materials Resources are limited', '')).to.equal('material resources are limited');
        });
        it('does not affect already-correct form', () => {
            expect(applyTermMappings('material resources', '')).to.equal('material resources');
        });
    });

    describe('"the Bible say" → "the Bible says"', () => {
        it('adds missing third-person s', () => {
            expect(applyTermMappings('the Bible say we should pray', '')).to.equal('the Bible says we should pray');
        });
        it('handles sentence-initial capital "The Bible say"', () => {
            expect(applyTermMappings('The Bible say to love others', '')).to.equal('The Bible says to love others');
        });
        it('does not affect already-correct "the Bible says"', () => {
            expect(applyTermMappings('the Bible says to love others', '')).to.equal('the Bible says to love others');
        });
    });

    describe('source-gated: "tips" → "advice" when source has sfaturi', () => {
        it('replaces tips with advice when source has sfaturi', () => {
            expect(applyTermMappings('good tips for daily life', 'sfaturi bune')).to.equal('good advice for daily life');
        });
        it('leaves tips unchanged when source lacks sfaturi', () => {
            expect(applyTermMappings('practical tips for cooking', 'rețete practice')).to.equal('practical tips for cooking');
        });
    });

    describe('"find out many"/"learn many" → "find out more"', () => {
        it('fixes "find out many"', () => {
            expect(applyTermMappings('find out many at jw.org', '')).to.equal('find out more at jw.org');
        });
        it('fixes "learn many"', () => {
            expect(applyTermMappings('learn many at jw.org', '')).to.equal('find out more at jw.org');
        });
        it('does not affect "find out more"', () => {
            expect(applyTermMappings('find out more details', '')).to.equal('find out more details');
        });
    });

    describe('"physician resources" → "medical resources"', () => {
        it('corrects mistranslation of resursele medicale', () => {
            expect(applyTermMappings('limit access to physician resources', '')).to.equal('limit access to medical resources');
        });
        it('does not affect "medical resources"', () => {
            expect(applyTermMappings('medical resources are scarce', '')).to.equal('medical resources are scarce');
        });
    });

    describe('"no longer deserve living" → "no longer worth living"', () => {
        it('fixes grammatically broken hopelessness phrase', () => {
            expect(applyTermMappings('life is no longer deserve living', '')).to.equal('life is no longer worth living');
        });
        it('does not affect already-correct form', () => {
            expect(applyTermMappings('no longer worth living', '')).to.equal('no longer worth living');
        });
    });

    describe('"Romani" (Bible book) → "Romans" when source has "romani \d"', () => {
        it('converts Romani to Romans when source shows Bible book pattern', () => {
            expect(applyTermMappings('Romani 5 through 12', 'romani 5 cu 12')).to.equal('Romans 5 through 12');
        });
        it('does not fire when source has ethnic group context (no digit after romani)', () => {
            expect(applyTermMappings('the Romani people', 'frații romani')).to.equal('the Romani people');
        });
        it('does not fire when source has no romani at all', () => {
            expect(applyTermMappings('Romani 5', 'alte cuvinte')).to.equal('Romani 5');
        });
    });

    // --- 2026-06-14 Sunday meeting rules ---

    describe('"who I love" → "who love" (cei care iubesc — source-gated)', () => {
        it('fixes relative clause when source confirms iubesc', () => {
            expect(applyTermMappings('those who I love the truth', 'cei care iubesc adevărul')).to.equal('those who love the truth');
        });
        it('fixes multiple occurrences', () => {
            expect(applyTermMappings('people who I love God and who I love truth', 'care iubesc')).to.equal('people who love God and who love truth');
        });
        it('does NOT fire without iubesc in source (false-positive guard)', () => {
            expect(applyTermMappings('the sister who I love', 'sora pe care o prețuiesc')).to.equal('the sister who I love');
        });
    });

    describe('"Jesus/he start" → "started" (uninflected verb)', () => {
        it('fixes Jesus start', () => {
            expect(applyTermMappings('Jesus start the work on earth', '')).to.equal('Jesus started the work on earth');
        });
        it('fixes he start', () => {
            expect(applyTermMappings('he start preaching in Galilee', '')).to.equal('he started preaching in Galilee');
        });
        it('fixes sentence-initial He start', () => {
            expect(applyTermMappings('He start the war in 1914', '')).to.equal('He started the war in 1914');
        });
        it('does not affect already-correct "started"', () => {
            expect(applyTermMappings('Jesus started the work', '')).to.equal('Jesus started the work');
        });
    });

    describe('"he creator" → "he created" (source-gated)', () => {
        it('fixes when source contains creat', () => {
            expect(applyTermMappings('everything he creator for us', 'tot ce a creat')).to.equal('everything he created for us');
        });
        it('does NOT fire without creat in source (false-positive guard)', () => {
            expect(applyTermMappings('he creator of all things', 'Iehova este puternic')).to.equal('he creator of all things');
        });
    });

    describe('"what/how certain" → "what/how exactly" (cum anume)', () => {
        it('fixes what certain', () => {
            expect(applyTermMappings('what certain Jehovah predicted', '')).to.equal('what exactly Jehovah predicted');
        });
        it('fixes how certain', () => {
            expect(applyTermMappings('how certain he helps us', '')).to.equal('exactly how he helps us');
        });
    });

    describe('"cousin of lies" → "veil of lies"', () => {
        it('fixes the cousin of lies', () => {
            expect(applyTermMappings('remove the cousin of lies that Satan spread', '')).to.equal('remove the veil of lies that Satan spread');
        });
    });

    describe('"Christian combination" → "Christian congregation"', () => {
        it('fixes Christian combination', () => {
            expect(applyTermMappings('angels help the Christian combination', '')).to.equal('angels help the Christian congregation');
        });
        it('fixes with article', () => {
            expect(applyTermMappings('the Christian combination is gathering', '')).to.equal('the Christian congregation is gathering');
        });
    });

    describe('"Safari\'s lies" → "Satan\'s lies"', () => {
        it('fixes Safari\'s lies', () => {
            expect(applyTermMappings("Safari's lies deceive many", '')).to.equal("Satan's lies deceive many");
        });
        it('fixes Safari\'s deceptions', () => {
            expect(applyTermMappings("Safari's deceptions", '')).to.equal("Satan's deceptions");
        });
    });

    describe('"conviction estimated by" → "conviction expressed by"', () => {
        it('fixes the apostle Paul citation', () => {
            expect(applyTermMappings('the conviction estimated by the apostle Paul', '')).to.equal('the conviction expressed by the apostle Paul');
        });
    });

    describe('Armageddon name fixes', () => {
        it('fixes "war appointed Armageddon"', () => {
            expect(applyTermMappings('the war appointed Armageddon will begin', '')).to.equal('the war called Armageddon will begin');
        });
        it('fixes "unending war of Armageddon"', () => {
            expect(applyTermMappings('the unending war of Armageddon', '')).to.equal('the war called Armageddon');
        });
    });

    describe('"graph N" → "paragraph N" (source-gated on paragraful)', () => {
        it('fixes graph N when source has paragraful', () => {
            expect(applyTermMappings('as we read in graph 7', 'paragraful 7')).to.equal('as we read in paragraph 7');
        });
        it('does NOT fire without paragraful in source', () => {
            expect(applyTermMappings('see graph 3 for data', 'vedeți graficul 3')).to.equal('see graph 3 for data');
        });
    });

    // --- 2026-07-19 Sunday meeting rules ---

    describe('"holy shit" → "Holy Spirit" (lui sfânt fragment garbled by MT)', () => {
        it('fixes "holy shit" to "Holy Spirit"', () => {
            expect(applyTermMappings('holy shit if I don\'t apply them', 'lui sfânt dacă nu le aplic')).to.equal('Holy Spirit if I don\'t apply them');
        });
        it('fixes lowercase "holy shit"', () => {
            expect(applyTermMappings('the holy shit will guide us', 'spiritul sfânt ne va ghida')).to.equal('the Holy Spirit will guide us');
        });
        it('does NOT corrupt "Holy Spirit" already correct', () => {
            expect(applyTermMappings('the Holy Spirit will help us', 'spiritul sfânt ne va ajuta')).to.equal('the Holy Spirit will help us');
        });
    });

    describe('"true sexy" / "search for sex" → meaning (sens misheard as sex, gated on source)', () => {
        it('fixes "true sexy" to "true meaning" when source has sens', () => {
            expect(applyTermMappings('will have true sexy and purpose', 'va avea cu adevărat sens')).to.equal('will have true meaning and purpose');
        });
        it('fixes "search for sex" to "search for meaning" when source has sens', () => {
            expect(applyTermMappings('people search for sex in life', 'oamenii caută sens în viață')).to.equal('people search for meaning in life');
        });
        it('fixes "looking for sex" to "looking for meaning" when source has sens', () => {
            expect(applyTermMappings('people are looking for sex', 'oamenii caută sens')).to.equal('people are looking for meaning');
        });
        it('does NOT corrupt "search for sex" when source contains sex (speaker discussing immorality)', () => {
            expect(applyTermMappings('young people search for sex outside marriage', 'tinerii caută sex în afara căsătoriei')).to.equal('young people search for sex outside marriage');
        });
    });

    describe('"exist is a/no" → "there is a/no" (există rendered literally, gated on source)', () => {
        it('fixes "exist is a creator" when source has există', () => {
            expect(applyTermMappings('exist is a creator who made everything', 'există un creator care a creat totul')).to.equal('there is a creator who made everything');
        });
        it('fixes "exist is an answer" (preserves "an") when source has există', () => {
            expect(applyTermMappings('exist is an answer to this question', 'există un răspuns la această întrebare')).to.equal('there is an answer to this question');
        });
        it('fixes "exist is no law" when source has există', () => {
            expect(applyTermMappings('exist is no law against love', 'există nicio lege împotriva iubirii')).to.equal('there is no law against love');
        });
        it('fixes "exist was no limit" when source has exista', () => {
            expect(applyTermMappings('exist was no limit to his power', 'nu exista nicio limită pentru puterea sa')).to.equal('there was no limit to his power');
        });
        it('does NOT alter "exist" in other contexts', () => {
            expect(applyTermMappings('these problems still exist today', 'aceste probleme există și astăzi')).to.equal('these problems still exist today');
        });
        it('does NOT alter "exist" mid-sentence when no există in source', () => {
            expect(applyTermMappings('these problems still exist today', 'aceste probleme persistă astăzi')).to.equal('these problems still exist today');
        });
    });

    describe('"must Please to Jehovah" → "must pray to Jehovah" (gated on rugăm source)', () => {
        it('fixes "must Please to Jehovah" when source has rugăm', () => {
            expect(applyTermMappings('we must Please to Jehovah each day', 'trebuie să ne rugăm lui Iehova zilnic')).to.equal('we must pray to Jehovah each day');
        });
        it('does NOT alter "please" in other contexts (no rugăm gate)', () => {
            expect(applyTermMappings('we aim to please God', 'vrem să-i plăcem lui Dumnezeu')).to.equal('we aim to please God');
        });
    });

    describe('"God creator man" → "God created man"', () => {
        it('fixes "God creator man"', () => {
            expect(applyTermMappings('a very simple explanation God creator man a', '')).to.equal('a very simple explanation God created man a');
        });
        it('does NOT alter "God created man" already correct', () => {
            expect(applyTermMappings('God created man in his image', '')).to.equal('God created man in his image');
        });
    });

    describe('"image of 69" → "image of God" (chipul lui Dumnezeu, Dumnezeu garbled to number)', () => {
        it('fixes "image of 69" when source has chipul', () => {
            expect(applyTermMappings('and was created in the image of 69', 'a fost creat după chipul lui Dumnezeu')).to.equal('and was created in the image of God');
        });
        it('fixes other garbled numbers (image of 3)', () => {
            expect(applyTermMappings('created in the image of 3', 'creat după chipul său')).to.equal('created in the image of God');
        });
        it('does NOT fire without chipul in source', () => {
            expect(applyTermMappings('she was one of the image of 7 women', 'ea era una din cele 7 femei')).to.equal('she was one of the image of 7 women');
        });
    });

    describe('"granddaughter" → "young man" when source has nepoate (masculine vocative)', () => {
        it('fixes "Jehovah granddaughter" to "Jehovah young man"', () => {
            expect(applyTermMappings('Jehovah granddaughter Therefore although smoking', 'Iehova nepoate Așadar deși fumatul')).to.equal('Jehovah young man Therefore although smoking');
        });
        it('does NOT fire without nepoate in source', () => {
            expect(applyTermMappings('he has a beautiful granddaughter', 'el are o nepoată frumoasă')).to.equal('he has a beautiful granddaughter');
        });
    });

    describe('"is hot" → "is being proclaimed" when source has vestește (se vestește garbled)', () => {
        it('fixes "is hot" when source has vesteste', () => {
            expect(applyTermMappings('something that you know is hot', 'ceva ce știți că se vestește')).to.equal('something that you know is being proclaimed');
        });
        it('does NOT fire without vesteste in source', () => {
            expect(applyTermMappings('the iron is hot right now', 'fierul este fierbinte acum')).to.equal('the iron is hot right now');
        });
    });

    // --- 2026-07-23 Thursday meeting rules ---

    describe('"54 horses" → "54 chapters" (capitolele misheard as cai)', () => {
        it('fixes "54 horses"', () => {
            expect(applyTermMappings('The 54 horses will show you how Jehovah helped', '')).to.equal('The 54 chapters will show you how Jehovah helped');
        });
    });

    describe('"stubbornness led to the exit" → "exile" (exil misheard as exit)', () => {
        it('fixes "stubbornness led to the exit"', () => {
            expect(applyTermMappings('their stubbornness led to the exit from the land', '')).to.equal('their stubbornness led to exile from the land');
        });
    });

    describe('"kindness and composer" → "compassion" (compasiune misheard as compozitor)', () => {
        it('fixes "kindness and composer"', () => {
            expect(applyTermMappings('show kindness and composer to others', '')).to.equal('show kindness and compassion to others');
        });
        it('does NOT alter "kindness and compassion" already correct', () => {
            expect(applyTermMappings('showing kindness and compassion', '')).to.equal('showing kindness and compassion');
        });
    });

    describe('"balls that inspire us" → "examples" (memorabile chunk-split artifact)', () => {
        it('fixes "balls that inspire us"', () => {
            expect(applyTermMappings('balls that inspire us and together', '')).to.equal('examples that inspire us and together');
        });
    });

    describe('"brave and insensitive" / "unfeeling faith" → steadfast/unwavering (gated on nesimtit)', () => {
        it('fixes "brave and insensitive" when source has nesimtit', () => {
            expect(applyTermMappings('remain brave and insensitive in the face of trials', 'rămân curajos și nesimțit')).to.equal('remain brave and steadfast in the face of trials');
        });
        it('fixes "unfeeling faith" when source has nesimtit', () => {
            expect(applyTermMappings('unfeeling faith I like this idea', 'credința nesimțită îmi place această idee')).to.equal('unwavering faith I like this idea');
        });
        it('does NOT fire without nesimtit in source (could describe a legitimate antagonist)', () => {
            expect(applyTermMappings('Pharaoh was brave and insensitive to suffering', 'Faraon era curajos și indiferent la suferință')).to.equal('Pharaoh was brave and insensitive to suffering');
        });
    });

    describe('"sell the world" → "overcome the world" (biruit misheard as vinzi, John 16:33)', () => {
        it('fixes "sell the world"', () => {
            expect(applyTermMappings('courage, he can sell the world', '')).to.equal('courage, he can overcome the world');
        });
        it('"overcome" is tense-neutral and works after modal verbs', () => {
            expect(applyTermMappings('I have sell the world', '')).to.equal('I have overcome the world');
        });
    });

    describe('"laying a railway" → "planning" (pun la cale + STT inserts ferată, source-gated)', () => {
        it('fixes "laying a railway" when source has ferata', () => {
            expect(applyTermMappings('a calamity and laying a railway and correcting', 'pun la cale ferată și îndreptați')).to.equal('a calamity and planning and correcting');
        });
        it('does NOT fire without ferata in source', () => {
            expect(applyTermMappings('they were laying a railway through the mountains', 'construiau o linie prin munți')).to.equal('they were laying a railway through the mountains');
        });
    });

    describe('"the Jehovah" → "Jehovah" (article wrongly inserted before proper name)', () => {
        it('removes spurious "the" before Jehovah', () => {
            expect(applyTermMappings('Thus say the Jehovah of armies', '')).to.equal('Thus says Jehovah of armies');
        });
        it('does NOT alter "Jehovah" already without article', () => {
            expect(applyTermMappings('Jehovah is the God of love', '')).to.equal('Jehovah is the God of love');
        });
    });

    describe('"Please you to help us" → "we ask you to help us" (prayer fragment garble)', () => {
        it('fixes "Please you to help us"', () => {
            expect(applyTermMappings('Please you to help us to focus', '')).to.equal('we ask you to help us to focus');
        });
    });

    describe('"the molar" → "the potter" when source has molarul (olarul misheard)', () => {
        it('fixes "with the molar" when source has molarul', () => {
            expect(applyTermMappings('we see with the molar the vessel', 'vedem cu molarul vasul')).to.equal('we see with the potter the vessel');
        });
        it('fixes "the molar" when source has molarul', () => {
            expect(applyTermMappings('the molar does not throw away the vessel', 'molarul nu aruncă vasul')).to.equal('the potter does not throw away the vessel');
        });
        it('does NOT fire without molarul in source', () => {
            expect(applyTermMappings('the molar is the strongest tooth', 'cel mai puternic dinte')).to.equal('the molar is the strongest tooth');
        });
    });

    describe('"potter\'s voice breaks" → "potter\'s vessel breaks" (glasul/vasul confusion, Jer 19:11)', () => {
        it('fixes "potter\'s voice breaks" when source has olar and glasul', () => {
            expect(applyTermMappings("as a potter's voice breaks without being restored", 'cum se sfărâmă glasul unui olar')).to.equal("as a potter's vessel breaks without being restored");
        });
        it('does NOT fire without both olar and glasul in source', () => {
            expect(applyTermMappings("a potter's voice breaks through", 'vocea unui artist se remarcă')).to.equal("a potter's voice breaks through");
        });
    });

    // --- 2026-07-24 deep-dive fixes ---

    describe('"indifferent of/how/what" → "regardless of / no matter" (indiferent literal translation)', () => {
        it('fixes "indifferent of whether"', () => {
            expect(applyTermMappings('to act indifferent of whether we are together', '')).to.equal('to act regardless of whether we are together');
        });
        it('fixes "indifferent of" (without whether)', () => {
            expect(applyTermMappings('indifferent of the problems we face', '')).to.equal('regardless of the problems we face');
        });
        it('fixes "indifferent how"', () => {
            expect(applyTermMappings('indifferent how difficult or scary it may be', '')).to.equal('no matter how difficult or scary it may be');
        });
        it('fixes "indifferent what"', () => {
            expect(applyTermMappings('indifferent what we go through', '')).to.equal('no matter what we go through');
        });
        it('does NOT alter "indifferent" used correctly as an adjective', () => {
            expect(applyTermMappings('he was completely indifferent to her suffering', '')).to.equal('he was completely indifferent to her suffering');
        });
    });

    describe('"con regulation" → "congregation" (congregației garbled)', () => {
        it('fixes "con regulation"', () => {
            expect(applyTermMappings('of this con regulation Do not be afraid', '')).to.equal('of this congregation Do not be afraid');
        });
    });

    describe('"my the help" → "my help" (stray article from Romanian possessive)', () => {
        it('fixes "my the help"', () => {
            expect(applyTermMappings('Jehovah is my the help and my shield', '')).to.equal('Jehovah is my help and my shield');
        });
        it('does NOT alter "my help" already correct', () => {
            expect(applyTermMappings('Jehovah is my help', '')).to.equal('Jehovah is my help');
        });
    });

    // --- 2026-07-24 deep-dive fixes (thu-1950) ---

    describe('third-person verb agreement (he say / it say / he know — systematic MT error)', () => {
        it('fixes "he say" mid-sentence', () => {
            expect(applyTermMappings('here he say to them', '')).to.equal('here he says to them');
        });
        it('fixes "He say" sentence-initial (preserves capitalisation)', () => {
            expect(applyTermMappings('He say that we must serve Jehovah', '')).to.equal('He says that we must serve Jehovah');
        });
        it('fixes "it say" mid-sentence', () => {
            expect(applyTermMappings('it say that they offer sacrifices', '')).to.equal('it says that they offer sacrifices');
        });
        it('fixes "It say" sentence-initial (preserves capitalisation)', () => {
            expect(applyTermMappings('It say in the Bible', '')).to.equal('It says in the Bible');
        });
        it('fixes "he know" mid-sentence', () => {
            expect(applyTermMappings('he know our past and our heart', '')).to.equal('he knows our past and our heart');
        });
        it('fixes "He know" sentence-initial (preserves capitalisation)', () => {
            expect(applyTermMappings('He know the needs of each one', '')).to.equal('He knows the needs of each one');
        });
        it('fixes "Thus say Jehovah"', () => {
            expect(applyTermMappings('Thus say Jehovah of armies', '')).to.equal('Thus says Jehovah of armies');
        });
        it('does NOT alter "he says" already correct', () => {
            expect(applyTermMappings('he says what he means', '')).to.equal('he says what he means');
        });
    });

    describe('double-marked negatives (doesn\'t loves / do not allows / we seen)', () => {
        it('fixes "doesn\'t loves"', () => {
            expect(applyTermMappings("she doesn't loves someone", '')).to.equal("she doesn't love someone");
        });
        it('fixes "do not allows"', () => {
            expect(applyTermMappings('do not allows your actions to hurt others', '')).to.equal('do not allow your actions to hurt others');
        });
        it('fixes "we seen"', () => {
            expect(applyTermMappings('we seen that he was going there', '')).to.equal('we saw that he was going there');
        });
        it('does NOT alter "we have seen" already correct', () => {
            expect(applyTermMappings('we have seen his faithfulness', '')).to.equal('we have seen his faithfulness');
        });
    });

    describe('"Mulțumim" (Romanian "thank you") left untranslated in English output', () => {
        it('replaces untranslated Mulțumim with Thank you', () => {
            expect(applyTermMappings('an insult to Mulțumim', '')).to.equal('an insult to Thank you');
        });
    });

    describe('"world translation" → "New World Translation" (JW Bible, source-gated)', () => {
        it('fixes "world translation" when source has traducerii lumii', () => {
            expect(applyTermMappings('older editions of the world translation', 'ediții mai vechi ale traducerii lumii noi')).to.equal('older editions of the New World Translation');
        });
        it('does NOT fire without traducerii/lumii in source', () => {
            expect(applyTermMappings('this is a world translation effort', 'acesta este un efort de traducere mondială')).to.equal('this is a world translation effort');
        });
    });

    describe('"to joy the" → "to enjoy the" (bucura stripped of prefix by MT)', () => {
        it('fixes "to joy the"', () => {
            expect(applyTermMappings('we will be able to joy the spiritual Paradise', '')).to.equal('we will be able to enjoy the spiritual Paradise');
        });
        it('v224: does NOT touch "leads to joy the world cannot give" (joy is a noun there)', () => {
            expect(applyTermMappings('this leads to joy the world cannot give', 'aceasta duce la bucuria pe care lumea nu o poate da'))
                .to.equal('this leads to joy the world cannot give');
        });
        it('v224: still converts "the path to joy the blessings" (path takes an infinitive)', () => {
            expect(applyTermMappings('the path to joy the blessings', 'calea de a te bucura de binecuvântări'))
                .to.equal('the path to enjoy the blessings');
        });
    });

    describe('"were joy" → "were joyful" (v224: guarded against the "were a joy to <person>/and" noun idiom)', () => {
        it('fixes bare "they were joy"', () => {
            expect(applyTermMappings('they were joy at the news', 'erau bucuroși de veste'))
                .to.equal('they were joyful at the news');
        });
        it('still converts "were joy to <verb>" ("were joyful to hear")', () => {
            expect(applyTermMappings('they were joy to hear the good news', 'au fost bucuroși să audă vestea bună'))
                .to.equal('they were joyful to hear the good news');
        });
        it('does NOT touch "were joy to my heart" (noun: "were a joy to <possessive>")', () => {
            expect(applyTermMappings('your words were joy to my heart', 'cuvintele tale au fost bucurie inimii mele'))
                .to.equal('your words were joy to my heart');
        });
        it('does NOT touch "were joy and peace" (coordinated noun)', () => {
            expect(applyTermMappings('there were joy and peace in the hall', 'erau bucurie și pace în sală'))
                .to.equal('there were joy and peace in the hall');
        });
        it('does NOT touch "were joy to Maria\'s heart" (possessive proper noun)', () => {
            expect(applyTermMappings("your words were joy to Maria's heart", 'cuvintele tale au fost bucurie inimii Mariei'))
                .to.equal("your words were joy to Maria's heart");
        });
    });

    // --- 2026-07-26 Sunday meeting deep-dive fixes ---

    describe('pray→Please fix (rugăm/roagă parsed as politeness marker by MT)', () => {
        it('fixes "let\'s Please" when source has rugăm', () => {
            expect(applyTermMappings("let's Please for Jehovah's guidance", 'să ne rugăm pentru îndrumarea lui Iehova')).to.equal("let us pray for Jehovah's guidance");
        });
        it('fixes "we Please" when source has rugăm', () => {
            expect(applyTermMappings('we Please with thankful hearts', 'ne rugăm cu inimi recunoscătoare')).to.equal('we pray with thankful hearts');
        });
        it('fixes "should Please to God"', () => {
            expect(applyTermMappings('we should Please to God about this decision', 'ar trebui să ne rugăm lui Dumnezeu')).to.equal('we should pray to God about this decision');
        });
        it('fixes "Please to God"', () => {
            expect(applyTermMappings('Please to God about this decision', 'Roagă-te lui Dumnezeu pentru această decizie')).to.equal('pray to God about this decision');
        });
        it('does NOT fire without rug in source', () => {
            expect(applyTermMappings("let's Please consider this point", 'să luăm în considerare acest punct')).to.equal("let's Please consider this point");
        });
    });

    describe('Iehova mishearing fixes (Moldova, export, sheep)', () => {
        it('fixes "trust in Moldova" when source has Iehova', () => {
            expect(applyTermMappings('trust in Moldova the creator', 'să avem încredere în Iehova creatorul')).to.equal('trust in Jehovah the creator');
        });
        it('fixes "worship of export" when source has Iehova', () => {
            expect(applyTermMappings('worship of export must be paramount', 'închinarea la Iehova trebuie să fie primordială')).to.equal('worship of Jehovah must be paramount');
        });
        it('fixes "ask a sheep for support" when source has Iehova', () => {
            expect(applyTermMappings('ask a sheep for support', 'cerem lui Iehova sprijin')).to.equal('ask Jehovah for support');
        });
        it('does NOT fire without Iehova in source', () => {
            expect(applyTermMappings('trust in Moldova', 'avem încredere în Moldova')).to.equal('trust in Moldova');
        });
    });

    describe('"additional insulin" → "additional training" (instruire garbled by STT)', () => {
        it('fixes "additional insulin"', () => {
            expect(applyTermMappings('decide whether to take additional insulin', '')).to.equal('decide whether to take additional training');
        });
        it('fixes "without higher insulin"', () => {
            expect(applyTermMappings('find a job without a higher insulin', '')).to.equal('find a job without higher education');
        });
    });

    describe('"Love Island" → "additional training" (Insula iubirii STT garble)', () => {
        it('fixes "Love Island" when source has Insula iubirii', () => {
            expect(applyTermMappings('how Christians view Love Island', 'cum trebuie creștinii să privească Insula iubirii')).to.equal('how Christians view additional training');
        });
        it('does NOT fix "Love Island" without Insula iubirii in source', () => {
            expect(applyTermMappings('how Christians view Love Island', 'un program TV')).to.equal('how Christians view Love Island');
        });
    });

    describe('"additional inspiration" → "additional training" (source-gated on instruire)', () => {
        it('fixes "additional inspiration" when source has instruire', () => {
            expect(applyTermMappings('decide whether to take additional inspiration', 'să urmeze sau nu o instruire suplimentară')).to.equal('decide whether to take additional training');
        });
        it('does NOT fix "additional inspiration" without instruire in source', () => {
            expect(applyTermMappings('the Bible provides additional inspiration', 'Biblia oferă inspirație suplimentară')).to.equal('the Bible provides additional inspiration');
        });
    });

    describe('"Jehovah \'s" → "Jehovah\'s" (tokenisation spacing artifact)', () => {
        it('fixes spacing in possessive', () => {
            expect(applyTermMappings("Jehovah 's promises are sure", '')).to.equal("Jehovah's promises are sure");
        });
        it('does not alter "Jehovah" without possessive', () => {
            expect(applyTermMappings('Jehovah is great', '')).to.equal('Jehovah is great');
        });
    });

    describe('double article removal ("his the word", "our the words")', () => {
        it('fixes "his the word"', () => {
            expect(applyTermMappings('meditate on his the word daily', '')).to.equal('meditate on his word daily');
        });
        it('fixes "our the words"', () => {
            expect(applyTermMappings('may our the words be acceptable', '')).to.equal('may our words be acceptable');
        });
    });

    describe('"I pleasant" → "I liked" (mi-a plăcut MT failure)', () => {
        it('fixes "I pleasant"', () => {
            expect(applyTermMappings('I pleasant the idea that one of the sisters said', '')).to.equal('I liked the idea that one of the sisters said');
        });
        it('fixes "me and I pleasant"', () => {
            expect(applyTermMappings('me and I pleasant the contrast between', '')).to.equal('and I liked the contrast between');
        });
    });

    describe('"a work" → "a job" (loc de muncă, source-gated)', () => {
        it('fixes "a work" when source has loc de muncă', () => {
            expect(applyTermMappings('start looking for a work after school', 'să caute un loc de muncă după școală')).to.equal('start looking for a job after school');
        });
        it('fixes "how many work" when source has loc de muncă', () => {
            expect(applyTermMappings('to see how many work are available', 'câte locuri de muncă sunt disponibile')).to.equal('to see how many jobs are available');
        });
        it('does NOT fix "a work" without loc de muncă in source (e.g. a work of art)', () => {
            expect(applyTermMappings('this is a work of art', 'aceasta este o operă de artă')).to.equal('this is a work of art');
        });
    });

    describe('"could not joy" / "are joy serving" (bucura rendered as joy)', () => {
        it('fixes "could not joy"', () => {
            expect(applyTermMappings('she could not joy as much as the first sister', '')).to.equal('she could not rejoice as much as the first sister');
        });
        it('fixes "who are joy serving"', () => {
            expect(applyTermMappings('brothers who are joy serving Jehovah', '')).to.equal('brothers who joyfully serve Jehovah');
        });
    });

    describe('"ask Jehovah the help" → "ask Jehovah for help"', () => {
        it('fixes stray article before help', () => {
            expect(applyTermMappings('ask Jehovah the help in prayer', '')).to.equal('ask Jehovah for help in prayer');
        });
    });

    // ── 2026-07-27 live-session fixes ──
    describe('"were need" → "were needed" (era nevoie, MT drops -ed)', () => {
        it('fixes "were need to" (ungated — never valid English)', () => {
            expect(applyTermMappings('efforts of faith and courage were need to enjoy the blessings', ''))
                .to.equal('efforts of faith and courage were needed to enjoy the blessings');
        });
        it('fixes "are need"', () => {
            expect(applyTermMappings('more workers are need for the harvest', ''))
                .to.equal('more workers are needed for the harvest');
        });
        it('does NOT touch valid "we need" / "they need our help"', () => {
            expect(applyTermMappings('we need to be patient', '')).to.equal('we need to be patient');
        });
        it('preserves capitalization at a segment start ("Were need" → "Were needed")', () => {
            expect(applyTermMappings('Were need to sacrifice more', '')).to.equal('Were needed to sacrifice more');
        });
        it('leaves singular "was need"/"is need" alone (there was/is need to…)', () => {
            expect(applyTermMappings('there was need to act quickly', '')).to.equal('there was need to act quickly');
            expect(applyTermMappings('there is need to remain calm', '')).to.equal('there is need to remain calm');
        });
    });

    describe('"Great Event" → "Great Tribulation" (necazul→cazul STT mishear)', () => {
        it('fixes when source has the (garbled) "cazul cel mare"', () => {
            expect(applyTermMappings('The Great Event could begin at any moment', 'cazul cel Mare ar putea să înceapă'))
                .to.equal('The Great Tribulation could begin at any moment');
        });
        it('fixes when source has the correct "necazul cel mare"', () => {
            expect(applyTermMappings('the great event is near', 'necazul cel mare este aproape'))
                .to.equal('the great tribulation is near');
        });
        it('does NOT fire without the source gate', () => {
            expect(applyTermMappings('The Great Event was a concert', 'un concert mare'))
                .to.equal('The Great Event was a concert');
        });
        it('fixes "Great Case" (MT rendered caz as "case") preserving title case', () => {
            expect(applyTermMappings('The Great Case could begin', 'cazul cel mare ar putea începe'))
                .to.equal('The Great Tribulation could begin');
        });
        it('fixes lowercase "great case"', () => {
            expect(applyTermMappings('during the great case', 'in necazul cel mare'))
                .to.equal('during the great tribulation');
        });
    });

    describe('"you learn [people]" → "you teach" (a învăța pe cineva)', () => {
        it('fixes "you learn all the Jews" when source has "înveți pe"', () => {
            expect(applyTermMappings('that you learn all the Jews', 'că îi înveți pe toți iudeii'))
                .to.equal('that you teach all the Jews');
        });
        it('does NOT touch "you learn" without the "pe" teaching construction', () => {
            expect(applyTermMappings('you learn quickly from mistakes', 'înveți repede din greșeli'))
                .to.equal('you learn quickly from mistakes');
        });
    });

    // ── 2026-08-06 midweek + 2026-08-08 weekend meeting review ──
    describe('"learn/learned + me/us/him" → teach/taught', () => {
        it('"they learned us wrong" → "they taught us wrong"', () => {
            expect(applyTermMappings('they learned us wrong', 'ne au învățat greșit'))
                .to.equal('they taught us wrong');
        });
        it('"learned me and my brothers" → "taught me..."', () => {
            expect(applyTermMappings('learned me and my brothers', 'învățat pe mine și pe frații mei'))
                .to.equal('taught me and my brothers');
        });
        it('"learn me" → "teach me"; "learns him" → "teaches him"', () => {
            expect(applyTermMappings('you must learn me', '')).to.equal('you must teach me');
            expect(applyTermMappings('she learns him', '')).to.equal('she teaches him');
        });
        it('does NOT touch valid "learned them by heart" / "learned from him"', () => {
            expect(applyTermMappings('I learned them by heart', '')).to.equal('I learned them by heart');
            expect(applyTermMappings('I learned from him', '')).to.equal('I learned from him');
        });
    });

    describe('"<pron> seen" → "<pron> saw" (past participle w/o auxiliary)', () => {
        it('generalizes across subjects', () => {
            expect(applyTermMappings('I seen that suffering', '')).to.equal('I saw that suffering');
            expect(applyTermMappings('Jehovah seen something good', '')).to.equal('Jehovah saw something good');
            expect(applyTermMappings('she seen the truth', '')).to.equal('she saw the truth');
        });
        it('does NOT touch "I have seen" / "I\'ve seen"', () => {
            expect(applyTermMappings('I have seen it', '')).to.equal('I have seen it');
            expect(applyTermMappings("I've seen it", '')).to.equal("I've seen it");
        });
        it('does NOT break inverted questions "Have you seen" / "has he seen"', () => {
            expect(applyTermMappings('Have you seen him?', '')).to.equal('Have you seen him?');
            expect(applyTermMappings('has he seen it', '')).to.equal('has he seen it');
        });
        it('handles capitalized sentence-initial pronouns', () => {
            expect(applyTermMappings('He seen the vision', '')).to.equal('He saw the vision');
            expect(applyTermMappings('They seen him leave', '')).to.equal('They saw him leave');
        });
    });

    describe('missing plural on "question" + "a many"', () => {
        it('"a many of question" → "many questions"', () => {
            expect(applyTermMappings('asked me a many of question', 'foarte multe întrebări'))
                .to.equal('asked me many questions');
        });
        it('"a many" → "a lot"', () => {
            expect(applyTermMappings('we learn a many', 'învățăm foarte multe')).to.equal('we learn a lot');
        });
        it('"a few question" → "a few questions" (article forces noun)', () => {
            expect(applyTermMappings('ask a few question', '')).to.equal('ask a few questions');
        });
        it('does NOT touch verb "question" after a bare quantifier', () => {
            expect(applyTermMappings('many question the wisdom of it', '')).to.equal('many question the wisdom of it');
        });
        it('does NOT touch "a few question marks" / "question and answer"', () => {
            expect(applyTermMappings('a few question marks', '')).to.equal('a few question marks');
            expect(applyTermMappings('a few question and answer segments', '')).to.equal('a few question and answer segments');
        });
    });

    describe('"joy" as verb: will/who joy → enjoy', () => {
        it('"will joy the meeting" → "will enjoy the meeting"', () => {
            expect(applyTermMappings('we will joy the meeting', 'ne vom bucura')).to.equal('we will enjoy the meeting');
        });
        it('"who joy talking" → "who enjoy talking"', () => {
            expect(applyTermMappings('people who joy talking about him', 'se bucură')).to.equal('people who enjoy talking about him');
        });
        it('does NOT mangle an inverted question "Will joy come..."', () => {
            expect(applyTermMappings('Will joy come to those who serve Jehovah?', ''))
                .to.equal('Will joy come to those who serve Jehovah?');
        });
    });

    describe('misc live-review grammar fixes', () => {
        it('"see what happen" → "see what happens" (case-preserving)', () => {
            expect(applyTermMappings('and see what happen', '')).to.equal('and see what happens');
            expect(applyTermMappings('See what happen next', '')).to.equal('See what happens next');
        });
        it('double negative "don\'t lose nothing" → "don\'t lose anything"', () => {
            expect(applyTermMappings("you don't lose nothing", 'nu pierzi nimic')).to.equal("you don't lose anything");
        });
        it('"he pleasant" → "he liked" (gated on plăcut)', () => {
            expect(applyTermMappings('what he pleasant about the program', 'ce a plăcut'))
                .to.equal('what he liked about the program');
        });
        it('does NOT touch "he pleasant" without plăcut gate', () => {
            expect(applyTermMappings('he pleasant company', 'companie plăcută'.replace('plăcută', 'X')))
                .to.equal('he pleasant company');
        });
        it('"I start" → "I started" gated on "am început"', () => {
            expect(applyTermMappings('When I start secular work', 'Când am început munca laică'))
                .to.equal('When I started secular work');
        });
        it('does NOT touch habitual "I start" without past gate', () => {
            expect(applyTermMappings('I start work at nine', 'încep lucrul la nouă')).to.equal('I start work at nine');
        });
        it('does NOT touch biblical "the fathers" (rule dropped — idiom collision)', () => {
            expect(applyTermMappings('the God of our fathers', 'Dumnezeul părinților noștri'))
                .to.equal('the God of our fathers');
        });
        it('"Redhead" → "Roșca" (gate on sourceNorm, fires even if STT drops ș)', () => {
            expect(applyTermMappings('Redhead, are you smiling now?', 'Roșca zâmbești acum'))
                .to.equal('Roșca, are you smiling now?');
            expect(applyTermMappings('Redhead is here', 'Rosca este aici'))
                .to.equal('Roșca is here');
        });
    });

    describe('past-tense flattening (gated on Romanian past marker)', () => {
        it('"Jehovah change" → "Jehovah changed" when source has "a schimbat"', () => {
            expect(applyTermMappings('but Jehovah change the way he provided guidance', 'Iehova a schimbat modul'))
                .to.equal('but Jehovah changed the way he provided guidance');
        });
        it('does NOT change "Jehovah change" without the past-tense gate', () => {
            expect(applyTermMappings('Jehovah change hearts', 'Iehova schimbă inimi'))
                .to.equal('Jehovah change hearts');
        });
        it('"they need" → "they needed" when source has "aveau nevoie"', () => {
            expect(applyTermMappings('They need faith to accept that', 'ei aveau nevoie de credință'))
                .to.equal('They needed faith to accept that');
        });
        it('does NOT touch "they need" without the past-tense gate', () => {
            expect(applyTermMappings('they need our support today', 'au nevoie de sprijin'))
                .to.equal('they need our support today');
        });
    });

    describe('"a young to" → "a young person to" (persoană dropped by MT)', () => {
        it('fixes "a young to"', () => {
            expect(applyTermMappings('to help a young to make a wise decision', '')).to.equal('to help a young person to make a wise decision');
        });
    });

    describe('past-narrative "and say" → "and said" (Romanian historical present)', () => {
        it('fixes regular past "-ed and say"', () => {
            expect(applyTermMappings('my father kissed me and say "it will pass"', '')).to.equal('my father kissed me and said "it will pass"');
        });
        it('fixes irregular past "took and say"', () => {
            expect(applyTermMappings('he took me in his arms and say let it go', '')).to.equal('he took me in his arms and said let it go');
        });
        it('does NOT alter "come and say" (non-past modal)', () => {
            expect(applyTermMappings('you should come and say hello', '')).to.equal('you should come and say hello');
        });
        it('does NOT alter "-ed to V and say" (infinitive chain)', () => {
            expect(applyTermMappings('he loved to come and say a few words', '')).to.equal('he loved to come and say a few words');
        });
        it('does NOT alter "asked person to V and say" (would invert semantics)', () => {
            expect(applyTermMappings('he asked the brother to stand and say something', '')).to.equal('he asked the brother to stand and say something');
        });
    });

    describe('"everything/something that happen" → "happens" (singular subject agreement)', () => {
        it('fixes "everything that happen"', () => {
            expect(applyTermMappings('everything that happen in your life has to do with me', '')).to.equal('everything that happens in your life has to do with me');
        });
        it('fixes "something that happen"', () => {
            expect(applyTermMappings('something that happen to us', '')).to.equal('something that happens to us');
        });
        it('does NOT alter "things that happen" (plural subject)', () => {
            expect(applyTermMappings('things that happen in life', '')).to.equal('things that happen in life');
        });
    });

    describe('"Na te rog" → "Please don\'t" meaning inversion fix', () => {
        it('fixes "Please don\'t" when source has na as standalone word', () => {
            expect(applyTermMappings("Please don't.", 'Na te rog')).to.equal('Go ahead, please.');
        });
        it('does NOT fix "Please don\'t" without na in source', () => {
            expect(applyTermMappings("Please don't do that", 'Nu face asta')).to.equal("Please don't do that");
        });
    });

    describe('2026-08-09 Sunday review: "joy" as verb (gated on bucur)', () => {
        // v223: only "joy special privileges" is structurally unambiguous; every other slot leaves
        // "joy" alone because it is a valid NOUN there.
        it('does NOT convert "be joy to" (ambiguous with "be a joy to <someone>/behold")', () => {
            expect(applyTermMappings('she continues to be joy to her family', 'ea continuă să fie o bucurie pentru familia ei'))
                .to.equal('she continues to be joy to her family');
        });
        it('"joy special privileges" → "enjoyed special privileges" (past narrative)', () => {
            expect(applyTermMappings('Joseph joy special privileges', 'Iosif se bucura de privilegii speciale'))
                .to.equal('Joseph enjoyed special privileges');
        });
        it('whitelisted subject "God will joy special privileges" → "will enjoy …" (via will-joy rule)', () => {
            expect(applyTermMappings('God will joy special privileges', 'Dumnezeu se va bucura de privilegii'))
                .to.equal('God will enjoy special privileges');
        });
        it('sentence-initial "Joy special privileges" → "Enjoyed …" (case preserved)', () => {
            expect(applyTermMappings('Joy special privileges he received', 'S-a bucurat de privilegii'))
                .to.equal('Enjoyed special privileges he received');
        });
        it('does NOT touch the noun "joy" when source has no bucur (e.g. a person named Joy)', () => {
            expect(applyTermMappings('give the book to Joy', 'dă cartea lui Joy'))
                .to.equal('give the book to Joy');
        });
        // v223 regression guards: "joy" is a valid NOUN after these words — must NOT be verb-ified
        // even with the bucur gate open (the over-broad to/can/modal + joy rules were removed).
        it('does NOT mangle the blessing "May joy be with you all" (gate open)', () => {
            expect(applyTermMappings('May joy be with you all', 'Fie ca bucuria să fie cu voi toți'))
                .to.equal('May joy be with you all');
        });
        it('does NOT mangle the inverted question "Will joy come to those who serve Jehovah?"', () => {
            expect(applyTermMappings('Will joy come to those who serve Jehovah?', 'Se vor bucura cei ce slujesc lui Iehova?'))
                .to.equal('Will joy come to those who serve Jehovah?');
        });
        it('does NOT mangle the noun phrase "the path to joy and peace" (gate open)', () => {
            expect(applyTermMappings('this is the path to joy and peace', 'aceasta e calea spre bucurie și pace'))
                .to.equal('this is the path to joy and peace');
        });
        it('does NOT mangle the question "Can joy be real?" (gate open)', () => {
            expect(applyTermMappings('Can joy be real?', 'Poate bucuria să fie reală?'))
                .to.equal('Can joy be real?');
        });
    });

    describe('2026-08-09 Sunday review: "creator" as verb (gated on crea)', () => {
        it('"did not creator us" → "did not create us"', () => {
            expect(applyTermMappings('God did not creator us to die', 'Dumnezeu nu ne-a creat ca să murim'))
                .to.equal('God did not create us to die');
        });
        it('"was creator" → "was created"', () => {
            expect(applyTermMappings('man was creator in the image of God', 'omul a fost creat după chipul lui Dumnezeu'))
                .to.equal('man was created in the image of God');
        });
        it('"creator us" → "created us"', () => {
            expect(applyTermMappings('God creator us to be happy', 'Dumnezeu ne-a creat să fim fericiți'))
                .to.equal('God created us to be happy');
        });
        it('"didn\'t creator us like robots" → "create"', () => {
            expect(applyTermMappings("he didn't creator us like robots", 'nu ne-a creat ca pe niște roboți'))
                .to.equal("he didn't create us like robots");
        });
        it('does NOT touch the noun "Creator" when source has no crea', () => {
            expect(applyTermMappings('our Creator is loving', 'Făcătorul nostru este iubitor'))
                .to.equal('our Creator is loving');
        });
        it('does NOT invert the noun-title "God was Creator of the universe" (article dropped, gate open)', () => {
            expect(applyTermMappings('God was Creator of the universe', 'Dumnezeu a fost Creatorul universului'))
                .to.equal('God was Creator of the universe');
        });
    });

    describe('2026-08-09 Sunday review: "deserve" → worth (gated on merit)', () => {
        it('"it\'s not deserve it" → "it\'s not worth it"', () => {
            expect(applyTermMappings("it's not deserve it", 'nu merită'))
                .to.equal("it's not worth it");
        });
        it('"is deserve" → "is worthwhile"', () => {
            expect(applyTermMappings('any activity connected with it is deserve', 'orice activitate merită'))
                .to.equal('any activity connected with it is worthwhile');
        });
        it('leaves "deserve the effort" alone (rule dropped — "does not deserve the effort" is valid)', () => {
            expect(applyTermMappings('these two options deserve the effort', 'aceste două opțiuni merită efortul'))
                .to.equal('these two options deserve the effort');
        });
        it('does NOT alter a correct "does not deserve it"', () => {
            expect(applyTermMappings('he does not deserve it', 'nu merită asta'))
                .to.equal('he does not deserve it');
        });
    });

    describe('2026-08-09 Sunday review: "Careful" noun → "care" (gated on grij)', () => {
        it('"great Careful" → "great care"', () => {
            expect(applyTermMappings('take great Careful of the garden', 'ai mare grijă de grădină'))
                .to.equal('take great care of the garden');
        });
        it('"so much Careful" → "so much care"', () => {
            expect(applyTermMappings('so much Careful and consideration', 'atâta grijă și considerație'))
                .to.equal('so much care and consideration');
        });
        it('does NOT touch "be careful" (lowercase, and no grij gate)', () => {
            expect(applyTermMappings('you must be careful', 'trebuie să fii atent'))
                .to.equal('you must be careful');
        });
        it('does NOT touch lowercase "more careful analysis" even with the grij gate open', () => {
            expect(applyTermMappings('we need more careful analysis', 'avem nevoie de mai multă grijă'))
                .to.equal('we need more careful analysis');
        });
    });

    describe('2026-08-09 Sunday review: noun-subject "seen" → "saw"', () => {
        it('"his brothers seen that" → "his brothers saw that"', () => {
            expect(applyTermMappings('when his brothers seen that their father loved him', 'când frații lui au văzut că tatăl îl iubea'))
                .to.equal('when his brothers saw that their father loved him');
        });
        it('does NOT touch "the brothers have seen"', () => {
            expect(applyTermMappings('the brothers have seen the vision', 'frații au văzut viziunea'))
                .to.equal('the brothers have seen the vision');
        });
        it('does NOT touch inverted "Have the brothers seen …?" (auxiliary lookbehind)', () => {
            expect(applyTermMappings('Have the brothers seen this proof?', 'Au văzut frații dovada?'))
                .to.equal('Have the brothers seen this proof?');
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyReligiousTerms
// ─────────────────────────────────────────────────────────────────────────────
describe('verifyReligiousTerms', () => {

    describe('passthrough for non-Romanian targets', () => {
        it('does nothing when targetLang is "en"', () => {
            const text = 'We love Jehova and his Biblie';
            expect(verifyReligiousTerms(text, 'jehovah bible', 'en')).to.equal(text);
        });

        it('does nothing when targetLang is "fr"', () => {
            const text = 'Jehova est notre Seigneur';
            expect(verifyReligiousTerms(text, 'jehovah', 'fr')).to.equal(text);
        });
    });

    describe('Romanian term correction', () => {
        it('Jehova → Iehova when "jehovah" in source', () => {
            expect(verifyReligiousTerms('Jehova ne iubește', 'Jehovah loves us', 'ro'))
                .to.equal('Iehova ne iubește');
        });

        it('Iehvoa → Iehova (typo variant)', () => {
            expect(verifyReligiousTerms('Iehvoa este bun', 'jehovah', 'ro'))
                .to.equal('Iehova este bun');
        });

        it('Ievhova → Iehova (transposition variant)', () => {
            expect(verifyReligiousTerms('Ievhova ne ajută', 'jehovah', 'ro'))
                .to.equal('Iehova ne ajută');
        });

        it('Biblie → Biblia when "bible" in source', () => {
            expect(verifyReligiousTerms('Citiți din Biblie zilnic', 'Read the Bible daily', 'ro'))
                .to.equal('Citiți din Biblia zilnic');
        });

        it('Iisus → Isus when "jesus" in source', () => {
            expect(verifyReligiousTerms('Iisus Hristos', 'Jesus Christ', 'ro'))
                .to.equal('Isus Hristos');
        });

        it('Cristos → Hristos when "christ" in source', () => {
            expect(verifyReligiousTerms('Isus Cristos este Domn', 'Jesus Christ is Lord', 'ro'))
                .to.equal('Isus Hristos este Domn');
        });

        it('Satan → Satana when "satan" in source', () => {
            expect(verifyReligiousTerms('Satan este înfrânt', 'satan is defeated', 'ro'))
                .to.equal('Satana este înfrânt');
        });

        it('Dumnezău → Dumnezeu when "god" in source', () => {
            expect(verifyReligiousTerms('Dumnezău ne cheamă', 'God calls us', 'ro'))
                .to.equal('Dumnezeu ne cheamă');
        });

        it('fixes multiple terms in one pass', () => {
            const result = verifyReligiousTerms(
                'Jehova și Iisus și Biblie',
                'Jehovah and Jesus and the Bible',
                'ro'
            );
            expect(result).to.equal('Iehova și Isus și Biblia');
        });
    });

    describe('no false replacements', () => {
        it('does not replace when trigger term absent from source', () => {
            // "jehovah" not in source → no replacement
            const text = 'Jehova ne binecuvântează';
            expect(verifyReligiousTerms(text, 'God loves us', 'ro')).to.equal(text);
        });

        it('does not do partial word matches (word boundary check)', () => {
            // "godly" contains "god" but must not trigger the "god" fix
            const text = 'diavol este prezent';
            expect(verifyReligiousTerms(text, 'godly behaviour', 'ro')).to.equal(text);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// preserveSourceNumbers
// ─────────────────────────────────────────────────────────────────────────────
describe('preserveSourceNumbers', () => {

    it('returns translated unchanged when source has no numbers', () => {
        expect(preserveSourceNumbers('Hello world', 'Hello world translated')).to.equal(
            'Hello world translated'
        );
    });

    it('preserves a simple integer from source', () => {
        expect(preserveSourceNumbers('psalm 23', 'psalm 24')).to.equal('psalm 23');
    });

    it('preserves decimal numbers from source', () => {
        expect(preserveSourceNumbers('rata de 3,5%', 'rate of 3.8%')).to.equal('rate of 3,5%');
    });

    it('does NOT replace Romanian thousands separator (68.128 → stays as 68,128 in English)', () => {
        // Romanian "68.128" = 68,128 in English; Google correctly converts to "68,128"
        // We must NOT restore the dot-format back (would make English readers see a decimal)
        const result = preserveSourceNumbers('68.128 de frați', '68,128 brothers');
        expect(result).to.equal('68,128 brothers');
    });

    it('does NOT replace multi-group Romanian thousands (1.234.567)', () => {
        const result = preserveSourceNumbers('1.234.567 de membri', '1,234,567 members');
        expect(result).to.equal('1,234,567 members');
    });

    it('preserves year numbers (non-thousands)', () => {
        const result = preserveSourceNumbers('în 2024', 'in 2025');
        expect(result).to.equal('in 2024');
    });

    it('restores numbers positionally when a value repeats in the translation', () => {
        // Regression: source [3,5] vs translation [3,3]. The 2nd source number (5)
        // must land on the 2nd translated number, not clobber the first "3".
        expect(preserveSourceNumbers('3 versete și 5 capitole', '3 verses and 3 chapters'))
            .to.equal('3 verses and 5 chapters');
    });

    it('restores two distinct numbers in order', () => {
        expect(preserveSourceNumbers('psalm 23 și 24', 'psalm 25 and 26'))
            .to.equal('psalm 23 and 24');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// preserveDates
// ─────────────────────────────────────────────────────────────────────────────
describe('preserveDates', () => {

    it('returns translated unchanged when source has no date', () => {
        expect(preserveDates('Hello world', 'Hello world')).to.equal('Hello world');
    });

    it('restores missing month in translated output', () => {
        // Google dropped "martie" from translation
        const result = preserveDates(
            'conferința din 15 martie 2024',
            'the conference on 15 2024'
        );
        expect(result).to.equal('the conference on 15 martie 2024');
    });

    it('leaves translation unchanged when month already present', () => {
        const result = preserveDates(
            'în 10 ianuarie 2023',
            'on January 10, 2023'
        );
        // Month already present ("January") → no change
        expect(result).to.equal('on January 10, 2023');
    });

    it('handles Romanian diacritic month names in source', () => {
        const result = preserveDates(
            'adunarea din 3 septembrie 2025',
            'the meeting on 3 2025'
        );
        expect(result).to.equal('the meeting on 3 septembrie 2025');
    });
});

// ─── v217: 2026-07-26 deep-dive second-pass fixes ─────────────────────────

describe('applyTermMappings — v217 fixes', () => {
    const T = (text, src = '') => applyTermMappings(text, src);

    // Homa → Jehovah
    it('replaces "Homa" with "Jehovah" when source contains "Homa"', () => {
        expect(T("Homa's thoughts can become our thoughts", 'gândurile lui Homa pot deveni')).to.equal("Jehovah's thoughts can become our thoughts");
    });
    it('replaces bare "Homa" in output', () => {
        expect(T('we thank Homa for his care', 'mulțumim lui Homa')).to.equal('we thank Jehovah for his care');
    });
    it('does not touch "Homa" when source does not contain it', () => {
        expect(T('we thank Homa', 'mulțumim')).to.equal('we thank Homa');
    });

    // Hopa → Oops catch
    it('replaces "Oops" with "Jehovah" when source contains "Hopa"', () => {
        expect(T('How does he offer us comfort Oops', 'Cum ne oferă Hopa mângâiere')).to.equal('How does he offer us comfort Jehovah');
    });

    // P4: differently → different before nouns
    it('replaces "differently" with "different" before a noun', () => {
        expect(T('we have differently situations', '')).to.equal('we have different situations');
    });
    it('replaces "differently" before adjective+noun', () => {
        expect(T('differently biblical characters', '')).to.equal('different biblical characters');
    });
    it('replaces "differently" before "ages"', () => {
        expect(T('friends of differently ages', '')).to.equal('friends of different ages');
    });
    it('does NOT replace "differently" before "from"', () => {
        expect(T('done differently from before', '')).to.equal('done differently from before');
    });
    it('does NOT replace "differently" before a past participle', () => {
        expect(T('done differently situated', '')).to.equal('done differently situated');
    });
    it('does NOT replace "differently" before "to"', () => {
        expect(T('respond differently to stress', '')).to.equal('respond differently to stress');
    });

    // Scripture citation "N with M" → "N:M"
    it('converts "Psalm 94 with 19" to "Psalm 94:19" when source has cu pattern', () => {
        expect(T('Psalm 94 with 19', 'Psalmul 94 cu 19')).to.equal('Psalm 94:19');
    });
    it('converts "Galatians 6 with 5" to "Galatians 6:5" when source has cu pattern', () => {
        expect(T('Galatians 6 with 5', 'Galateni 6 cu 5')).to.equal('Galatians 6:5');
    });
    it('converts "Isaiah 41 with 10" to "Isaiah 41:10" when source has cu pattern', () => {
        expect(T('in Isaiah 41 with 10 we read', 'Isaia 41 cu 10')).to.equal('in Isaiah 41:10 we read');
    });
    it('leaves already-formatted citation unchanged', () => {
        expect(T('Psalm 94:19', 'Psalmul 94 cu 19')).to.equal('Psalm 94:19');
    });
    it('does NOT convert "N with M" when source has no "digit cu digit" pattern', () => {
        expect(T('he divided it into 2 with 3 equal parts', 'l-a împărțit în 2 și 3 egale')).to.equal('he divided it into 2 with 3 equal parts');
    });

    // "second cold" → "2 Kings"
    it('replaces "second cold" with "2 Kings"', () => {
        expect(T('we read the second cold 19:35', '')).to.equal('we read the 2 Kings 19:35');
    });
    it('combines "second cold" and citation rules: "second cold 19 with 35"', () => {
        expect(T('we read the second cold 19 with 35', 'a doua reci 19 cu 35')).to.equal('we read the 2 Kings 19:35');
    });

    // Verb agreement: Promise/promises
    it('fixes "Jehovah Promise" to "Jehovah promises"', () => {
        expect(T('Jehovah Promise us that he cares', '')).to.equal('Jehovah promises us that he cares');
    });
    it('fixes "He promise" to "He promises"', () => {
        expect(T('He promise to continue to sustain us', '')).to.equal('He promises to continue to sustain us');
    });
    it('does NOT change "He promised" (already past tense)', () => {
        expect(T('He promised us', '')).to.equal('He promised us');
    });
    it('does NOT change "He promises" (already correct)', () => {
        expect(T('He promises us', '')).to.equal('He promises us');
    });

    // Verb agreement: Jehovah support/supports
    it('fixes "Jehovah support" to "Jehovah supports"', () => {
        expect(T('Jehovah support us through our friends', '')).to.equal('Jehovah supports us through our friends');
    });
    it('does NOT change "Jehovah supported"', () => {
        expect(T('Jehovah supported us', '')).to.equal('Jehovah supported us');
    });

    // "who care of us" → "who cares for us"
    it('fixes "who care of us"', () => {
        expect(T('We thank Jehovah who care of us', '')).to.equal('We thank Jehovah who cares for us');
    });

    // Missing possessive: "Jehovah servants"
    it('fixes "Jehovah servants" to "Jehovah\'s servants"', () => {
        expect(T("Jehovah servants can feel overwhelmed", '')).to.equal("Jehovah's servants can feel overwhelmed");
    });
    it('fixes "Jehovah servant" singular', () => {
        expect(T("Jehovah servant Hannah", '')).to.equal("Jehovah's servant Hannah");
    });
    it('does NOT modify "Jehovah\'s servants" (already correct)', () => {
        expect(T("Jehovah's servants", '')).to.equal("Jehovah's servants");
    });

    // "was full with" → "was filled with"
    it('fixes "was full with bitterness"', () => {
        expect(T('Hannah was full with bitterness', '')).to.equal('Hannah was filled with bitterness');
    });

    // "Will We Ever Joy" → "Will We Ever Enjoy"
    it('fixes "Will We Ever Joy True Justice?"', () => {
        expect(T('Will We Ever Joy True Justice?', '')).to.equal('Will We Ever Enjoy True Justice?');
    });

    // "are happen" → "are happening"
    it('fixes "are happen" to "are happening"', () => {
        expect(T('How many good things are happen in our life', '')).to.equal('How many good things are happening in our life');
    });

    // Mid-sentence "Decision" → "decision"
    it('lowercases "the Decision" mid-sentence', () => {
        expect(T('the Decision to pursue additional training', '')).to.equal('the decision to pursue additional training');
    });
    it('lowercases "a Decision"', () => {
        expect(T('making a Decision is personal', '')).to.equal('making a decision is personal');
    });
    it('does NOT lowercase "The Decision" at sentence start (capital The not matched)', () => {
        // The regex pattern only matches lowercase article forms: the|a|this|that|an
        // "The Decision" starts with capital "The" which is not in the alternation (no /i flag)
        expect(T('The Decision was made by the elders', '')).to.equal('The Decision was made by the elders');
    });
    it('does NOT change modal + Decision (handled by earlier rule)', () => {
        // "will Decision" → "will decide" (existing rule on line 141)
        expect(T('they will Decision', '')).to.equal('they will decide');
    });

    // P6: Jesus learned → taught
    it('fixes "Jesus also learned his listeners"', () => {
        expect(T('Jesus also learned his listeners not to worry', '')).to.equal('Jesus also taught his listeners not to worry');
    });
    it('fixes "Jesus learned his listeners" without "also"', () => {
        expect(T('Jesus learned his listeners in Galilee', '')).to.equal('Jesus taught his listeners in Galilee');
    });

    // "the verse say" → "the verse says"
    it('fixes "as the verse say"', () => {
        expect(T('as the verse say', '')).to.equal('as the verse says');
    });

    // "and start to pray" → "and started to pray"
    it('fixes "and start to pray" in past narrative', () => {
        expect(T('Hannah was full with bitterness and started to pray', '')).to.equal('Hannah was filled with bitterness and started to pray');
    });
    it('fixes "and start to pray" → "and started to pray"', () => {
        expect(T('she wept and start to pray', '')).to.equal('she wept and started to pray');
    });

    // instruire: or skating
    it('fixes "additional training or skating" when source has instruire', () => {
        expect(T('additional training or skating', 'instruire suplimentară')).to.equal('additional training');
    });
    it('fixes "additional education or skating" when source has instruire', () => {
        expect(T('additional education or skating', 'instruire suplimentară')).to.equal('additional training');
    });
    it('does NOT change "or skating" without instruire in source', () => {
        expect(T('additional training or skating', '')).to.equal('additional training or skating');
    });

    // instruire: inspired by a higher power
    it('fixes "inspired by a higher power" when source has instruire', () => {
        expect(T('whether they might be inspired by a higher power', 'instruire superioară')).to.equal('whether they might be higher education');
    });
    it('does NOT change "inspired by a higher power" without instruire in source', () => {
        expect(T('inspired by a higher power', '')).to.equal('inspired by a higher power');
    });
});
