/**
 * EarBuds mode must SPEAK translations, not just show them.
 *
 * 2026-11-19: the server sent every translation and the phone showed the text, but the listener
 * heard nothing. No server-side test could see that — this one loads the real index.html and the
 * real client scripts in a simulated browser, with a speech engine that records what it is asked
 * to say, and drives them the way the phone does: tap EarBuds, receive translations over the socket.
 */
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scriptSrcs = [...html.matchAll(/<script\s+src="\/([^"]+)"/g)].map(m => m[1]);
const clientScripts = scriptSrcs.filter(s => !s.startsWith('socket.io/'));

function loadPage() {
    const dom = new JSDOM(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''), {
        runScripts: 'outside-only',
        url: 'https://translate.example.test/',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const spoken = [];
    const socketHandlers = {};

    // Speech engine: records each utterance and finishes it asynchronously, like a browser.
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
    window.speechSynthesis = {
        paused: false,
        speaking: false,
        getVoices: () => [{ name: 'Samantha', lang: 'en-US', localService: true }],
        addEventListener() {},
        speak(u) { spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 0); },
        cancel() {},
        resume() {},
    };
    // Socket.IO: capture the handlers the client registers.
    window.io = () => ({
        on(evt, cb) { socketHandlers[evt] = cb; },
        emit() {},
        connected: true,
    });
    const errors = [];
    window.console = { log() {}, warn() {}, info() {}, debug() {}, error: (...a) => errors.push(a.join(' ')) };
    window.alert = () => {}; // checkBrowserCompatibility warns about missing mic/audio APIs

    // Browsers share one global lexical scope across <script> tags (the `class` in client.js is
    // used by the later files); separate eval calls do not, so run them as one script, in order.
    // client-init.js declares `const app` — expose it so the test can reach the instance.
    const code = clientScripts.map(src => fs.readFileSync(path.join(ROOT, src), 'utf8')).join('\n;\n');
    window.eval(code + '\n;window.__app = app;');
    const receive = (data) => socketHandlers['translation-result'](data);
    const tapMode = (mode) => window.document.querySelector(`.mode-option[data-mode="${mode}"]`).click();
    return { window, spoken, errors, receive, tapMode, app: window.__app };
}

// Wait until the speech queue settles (each fake utterance ends on the next timer tick).
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5)); };

describe('EarBuds mode speaks translations (client, simulated browser)', () => {
    it('index.html offers an EarBuds option that turns speech on', () => {
        expect(html).to.match(/data-mode="earbuds"[^>]*data-enable-tts="true"/);
    });

    it('every client script the page loads has a server route', () => {
        const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        expect(clientScripts.length).to.be.above(0);
        for (const src of clientScripts) {
            expect(server, `server.js does not serve /${src}`).to.include(`app.get('/${src}'`);
            expect(fs.existsSync(path.join(ROOT, src)), `${src} is missing`).to.equal(true);
        }
    });

    it('after tapping EarBuds, a final translation is spoken', async () => {
        const page = loadPage();
        page.tapMode('earbuds');
        expect(page.app.ttsEnabled).to.equal(true);
        page.receive({ original: 'Haideți să ne imaginăm', translated: "Let's imagine what Jeremiah felt", isInterim: false });
        await tick();
        expect(page.spoken).to.deep.equal(["Let's imagine what Jeremiah felt"]);
        expect(page.errors.filter(e => /voice|speech|TTS/i.test(e))).to.deep.equal([]);
        page.window.close();
    });

    it('speaks consecutive translations in order', async () => {
        const page = loadPage();
        page.tapMode('earbuds');
        page.receive({ original: 'a', translated: 'First sentence of the talk.', isInterim: false });
        page.receive({ original: 'b', translated: 'Second, quite different sentence.', isInterim: false });
        await tick(); await tick();
        expect(page.spoken).to.deep.equal(['First sentence of the talk.', 'Second, quite different sentence.']);
    });

    it('switching from EarBuds back to Talks stops speaking', async () => {
        const page = loadPage();
        page.tapMode('earbuds');
        page.tapMode('talks');
        page.receive({ original: 'x', translated: 'This should only be shown on screen.', isInterim: false });
        await tick();
        expect(page.spoken).to.deep.equal([]);
    });

    it('interim results are not spoken in EarBuds mode (only finals)', async () => {
        const page = loadPage();
        page.tapMode('earbuds');
        page.receive({ original: 'x', translated: 'partial text so far', isInterim: true });
        await tick();
        expect(page.spoken).to.deep.equal([]);
    });
});
