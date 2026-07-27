'use strict';

// JS side of the shared JS<->Python post-processor parity corpus.
// Asserts applyTermMappings reproduces every case in
// test/fixtures/postprocessor-parity-corpus.json. PhraseTranslation's pytest runs
// the SAME fixture against its Python apply_term_mappings, so a rule that drifts
// between the two implementations turns into a test failure on one side.

const { expect } = require('chai');
const path = require('path');
const { applyTermMappings } = require('../translation-post-processor');
const corpus = require('./fixtures/postprocessor-parity-corpus.json');

describe('post-processor JS<->Python parity corpus (JS side)', () => {
    it('has cases to check', () => {
        expect(corpus.cases.length).to.be.greaterThan(0);
    });

    corpus.cases.forEach((c) => {
        it(`${c.name}`, () => {
            expect(applyTermMappings(c.input, c.source)).to.equal(c.expected);
        });
    });
});
