const { describe, it } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadExtraWindows, isInCaptureWindow } = require('../capture-windows');

// 2026-10-18 is a Sunday; Bucharest is UTC+3 (EEST) until 2026-10-25, UTC+2 after
const at = iso => new Date(iso);

describe('capture windows', () => {
    describe('regular Thu/Sun windows', () => {
        it('is open during the Sunday meeting', () => {
            expect(isInCaptureWindow(at('2026-10-18T14:00:00+03:00'))).to.equal(true);
        });
        it('is open during the Thursday meeting', () => {
            expect(isInCaptureWindow(at('2026-10-22T20:30:00+03:00'))).to.equal(true);
        });
        it('is closed on other days and off-hours', () => {
            expect(isInCaptureWindow(at('2026-10-19T14:00:00+03:00'))).to.equal(false); // Monday
            expect(isInCaptureWindow(at('2026-10-18T03:00:00+03:00'))).to.equal(false); // Sunday night
            expect(isInCaptureWindow(at('2026-10-22T12:00:00+03:00'))).to.equal(false); // Thursday noon
        });
        it('stays open for the grace period after the window, then closes', () => {
            expect(isInCaptureWindow(at('2026-10-18T16:08:00+03:00'))).to.equal(true);
            expect(isInCaptureWindow(at('2026-10-18T16:12:00+03:00'))).to.equal(false);
        });
        it('follows Bucharest wall-clock time across the DST change', () => {
            // 2026-11-01 Sunday, UTC+2: 14:00 Bucharest = 12:00 UTC
            expect(isInCaptureWindow(at('2026-11-01T12:00:00Z'))).to.equal(true);
            expect(isInCaptureWindow(at('2026-11-01T08:00:00Z'))).to.equal(false); // 10:00 Bucharest
        });
    });

    describe('boundaries', () => {
        const open = iso => isInCaptureWindow(at(iso));
        it('Sunday 12:30-16:00 plus 10 min grace', () => {
            expect(open('2026-10-18T12:29:00+03:00')).to.equal(false);
            expect(open('2026-10-18T12:30:00+03:00')).to.equal(true);
            expect(open('2026-10-18T16:10:00+03:00')).to.equal(true);
            expect(open('2026-10-18T16:11:00+03:00')).to.equal(false);
        });
        it('Thursday 19:00-22:00 plus 10 min grace', () => {
            expect(open('2026-10-22T18:59:00+03:00')).to.equal(false);
            expect(open('2026-10-22T19:00:00+03:00')).to.equal(true);
            expect(open('2026-10-22T22:10:00+03:00')).to.equal(true);
            expect(open('2026-10-22T22:11:00+03:00')).to.equal(false);
        });
        it('midnight Bucharest is closed (h23 handling)', () => {
            expect(open('2026-10-19T00:00:00+03:00')).to.equal(false);
        });
        it('Sunday 14:00 local is open on both sides of the 2026-10-25 DST change', () => {
            expect(open('2026-10-18T14:00:00+03:00')).to.equal(true);
            expect(open('2026-10-25T12:00:00Z')).to.equal(true);  // 14:00 EET (UTC+2)
            expect(open('2026-10-25T11:00:00Z')).to.equal(true);  // 13:00 EET
            expect(open('2026-10-25T09:00:00Z')).to.equal(false); // 11:00 EET
        });
    });

    describe('extra windows', () => {
        const extra = loadExtraWindows(path.join(os.tmpdir(), 'does-not-exist.json'))
            .concat([{ start: Date.parse('2026-10-20T10:00:00+03:00'), end: Date.parse('2026-10-20T16:00:00+03:00') }]);

        it('opens a one-off meeting on a normally closed day', () => {
            expect(isInCaptureWindow(at('2026-10-20T12:00:00+03:00'))).to.equal(false);
            expect(isInCaptureWindow(at('2026-10-20T12:00:00+03:00'), extra)).to.equal(true);
        });
        it('opens at the start and still applies regular windows alongside', () => {
            expect(isInCaptureWindow(at('2026-10-20T09:59:00+03:00'), extra)).to.equal(false);
            expect(isInCaptureWindow(at('2026-10-20T10:00:00+03:00'), extra)).to.equal(true);
            expect(isInCaptureWindow(at('2026-10-18T14:00:00+03:00'), extra)).to.equal(true);
        });
        it('a tick a few ms past end+grace still counts as the last grace tick', () => {
            expect(isInCaptureWindow(at('2026-10-20T16:10:00.040+03:00'), extra)).to.equal(true);
        });
        it('closes after the end plus grace', () => {
            expect(isInCaptureWindow(at('2026-10-20T16:08:00+03:00'), extra)).to.equal(true);
            expect(isInCaptureWindow(at('2026-10-20T16:12:00+03:00'), extra)).to.equal(false);
        });
    });

    describe('loadExtraWindows', () => {
        const write = content => {
            const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-')), 'w.json');
            fs.writeFileSync(file, content);
            return file;
        };
        it('returns [] for a missing file', () => {
            expect(loadExtraWindows(path.join(os.tmpdir(), 'nope-cw.json'))).to.deep.equal([]);
        });
        it('returns [] for malformed JSON or a non-array', () => {
            expect(loadExtraWindows(write('{oops'))).to.deep.equal([]);
            expect(loadExtraWindows(write('{}'))).to.deep.equal([]);
        });
        it('rejects offset-less, non-string, null and over-24h entries', () => {
            const file = write(JSON.stringify([
                { start: '2026-10-20T10:00:00', end: '2026-10-20T16:00:00' },
                { start: 1760000000000, end: 1760003600000 },
                null,
                { start: '2026-10-20T10:00:00+03:00', end: '2026-10-22T10:00:00+03:00' },
            ]));
            expect(loadExtraWindows(file)).to.deep.equal([]);
        });
        it('the committed capture-windows.json is a valid array', () => {
            const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'capture-windows.json'), 'utf8'));
            expect(committed).to.be.an('array');
        });
        it('parses valid entries and drops invalid ones', () => {
            const file = write(JSON.stringify([
                { start: '2026-10-20T10:00:00+03:00', end: '2026-10-20T16:00:00+03:00' },
                { start: 'garbage', end: '2026-10-20T16:00:00+03:00' },
                { start: '2026-10-20T16:00:00+03:00', end: '2026-10-20T10:00:00+03:00' },
            ]));
            const result = loadExtraWindows(file);
            expect(result).to.have.length(1);
            expect(result[0].start).to.equal(Date.parse('2026-10-20T10:00:00+03:00'));
        });
    });
});
