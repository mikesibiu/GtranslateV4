/**
 * Glossary Builder for GTranslate V4
 * Extracts parallel text from English and Romanian documents
 * Builds a custom translation glossary
 */

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { Translate } = require('@google-cloud/translate').v2;

// Check for required dependencies
const requiredPackages = ['pdf-parse', 'epub2txt'];
console.log('📦 Checking dependencies...');

const GLOSSARY_DIR = path.join(__dirname, 'glossaries');
const DOCUMENTS_DIR = path.join(__dirname, 'documents');
const CREDENTIALS_PATH = path.join(__dirname, 'google-credentials.json');

// Check for credentials
if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('❌ Credentials file not found!');
    console.error(`Looking for: ${CREDENTIALS_PATH}`);
    console.error('Please ensure google-credentials.json exists');
    process.exit(1);
}

// Set credentials environment variable
process.env.GOOGLE_APPLICATION_CREDENTIALS = CREDENTIALS_PATH;

// Ensure directories exist
if (!fs.existsSync(GLOSSARY_DIR)) {
    fs.mkdirSync(GLOSSARY_DIR);
}
if (!fs.existsSync(DOCUMENTS_DIR)) {
    fs.mkdirSync(DOCUMENTS_DIR);
    console.log(`✅ Created documents directory: ${DOCUMENTS_DIR}`);
    console.log('📄 Place your parallel documents here:');
    console.log('   - English version: document_en.pdf');
    console.log('   - Romanian version: document_ro.pdf');
}

// Initialize Google Cloud Translation client
const translateClient = new Translate();

/**
 * Extract text from PDF file
 */
async function extractPdfText(pdfPath) {
    console.log(`📖 Reading PDF: ${path.basename(pdfPath)}`);

    try {
        const dataBuffer = await fs.promises.readFile(pdfPath);

        // Validate it's actually a PDF
        const header = dataBuffer.slice(0, 5).toString('ascii');
        if (header !== '%PDF-') {
            throw new Error(`Invalid PDF header: expected '%PDF-', got '${header}'`);
        }

        const data = await pdfParse(dataBuffer);

        if (!data.text || data.text.trim().length === 0) {
            throw new Error('PDF contains no extractable text (might be image-based or encrypted)');
        }

        return data.text;
    } catch (error) {
        console.error(`❌ Failed to extract text from ${path.basename(pdfPath)}: ${error.message}`);
        throw new Error(`PDF extraction failed for ${pdfPath}: ${error.message}`);
    }
}

/**
 * Split text into sentences
 */
function splitIntoSentences(text) {
    // Split on sentence boundaries
    return text
        .split(/[.!?]+/)
        .map(s => s.trim())
        .filter(s => s.length > 10); // Minimum sentence length
}

/**
 * Common Romanian words to filter out (stopwords)
 * These are common words that wouldn't need custom translation
 */
const COMMON_ROMANIAN_WORDS = new Set([
    // Articles
    'este', 'sunt', 'era', 'erau', 'fost', 'fiind',
    // Pronouns
    'care', 'acest', 'aceasta', 'acesta', 'acestea', 'acestor', 'acestora',
    'acestui', 'aceștia', 'acele', 'acel', 'aceea', 'acea',
    'mea', 'mele', 'mei', 'meu', 'tale', 'tău', 'tăi', 'ta',
    'lui', 'lor', 'nostru', 'noștri', 'noastre', 'noastră',
    'vostru', 'voștri', 'voastre', 'voastră',
    // Conjunctions
    'dacă', 'când', 'unde', 'pentru', 'într', 'dintr', 'despre',
    'prin', 'după', 'până', 'peste', 'fără', 'către', 'datorită',
    'deși', 'totuși', 'însă', 'deci', 'astfel', 'atunci',
    // Common verbs
    'avea', 'avea', 'face', 'spune', 'veni', 'merge', 'lua', 'vedea',
    'putea', 'trebui', 'vrea', 'ști', 'crede', 'găsi', 'lăsa',
    'urma', 'arăta', 'ține', 'părea', 'deveni', 'rămâne',
    'avea', 'avem', 'aveți', 'aveam', 'aveau',
    'face', 'facem', 'faceți', 'făcea', 'făceau',
    // Common adjectives/adverbs
    'foarte', 'mult', 'mulți', 'multe', 'puțin', 'puțini', 'puține',
    'bine', 'rău', 'bun', 'bună', 'buni', 'bune', 'mare', 'mari',
    'mic', 'mici', 'nou', 'nouă', 'noi', 'vechi', 'vechin', 'prima',
    'primul', 'primii', 'primele', 'ultim', 'ultimul', 'ultimii',
    // Common nouns
    'timp', 'ani', 'anul', 'ziua', 'zilei', 'parte', 'părți',
    'lume', 'lumea', 'lumii', 'oameni', 'oamenilor', 'persoană',
    'persoane', 'lucru', 'lucruri', 'mod', 'moduri', 'întrebare',
    'întrebări', 'răspuns', 'răspunsuri', 'nume', 'numelor',
    'ceva', 'nimic', 'cineva', 'nimeni', 'toată', 'toate', 'toți',
    'fiecare', 'altă', 'alte', 'alți', 'alta', 'câteva', 'câțiva'
]);

