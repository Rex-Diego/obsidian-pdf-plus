const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function load(relativePath) {
    const sourcePath = path.join(__dirname, '..', relativePath);
    const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        fileName: sourcePath,
    }).outputText;
    const module = { exports: {} };
    new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
    return module.exports;
}

const crop = load('src/lib/viewport-crop.ts');
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

test('rect and ratios round-trip with a non-zero page origin', () => {
    const viewBox = { x: -20, y: 10, width: 200, height: 400 };
    const rect = { x: 0, y: 50, width: 140, height: 280 };
    const ratios = crop.ratiosFromRect(rect, viewBox);
    assert.deepEqual(ratios, { top: 0.2, right: 0.2, bottom: 0.1, left: 0.1 });
    assert.deepEqual(crop.rectFromRatios(viewBox, ratios), rect);
});

test('page state preserves quarter-turn rotation and validates dimensions', () => {
    const state = crop.createViewportCropPageState(
        { x: 10, y: 20, width: 80, height: 160 },
        { viewBox: { x: 0, y: 0, width: 100, height: 200 }, pageWidth: 100, pageHeight: 200, rotation: 270 },
    );
    assert.equal(state.rotation, 270);
    assert.throws(() => crop.normalizeViewportCropRotation(45), /quarter-turn/);
    assert.throws(() => crop.createViewportCropPageState(state.rect, { ...state, pageWidth: 0 }), /dimensions/);
});

test('display edge ratios map across mixed page rotations', () => {
    const pdfRatios = { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 };
    assert.deepEqual(crop.viewportCropRatiosToDisplay(pdfRatios, 90), {
        top: 0.4, right: 0.1, bottom: 0.2, left: 0.3,
    });
    const display = { top: 0.05, right: 0.1, bottom: 0.15, left: 0.2 };
    for (const rotation of [0, 90, 180, 270]) {
        assert.deepEqual(
            crop.viewportCropRatiosToDisplay(crop.viewportCropRatiosFromDisplay(display, rotation), rotation),
            display,
        );
    }
});

test('viewport bounds respect scale, resize, rotation, and non-zero origins', () => {
    const rect = { x: 20, y: 30, width: 40, height: 80 };
    const makeViewport = (scale, rotation) => ({
        width: (rotation % 180 === 0 ? 100 : 200) * scale,
        height: (rotation % 180 === 0 ? 200 : 100) * scale,
        convertToViewportPoint(x, y) {
            if (rotation === 0) return [(x - 10) * scale, (220 - y) * scale];
            return [(y - 20) * scale, (x - 10) * scale];
        },
    });
    assert.deepEqual(crop.viewportCropRectToViewportBounds(rect, makeViewport(1, 0)), {
        left: 10, top: 110, width: 40, height: 80,
    });
    assert.deepEqual(crop.viewportCropRectToViewportBounds(rect, makeViewport(2, 0)), {
        left: 20, top: 220, width: 80, height: 160,
    });
    assert.deepEqual(crop.viewportCropRectToViewportBounds(rect, makeViewport(1, 90)), {
        left: 10, top: 10, width: 80, height: 40,
    });
});

test('scope expansion handles current, range, and all pages', () => {
    assert.deepEqual(crop.getViewportCropPageNumbers('current', 3, 6), [3]);
    assert.deepEqual(crop.getViewportCropPageNumbers('range', 3, 6, 2, 5), [2, 3, 4, 5]);
    assert.deepEqual(crop.getViewportCropPageNumbers('all', 3, 4), [1, 2, 3, 4]);
    assert.throws(() => crop.getViewportCropPageNumbers('range', 3, 6, 5, 2), /range/);
});

function documentState(hash = hashA) {
    const page = crop.createViewportCropPageState(
        { x: 10, y: 20, width: 80, height: 160 },
        { viewBox: { x: 0, y: 0, width: 100, height: 200 }, pageWidth: 100, pageHeight: 200, rotation: 0 },
    );
    return crop.createViewportCropDocumentState('paper.pdf', hash, 1, { 1: page }, 10);
}

test('changed PDF with compatible structure remaps by ratios', () => {
    const result = crop.reconcileViewportCropDocument(documentState(), hashB, 1, {
        1: { viewBox: { x: 5, y: 10, width: 200, height: 400 }, pageWidth: 200, pageHeight: 400, rotation: 0 },
    }, 20);
    assert.equal(result.changed, true);
    assert.deepEqual(result.stalePages, []);
    assert.equal(result.state.sourceSha256, hashB);
    assert.deepEqual(result.state.pages[1].rect, { x: 25, y: 50, width: 160, height: 320 });
});

test('page-count and rotation changes mark crops stale', () => {
    const count = crop.reconcileViewportCropDocument(documentState(), hashB, 2, {});
    assert.deepEqual(count.stalePages, [1]);
    assert.match(count.state.pages[1].staleReason, /page count/);

    const rotation = crop.reconcileViewportCropDocument(documentState(), hashB, 1, {
        1: { viewBox: { x: 0, y: 0, width: 100, height: 200 }, pageWidth: 100, pageHeight: 200, rotation: 90 },
    });
    assert.deepEqual(rotation.stalePages, [1]);
    assert.match(rotation.state.pages[1].staleReason, /rotation/);
});

test('store validates, snapshots, persists serially, and broadcasts file changes', async () => {
    const writes = [];
    const events = [];
    const plugin = {
        settings: { viewportCropDocuments: {} },
        async saveSettings() { writes.push(structuredClone(this.settings.viewportCropDocuments)); },
        trigger(event, fileKey) { events.push([event, fileKey]); },
    };
    const store = new crop.ViewportCropStore(plugin);
    store.load({ 'paper.pdf': documentState() });
    const copy = store.get('paper.pdf');
    copy.pages[1].rect.x = 999;
    assert.equal(store.get('paper.pdf').pages[1].rect.x, 10);
    await store.clear('paper.pdf', [1]);
    assert.equal(store.get('paper.pdf'), undefined);
    assert.equal(writes.length, 1);
    assert.deepEqual(events, [['viewport-crop-state-change', 'paper.pdf']]);
});

test('store migrates a renamed path only when the fingerprint still matches', async () => {
    const plugin = {
        settings: { viewportCropDocuments: {} },
        async saveSettings() {},
        trigger() {},
    };
    const store = new crop.ViewportCropStore(plugin);
    store.load({ 'paper.pdf': documentState() });
    assert.equal(await store.rename('paper.pdf', 'moved.pdf', hashB), false);
    assert.ok(store.get('paper.pdf'));
    assert.equal(await store.rename('paper.pdf', 'moved.pdf', hashA), true);
    assert.equal(store.get('paper.pdf'), undefined);
    assert.equal(store.get('moved.pdf').fileKey, 'moved.pdf');
});

test('store drops malformed persisted records without weakening valid records', () => {
    const plugin = { settings: {}, saveSettings: async () => {}, trigger() {} };
    const store = new crop.ViewportCropStore(plugin);
    store.load({ valid: { ...documentState(), fileKey: 'valid' }, invalid: { schemaVersion: 1 } });
    assert.ok(store.get('valid'));
    assert.equal(store.get('invalid'), undefined);
});

test('SHA-256 helper fingerprints bytes without modifying them', async () => {
    const bytes = new TextEncoder().encode('abc');
    const before = [...bytes];
    assert.equal(await crop.sha256Hex(bytes), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.deepEqual([...bytes], before);
});
