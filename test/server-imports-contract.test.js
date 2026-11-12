const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Regression guard (v233): server.js imported normalizeSourceForMT / extractByAlignmentFallback
// from translation-post-processor.js, but the module change was never committed, so production
// threw "normalizeSourceForMT is not a function" on every translation. Every name server.js
// destructures from a local module must exist on that module's exports.
describe('server.js local-module import contract', () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const re = /const\s*\{([^}]+)\}\s*=\s*require\('(\.\/[^']+)'\)/g;
    const imports = [];
    let m;
    while ((m = re.exec(serverSrc)) !== null) {
        imports.push({
            file: m[2],
            names: m[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean),
        });
    }

    it('finds at least the post-processor import', () => {
        assert.ok(imports.some(i => i.file === './translation-post-processor'));
    });

    imports.forEach(({ file, names }) => {
        describe(file, () => {
            names.forEach(name => {
                it(`exports ${name}`, () => {
                    const mod = require(path.join(__dirname, '..', file));
                    assert.notStrictEqual(mod[name], undefined, `${file} does not export ${name}`);
                });
            });
        });
    });
});

describe('normalizeSourceForMT', () => {
    const { normalizeSourceForMT } = require('../translation-post-processor');

    it('is a function', () => assert.strictEqual(typeof normalizeSourceForMT, 'function'));

    it('lowercases a copula/modal verb capitalised after "nu"', () => {
        assert.strictEqual(normalizeSourceForMT('nu Este meritul meu'), 'nu este meritul meu');
        assert.strictEqual(normalizeSourceForMT('nu Putem merge'), 'nu putem merge');
    });

    it('leaves "Nu. Am fost ocupat" untouched', () => {
        assert.strictEqual(normalizeSourceForMT('Nu. Am fost ocupat'), 'Nu. Am fost ocupat');
    });

    it('turns bare "nu să" into the interjection "nu, să"', () => {
        assert.strictEqual(normalizeSourceForMT('dar nu să ne concentrăm'), 'dar nu, să ne concentrăm');
    });

    it('keeps the stutter "să nu să" and contrastive "nu să ... ci" as-is', () => {
        assert.strictEqual(normalizeSourceForMT('să nu să dăm'), 'să nu să dăm');
        assert.strictEqual(normalizeSourceForMT('nu să judec ci să salvez'), 'nu să judec ci să salvez');
    });

    it('passes ordinary text through unchanged', () => {
        assert.strictEqual(normalizeSourceForMT('Iehova ne iubește'), 'Iehova ne iubește');
    });
});