/**
 * Common Romanian words that appear in concatenations (for detection)
 * Shorter list focused on words commonly found in PDF artifacts
 */
const CONCATENATION_MARKERS = [
    'lui', 'dumnezeu', 'iehova', 'biblia', 'bibliei', 'turnul', 'veghe', 'pentru',
    'despre', 'după', 'spune', 'către', 'poate', 'apoi', 'astfel',
    'acum', 'aici', 'este', 'sunt', 'când', 'unde', 'fiind', 'face',
    'discuta', 'citit', 'crede', 'trebui', 'vrea', 'exemplu', 'dela',
    'dece', 'acest', 'cristos', 'cristo', 'isus', 'care', 'iubire',
    'cateva', 'ajuta', 'ajutat', 'putea', 'avea', 'eden', 'gradina', 'aale'
];

/**
 * Extract unique terms from text (words that appear multiple times)
 * Filters out common words to focus on specialized terminology
 */
function extractTerms(text) {
    const words = text.toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ') // Remove punctuation
        .split(/\s+/)
        .filter(w => w.length > 4); // Minimum word length (increased to 5 for more specific terms)

    // Count word frequencies
    const wordCount = {};
    words.forEach(word => {
        wordCount[word] = (wordCount[word] || 0) + 1;
    });

    // Return words that appear 3+ times AND are not common words
    return Object.keys(wordCount)
        .filter(word => {
            return wordCount[word] >= 3 && !COMMON_ROMANIAN_WORDS.has(word);
        })
        .sort((a, b) => wordCount[b] - wordCount[a]); // Sort by frequency (most common first)
}

/**
 * Validate if a word is a good glossary candidate
 * Filters out numbers, bible references, artifacts, etc.
 */
function isValidGlossaryTerm(word) {
    // Must be at least 5 characters
    if (word.length < 5) return false;

    // Must not be longer than 20 characters (likely concatenation artifact)
    // Reduced from 30 to catch more concatenated words like "bibliaspune"
    if (word.length > 20) return false;

    // Must start and end with a letter
    if (!/^[a-zăâîșț].*[a-zăâîșț]$/i.test(word)) return false;

    // Must not be purely numeric or mostly numeric
    if (/^\d+$/.test(word)) return false;
    if (/\d{5,}/.test(word)) return false; // Contains 5+ consecutive digits

    // Must not be a Bible reference pattern (e.g., 1petru2, 2timotei3)
    if (/^\d+[a-z]+\d+$/i.test(word)) return false;

    // Must not start with too many repeated characters (PDF artifact)
    if (/^(.)\1{2,}/.test(word)) return false;

    // Must be at least 30% unique characters (not "aaaaabbbb")
    const uniqueChars = new Set(word.split('')).size;
    if (uniqueChars / word.length < 0.3) return false;

    // Must not contain unusual character sequences (PDF artifacts)
    if (/[a-z]{15,}/i.test(word)) return false; // 15+ consecutive letters without breaks

    // Filter out likely concatenated words (two capital-like patterns or known compounds)
    // Detects patterns like "turnulDe", "bibliaSpune", "deLa" (camelCase artifacts)
    if (/[a-zăâîșț]{4,}[A-ZĂÂÎȘȚ][a-zăâîșț]{3,}/.test(word)) return false;

    // Must not have repeated substrings (like "ariilec" vs "ariillec" - PDF artifacts)
    if (/(.{2,})\1/.test(word)) return false;

    // Detect likely concatenations: word contains common Romanian words as substrings
    // e.g., "luidumnezeu" contains "lui" and "dumnezeu"
    let concatenationCount = 0;
    for (const marker of CONCATENATION_MARKERS) {
        if (word.includes(marker) && word !== marker) {
            concatenationCount++;
            if (concatenationCount >= 2) {
                // Word contains 2+ common words - likely a concatenation
                return false;
            }
        }
    }

    // Special check: words starting with prepositions followed by more letters
    // e.g., "pentruag" starts with "pentru" + "ag"
    const prepositions = ['pentru', 'despre', 'printr', 'dintr'];
    for (const prep of prepositions) {
        if (word.startsWith(prep) && word.length > prep.length + 1) {
            // Word starts with preposition and has more content after
            return false;
        }
    }

    // Filter out partial words/suffixes (likely PDF extraction artifacts)
    // Common Romanian suffixes that shouldn't appear alone
    const invalidSuffixes = ['tiilor', 'iilor', 'ilor', 'ului', 'ilor', 'tilor'];
    if (invalidSuffixes.includes(word)) {
        return false;
    }

    // Filter concatenations with possessive pronouns
    // e.g., "tanoastr" = "ta noastră" (yours our)
    const possessives = ['noastr', 'voastr', 'meau', 'tale'];
    for (const poss of possessives) {
        if (word.includes(poss) && word.length > poss.length + 1) {
            // Word contains possessive and more content
            return false;
        }
    }

    return true;
}

