const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '..', 'src', 'lib', 'viewport-crop-text.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
}).outputText;
const moduleForTest = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, moduleForTest, moduleForTest.exports);
const text = moduleForTest.exports;

const crop = { x: 0, y: 0, width: 10, height: 10 };
const chars = [
    { char: 'A', rect: { x: 1, y: 1, width: 2, height: 2 }, itemIndex: 0, itemOffset: 0, textOffset: 0, selected: true },
    { char: 'B', rect: { x: 12, y: 1, width: 2, height: 2 }, itemIndex: 0, itemOffset: 1, textOffset: 1, selected: true },
    { char: 'C', rect: { x: 2, y: 4, width: 2, height: 2 }, itemIndex: 1, itemOffset: 0, textOffset: 2, selected: false, lineBreakAfter: true },
];

test('visible text keeps selected in-crop characters only', () => {
    assert.equal(text.filterViewportCropCharacters(chars, crop, true), 'A');
    assert.equal(text.filterViewportCropCharacters(chars, crop), 'AC\n');
});
test('search match is accepted only when all non-whitespace characters are visible', () => {
    assert.equal(text.isViewportCropMatchVisible(chars, 0, 1, crop), true);
    assert.equal(text.isViewportCropMatchVisible(chars, 0, 2, crop), false);
    assert.equal(text.isViewportCropMatchVisible(chars, 99, 1, crop), false);
});
