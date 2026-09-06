const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const notices = [];
const moduleCache = new Map();
function loadTs(sourcePath) {
    sourcePath = sourcePath.endsWith('.ts') ? sourcePath : `${sourcePath}.ts`;
    if (moduleCache.has(sourcePath)) return moduleCache.get(sourcePath).exports;
    const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        fileName: sourcePath,
    }).outputText;
    const module = { exports: {} };
    moduleCache.set(sourcePath, module);
    const localRequire = (specifier) => {
        if (specifier === 'obsidian') return { Notice: class Notice { constructor(message) { notices.push(message); } } };
        if (specifier.startsWith('.')) return loadTs(path.resolve(path.dirname(sourcePath), specifier));
        return require(specifier);
    };
    new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
    return module.exports;
}

const { ViewportCropSearchAdapter } = loadTs(path.join(__dirname, '..', 'src', 'lib', 'viewport-crop-search'));

function fixture() {
    let state = {
        pages: {
            1: { rect: { x: 0, y: 0, width: 10, height: 10 } },
        },
    };
    const dispatched = [];
    const listeners = new Map();
    const findController = {
        _pageMatches: [[0, 1]],
        _pageMatchesLength: [[1, 1]],
        _matchesCountTotal: 2,
        _selected: { pageIdx: 0, matchIdx: 0 },
        _offset: { pageIdx: 0, matchIdx: 0 },
    };
    const eventBus = {
        on(name, callback) { listeners.set(name, callback); },
        off(name) { listeners.delete(name); },
        dispatch(name, data) { dispatched.push([name, data]); },
    };
    const plugin = {
        manifest: { name: 'PDF++' },
        viewportCropStore: { get: () => state },
    };
    const child = { file: { path: 'paper.pdf' }, pdfViewer: { findController, eventBus } };
	const chars = [
		{ char: 'A', rect: { x: 1, y: 1, width: 1, height: 1 }, textOffset: 0 },
		{ char: 'B', rect: { x: 20, y: 1, width: 1, height: 1 }, textOffset: 1 },
		{ char: 'C', rect: { x: 2, y: 1, width: 1, height: 1 }, textOffset: 2 },
	];
    const adapter = new ViewportCropSearchAdapter(plugin, child, () => chars);
    return { adapter, findController, dispatched, setState(value) { state = value; } };
}

test('adapter removes hidden matches from highlight, count, and navigation arrays', () => {
    const { adapter, findController, dispatched } = fixture();
    assert.equal(adapter.filterMatches(), true);
    assert.deepEqual(findController._pageMatches, [[0]]);
    assert.deepEqual(findController._pageMatchesLength, [[1]]);
    assert.equal(findController._matchesCountTotal, 1);
    assert.ok(dispatched.some(([name, data]) => name === 'updatefindmatchescount' && data.matchesCount.total === 1));
});

test('adapter remaps selected and navigation cursors after earlier hidden matches are removed', () => {
	const { adapter, findController } = fixture();
	findController._selected.matchIdx = 1;
	findController._offset.matchIdx = 1;
	adapter.filterMatches();
	assert.equal(findController._selected.matchIdx, -1);
	assert.equal(findController._offset.matchIdx, null);

	findController._pageMatches = [[0, 1, 2]];
	findController._pageMatchesLength = [[1, 1, 1]];
	findController._selected.matchIdx = 2;
	findController._offset.matchIdx = 2;
	adapter.filterMatches();
	assert.equal(findController._selected.matchIdx, 1);
	assert.equal(findController._offset.matchIdx, 1);
});

test('adapter restores original matches when crop state is removed', () => {
    const { adapter, findController, setState } = fixture();
    adapter.filterMatches();
    setState(undefined);
    assert.equal(adapter.filterMatches(), true);
    assert.deepEqual(findController._pageMatches, [[0, 1]]);
    assert.equal(findController._matchesCountTotal, 2);
});

test('unknown host controller is skipped without blocking PDF startup', () => {
    notices.length = 0;
    const plugin = { manifest: { name: 'PDF++' }, viewportCropStore: { get: () => ({ pages: { 1: {} } }) } };
    const child = { file: { path: 'paper.pdf' }, pdfViewer: { findController: {}, eventBus: { on() {}, off() {}, dispatch() {} } } };
    const adapter = new ViewportCropSearchAdapter(plugin, child, () => []);
    assert.equal(adapter.filterMatches(), false);
    assert.deepEqual(notices, []);
});

test('controller without per-match lengths is skipped without blocking PDF startup', () => {
	notices.length = 0;
	const plugin = { manifest: { name: 'PDF++' }, viewportCropStore: { get: () => ({ pages: { 1: { stale: false } } }) } };
	const findController = {
		_pageMatches: [[0]], _matchesCountTotal: 1,
		_selected: { pageIdx: 0, matchIdx: 0 }, _offset: { pageIdx: 0, matchIdx: 0 },
	};
	const child = { file: { path: 'paper.pdf' }, pdfViewer: { findController, eventBus: { on() {}, off() {}, dispatch() {} } } };
	const adapter = new ViewportCropSearchAdapter(plugin, child, () => []);
	assert.equal(adapter.filterMatches(), false);
	assert.deepEqual(notices, []);
});
