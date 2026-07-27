'use strict';

/**
 * Translation post-processing utilities.
 *
 * Pure functions — no external state, no logger, no socket dependencies.
 * Extracted from server.js so they can be unit-tested and shared.
 *
 * Used by both GTranslateV4 (main) and NovaTranslate branches,
 * and by BudgetTranslate.
 */

/**
 * Apply JW domain term corrections to translated text.
 *
 * Fixes known mistranslations and JW-specific terminology that Google Translate
 * gets wrong without sufficient context (e.g. "vestitori" → "publishers",
 * "congres" → "convention", "congregație" → "congregation" not "church").
 *
 * @param {string} text - Translated output to correct
 * @param {string} [sourceText=''] - Original STT source (Romanian) for source-aware fixes
 * @returns {string} Corrected translation
 */
function applyTermMappings(text, sourceText = '') {
    // Normalize source for diacritic-insensitive matching: Deepgram sometimes drops
    // diacritics (e.g. "congregatie" instead of "congregație"), so source-aware regex
    // checks must work against both the original and the stripped form.
    const sourceNorm = sourceText.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const mappings = [
        { pattern: /\bvestitori\b/gi, replacement: 'publishers' },
        { pattern: /\bMartorii lui Iehova\b/gi, replacement: "Jehovah's Witnesses" },
        { pattern: /\bnume nou\b/gi, replacement: 'new name' },
        { pattern: /\bnume noi\b/gi, replacement: 'new names' },
        // "congres" is a JW convention, not a political congress
        { pattern: /\bcongresses\b/gi, replacement: 'conventions' },
        { pattern: /\bcongress\b/gi, replacement: 'convention' },
        // Bible reference format: Romanian "Proverbe de 7,3" → translated "Proverbs of 7,3"
        // → should be "Proverbs 7:3". Pattern: CapitalizedWord + "of" + N,M → N:M
        { pattern: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+of\s+(\d+)[,.](\d+)\b/g, replacement: '$1 $2:$3' },
        // "must to [verb]" — literal calque of Romanian "trebuie să [verb]".
        // Google Translate produces this when the fragment lacks sentence context.
        // "don't must to" → "don't have to"; "must to" → "must"
        { pattern: /\bdon['']t\s+must\s+to\b/gi, replacement: "don't have to" },
        { pattern: /\bmust\s+to\s+/gi, replacement: 'must ' },
        // STT mishearing: "congresul de circuit" (circuit assembly) is sometimes transcribed
        // as "congresul de tip construcție", producing "construction type convention/assembly".
        // NOTE: the congress→convention rule above runs first, so by the time these patterns
        // execute the text already reads "construction type convention". The "congress" variant
        // is kept as a defensive fallback in case mapping order ever changes.
        { pattern: /\bconstruction[\s-]type\s+convention\b/gi, replacement: 'circuit assembly' },
        { pattern: /\bconstruction[\s-]type\s+assembly\b/gi, replacement: 'circuit assembly' },
        { pattern: /\bconstruction[\s-]type\s+congress\b/gi, replacement: 'circuit assembly' },
    ];

    let result = text;
    for (const { pattern, replacement } of mappings) {
        result = result.replace(pattern, replacement);
    }

    // Source-aware fix: "Hopa" (STT mishear of "Iehova" in prayer/vocative context).
    // Google Translate passes the unknown word through verbatim, so "Hopa" appears in result as-is.
    // CASE-SENSITIVE GATE — intentional: lowercase "hopa" is the Romanian exclamation "whoops"
    // and must NOT be corrected. Do not add /i to either regex.
    // Confirmed failure: 2026-04-30 closing prayer — "Hopa să fi alături de noi" → "Hopa, be with us."
    // MT sometimes translates "Hopa" as "Oops" — catch both outputs.
    if (/\bHopa\b/.test(sourceText)) {
        result = result.replace(/\bHopa\b/g, 'Jehovah');
        result = result.replace(/\bOops\b/g, 'Jehovah');
    }

    // Source-aware fix: "Homa" (STT mishear of "Iehova" — same /H/ onset family as Hopa/Popa/Boga).
    // CASE-SENSITIVE GATE — intentional: lowercase "homa" excluded for safety.
    // Do not add /i to either regex. Possessive form must run before bare form.
    // Confirmed: 2026-07-26 — "gândurile lui Homa pot deveni" → "Homa's thoughts can become"
    if (/\bHoma\b/.test(sourceText)) {
        result = result.replace(/\bHoma's\b/g, "Jehovah's");
        result = result.replace(/\bHoma\b/g, 'Jehovah');
    }

    // Source-aware fix: "congregație" → "congregation" (not "church").
    // Google Translate sometimes returns "church" for "congregație" in religious contexts.
    // JW terminology strictly uses "congregation", never "church".
    // Uses sourceNorm (diacritics stripped) to match even when Deepgram drops ț → t.
    if (/congregati/i.test(sourceNorm)) {
        result = result.replace(/\bchurch\b/gi, 'congregation');
        result = result.replace(/\bchurches\b/gi, 'congregations');
    }

    // Source-aware fix: "biserica" (definite singular = "the church") → "the congregation".
    // In JW meetings, speakers use "biserica" to mean their own congregation/organization,
    // not the churches of Christendom (for those they use "religiile lumii", "creștinătatea").
    // Only fires on definite "the church" — "our church"/"his church"/"a church" from
    // "biserica noastră/lui/o" are not corrected; expand if new patterns emerge in logs.
    // Note: the trigger word "biserica" contains no Romanian diacritics, so matching
    // directly against sourceText is sufficient — no need for sourceNorm here.
    if (/\bbiserica\b/i.test(sourceText)) {
        result = result.replace(/\bthe church\b/gi, 'the congregation');
    }

    // Source-aware fix: STT garbles "congrese speciale" → "congrete fiare" (beasts).
    // When the source contains "congres" family words, "beast/beasts" in the output
    // is always a garble artifact — replace with "convention/conventions".
    if (/congres/i.test(sourceText)) {
        result = result.replace(/\bbeasts?\b/gi, (match) => match.toLowerCase() === 'beast' ? 'convention' : 'conventions');
    }

    // Source-aware fix: STT garbles "Tongo" (venue/stadium name) → "Togo" (country).
    // "Togo" in this domain context is always the venue, never the African country.
    if (/tongo/i.test(sourceText)) {
        result = result.replace(/\bTogo\b/g, 'Tongo');
    }

    // Source-aware fix: "Cartea Bucuriei" = "The Book of Joy" (JW publication).
    // Google Translate sometimes renders "bucurie" as "Rejoice" without context.
    if (/cart(?:ea|e)\s+bucur/i.test(sourceText)) {
        result = result.replace(/\bRejoice\b/gi, 'Joy');
        result = result.replace(/\bbook\s+rejoice\b/gi, 'Book of Joy');
    }

    // Source-aware fix: "bunătate" (kindness) garbled to "bani" (money) by STT.
    // If source contains "bunătate" and output has "money", it's the STT error.
    if (/bun[ăa]tate/i.test(sourceText)) {
        result = result.replace(/\bmoney\b/gi, 'kindness');
    }

    // Source-aware fix: "cu siguranță" = certainly/surely (adverb), NOT "safety" (noun).
    // Google/Claude maps "siguranță" to "safety" but "cu siguranță" is the adverb "certainly".
    if (/cu\s+siguranta/i.test(sourceNorm)) {
        result = result.replace(/\bSafety\b/g, 'Certainly');
        result = result.replace(/\bsafety\b/g, 'certainly');
    }

    // Grammar fix: "say/says [pronoun]" → "tell/tells [pronoun]".
    // Romanian "a spune cuiva" (to tell someone) translates literally as "say me/you/him"
    // but English requires "tell" when a personal object follows.
    result = result.replace(/\bsays\s+(me|us|him|her|them|you)\b/gi, 'tells $1');
    result = result.replace(/\bsay\s+(me|us|him|her|them|you)\b/gi, 'tell $1');

    // Collapse consecutive duplicate 2-3 word phrases (e.g. "you can't you can't" → "you can't").
    // Caused by Romanian emphasis doubling ("nu poți nu poți") or stream restart repeats.
    result = result.replace(/\b([\w']+(?:\s+[\w']+){1,2})\s+\1\b/gi, '$1');

    // Source-aware fix: "conștiință curată" = clean conscience (curată = adjective "clean/pure").
    // Claude sometimes picks the verb "cleanse" instead of the adjective "clean".
    if (/constiinta/i.test(sourceNorm)) {
        result = result.replace(/\bcleanse\s+conscience\b/gi, 'clean conscience');
    }

    // Fix noun/verb confusion: "will/can/could/etc. Decision" → "decide".
    // Claude occasionally uses the noun "Decision" after modal verbs instead of the verb.
    result = result.replace(/\b(will|can|could|might|may|should|would|to)\s+Decision\b/g, '$1 decide');

    // Source-aware fix: "adunare" = congregation (local) or assembly (circuit/district).
    // Google Translate maps "adunare" to "gathering" which is incorrect in JW context.
    if (/\badunare\b/i.test(sourceText)) {
        result = result.replace(/\bgathering\b/gi, 'congregation');
        result = result.replace(/\bgatherings\b/gi, 'congregations');
    }

    // Source-aware fix: "serviciu" in JW context = ministry/field service, not "service" (generic).
    // "serviciul pe pământ" = "his ministry on earth"; "serviciu de predicare" = "preaching ministry".
    // Only apply when source contains "serviciu" to avoid over-correcting unrelated "service" uses.
    if (/serviciu/i.test(sourceText)) {
        result = result.replace(/\bhis service on earth\b/gi, 'his ministry on earth');
        result = result.replace(/\bthe service on earth\b/gi, 'the ministry on earth');
        result = result.replace(/\bpreaching service\b/gi, 'preaching ministry');
        result = result.replace(/\bfield service\b/gi, 'field ministry');
    }

    // Source-aware fix: "sportivă/sportiv" in Romanian speech = fair/sportsmanlike (showing
    // integrity and fair play), not "sporty" (fashion/athletic style).
    // Seen: "ce este sportivă" → "what is sporty" (2026-04-05 session).
    if (/sportiv[ăa]?\b/i.test(sourceText)) {
        result = result.replace(/\bsporty\b/gi, 'fair and upright');
        // NOTE: bare "sporting" intentionally NOT replaced — too broad ("sporting chance",
        // "sporting event", "sporting goods"). Only the confirmed bad output "sporty" is fixed.
    }

    // Source-aware fix: "romani" in Romanian = Romani people/language (Roma), not Romans.
    // JW meetings regularly reference "limba romani" (Romani language) and "frații romani"
    // (Romani brothers). Exception: "cartea Romani" = the biblical book of Romans.
    if (/\bromani\b/i.test(sourceText) && !/cart(?:ea)?\s+romani\b/i.test(sourceText) && !/romani\s+\d/i.test(sourceText)) {
        result = result.replace(/\bRomans\b/g, 'Romani');
    }

    // Source-aware fix: "blestemator" = blasphemer (theological term, 1 Tim 1:13).
    // Google Translate renders it as "curser" (colloquial) — wrong in a Bible-reading context.
    // Confirmed: 2026-04-30 session — "a fost blestemator persecutor" → "a curser persecutor".
    if (/\bblestemator/i.test(sourceText)) {  // matches singular + plural "blestematori"
        result = result.replace(/\bcurser\b/gi, 'blasphemer');
        result = result.replace(/\bcursers\b/gi, 'blasphemers');
    }

    // Source-aware fix: "versuri" in JW context = Bible verses/scriptures, not song lyrics.
    // Google Translate defaults to "lyrics" because "versuri" is most commonly poetry/songs.
    // Confirmed: 2026-04-30 session — "organizarea versurilor" → "organization of lyrics".
    if (/\bversur/i.test(sourceText)) {
        result = result.replace(/\blyrics\b/gi, 'verses');
    }

    // Source-aware fix: "sigur" (Romanian adverb = "certainly/sure") capitalized by STT →
    // Google Translate treats capital "Sigur" as a person's name and adds possessive.
    // Confirmed: 2026-04-30 — "pe marginea lui Sigur" → "discuss Sigur's side" (should be "certainly").
    // Note: "Sigur" is a legitimate Romanian given name, so only apply when lowercase "sigur"
    // is present in source (STT capitalised it but the speaker meant the adverb).
    if (/\bsigur\b/.test(sourceText)) {
        // Possessive MUST run before bare form — bare /\bSigur\b/ would otherwise turn
        // "Sigur's" into "certainly's" (the \b falls before the apostrophe).
        result = result.replace(/\bSigur's\b/g, 'certainly');
        result = result.replace(/\bSigur\b/g, 'certainly');
    }

    // Source-aware fix: "Popa" (capital) = STT mishear of "Iehova" (same /H/ onset pattern as Hopa).
    // Lowercase "popa" = Romanian colloquial for "priest" — intentionally excluded by case-sensitive gate.
    // Confirmed: 2026-05-14 — "gurița sa va trăi de Popa" → "his mouth will live on Popa".
    if (/\bPopa\b/.test(sourceText)) {
        result = result.replace(/\bPopa\b/g, 'Jehovah');
    }

    // Source-aware fix: "franci/francii" = STT mishear of "frați/frații" (brothers/the brothers).
    // The /ts/ cluster in "frați" causes Google STT to commit to "franci" (francs — French currency).
    // Confirmed: 2026-05-14 — "450 de franci" → "450 francs" (should be "450 brothers");
    //            "efectiv am simțit cu francii" → "with the francs" (should be "with the brothers").
    // Gate uses /\bfrancii?\b/ (not open suffix) to avoid firing on "Francisc" (proper name).
    // "franci" has no diacritics — sourceText is sufficient (no need for sourceNorm).
    if (/\bfrancii?\b/i.test(sourceText)) {
        result = result.replace(/\bthe francs\b/gi, 'the brothers');
        result = result.replace(/\bfrancs\b/gi, 'brothers');
    }

    // Grammar fix: "fi prieteni" (be friends) → Google Translate produces "be friendship with".
    // "be friendship with" is impossible English — safe to fix globally (no source gate needed).
    // Confirmed: 2026-05-14 — "fi prieteni cu Iehova" → "be friendship with Jehovah".
    result = result.replace(/\bbe friendship with\b/gi, 'be friends with');

    // Grammar fix: "considera prieteni" → "consider friendship" (wrong noun form).
    // "consider friendship" IS valid English ("consider friendship important") so source gate required.
    if (/consider[aă]/i.test(sourceNorm)) {
        result = result.replace(/\bconsider friendship\b/gi, 'consider friends');
    }

    // Source-aware fix: "Boga" (capital) = STT mishear of "Iehova" — same /H/ onset mishear
    // family as Hopa and Popa. Lowercase "boga" is not a standard Romanian word but excluded
    // by case-sensitive gate for safety. Confirmed: 2026-05-14 — "îl cunoaște pe Boga" →
    // "knows Boga" (should be "knows Jehovah"); preposition "pe" confirms it is a proper noun.
    if (/\bBoga\b/.test(sourceText)) {
        result = result.replace(/\bBoga\b/g, 'Jehovah');
    }

    // Source-aware fix: "pulberabilă" = STT mishear of "vulnerabilă" (vulnerable).
    // The /vl/ → /pb/ shift produces a non-word that Google Translate renders as "pulverizable".
    // "pulberabilă" never appears in real Romanian — safe to fix without false-positive risk.
    // Confirmed: 2026-05-14 — "o minoritate religioasă pulberabilă" → "a pulverizable religious minority".
    if (/pulberabil/i.test(sourceText)) {
        result = result.replace(/\bpulverizable\b/gi, 'vulnerable');
    }

    // Source-aware fix: "iertova" = STT mishear of "Iehova" — non-word produced by blending
    // "ierta" (to forgive) with "Iehova". Google Translate maps it to "Forgiveness".
    // "iertova" is never a real Romanian word — safe gate with no false-positive risk.
    // Confirmed: 2026-05-17 live — Psalm 83:18 "iertova numai tu ești cel preaînalt" →
    // "Forgiveness, you alone are the Most High" (should be "Jehovah").
    if (/iertova/i.test(sourceText)) {
        result = result.replace(/\bForgiveness\b/g, 'Jehovah');
        result = result.replace(/\bforgiveness\b/g, 'Jehovah');
    }

    // Source-aware fix: "prieteni" (friends, plural) → Google Translate renders as "friendship"
    // (abstract noun) in some constructions. Confirmed: 2026-05-17 live — "Trei prieteni" →
    // "three friendship" (should be "three friends").
    // Gate: only apply when source has "prieteni" (plural) — "prietenie/prietenia" = friendship
    // (abstract) is legitimate and excluded by the \bprieteni\b word boundary.
    if (/\bprietenii?\b/i.test(sourceText)) {  // matches both prieteni and prietenii (definite form)
        result = result.replace(/\bfriendship\b/gi, 'friends');
    }

    // Source-aware fix: "dioxive" = STT garble, likely of "dificile" (difficult).
    // "dioxyves" is not an English word — safe to replace with "difficult".
    // Confirmed: 2026-05-17 live — "încercări sunt dioxive" → "trials are dioxyves".
    if (/dioxiv/i.test(sourceText)) {
        result = result.replace(/\bdioxyves\b/gi, 'difficult');
        result = result.replace(/\bdioxive\b/gi, 'difficult');
    }

    // Source-aware fix: "Comitetul de Ramură" (Branch Committee) — STT mishears "Ramură"
    // (branch) as something that Google Translate renders as "psychiatric" or similar.
    // Confirmed: 2026-05-17 live — "John Preda pentru Comitetul de Ramură" →
    // "John Preda for the Psychiatric committee" (should be "Branch Committee").
    if (/ramur/i.test(sourceText)) {
        result = result.replace(/\bpsychiatric\b/gi, 'Branch');
        result = result.replace(/\bpsychiatry\b/gi, 'Branch');
    }

    // "sclavul fidel și prevăzător" = "the faithful and discreet slave" (Matthew 24:45)
    // "prevăzător" (foresighted) → Google Translate: "cautious"; JW canonical term: "discreet"
    // "fidel" (faithful adjective) → sometimes rendered "faithfully" (adverb) by Google in context
    // Confirmed: 2026-05-17 live — "sclavul fidel și prevăzător" → "faithfully and cautious slave"
    if (/prevăzător/i.test(sourceText)) {
        result = result.replace(/\bcautious\b/gi, 'discreet');
        result = result.replace(/\bcautiously\b/gi, 'discreet');
    }
    if (/\bfidel\b/i.test(sourceText)) {
        // Only the adjectival "faithfully" that governs "slave" (the "faithful and
        // discreet slave" phrase) — never a standalone adverb elsewhere in a longer
        // utterance. Lookahead allows an optional "and <word>" connector.
        result = result.replace(/\bfaithfully\b(?=\s+(?:and\s+\w+\s+)?slave\b)/gi, 'faithful');
    }

    // "rugăm" (we pray) → Google Translate sometimes renders as "Please" (confuses with "vă rugăm" = please)
    // Gate: source contains "rugăm" (first-person plural prayer form)
    // Confirmed: 2026-05-17 — "continuăm să ne rugăm pentru voi" → "we continue to Please for you"
    if (/rugăm/i.test(sourceText)) {
        result = result.replace(/\bPlease for\b/g, 'pray for');
        result = result.replace(/\bto Please\b/g, 'to pray');
    }

    // "mă bucură" / "bucur" → Google Translate renders as "joy" (noun) instead of "glad/happy"
    // Confirmed: 2026-05-17 — "Mă bucură și pe mine" → "I'm joy too"
    if (/bucur/i.test(sourceText)) {
        result = result.replace(/\bI'm joy\b/gi, "I'm glad");
        result = result.replace(/\bI am joy\b/gi, 'I am glad');
        result = result.replace(/\bmakes me joy\b/gi, 'makes me happy');
    }

    // "suplinitori" (servants/publishers of Jehovah) → Google Translate: "substitutes"
    // Confirmed: 2026-05-17 — "2 milioane de suplinitori ai lui Iehova" → "2 million substitutes of Jehovah"
    if (/suplinitor/i.test(sourceText)) {
        result = result.replace(/\bsubstitutes\b/gi, 'servants');
    }

    // "teocratică" (theocratic) → STT splits to "de ocratică", Google Translate outputs "democratic"
    // Gate catches both the correct form AND the STT-garbled split "de ocratică"
    // Cannot use /ocratic/ alone — "democratic" in source also contains it
    // Confirmed: 2026-05-17 — "istoria noastră de ocratică" → "our democratic history"
    if (/(teocratic|de ocratic)/i.test(sourceText)) {
        result = result.replace(/\bdemocratic\b/gi, 'theocratic');
    }

    // "integri" (maintaining integrity) → Google Translate: "intact"
    // JW context: "a rămâne integri" = to maintain integrity (spiritual steadfastness)
    // Confirmed: 2026-05-17 — "să rămână integri" → "to stay intact"
    if (/\bintegr/i.test(sourceText)) {
        result = result.replace(/\bstay intact\b/gi, 'maintain their integrity');
        result = result.replace(/\bremain intact\b/gi, 'remain faithful');
    }

    // "școala pentru evanghelizatori ai regatului" = "Kingdom Evangelizers' School" (official JW programme name)
    // Confirmed: 2026-05-17 — output "the school for evangelizers of the kingdom"
    if (/evanghelizatori/i.test(sourceText)) {
        result = result.replace(/\bthe school for evangelizers of the kingdom\b/gi, "Kingdom Evangelizers' School");
        result = result.replace(/\bschool for evangelizers of the kingdom\b/gi, "Kingdom Evangelizers' School");
    }

    // Source-aware fix: "evoMAG" = STT mishear of "Iehova" — evoMAG is a Romanian electronics
    // retailer; the /jɛ/ onset of "Iehova" phonetically resembles "evo-".
    // CASE-SENSITIVE GATE — intentional: "evoMAG" only appears capitalised as a brand name;
    // lowercase "evomag" is a different error pattern and not in scope.
    // Confirmed: 2026-05-21 — "oameni care îl iubesc pe evoMAG" → "people who love evoMAG"
    if (/\bevoMAG\b/.test(sourceText)) {
        result = result.replace(/\bevoMAG\b/g, 'Jehovah');
    }

    // Source-aware fix: "omul de ordine" / "oamenii de ordine" = JW meeting attendant/floor steward.
    // Google Translate renders this as "law enforcement officer/people" because the phrase is also
    // used for police/security in Romanian. In a Kingdom Hall, these are volunteer attendants.
    // Gate: /de ordine\b/i covers all inflections (omul/omului/oamenii/oamenilor de ordine).
    // Specific compound forms first (prevents "law enforcement officers" → "attendant officers").
    // Confirmed: 2026-05-21 — "omul de ordine îi îndrumă pe cei prezenți" →
    // "the law enforcement officer directs those present"
    if (/de ordine\b/i.test(sourceText)) {
        result = result.replace(/\blaw enforcement officers\b/gi, 'attendants');
        result = result.replace(/\blaw enforcement officer\b/gi, 'attendant');
        result = result.replace(/\blaw enforcement people\b/gi, 'attendants');
        result = result.replace(/\blaw enforcement\b/gi, 'attendant');
    }

    // Source-aware fix: "primul ajutor" (first aid) → Google Translate: "first help"
    // "First help" is not a recognised English compound noun; "first aid" is the correct medical term.
    // Confirmed: 2026-05-21 fire safety talk — "acordarea primului ajutor" → "providing first help" (×5)
    if (/prim(?:ul|ului)?\s+ajutor/i.test(sourceNorm)) {
        result = result.replace(/\bfirst help\b/gi, 'first aid');
    }

    // Source-aware fix: "apărarea împotriva incendiilor" (fire protection/fire safety) →
    // Google Translate: "against protection" (structural inversion confuses the parser).
    // Confirmed: 2026-05-21 — "regulamentul privind apărarea împotriva incendiilor" →
    // "against protection regulation" (should be "fire protection regulation")
    if (/apararea impotriva incendiilor/i.test(sourceNorm)) {
        result = result.replace(/\bagainst protection\b/gi, 'fire protection');
    }

    // Source-aware fix: "starea morților" (condition of the dead) — JW theological topic.
    // STT garbles "morților" (of the dead) to "morală" (moral) → Google Translate: "Moral State".
    // "Starea morților" is a core JW doctrine about what happens after death; "Moral State" is
    // completely wrong. Confirmed: 2026-05-21 — "adevărul cu privire la Starea morală" →
    // "the truth about the Moral State"
    // ONLY replace the title-cased "Moral State" (Google Translate output for the garble).
    // Lowercase "moral state" is legitimate English output when a speaker genuinely discusses
    // the moral condition of the world — replacing it would cause doctrine confusion.
    if (/starea moral/i.test(sourceText)) {
        result = result.replace(/\bMoral State\b/g, 'condition of the dead');
    }

    // Source-aware fix: "cașul de Cult" = STT garble of "casa de cult" (house of worship /
    // Kingdom Hall). "Worship hut" is degrading and wrong; "Kingdom Hall" is the correct JW term.
    // Confirmed: 2026-05-21 — "să evacueze la cașul de Cult" → "to evacuate to the Worship hut"
    if (/cașul de Cult|casei de cult|casa de cult/i.test(sourceText)) {
        result = result.replace(/\bWorship hut\b/gi, 'Kingdom Hall');
    }

    // Source-aware fix: "pe Lot" = biblical Lot (nephew of Abraham), not "by lot" (drawing of lots).
    // Romanian direct-object marker "pe" + name "Lot" → Google Translate interprets "lot" as idiom.
    // Gate: source has "pe Noe" AND "pe lot" (both often cited together as faithful servants saved
    // by Jehovah — Gen 7, Gen 19). The pairing "Noe...Lot" uniquely identifies the biblical context.
    // Confirmed: 2026-05-21 — "Biblia nu l-a salvat pe Noe pe lot" → "did not save Noah by lot"
    if (/pe Noe/i.test(sourceText) && /\bpe [Ll]ot\b/.test(sourceText)) {
        result = result.replace(/\bby lot\b/gi, 'Lot');
    }

    // Source-aware fix: "Turnul de Vegan" = STT garble of "Turnul de Veghe" (The Watchtower).
    // STT commits "Vegan" (the diet) over "Veghe" (watchfulness) despite phrase hint.
    // Post-processor is the fallback when the STT hint fails.
    // Confirmed: 2026-05-24 — "revista Turnul de Vegan" → "The tower de Vegan"
    if (/Turnul de Vegan/i.test(sourceText)) {
        result = result.replace(/\btower\s+(?:de|of)\s+Vegan\b/gi, 'Watchtower');
        result = result.replace(/\b(?:de|of)\s+Vegan\b/gi, 'Watchtower');
    }

    // Source-aware fix: "conferința publică" = JW public talk (a single discourse), not a "conference"
    // (which implies a multi-session event). Google Translate consistently produces "public conference".
    // Confirmed: 2026-05-24 — "conferința publică de astăzi" → "today's public conference"
    if (/conferinta publica/i.test(sourceNorm)) {
        result = result.replace(/\bpublic conference\b/gi, 'public talk');
    }

    // Source-aware fix: "rugăm" rule extension — "We Please to" pattern not caught by v203 rule.
    // v203 catches "Please for" and "to Please" but misses sentence-initial "We Please to/towards".
    // Confirmed: 2026-05-24 — "te rugăm Iehova și în aceste clipe" → "We Please to Jehovah"
    if (/rugăm|rugam/i.test(sourceNorm)) {
        result = result.replace(/\bWe [Pp]lease\b/g, 'We pray');
        result = result.replace(/\bwe [Pp]lease\b/g, 'we pray');
        // "ne rugăm" (we pray) → MT outputs "Please" when fragments arrive without subject
        // "must Please to Jehovah" pattern from 2026-07-19 Sunday meeting
        result = result.replace(/\bmust Please to Jehovah\b/gi, 'must pray to Jehovah');
    }

    // Grammar fix: Romanian possessive + definite article suffix on noun → "your the X" double article.
    // "ajutorul tău" → "your the help"; "cuvântul tău" → "your the word". No source gate needed —
    // "your the" is never correct English regardless of context.
    result = result.replace(/\byour the\b/gi, 'your');

    // Grammar fix: "spiritul tău cel sfânt" → "your holy the spirit" (same possessive/article issue
    // but the adjective "holy" sits between possessive and "the"). Fix the "holy the spirit" fragment.
    result = result.replace(/\bholy the spirit\b/gi, 'Holy Spirit');

    // "există" → "exist are" (ungrammatical) — never valid English
    result = result.replace(/\bexist are\b/gi, 'there are');

    // "plăcut lui Iehova" → "pleasant Jehovah" — adjective used where verb needed
    result = result.replace(/\bpleasant Jehovah\b/gi, 'pleasing to Jehovah');

    // "rețelele de socializare" → "social networks" — correct to "social media"
    // "socializare" has no diacritics, so sourceText is sufficient (no need for sourceNorm)
    if (/socializare/i.test(sourceText)) {
        result = result.replace(/\bsocial networks\b/gi, 'social media');
    }

    // "judecată sănătoasă" → "common sense" — article uses "good judgment"
    // Confirmed: 2026-05-24 WT audio test (w_M_202603_03 paragraph 15/18)
    if (/judecata sanatoasa/i.test(sourceNorm)) {
        result = result.replace(/\bcommon sense\b/gi, 'good judgment');
    }

    // "o presiune continuă" → "continue pressure" — Romanian adjective form mistaken for verb
    result = result.replace(/\bcontinue pressure\b/gi, 'continuous pressure');

    // "resursele materiale" → "materials resources" (noun used as adj) — Confirmed: 2026-05-24 Awake audio test
    result = result.replace(/\bmaterials resources\b/gi, 'material resources');

    // "the Bible say" — missing 3rd-person 's' — recurring across all Awake/WT articles
    // Replacer preserves original capitalisation ("The" at sentence start vs "the" mid-sentence)
    result = result.replace(/\bthe Bible say\b/gi, (m) => (m[0] === 'T' ? 'The' : 'the') + ' Bible says');

    // "sfaturi" → "tips" — too casual; correct to "advice" — Confirmed: 2026-05-24 Awake audio test
    if (/sfaturi/i.test(sourceText)) {
        result = result.replace(/\btips\b/gi, 'advice');
    }

    // "află mai multe" → "find out many"/"learn many" — "many" vs "more" — Confirmed: 2026-05-24 Awake audio test
    result = result.replace(/\bfind out many\b/gi, 'find out more');
    result = result.replace(/\blearn many\b/gi, 'find out more');

    // "resursele medicale" → "physician resources" — should be "medical resources"
    result = result.replace(/\bphysician resources\b/gi, 'medical resources');

    // "nu mai merită să trăiești" → "no longer deserve living" — should be "no longer worth living"
    result = result.replace(/\bno longer deserve living\b/gi, 'no longer worth living');

    // --- 2026-06-14 Sunday meeting fixes ---

    // "cei care iubesc" → "who I love" (Google MT picks 1sg form of "iubesc" when context is clipped)
    // Affects: "those who I love the truth", "people who I love", "all who I love God", etc.
    // Gated on "iubesc" in source: "who I love" is valid English in testimonial/prayer sentences,
    // so we only correct it when the Romanian source confirms the 3pl relative-clause pattern.
    if (/\biubesc\b/i.test(sourceNorm)) {
        result = result.replace(/\bwho I love\b/g, 'who love');
    }

    // "a început" (he started) → uninflected "start" when partial context arrives
    result = result.replace(/\bJesus start\b/gi, 'Jesus started');
    result = result.replace(/\bhe start\b/gi, (m) => (m[0] === 'H' ? 'He' : 'he') + ' started');

    // "a creat" (he created) → uninflected "creator" in translation output; gated on "creat" in source
    if (/\bcreat\b/i.test(sourceNorm)) {
        result = result.replace(/\bhe creator\b/gi, 'he created');
    }

    // "cum anume" → "what certain" / "how certain" (recurring mistranslation of Romanian emphatic "anume")
    result = result.replace(/\bwhat certain\b/gi, 'what exactly');
    result = result.replace(/\bhow certain\b/gi, 'exactly how');

    // "vărul de minciuni" → "cousin of lies" ("vărul" = veil/cousin homograph; context is always veil)
    result = result.replace(/\bthe cousin of lies\b/gi, 'the veil of lies');

    // "combinația creștină" (STT for "congregația creștină") → "Christian combination"
    result = result.replace(/\bChristian combination\b/gi, 'Christian congregation');

    // "Satanei" STT-garbled to "Safari" → "Safari's lies/deceptions" in translation output
    result = result.replace(/\bSafari's (lies|deceptions|falsehoods)\b/gi, "Satan's $1");

    // "exprimată" STT-garbled to "estimată" → "conviction estimated by the apostle Paul"
    result = result.replace(/\bconviction estimated by\b/gi, 'conviction expressed by');

    // "numit Armageddon" STT-garbled to "neumit Armageddon" (non-word) → "appointed/unending Armageddon"
    result = result.replace(/\bwar appointed Armageddon\b/gi, 'war called Armageddon');
    result = result.replace(/\bunending war of Armageddon\b/gi, 'war called Armageddon');

    // "paragraful N" STT-garbled to "graful N" → "graph N" in translation output
    // Gated on "paragraful" in source to avoid touching legitimate "graph N" references.
    if (/\bparagraful\b/i.test(sourceNorm)) {
        result = result.replace(/\bgraph (\d+)\b/gi, 'paragraph $1');
    }

    // "Romani" (Bible book) not converted by glossary when source was lowercase.
    // Gate on source having "romani \d" (Bible book always has chapter number; ethnic group never does).
    // Line 172 above is also updated to exclude this case, so the two rules are logically independent.
    if (/romani\s+\d/i.test(sourceText)) {
        result = result.replace(/\bRomani\b(?=\s+\d)/g, 'Romans');
    }

    // 2026-07-19 Sunday meeting fixes:

    // "lui sfânt" fragment without "spiritul" context → MT produces "holy shit"
    // In a JW meeting this can only ever mean Holy Spirit. Ungated — never valid in this context.
    result = result.replace(/\bholy shit\b/gi, 'Holy Spirit');

    // "sens" (meaning/purpose) → STT mishears as "sexi"/"sex" → MT outputs "sexy"/"sex"
    // Gated on source containing "sens" — speakers may legitimately discuss sexual immorality.
    if (/\bsens(ul)?\b/i.test(sourceNorm)) {
        result = result.replace(/\btrue sexy\b/gi, 'true meaning');
        result = result.replace(/\bsearch for sex\b/gi, 'search for meaning');
        result = result.replace(/\blooking for sex\b/gi, 'looking for meaning');
    }

    // "există" (there is/exists) → MT renders "exist is" or "exist was" (literal transliteration)
    // Gated on source containing "există"/"exista" — "exist is a/no" can appear in valid English otherwise.
    if (/\bexist[aă]\b/i.test(sourceNorm)) {
        result = result.replace(/\b(exist) is (an?)\b/gi, (m, w, art) => (w[0] === 'E' ? 'There' : 'there') + ' is ' + art);
        result = result.replace(/\b(exist) is no\b/gi, (m, w) => (w[0] === 'E' ? 'There' : 'there') + ' is no');
        result = result.replace(/\b(exist) was no\b/gi, (m, w) => (w[0] === 'E' ? 'There' : 'there') + ' was no');
    }

    // "a creat" (created) → MT outputs "creator" for short fragments — Confirmed: 2026-07-19
    result = result.replace(/\bGod (creator) man\b/gi, (m, w) => 'God ' + (w[0] === 'C' ? 'Created' : 'created') + ' man');

    // "chipul lui Dumnezeu" → STT garbles "Dumnezeu" to a number → "image of 69" etc.
    // Gated on "chipul" in source — "image of [number]" is never valid in this context.
    if (/\bchipul\b/i.test(sourceNorm)) {
        result = result.replace(/\bimage of \d+\b/gi, 'image of God');
    }

    // "nepoate" (masculine vocative: young man/son, term of affection) → MT outputs "granddaughter" (wrong gender).
    // The conductor says "Iehova, nepoate!" as an affirmation after a student answers.
    // Gated on "nepoate" in source to avoid touching unrelated "granddaughter" references.
    if (/\bnepoate\b/i.test(sourceText)) {
        result = result.replace(/\bgranddaughter\b/gi, 'young man');
    }

    // "se vestește" (is announced/proclaimed) → MT outputs "is hot" for short fragments.
    // Gated on "vesteste"/"vestește" in source.
    if (/\bvesteste\b/i.test(sourceNorm)) {
        result = result.replace(/\bis hot\b/gi, 'is being proclaimed');
    }

    // 2026-07-23 Thursday meeting fixes:

    // "cele 54 de capitole" → STT hears "cai" (horses) → "54 horses" in translation
    result = result.replace(/\b54 horses\b/gi, '54 chapters');

    // "stubbornness led to exile" → STT produced English "exit" for Romanian "exil"
    result = result.replace(/\bstubbornness led to the exit\b/gi, 'stubbornness led to exile');

    // "compasiune" (compassion) → STT produced "compozitor" (composer/music writer)
    result = result.replace(/\bkindness and composer\b/gi, 'kindness and compassion');

    // "memorabile" split across chunks: "memora-" + "-bile" → MT outputs "balls that inspire"
    result = result.replace(/\bballs that inspire us\b/gi, 'examples that inspire us');

    // "nesimțit" used to mean fearless/unflinching → MT outputs negative "insensitive"
    // Gated on source containing "nesimtit" — "brave and insensitive" can be legitimate for antagonists.
    if (/nesimtit/i.test(sourceNorm)) {
        result = result.replace(/\bbrave and insensitive\b/gi, 'brave and steadfast');
        result = result.replace(/\bunfeeling faith\b/gi, 'unwavering faith');
    }

    // "meditând" (meditating) → STT heard "medicina" (medicine)
    result = result.replace(/\bstudying medicine and the examples from the Bible\b/gi, 'meditating on the examples from the Bible');

    // "te rugăm să ne ajuți" (we ask you to help us) → MT fragment: "Please you to help us"
    result = result.replace(/\bPlease you to help us\b/gi, 'we ask you to help us');

    // "the Jehovah" — article wrongly inserted before proper name Jehovah by MT
    result = result.replace(/\bthe Jehovah\b/gi, 'Jehovah');

    // "biruit lumea" (overcome the world, John 16:33) → STT heard "vinzi" (sell) → "sell the world"
    // "overcome" is tense-neutral (works with has/have/will/can); "conquered" breaks after modal verbs.
    result = result.replace(/\bsell the world\b/gi, 'overcome the world');

    // "pun la cale" (plotting/planning) + STT inserts "ferată" → "cale ferată" (railway) → "laying a railway"
    // Gated on "ferat" in source (the STT error word ferată) — "laying a railway" is valid English otherwise.
    if (/ferat/i.test(sourceText)) {
        result = result.replace(/\blaying a railway\b/gi, 'planning');
    }

    // "olarul" (the potter, Jeremiah/Isaiah imagery) → STT hears "molarul" (the molar tooth)
    // Gated on "molarul" in source — prevents false positives if a speaker discusses dentistry.
    if (/\bmolarul\b/i.test(sourceNorm)) {
        result = result.replace(/\bwith the molar\b/gi, 'with the potter');
        result = result.replace(/\bthe molar\b/gi, 'the potter');
    }

    // "glasul unui Olar" → STT heard "glasul" (voice) instead of "vasul" (vessel)
    // "potter's voice breaks" should be "potter's vessel breaks" (Jeremiah 19:11 imagery)
    // Gated on both "olar" (potter talk) and "glasul" (the STT error word) in source.
    if (/\bolar\b/i.test(sourceNorm) && /\bglas/i.test(sourceNorm)) {
        result = result.replace(/\bpotter's voice breaks\b/gi, "potter's vessel breaks");
    }

    // 2026-07-24 deep-dive fixes (thu-1950):

    // Third-person verb agreement — MT drops -s on short fragments (systematic, recurring)
    result = result.replace(/\bhe say\b/gi, (m) => (m[0] === 'H' ? 'He' : 'he') + ' says');
    result = result.replace(/\bit say\b/gi, (m) => (m[0] === 'I' ? 'It' : 'it') + ' says');
    result = result.replace(/\bhe know\b/gi, (m) => (m[0] === 'H' ? 'He' : 'he') + ' knows');
    // "Așa spune Iehova" → "Thus say Jehovah" ("the Jehovah" already cleaned upstream)
    result = result.replace(/\bThus say Jehovah\b/gi, 'Thus says Jehovah');
    result = result.replace(/\bThus say the Lord\b/gi, 'Thus says the Lord');

    // Double-marked negatives — MT inflects the verb after "don't/do not" (grammatically impossible)
    result = result.replace(/\bdoesn't loves\b/gi, "doesn't love");
    result = result.replace(/\bdo not allows\b/gi, 'do not allow');
    // "am văzut" → "we seen" (past participle without auxiliary — regional but wrong in translation)
    result = result.replace(/\bwe seen\b/gi, 'we saw');

    // Untranslated Romanian leaking into English output — MT failed to translate the word
    // "Mulțumim" (Thank you) appears verbatim in output when MT drops it
    result = result.replace(/\bMulțumim\b/g, 'Thank you');

    // "traducerea/traducerii lumii" (the world translation) → should be "New World Translation" (JW Bible)
    // Source gate: only fires when "traduc" + "lumii" appear together in source
    if (/traduc\w*\s+\w*\s*lumii|lumii\s+\w*\s*traduc/i.test(sourceNorm)) {
        result = result.replace(/\bworld translation\b/gi, 'New World Translation');
    }

    // "bucura" (to enjoy/rejoice) → MT strips prefix → "to joy the" instead of "to enjoy the"
    result = result.replace(/\bto joy the\b/gi, 'to enjoy the');

    // 2026-07-24 deep-dive fixes (thu-2045):

    // "indiferent de/că/cât" (regardless of / no matter) → MT renders literally as "indifferent"
    // "indifferent of/how/what" is not natural English; "regardless of" / "no matter" is correct.
    // Ordered most-specific first to avoid overlapping replacements.
    result = result.replace(/\bindifferent of whether\b/gi, 'regardless of whether');
    result = result.replace(/\bindifferent of\b/gi, 'regardless of');
    result = result.replace(/\bindifferent (how)\b/gi, 'no matter $1');
    result = result.replace(/\bindifferent (what)\b/gi, 'no matter $1');
    result = result.replace(/\bindifferent (that)\b/gi, 'regardless of the fact $1');

    // "con reglației/con regulation" → STT garbles "congregației" (of the congregation)
    result = result.replace(/\bcon regulation\b/gi, 'congregation');

    // "Jehovah is my the help" → stray article inserted between possessive and noun
    result = result.replace(/\bmy the help\b/gi, 'my help');

    // 2026-07-26 Sunday meeting deep-dive fixes:

    // "rugăm/roagă/rugăciune" → Google Translate reads politeness marker "rog" → outputs "Please"
    // Gate: source must contain "rug" (covers rugăm, roagă, rugăciune, rugați)
    // Gate covers rugăm/rugăciune (rug) AND roagă/Roagă-te (roag) forms
    if (/rug|roag/i.test(sourceNorm)) {
        result = result.replace(/let's\s+Please\b/gi, 'let us pray');
        result = result.replace(/\blet's pray\b/gi, 'let us pray'); // fallback if two-step fires
        result = result.replace(/\bshould Please to God\b/gi, 'should pray to God');
        result = result.replace(/\bwe Please\b/gi, 'we pray');
        result = result.replace(/\bPlease to God\b/gi, 'pray to God');
    }

    // Iehova mishearings → garbled English proper nouns
    // Gate: source must contain Iehova (or close variant)
    if (/iehov|ihova/i.test(sourceNorm)) {
        result = result.replace(/\btrust in Moldova\b/gi, 'trust in Jehovah');
        result = result.replace(/\bworship of export\b/gi, 'worship of Jehovah');
        result = result.replace(/\bask a sheep for\b/gi, 'ask Jehovah for');
        result = result.replace(/\bhova (ever|always)\b/gi, 'Jehovah $1');
    }

    // "instruire (suplimentară)" garbled by STT into medical/unrelated words
    // "additional insulin" / "without higher insulin" — never valid; no gate needed
    result = result.replace(/\badditional insulin\b/gi, 'additional training');
    result = result.replace(/\bwithout (?:a )?higher insulin\b/gi, 'without higher education');
    // "Love Island" ← STT transcribed "instruirea" as "Insula iubirii" (Romanian TV show name)
    // "Insula iubirii" = STT garble of "instruirea" (Romanian TV show name for Love Island)
    if (/insula iubirii/i.test(sourceText)) {
        result = result.replace(/\bLove Island\b/gi, 'additional training');
    }
    // "additional inspiration" in training context (gate: instruire in source)
    if (/instruir/i.test(sourceNorm)) {
        result = result.replace(/\badditional inspiration\b/gi, 'additional training');
        result = result.replace(/\bit inspires you\b/gi, 'it trains you');
        // STT garble: "instruire" → "distruge suplimentară" → "additional education or skating"
        result = result.replace(/\badditional (?:education|training) or skating\b/gi, 'additional training');
        // STT garble: "instruire superioară" → "o inspire superioară" → MT: "inspired by a higher power"
        result = result.replace(/\binspired by a higher power\b/gi, 'higher education');
    }

    // "Jehovah 's" → "Jehovah's" (spacing artifact from MT tokenisation)
    result = result.replace(/\bJehovah 's\b/g, "Jehovah's");

    // Double article artifacts: "his the word", "our the words"
    result = result.replace(/\bhis the (\w)/g, 'his $1');
    result = result.replace(/\bour the (\w)/g, 'our $1');

    // "mi-a plăcut" → MT outputs "I pleasant" instead of "I liked"
    // More-specific rule first to prevent "I pleasant" firing inside "me and I pleasant"
    result = result.replace(/\bme and I pleasant\b/gi, 'and I liked');
    result = result.replace(/\bI pleasant\b/gi, 'I liked');

    // "loc de muncă" (job/workplace) → MT outputs "work" (gate on source)
    // Gate on "munc" covers both "loc de muncă" (singular) and "locuri de muncă" (plural)
    if (/munc/i.test(sourceNorm)) {
        result = result.replace(/\ba work\b/g, 'a job');
        result = result.replace(/\bhow many work\b/gi, 'how many jobs');
    }

    // "nu putea bucura" / "se bucure" rendered as "joy" not "rejoice/enjoy"
    result = result.replace(/\bcould not joy\b/gi, 'could not rejoice');
    result = result.replace(/\bwho are joy serving\b/gi, 'who joyfully serve');
    result = result.replace(/\bwere joy\b/gi, 'were joyful');

    // "era nevoie de" (was/were needed) → MT drops the -ed: "were need to" → "were needed to".
    // "were need" / "are need" are never valid English, so no source gate needed. (Singular
    // "was need"/"is need" left alone — ambiguous with "there was/is need to…".)
    result = result.replace(/\b(w)ere need\b/gi, (m, w) => (w === 'W' ? 'Were' : 'were') + ' needed');
    result = result.replace(/\b(a)re need\b/gi, (m, a) => (a === 'A' ? 'Are' : 'are') + ' needed');

    // Romanian past tense flattened to English present. Gated on the past-tense source
    // marker so legitimate present-tense uses ("Jehovah changes hearts", "they need our
    // help") are never touched.
    if (/\bschimbat\b/i.test(sourceNorm)) {
        // "Iehova a schimbat" (Jehovah changed) → MT: "Jehovah change" (also missing -d).
        result = result.replace(/\bJehovah change\b/g, 'Jehovah changed');
    }
    if (/aveau nevoie/i.test(sourceNorm)) {
        // "ei aveau nevoie" (they needed) → MT present "they need".
        result = result.replace(/\b(they) need\b/gi, '$1 needed');
    }

    // "necazul cel mare" (the great tribulation, JW term) misheard by STT as "cazul cel
    // mare" (dropped "ne-"); MT then renders "cazul" as "event/case". The gate matches both
    // the garbled and correct forms since "necazul" ends with "cazul cel mare".
    if (/cazul cel mare/i.test(sourceNorm)) {
        result = result.replace(/\bGreat Event\b/g, 'Great Tribulation');
        result = result.replace(/\bgreat event\b/g, 'great tribulation');
        result = result.replace(/\bGreat Case\b/g, 'Great Tribulation');
        result = result.replace(/\bgreat case\b/g, 'great tribulation');
    }

    // "ask Jehovah the help" → stray article
    result = result.replace(/\bask Jehovah the help\b/gi, 'ask Jehovah for help');

    // "a young to" → missing "person" (MT drops "persoană" in youth-education context)
    result = result.replace(/\ba young to\b/gi, 'a young person to');
    result = result.replace(/\bhelp young make\b/gi, 'help a young person make');
    result = result.replace(/\bon young to\b/gi, 'on a young person to');

    // "ce se întâmplă" (what is happening) → MT drops -ing suffix
    result = result.replace(/\bwhat is happen\b/gi, 'what is happening');
    result = result.replace(/\bwhat was happen\b/gi, 'what was happening');

    // Romanian historical present "spune" in past narrative → MT outputs "say" after past-tense verb
    // Allow up to 3 intervening words between past verb and "and say"
    // Negative lookahead (?!to\b) prevents "loved to come and say" / "asked him to stand and say"
    result = result.replace(/\b(\w+ed(?:\s+(?!to\b)\w+){0,3})\s+and\s+say\b/gi, '$1 and said');
    result = result.replace(/\b((?:took|came|gave|held|stood|sat|ran|went|brought|put|told|asked|called|made|kept|left|met)(?:\s+(?!to\b)\w+){0,5})\s+and\s+say\b/gi, '$1 and said');

    // "everything/something/anything that happen" → singular subject requires "happens"
    result = result.replace(/\b(everything|something|anything|nothing)\s+that\s+happen\b/gi, '$1 that happens');

    // "Na te rog" → "Please don't." — "Na" = "here you go / go ahead"; MT reads "Na" as negation
    // Gate: source must contain "na" as standalone word (imperative particle, not the syllable)
    if (/\bna\b/i.test(sourceText)) {
        result = result.replace(/\bPlease don't\.\b/gi, 'Go ahead, please.');
        result = result.replace(/\bPlease don't\b/gi, 'Go ahead, please');
    }

    // 2026-07-26 deep-dive second-pass fixes (v217):

    // P4: "differently" before noun → "different" (Romanian adj "diferit" mismapped to adverb by MT)
    // Excludes prepositions and past participles (-ed forms) to avoid false positives.
    result = result.replace(/\bdifferently\s+(?!from\b|than\b|to\b|by\b|in\b|of\b|with\b|on\b|at\b|for\b|about\b|\w*ed\b)/gi, 'different ');

    // Scripture citation: "N with M" → "N:M" — MT translates Romanian chapter-verse separator
    // "cu" as "with". Gate: source must contain "digit cu digit" (the Romanian citation pattern).
    // Confirmed source patterns: "Psalm 94 cu 19", "Galateni 6 cu 5", "Isaia 41 cu 10".
    if (/\b\d+\s+cu\s+\d+\b/.test(sourceText)) {
        result = result.replace(/\b(\d+)\s+with\s+(\d+)\b/g, '$1:$2');
    }

    // "second cold" — STT mishears "regi" (Kings) as "reci" (cold) → "second cold 19 with 35"
    // "second cold" is never valid English; safe to fix without source gate.
    result = result.replace(/\bsecond cold\b/gi, '2 Kings');

    // Verb agreement: subject + bare "Promise" → "promises" (missing 3rd-person -s)
    // Confirmed: "Jehovah Promise us", "He promise us", "He promise to continue" (3 instances)
    result = result.replace(/\b(Jehovah|He|She|God|Jesus)\s+[Pp]romise\b(?![sd]\b)/g, '$1 promises');

    // Verb agreement: "Jehovah support" → "Jehovah supports"
    result = result.replace(/\bJehovah\s+support\b(?!s\b|ed\b|ing\b)/g, 'Jehovah supports');

    // "who care of us" → "who cares for us" ("care grijă de noi" → wrong preposition + missing -s)
    result = result.replace(/\bwho care of us\b/gi, 'who cares for us');

    // Missing possessive: "Jehovah servants/servant" (MT drops apostrophe-s)
    // Safe: "Jehovah's servants" won't match \bJehovah\s+ (no whitespace between Jehovah and ')
    result = result.replace(/\bJehovah\s+(servants?)\b/g, "Jehovah's $1");

    // "was full with" → "was filled with" ("plină de" = filled with, not full with)
    result = result.replace(/\bwas full with\b/gi, 'was filled with');

    // P7: "Joy" as verb — "se vor bucura vreodată de adevărata dreptate" (will they ever enjoy)
    // MT strips prefix → "joy" (noun) instead of "enjoy" (verb). Confirmed: next-week talk title.
    // Case-preserving: title-case input ("Will We Ever Joy") keeps title case in output.
    result = result.replace(/\bwill we ever joy\b/gi, (m) =>
        m[0] === 'W' ? 'Will We Ever Enjoy' : 'will we ever enjoy'
    );

    // "are happen" → "are happening" (same pattern as "what is happen" fixed in v215)
    result = result.replace(/\bare happen\b/gi, 'are happening');

    // Mid-sentence "Decision" → "decision" (MT over-capitalises "decizia" with definite article)
    // Only fires when preceded by article/demonstrative — never at sentence start.
    result = result.replace(/\b(the|a|this|that|an)\s+Decision\b/g, '$1 decision');

    // P6: "Jesus learned his listeners" → "taught" ("a învăța pe cineva" = to teach someone)
    // Covers "Jesus also learned" variant.
    result = result.replace(/\b(Jesus(?:\s+also)?)\s+learned\s+(his\s+listeners?)\b/gi, '$1 taught $2');

    // "a învăța PE cineva" (to teach someone) — the personal-accusative "pe <people>" marks
    // teaching, not learning, but MT renders "învăța" as "learn". Acts 21:21: "înveți pe toți
    // iudeii" → "you learn all the Jews" should be "you teach…". Gate on the "înv…pe"
    // construction in source (normalized: inveti/invata … pe) so ordinary "you learn" is safe.
    if (/\binv[ae]\w*\s+pe\b/i.test(sourceNorm)) {
        result = result.replace(/\byou learn\b/gi, (m) => (m[0] === 'Y' ? 'You' : 'you') + ' teach');
    }

    // "the verse say" → "the verse says" (3rd-person -s missing, same pattern as "the Bible say")
    result = result.replace(/\bthe verse say\b/gi, 'the verse says');

    // "and start to pray" → "and started to pray" in past narrative ("a început să se roage")
    result = result.replace(/\band start to pray\b/gi, 'and started to pray');

    return result;
}

/**
 * Verify religious proper nouns survived translation correctly (en→ro direction).
 *
 * When translating English to Romanian, Google may produce incorrect variants of
 * JW proper nouns (e.g. 'Jehova' instead of 'Iehova', 'Biblie' instead of 'Biblia').
 * This function patches known bad variants to the authoritative Romanian JW form.
 *
 * Only runs when targetLang is 'ro'.
 *
 * @param {string} translated - Translation output to verify
 * @param {string} sourceText - Original English source (used to detect which terms appeared)
 * @param {string} targetLang - Target language code (only patches when 'ro')
 * @returns {string} Corrected translation
 */
function verifyReligiousTerms(translated, sourceText, targetLang) {
    if (targetLang !== 'ro') return translated;

    // English trigger term → canonical Romanian JW form
    const religiousTerms = {
        'jehovah':  'Iehova',
        'satan':    'Satana',
        'bible':    'Biblia',
        'jesus':    'Isus',
        'christ':   'Hristos',
        'god':      'Dumnezeu',
        'devil':    'diavolul',
        'kingdom':  'regatul',
        'heaven':   'cerul',
        'prayer':   'rugăciune',
        'faith':    'credință',
    };

    // Canonical Romanian form → incorrect variants Google may produce
    const romanianVariants = {
        'Iehova':    ['Iehvoa', 'Ievhova', 'Jehova'],
        'Satana':    ['Satan'],
        'Isus':      ['Iisus'],
        'Hristos':   ['Cristos', 'Christos'],
        'Dumnezeu':  ['Dumnezău'],
        'Biblia':    ['Biblie'],
        'diavolul':  ['diavol'],
        'regatul':   ['regat'],
        'cerul':     ['cer'],
        'rugăciune': ['rugăciunea'],
        'credință':  ['credința'],
    };

    const sourceLower = sourceText.toLowerCase();
    let result = translated;

    for (const [engTerm, roTerm] of Object.entries(religiousTerms)) {
        if (new RegExp('\\b' + engTerm + '\\b').test(sourceLower)) {
            for (const variant of (romanianVariants[roTerm] || [])) {
                const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                result = result.replace(new RegExp(escaped, 'gi'), roTerm);
            }
        }
    }

    return result;
}

/**
 * Preserve numbers from source text to avoid numeric drift in translation.
 *
 * Google Translate sometimes alters or drops numbers. Romanian uses '.' as a
 * thousands separator ("68.128" = 68,128 in English); we must not replace
 * Google's correctly-converted English comma-format back to the dot-format.
 *
 * @param {string} sourceText - Original Romanian source with authoritative numbers
 * @param {string} translatedText - Translation output that may have drifted numbers
 * @returns {string} Translation with numbers restored from source
 */
function preserveSourceNumbers(sourceText, translatedText) {
    const numberRegex = /\d+(?:\.\d{3})+|\d+(?:[.,]\d+)?/g;
    const sourceNumbers = sourceText.match(numberRegex) || [];
    if (sourceNumbers.length === 0) return translatedText;

    const isRomanianThousands = (n) => /^(\d+\.)+\d{3}$/.test(n);

    let result = translatedText;
    const translatedNumbers = translatedText.match(numberRegex) || [];

    if (translatedNumbers.length === sourceNumbers.length) {
        // Positional restore: rewrite the i-th number in the translation to the
        // i-th source number. Using a replace-callback walks matches in order so
        // repeated values (e.g. "3 ... 3") map to the correct position — a plain
        // string .replace() would always hit the first occurrence and corrupt it.
        let i = 0;
        result = result.replace(numberRegex, (match) => {
            const srcNum = sourceNumbers[i++];
            if (!srcNum || isRomanianThousands(srcNum)) return match;
            return srcNum;
        });
        return result;
    }

    // Track how many occurrences of each digit-string we've already placed, so two
    // source numbers with identical digits map to distinct occurrences rather than
    // both clobbering the first one. (Spliced-in srcNum keeps the same digit-string,
    // so skipping already-consumed occurrences advances to the next one.)
    const consumedByDigits = new Map();
    sourceNumbers.forEach((srcNum) => {
        if (isRomanianThousands(srcNum)) return;
        const digits = srcNum.replace(/[.,]/g, '');
        const splitPattern = new RegExp(`(\\d+[\\s.,]+){0,2}\\d+`, 'g');
        const matches = [...result.matchAll(splitPattern)];
        let skip = consumedByDigits.get(digits) || 0;
        for (const m of matches) {
            const candidate = m[0];
            const candidateDigits = candidate.replace(/[\s.,]/g, '');
            if (candidateDigits === digits) {
                if (skip > 0) { skip--; continue; } // occurrence already used by an earlier source number
                // Splice at the matched position rather than replacing the first
                // occurrence of the candidate substring, which may appear earlier.
                result = result.slice(0, m.index) + srcNum + result.slice(m.index + candidate.length);
                consumedByDigits.set(digits, (consumedByDigits.get(digits) || 0) + 1);
                break;
            }
        }
    });

    return result;
}

/**
 * Preserve date components if month drops out in translation.
 *
 * Google sometimes drops the Romanian month name when translating a full date
 * ("15 martie 2024" → "15 2024"). Restores the month from source when missing.
 *
 * @param {string} sourceText - Original Romanian source with complete dates
 * @param {string} translatedText - Translation output that may be missing the month
 * @returns {string} Translation with dates restored
 */
function preserveDates(sourceText, translatedText) {
    const monthNames = [
        'ianuarie','februarie','martie','aprilie','mai','iunie','iulie','august','septembrie','octombrie','noiembrie','decembrie',
        'january','february','march','april','may','june','july','august','september','october','november','december'
    ];
    const monthRegex = new RegExp(`\\b(${monthNames.join('|')})\\b`, 'i');
    const dateRegex = /(\d{1,2})\s+([A-Za-zăâîșțéó]+)\s+(\d{4})/gi;

    let result = translatedText;
    let m;
    while ((m = dateRegex.exec(sourceText)) !== null) {
        const [, day, month, year] = m;
        const hasMonthInTranslation = monthRegex.test(result);
        const hasDay = result.includes(day);
        const hasYear = result.includes(year);

        if (hasDay && hasYear && !hasMonthInTranslation) {
            const dayYearPattern = new RegExp(`${day}[\\s.,]*${year}`);
            if (dayYearPattern.test(result)) {
                result = result.replace(dayYearPattern, `${day} ${month} ${year}`);
            } else {
                result = result.replace(year, `${month} ${year}`);
            }
        }
    }
    return result;
}

/**
 * Extract the unemitted portion of a full translation using word-level LCP matching.
 *
 * Sends the full STT transcript to Google Translate for maximum context quality,
 * then extracts only the new (unemitted) portion using word-level LCP matching.
 *
 * If ≥75% of committedTranslation words match the prefix of translatedFull,
 * returns the tail (new words). Otherwise returns null — caller should emit the
 * full translation.
 *
 * Romanian diacritics (ă, â, î, ș, ț) are preserved as word characters via
 * Unicode property escapes (\p{L}\p{N} with /u flag).
 *
 * @param {string} translatedFull - Translation of the full STT transcript
 * @param {string} committedTranslation - Full translation from the previous call
 * @returns {string|null} New tail to emit, or null if LCP ratio < 75%
 */
function extractByWordLCP(translatedFull, committedTranslation) {
    const trimmedFull = translatedFull.trim();
    const trimmedCommitted = committedTranslation.trim();
    if (!trimmedCommitted) return trimmedFull;
    if (!trimmedFull) return null;

    // Normalize: split on whitespace, strip leading/trailing punctuation, lowercase.
    // Use \p{L}\p{N} (unicode property escapes) so Romanian diacritics (ă, â, î, ș, ț)
    // are preserved as word characters and not stripped by the boundary replace.
    const normalizeWord = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const normalizeWords = (s) =>
        s.split(/\s+/)
         .map(normalizeWord)
         .filter(w => w.length > 0);

    const committedNorm = normalizeWords(trimmedCommitted);

    // Build fullNorm and fullOrigWords together so their indices always align.
    // Pure-punctuation tokens (e.g. em-dash "—", "...") normalize to empty string and
    // must be excluded from BOTH arrays — otherwise lastMatchedInFull (a fullNorm index)
    // would be used to slice fullOrigWords at the wrong position.
    const fullNorm = [];
    const fullOrigWords = [];
    for (const token of trimmedFull.split(/\s+/)) {
        const norm = normalizeWord(token);
        if (norm.length > 0) {
            fullNorm.push(norm);
            fullOrigWords.push(token);
        }
    }

    if (committedNorm.length === 0) return trimmedFull;
    if (fullNorm.length <= committedNorm.length) return null;

    // Greedy subsequence scan with bounded lookahead window.
    //
    // Problem: Google Translate non-determinism produces translations that differ in
    // multiple scattered ways: inserted/deleted articles ("the"), word-form changes
    // ("congregate"→"congregation"), synonym swaps ("connection"→"contact"). Strict
    // prefix matching breaks on the first difference; a substitution budget (previous
    // fix) is exhausted after 1-2 scattered changes in a 30-word sequence, so the
    // ratio drops below 75% and the entire full text is re-emitted as a duplicate.
    //
    // Solution: for each committed word, search for it in fullNorm within a small
    // lookahead window starting at the current scan position. If found, advance the
    // scan cursor past it. If not found (deleted or substituted in full), skip the
    // committed word without advancing the scan cursor — the 75% match threshold
    // still guards against genuine divergence.
    //
    // The tail starts immediately after the last matched full-position, so skipped
    // committed words and inserted full words between matched positions are absorbed
    // into the "committed prefix" region and do not re-appear in the output.
    //
    // WINDOW=3 handles up to 3 consecutive word insertions in full between any two
    // consecutive matched committed words (e.g. multiple articles/prepositions).
    const WINDOW = 3;
    let matchCount = 0;
    let lastMatchedInFull = -1;
    let iInFull = 0;

    for (let iCommitted = 0; iCommitted < committedNorm.length; iCommitted++) {
        if (iInFull >= fullNorm.length) break;
        const searchEnd = Math.min(iInFull + WINDOW + 1, fullNorm.length);
        for (let j = iInFull; j < searchEnd; j++) {
            if (fullNorm[j] === committedNorm[iCommitted]) {
                matchCount++;
                lastMatchedInFull = j;
                iInFull = j + 1;
                break;
            }
        }
        // If not found in window: committed word was deleted or substituted in full.
        // Don't advance iInFull — retry from same position for the next committed word.
    }

    const matchRatio = matchCount / committedNorm.length;
    if (matchRatio < 0.75) return null;

    const tail = fullOrigWords.slice(lastMatchedInFull + 1).join(' ').trim();
    return tail || null;
}

module.exports = {
    applyTermMappings,
    verifyReligiousTerms,
    preserveSourceNumbers,
    preserveDates,
    extractByWordLCP,
};
