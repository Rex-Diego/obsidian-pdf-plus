const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('viewport crop implementation has no PDF byte-writing path', () => {
    const implementation = [
        'src/lib/viewport-crop.ts',
        'src/lib/viewport-crop-controller.ts',
        'src/lib/viewport-crop-search.ts',
        'src/modals/viewport-crop-modal.ts',
    ].map(read).join('\n');
    assert.doesNotMatch(implementation, /modifyBinary|processArrayBuffer|PDFDocument\.load|\.save\(\)/);
});

test('legacy CropBox transaction modules are absent and settings are explicitly discarded', () => {
    for (const relative of [
        'src/lib/crop-box.ts',
        'src/lib/crop-box-write.ts',
        'src/modals/crop-box-modal.ts',
    ]) {
        assert.equal(fs.existsSync(path.join(root, relative)), false, `${relative} should not exist`);
    }
    const main = read('src/main.ts');
    assert.match(main, /delete saved\.cropBoxSnapshots/);
    assert.match(main, /delete saved\.cropBoxPending/);
});

test('selection deep-link indices remain generated from original text-layer nodes', () => {
    const copyLink = read('src/lib/copy-link.ts');
    assert.match(copyLink, /beginIndex: \+beginIndex - this\.plugin\.textDivFirstIdx/);
    assert.match(copyLink, /endIndex: \+endIndex - this\.plugin\.textDivFirstIdx/);
    assert.match(copyLink, /viewportCropController\?\.filterSelectionText\(selection\)/);
});

test('viewport crop is available from the PDF page context menu', () => {
    const contextMenu = read('src/context-menu.ts');
    assert.match(contextMenu, /Crop visible PDF area/);
    assert.match(contextMenu, /Manage viewport crop/);
    assert.match(contextMenu, /child\.viewportCropController/);
});

test('viewport crop compacts both page dimensions without wrapping PDF.js layers', () => {
    const controller = read('src/lib/viewport-crop-controller.ts');
    const styles = read('styles.css');
    assert.match(controller, /'--pdf-plus-viewport-crop-width', `\$\{width\}px`/);
    assert.match(controller, /'--pdf-plus-viewport-crop-height', `\$\{height\}px`/);
    assert.match(styles, /width: var\(--pdf-plus-viewport-crop-width\) !important/);
    assert.match(styles, /height: var\(--pdf-plus-viewport-crop-height\) !important/);
    assert.match(styles, /> :is\(\.canvasWrapper, \.textLayer, \.annotationLayer, \.annotationEditorLayer, \.xfaLayer, \.pdf-plus-backlink-highlight-layer\)/);
    assert.match(styles, /translate: var\(--pdf-plus-viewport-crop-offset-x\) var\(--pdf-plus-viewport-crop-offset-y\)/);
    assert.doesNotMatch(controller, /ensureShell\(pageView\)/);
    assert.doesNotMatch(controller, /pageView\.div\.style\.clipPath = `inset\(/);
});

test('PDF++ backlink highlights and underlines share the cropped page offset', () => {
    const highlights = read('src/lib/highlights/viewer.ts');
    const styles = read('styles.css');
    assert.match(highlights, /pageDiv\.createDiv\('pdf-plus-backlink-highlight-layer'/);
    assert.match(styles, /pdf-plus-viewport-cropped[^\n]+pdf-plus-backlink-highlight-layer/);
});

test('viewport crop has no toolbar button and defaults to all pages', () => {
    const toolbar = read('src/toolbar.ts');
    const modal = read('src/modals/viewport-crop-modal.ts');
    assert.doesNotMatch(toolbar, /addViewportCropButton|pdf-plus-viewport-crop-button/);
    assert.match(modal, /private cropScope: ViewportCropScope = 'all'/);
});

test('viewport crop modal previews the actual page ratio and synchronizes scope bounds', () => {
    const controller = read('src/lib/viewport-crop-controller.ts');
    const modal = read('src/modals/viewport-crop-modal.ts');
    assert.match(controller, /\{ width: pageView\.viewport\.width, height: pageView\.viewport\.height \}/);
    assert.match(modal, /viewBox: `0 0 \$\{width\} \$\{height\}`/);
    assert.match(modal, /this\.cropScope === 'all' \? 1/);
    assert.match(modal, /this\.cropScope === 'all' \? this\.pageCount/);
    assert.match(modal, /this\.cropScope === 'current' \? this\.currentPage/);
    assert.match(modal, /setDisabled\(!editable\)/);
    assert.match(modal, /this\.cropScope = value as ViewportCropScope;\s+updatePageRange\(\)/);
    assert.doesNotMatch(modal, /pageRange\.(?:settingEl|controlEl)\.(?:addClass|toggleClass)\('is-hidden'/);
});

test('viewport crop context menu uses the standard crop icon', () => {
    const contextMenu = read('src/context-menu.ts');
    const main = read('src/main.ts');
    assert.match(contextMenu, /\.setIcon\('lucide-crop'\)/);
    assert.doesNotMatch(main, /addIcon\('pdf-plus-viewport-crop'/);
});