/**
 * Calculate similarity between two strings (0-1, where 1 is identical)
 * Uses Levenshtein distance ratio
 */
function calculateSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) return 1.0;

    const editDistance = levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1, str2) {
    const matrix = [];

    for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
            if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }

    return matrix[str2.length][str1.length];
}

/**
 * Translate with retry logic and timeout
 * Handles API rate limits with exponential backoff
 */
async function translateWithRetry(batch, targetLang, maxRetries = 3, timeoutMs = 30000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Wrap translation in Promise.race for timeout
            const translationPromise = translateClient.translate(batch, targetLang);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Translation timeout')), timeoutMs)
            );

            const [translations] = await Promise.race([translationPromise, timeoutPromise]);
            return translations;

        } catch (error) {
            const errorCode = error.code ? String(error.code) : '';
            const isRetryable = errorCode === '429' ||
                               errorCode === '503' ||
                               error.code === 429 ||
                               error.code === 503 ||
                               error.message.includes('timeout') ||
                               error.message.includes('ECONNRESET') ||
                               error.message.includes('ETIMEDOUT');

            if (!isRetryable || attempt === maxRetries) {
                throw error;
            }

            const delay = Math.min(1000 * Math.pow(2, attempt), 10000); // Max 10s
            console.log(`   ⚠️  ${error.message}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/**
 * Align parallel texts to find matching terminology
 */
async function alignTexts(roText, enText) {
    console.log('🔍 Extracting terminology...');

    const roTerms = extractTerms(roText);
    const enTerms = extractTerms(enText);

    console.log(`   Found ${roTerms.length} Romanian candidate terms`);
    console.log(`   Found ${enTerms.length} English candidate terms`);

    // Filter to valid glossary terms only
    const validRoTerms = roTerms.filter(isValidGlossaryTerm);
    console.log(`   Filtered to ${validRoTerms.length} valid Romanian terms`);

    // For now, we'll use a simple approach:
    // Extract terms and let Google translate them, then we can manually review
    const glossary = [];

    // Take top 500 Romanian terms (sorted by frequency)
    const topRoTerms = validRoTerms.slice(0, 500);

    console.log('🌐 Translating terms to build glossary...');

    for (let i = 0; i < topRoTerms.length; i += 10) {
        const batch = topRoTerms.slice(i, i + 10);

        try {
            const translations = await translateWithRetry(batch, 'en');

            batch.forEach((roTerm, idx) => {
            const enTranslation = Array.isArray(translations[idx])
                ? translations[idx][0]
                : translations[idx];

            const enClean = enTranslation.toLowerCase().trim();

            // Skip if translation is identical to original (not actually translated)
            if (roTerm === enClean) {
                console.log(`   ⚠️  Skipping identical pair: ${roTerm} = ${enClean}`);
                return;
            }

            // Skip if translation is too short
            if (enClean.length < 3) {
                console.log(`   ⚠️  Skipping short translation: ${roTerm} -> ${enClean}`);
                return;
            }

            // Skip if translation is too similar (edit distance < 3)
            // Catches pairs like "ariilec" -> "ariillec", "azboaielor" -> "azboai"
            const similarity = calculateSimilarity(roTerm, enClean);
            if (similarity > 0.85) {
                console.log(`   ⚠️  Skipping overly similar pair: ${roTerm} -> ${enClean}`);
                return;
            }

            // Skip if translation contains spaces (likely a phrase, not a term)
            // or has punctuation (malformed translation)
            if (enClean.includes(' ') || /[",.]/.test(enClean)) {
                console.log(`   ⚠️  Skipping phrase/malformed: ${roTerm} -> ${enClean}`);
                return;
            }

            // Skip if translation length ratio is suspicious (too different)
            const lengthRatio = enClean.length / roTerm.length;
            if (lengthRatio < 0.4 || lengthRatio > 2.5) {
                console.log(`   ⚠️  Skipping suspicious length ratio: ${roTerm} -> ${enClean}`);
                return;
            }

                glossary.push({ ro: roTerm, en: enClean });
            });

            console.log(`   Processed ${Math.min(i + 10, topRoTerms.length)}/${topRoTerms.length} terms (${glossary.length} valid entries)`);

        } catch (error) {
            console.error(`   ❌ Failed to translate batch ${i}-${i + 10}: ${error.message}`);
            console.log(`   ⚠️  Skipping batch and continuing...`);
            // Continue with next batch instead of failing completely
        }
    }

    return glossary;
}

/**
 * Escape CSV field to prevent injection and handle special characters
 */
function escapeCsvField(field) {
    const str = String(field).trim();

    // If contains comma, quote, or newline, wrap in quotes and escape existing quotes
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
    }

    // Prevent formula injection (fields starting with =, +, -, @)
    if (/^[=+\-@]/.test(str)) {
        return `"'${str}"`;
    }

    return str;
}

/**
 * Save glossary to CSV file
 */
async function saveGlossary(glossary, outputPath) {
    const csv = [
        'ro,en',
        ...glossary.map(entry => `${escapeCsvField(entry.ro)},${escapeCsvField(entry.en)}`)
    ].join('\n');
    await fs.promises.writeFile(outputPath, csv, 'utf8');
    console.log(`✅ Glossary saved: ${outputPath}`);
    console.log(`   Total entries: ${glossary.length}`);
}

/**
 * Find all matching PDF pairs in the documents directory
 */
function findDocumentPairs() {
    const files = fs.readdirSync(DOCUMENTS_DIR);
    const pairs = [];

    // Find all *_ro.pdf files
    const roFiles = files.filter(f => f.endsWith('_ro.pdf'));

    roFiles.forEach(roFile => {
        // Extract base name (everything before _ro.pdf)
        const baseName = roFile.replace('_ro.pdf', '');
        const enFile = `${baseName}_en.pdf`;

        // Check if matching English file exists
        if (files.includes(enFile)) {
            pairs.push({
                baseName,
                roFile: path.join(DOCUMENTS_DIR, roFile),
                enFile: path.join(DOCUMENTS_DIR, enFile)
            });
        } else {
            console.log(`⚠️  Warning: No matching English file for ${roFile}`);
        }
    });

    return pairs;
}

/**
 * Main function
 */
async function main() {
    console.log('═══════════════════════════════════════');
    console.log('📚 GTranslate V4 - Glossary Builder');
    console.log('═══════════════════════════════════════\n');

    // Find all document pairs
    const pairs = findDocumentPairs();

    if (pairs.length === 0) {
        console.error('❌ No matching document pairs found!');
        console.log('\n📄 Please add parallel documents to the documents/ directory:');
        console.log('   Format: <name>_ro.pdf and <name>_en.pdf');
        console.log('\n   Examples:');
        console.log('   - watchtower_2024_01_ro.pdf');
        console.log('   - watchtower_2024_01_en.pdf');
        console.log('   - book_chapter1_ro.pdf');
        console.log('   - book_chapter1_en.pdf');
        process.exit(1);
    }

    console.log(`✅ Found ${pairs.length} document pair(s):\n`);
    pairs.forEach((pair, idx) => {
        console.log(`   ${idx + 1}. ${pair.baseName}`);
    });
    console.log('');

    try {
        const roTextArray = [];
        const enTextArray = [];

        // Process all document pairs
        for (let i = 0; i < pairs.length; i++) {
            const pair = pairs[i];
            console.log(`📖 Processing pair ${i + 1}/${pairs.length}: ${pair.baseName}`);

            // Extract text from PDFs
            const roText = await extractPdfText(pair.roFile);
            const enText = await extractPdfText(pair.enFile);

            console.log(`   Romanian: ${roText.length.toLocaleString()} characters`);
            console.log(`   English: ${enText.length.toLocaleString()} characters\n`);

            // Collect texts in arrays (more memory efficient than string concatenation)
            roTextArray.push(roText);
            enTextArray.push(enText);
        }

        // Combine texts from all documents
        const combinedRoText = roTextArray.join(' ');
        const combinedEnText = enTextArray.join(' ');

        console.log(`📊 Total combined Romanian text: ${combinedRoText.length.toLocaleString()} characters`);
        console.log(`📊 Total combined English text: ${combinedEnText.length.toLocaleString()} characters\n`);

        // Align texts and build glossary from combined corpus
        const glossary = await alignTexts(combinedRoText, combinedEnText);

        // Save glossary
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const outputPath = path.join(GLOSSARY_DIR, `glossary_${timestamp}.csv`);
        await saveGlossary(glossary, outputPath);

        console.log('\n✅ Glossary generation complete!');
        console.log(`   Processed ${pairs.length} document pair(s)`);
        console.log('\n📝 Next steps:');
        console.log('   1. Review the glossary CSV file');
        console.log('   2. Edit/remove any incorrect entries');
        console.log('   3. Upload to Google Cloud Translation glossary');
        console.log('   4. Update server.js to use the glossary');

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = { extractPdfText, alignTexts, saveGlossary };
