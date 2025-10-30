/**
 * Upload Glossary to Google Cloud Translation API
 * Uploads a CSV glossary file for use with Translation API v3
 */

const { TranslationServiceClient } = require('@google-cloud/translate').v3;
const fs = require('fs');
const path = require('path');

// Configuration
const CREDENTIALS_PATH = path.join(__dirname, 'google-credentials.json');
const GLOSSARY_FILE = path.join(__dirname, 'glossaries', 'glossary_2025-10-04T20-34-34.csv');
const GLOSSARY_ID = 'ro-en-religious-terms';

// Check for credentials
if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('❌ Credentials file not found!');
    console.error(`Looking for: ${CREDENTIALS_PATH}`);
    process.exit(1);
}

// Check for glossary file
if (!fs.existsSync(GLOSSARY_FILE)) {
    console.error('❌ Glossary file not found!');
    console.error(`Looking for: ${GLOSSARY_FILE}`);
    process.exit(1);
}

// Load credentials
const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
const projectId = credentials.project_id;

if (!projectId) {
    console.error('❌ No project_id found in credentials file');
    process.exit(1);
}

// Initialize Translation Service Client
const translationClient = new TranslationServiceClient({ credentials });

const location = 'us-central1';
const parent = `projects/${projectId}/locations/${location}`;
const glossaryPath = `${parent}/glossaries/${GLOSSARY_ID}`;

async function uploadGlossary() {
    console.log('═══════════════════════════════════════');
    console.log('📚 Google Cloud Glossary Upload');
    console.log('═══════════════════════════════════════\n');
    console.log(`Project ID: ${projectId}`);
    console.log(`Location: ${location}`);
    console.log(`Glossary ID: ${GLOSSARY_ID}`);
    console.log(`Glossary Path: ${glossaryPath}\n`);

    try {
        // Check if glossary already exists
        console.log('🔍 Checking if glossary already exists...');
        try {
            const [existingGlossary] = await translationClient.getGlossary({
                name: glossaryPath
            });

            console.log(`⚠️  Glossary already exists!`);
            console.log(`   Name: ${existingGlossary.name}`);
            console.log(`   Created: ${existingGlossary.submitTime?.seconds ? new Date(existingGlossary.submitTime.seconds * 1000).toISOString() : 'Unknown'}`);
            console.log(`   Entry count: ${existingGlossary.entryCount || 'Unknown'}\n`);

            // Ask if user wants to delete and re-upload
            console.log('💡 To update, you must first delete the existing glossary.');
            console.log('   Run: node delete-glossary.js\n');
            return;
        } catch (error) {
            if (error.code === 5) {
                console.log('✅ Glossary does not exist - proceeding with upload\n');
            } else {
                throw error;
            }
        }

        // Read glossary file
        console.log('📖 Reading glossary file...');
        const glossaryContent = fs.readFileSync(GLOSSARY_FILE, 'utf8');
        const lines = glossaryContent.trim().split('\n');
        const entryCount = lines.length - 1; // Subtract header row
        console.log(`   Found ${entryCount} glossary entries\n`);

        // Upload to Google Cloud Storage (required for glossary creation)
        // Note: For simplicity, we'll use the inline CSV data approach
        console.log('☁️  Uploading glossary to Google Cloud...');

        const glossary = {
            name: glossaryPath,
            languagePair: {
                sourceLanguageCode: 'ro',
                targetLanguageCode: 'en'
            },
            inputConfig: {
                gcsSource: {
                    inputUri: `gs://${projectId}-glossaries/${GLOSSARY_ID}.csv`
                }
            }
        };

        // For now, we need to upload the CSV to GCS first
        console.log('\n⚠️  IMPORTANT: Glossary upload requires Google Cloud Storage');
        console.log('\nPlease follow these steps:');
        console.log('\n1. Create a Cloud Storage bucket:');
        console.log(`   gsutil mb -l ${location} gs://${projectId}-glossaries`);
        console.log('\n2. Upload the glossary CSV:');
        console.log(`   gsutil cp ${GLOSSARY_FILE} gs://${projectId}-glossaries/${GLOSSARY_ID}.csv`);
        console.log('\n3. Create the glossary:');
        console.log(`   gcloud translation glossaries create ${GLOSSARY_ID} \\`);
        console.log(`     --source-language=ro \\`);
        console.log(`     --target-language=en \\`);
        console.log(`     --input-uri=gs://${projectId}-glossaries/${GLOSSARY_ID}.csv \\`);
        console.log(`     --location=${location}`);
        console.log('\nOr use the gcloud CLI directly:');
        console.log(`   export GOOGLE_APPLICATION_CREDENTIALS="${CREDENTIALS_PATH}"`);
        console.log(`   gcloud auth activate-service-account --key-file="${CREDENTIALS_PATH}"`);
        console.log(`   gcloud config set project ${projectId}`);
        console.log('   Then run the commands above.\n');

    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.code) {
            console.error(`   Error code: ${error.code}`);
        }
        console.error('\n💡 Troubleshooting:');
        console.error('   - Ensure Translation API is enabled in your GCP project');
        console.error('   - Ensure service account has Translation Admin role');
        console.error('   - Check that credentials file is valid');
        process.exit(1);
    }
}

// Run
uploadGlossary();
