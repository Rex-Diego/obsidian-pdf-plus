import { Notice } from 'obsidian';
import type { PDFPageProxy } from 'pdfjs-dist';

import type PDFPlus from 'main';
import { ViewportCropModal } from 'modals/viewport-crop-modal';
import type { PDFPageView, PDFViewerChild, TextContentItem } from 'typings';
import { getCharactersWithBoundingBoxesInPDFCoords, getFirstTextNodeIn, getTextLayerInfo } from 'utils';
import {
    createViewportCropDocumentState,
    createViewportCropPageState,
    getViewportCropPageNumbers,
    normalizeViewportCropRotation,
    ratiosFromRect,
    rectFromRatios,
    sha256Hex,
    ViewportCropDocumentState,
    ViewportCropPageGeometry,
    ViewportCropPageState,
    ViewportCropRatios,
    ViewportCropRect,
    ViewportCropScope,
    ViewportCropStore,
    ViewportCropViewBox,
    viewportCropRatiosFromDisplay,
    viewportCropRatiosToDisplay,
    viewportCropRectToViewportBounds,
} from './viewport-crop';
import { filterViewportCropCharacters, isViewportCropCharacterVisible, ViewportCropCharacter } from './viewport-crop-text';
import { ViewportCropSearchAdapter } from './viewport-crop-search';

type PageStyle = {
    originalCropOffsetX: string;
    originalCropOffsetY: string;
    originalPageWidth: string;
    originalPageHeight: string;
    originalCropWidth: string;
    originalCropHeight: string;
};

const VIEWPORT_CROP_STYLE_PROPERTIES = [
    '--pdf-plus-viewport-crop-offset-x',
    '--pdf-plus-viewport-crop-offset-y',
    '--pdf-plus-viewport-page-width',
    '--pdf-plus-viewport-page-height',
    '--pdf-plus-viewport-crop-width',
    '--pdf-plus-viewport-crop-height',
] as const;

type SelectionEndpoint = { node: Text; offset: number };

/** Applies persisted crop state only to the DOM viewport; PDF.js page and text indices stay intact. */
export class ViewportCropController {
    private readonly pageStyles = new Map<number, PageStyle>();
    private readonly pdfListeners: Array<[string, (data?: unknown) => void]> = [];
    private editingPage: number | null = null;
    private identitySha256: string | null = null;
    private selectionGuard = false;
    private selectionListener?: () => void;
    private stateListener?: (fileKey: string) => void;
    private searchAdapter?: ViewportCropSearchAdapter;
    private staleNoticeKey = '';
    private readonly characterCache = new Map<number, ViewportCropCharacter[]>();
    private cropSelectionCleanup?: () => void;

    constructor(
        private readonly plugin: PDFPlus,
        private readonly child: PDFViewerChild,
        private readonly store: ViewportCropStore,
    ) {}

    attach(): void {
        const bus = this.child.pdfViewer?.eventBus;
        if (!bus) return;
        const refresh = () => this.applyAll();
        for (const event of ['pagesloaded', 'pagerendered', 'textlayerrendered', 'annotationlayerrendered', 'scalechanging', 'rotationchanging']) {
            bus.on(event as never, refresh as never);
            this.pdfListeners.push([event, refresh]);
        }
        this.stateListener = (fileKey) => {
            if (this.child.file?.path === fileKey) {
                this.applyAll();
                this.searchAdapter?.filterMatches();
            }
        };
        this.plugin.events.on('viewport-crop-state-change', this.stateListener);

        const doc = this.child.containerEl.doc;
        this.selectionListener = () => this.clampSelection(doc.getSelection());
        doc.addEventListener('selectionchange', this.selectionListener);

        this.searchAdapter = new ViewportCropSearchAdapter(this.plugin, this.child, (page) => this.getCharacters(page));
        this.searchAdapter.attach();
    }

    unload(): void {
        const bus = this.child.pdfViewer?.eventBus;
        if (bus) {
            for (const [event, listener] of this.pdfListeners) bus.off(event as never, listener as never);
        }
        this.pdfListeners.length = 0;
        if (this.stateListener) this.plugin.events.off('viewport-crop-state-change', this.stateListener);
        this.stateListener = undefined;
        if (this.selectionListener) this.child.containerEl.doc.removeEventListener('selectionchange', this.selectionListener);
        this.selectionListener = undefined;
        this.searchAdapter?.unload();
        this.searchAdapter = undefined;
        this.cropSelectionCleanup?.();
        this.cropSelectionCleanup = undefined;
        this.restoreAll(true);
    }

	async loadFile(): Promise<void> {
		this.identitySha256 = null;
		this.staleNoticeKey = '';
		this.characterCache.clear();
		this.restoreAll(true);
		this.pageStyles.clear();
        if (!this.child.file || this.child.isFileExternal) {
            this.restoreAll();
            return;
        }
        const saved = this.store.get(this.child.file.path);
        if (!saved) {
            this.applyAll();
            return;
        }
        const pdfDocument = this.child.pdfViewer?.pdfViewer?.pdfDocument;
        if (!pdfDocument) return;
        const sourceSha256 = await this.getSourceSha256();
        const geometries: Record<number, ViewportCropPageGeometry> = {};
        if (saved.pageCount === pdfDocument.numPages) {
            await Promise.all(Object.keys(saved.pages).map(async (key) => {
                const pageNumber = Number(key);
                const page = await pdfDocument.getPage(pageNumber);
                geometries[pageNumber] = this.geometryFromPage(page);
                await this.cachePageCharacters(pageNumber, page);
            }));
        }
        const result = await this.store.reconcile(this.child.file.path, sourceSha256, pdfDocument.numPages, geometries);
        this.applyAll();
        if (result?.stalePages.length) this.showStaleNotice(result.stalePages);
    }

    onResize(): void {
        this.applyAll();
    }

    applyAll(): void {
        if (this.editingPage !== null) return;
        const state = this.child.file && !this.child.isFileExternal
            ? this.store.get(this.child.file.path)
            : undefined;
        for (const pageView of this.child.pdfViewer?.pdfViewer?._pages ?? []) this.applyPage(pageView, state);
    }

    applyPage(pageView: PDFPageView, documentState?: ViewportCropDocumentState): void {
        const crop = documentState?.pages[String(pageView.id)];
        if (!crop || crop.stale) {
            this.restorePage(pageView);
            return;
        }
        const viewBox = this.getViewBox(pageView);
        const rect = this.sameViewBox(crop.viewBox, viewBox) ? crop.rect : rectFromRatios(viewBox, crop.ratios);
        const { left, top, width, height } = viewportCropRectToViewportBounds(rect, pageView.viewport);
        if (!(width > 0 && height > 0)) {
            this.restorePage(pageView);
            return;
        }

        const legacyShell = this.unwrapLegacyShell(pageView);
        if (!this.pageStyles.has(pageView.id) && (legacyShell || pageView.div.hasClass('pdf-plus-viewport-cropped'))) {
            pageView.div.style.width = `${pageView.viewport.width}px`;
            pageView.div.style.height = `${pageView.viewport.height}px`;
            pageView.div.style.overflow = '';
            pageView.div.style.position = '';
            pageView.div.style.clipPath = '';
            pageView.div.removeClass('pdf-plus-viewport-cropped');
            for (const property of VIEWPORT_CROP_STYLE_PROPERTIES) pageView.div.style.removeProperty(property);
        }
        this.ensurePageStyle(pageView);
        // Keep every PDF.js layer as a direct child of the page. The page box
        // participates in layout at the cropped size, while CSS translates
        // the full-size layers behind that window. PDFPageView.reset() can
        // therefore still enumerate, retain, and replace its own layers.
        pageView.div.style.setProperty('--pdf-plus-viewport-crop-offset-x', `${-left}px`);
        pageView.div.style.setProperty('--pdf-plus-viewport-crop-offset-y', `${-top}px`);
        pageView.div.style.setProperty('--pdf-plus-viewport-page-width', `${pageView.viewport.width}px`);
        pageView.div.style.setProperty('--pdf-plus-viewport-page-height', `${pageView.viewport.height}px`);
        pageView.div.style.setProperty('--pdf-plus-viewport-crop-width', `${width}px`);
        pageView.div.style.setProperty('--pdf-plus-viewport-crop-height', `${height}px`);
        pageView.div.addClass('pdf-plus-viewport-cropped');
    }

    async beginCropSelection(): Promise<void> {
        if (!this.child.file || this.child.isFileExternal) {
            new Notice(`${this.plugin.manifest.name}: Viewport crop is available only for PDFs stored in this vault.`);
            return;
        }
        const pageNumber = this.child.pdfViewer?.pdfViewer?.currentPageNumber;
        if (!pageNumber) return;
        const pageView = this.child.getPage(pageNumber);
        if (!pageView?.div) return;

        this.cropSelectionCleanup?.();
        this.editingPage = pageNumber;
        this.restoreAll();
        pageView.div.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const overlay = pageView.div.createDiv('pdf-plus-viewport-crop-overlay');
        const box = overlay.createDiv('pdf-plus-viewport-crop-selection');
        let start: { x: number; y: number } | null = null;
        let current: { x: number; y: number } | null = null;

        const point = (event: PointerEvent) => {
            const rect = pageView.div.getBoundingClientRect();
            return {
                x: Math.max(0, Math.min(pageView.viewport.width, event.clientX - rect.left)),
                y: Math.max(0, Math.min(pageView.viewport.height, event.clientY - rect.top)),
            };
        };
        const draw = () => {
            if (!start || !current) return;
            const left = Math.min(start.x, current.x);
            const top = Math.min(start.y, current.y);
            box.setCssStyles({
                left: `${left}px`, top: `${top}px`,
                width: `${Math.abs(current.x - start.x)}px`,
                height: `${Math.abs(current.y - start.y)}px`,
            });
        };
        const cleanup = () => {
            overlay.remove();
            pageView.div.doc.removeEventListener('keydown', onKeyDown);
            if (this.cropSelectionCleanup === cleanup) this.cropSelectionCleanup = undefined;
        };
        const cancel = () => {
            cleanup();
            this.editingPage = null;
            this.applyAll();
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') cancel();
        };
        this.cropSelectionCleanup = cleanup;
        pageView.div.doc.addEventListener('keydown', onKeyDown);
        overlay.addEventListener('pointerdown', (event) => {
            start = current = point(event);
            overlay.setPointerCapture(event.pointerId);
            draw();
        });
        overlay.addEventListener('pointermove', (event) => {
            if (!start) return;
            current = point(event);
            draw();
        });
        overlay.addEventListener('pointercancel', cancel, { once: true });
        overlay.addEventListener('pointerup', (event) => {
            if (!start) return;
            current = point(event);
            const width = Math.abs(current.x - start.x);
            const height = Math.abs(current.y - start.y);
            if (width < 4 || height < 4) {
                cancel();
                return;
            }
            const left = Math.min(start.x, current.x);
            const right = Math.max(start.x, current.x);
            const top = Math.min(start.y, current.y);
            const bottom = Math.max(start.y, current.y);
            const first = pageView.getPagePoint(left, bottom);
            const second = pageView.getPagePoint(right, top);
            const rect: ViewportCropRect = {
                x: Math.min(first[0], second[0]),
                y: Math.min(first[1], second[1]),
                width: Math.abs(second[0] - first[0]),
                height: Math.abs(second[1] - first[1]),
            };
            const ratios = ratiosFromRect(rect, this.getViewBox(pageView));
            const displayRotation = normalizeViewportCropRotation(pageView.viewport.rotation);
            const intrinsicRotation = normalizeViewportCropRotation(pageView.pdfPage.rotate);
            const viewerRotation = normalizeViewportCropRotation(displayRotation - intrinsicRotation);
            const displayRatios = viewportCropRatiosToDisplay(ratios, displayRotation);
            cleanup();
            new ViewportCropModal(
                this.plugin, pageNumber, this.child.pdfViewer.pagesCount, displayRatios,
                { width: pageView.viewport.width, height: pageView.viewport.height },
                (scope, rangeStart, rangeEnd) => this.applyRatios(scope, pageNumber, rangeStart, rangeEnd, displayRatios, viewerRotation),
                (scope, rangeStart, rangeEnd) => this.restore(scope, pageNumber, rangeStart, rangeEnd),
                () => {
                    this.editingPage = null;
                    this.applyAll();
                },
            ).open();
        }, { once: true });
    }

    openCropManagement(): void {
        const pageNumber = this.child.pdfViewer?.pdfViewer?.currentPageNumber;
        if (!pageNumber || !this.child.file || this.child.isFileExternal) return;
        const crop = this.getPageCrop(pageNumber);
		if (!crop) {
			void this.beginCropSelection();
			return;
		}
        const pageView = this.child.getPage(pageNumber);
        const displayRotation = normalizeViewportCropRotation(pageView.viewport.rotation);
        const intrinsicRotation = normalizeViewportCropRotation(pageView.pdfPage.rotate);
        const viewerRotation = normalizeViewportCropRotation(displayRotation - intrinsicRotation);
        const displayRatios = viewportCropRatiosToDisplay(crop.ratios, displayRotation);
        new ViewportCropModal(
            this.plugin, pageNumber, this.child.pdfViewer.pagesCount, displayRatios,
            { width: pageView.viewport.width, height: pageView.viewport.height },
            (scope, rangeStart, rangeEnd) => this.applyRatios(scope, pageNumber, rangeStart, rangeEnd, displayRatios, viewerRotation),
            (scope, rangeStart, rangeEnd) => this.restore(scope, pageNumber, rangeStart, rangeEnd),
            () => this.applyAll(),
        ).open();
    }

    async restore(
        scope: ViewportCropScope,
        currentPage: number,
        rangeStart = currentPage,
        rangeEnd = currentPage,
    ): Promise<void> {
        if (!this.child.file) return;
        const pages = getViewportCropPageNumbers(scope, currentPage, this.child.pdfViewer.pagesCount, rangeStart, rangeEnd);
        await this.store.clear(this.child.file.path, pages);
    }

    filterSelectionText(selection: Selection | null): string {
        if (!selection || selection.rangeCount === 0 || !this.child.file) return selection?.toString() ?? '';
        const state = this.store.get(this.child.file.path);
        if (!state || !Object.values(state.pages).some((page) => !page.stale)) return selection.toString();
        const range = selection.getRangeAt(0);
        let result = '';
        for (const pageView of this.child.pdfViewer?.pdfViewer?._pages ?? []) {
            const crop = state.pages[String(pageView.id)];
            const { characters, nodes } = this.getCharacterData(pageView);
            if (!characters.length) continue;
            const selected = characters.map((character) => ({
                ...character,
                selected: this.isCharacterSelected(range, nodes[character.itemIndex], character.itemOffset),
            }));
            const pageText = crop && !crop.stale
                ? filterViewportCropCharacters(selected, crop.rect, true)
                : selected.filter((character) => character.selected).map((character) => character.char + (character.lineBreakAfter ? '\n' : '')).join('');
            if (pageText) result += (result && !result.endsWith('\n') ? '\n' : '') + pageText;
        }
        return result || '';
    }

    getPagePoint(pageView: PDFPageView, x: number, y: number): number[] {
		return pageView.getPagePoint(x, y);
	}

	getPageCrop(pageNumber: number): ViewportCropPageState | undefined {
		return this.child.file ? this.store.get(this.child.file.path)?.pages[String(pageNumber)] : undefined;
	}

	hasActiveCrop(): boolean {
		if (!this.child.file || this.child.isFileExternal) return false;
		const state = this.store.get(this.child.file.path);
		return !!state && Object.values(state.pages).some((page) => !page.stale);
	}

    getCharacters(pageNumber: number): ViewportCropCharacter[] {
        const live = this.getCharacterData(this.child.getPage(pageNumber)).characters;
        return live.length ? live : this.characterCache.get(pageNumber) ?? [];
    }

    private async applyRatios(
        scope: ViewportCropScope,
        currentPage: number,
        rangeStart: number,
        rangeEnd: number,
        displayRatios: ViewportCropRatios,
        viewerRotation: ViewportCropPageState['rotation'],
    ): Promise<void> {
        const file = this.child.file;
        const pdfDocument = this.child.pdfViewer?.pdfViewer?.pdfDocument;
        if (!file || !pdfDocument || this.child.isFileExternal) throw new Error('A vault PDF is required.');
        const pageNumbers = getViewportCropPageNumbers(scope, currentPage, pdfDocument.numPages, rangeStart, rangeEnd);
        const sourceSha256 = await this.getSourceSha256(true);
        const loadedSha256 = await sha256Hex(await pdfDocument.getData());
        if (loadedSha256 !== sourceSha256) {
            throw new Error('The PDF changed after it was opened. Reopen it before applying a viewport crop.');
        }
        const existing = this.store.get(file.path);
        const pages: Record<string, ViewportCropPageState> = {};
        for (const [key, page] of Object.entries(existing?.pages ?? {})) {
            const pageNumber = Number(key);
            if (pageNumber >= 1 && pageNumber <= pdfDocument.numPages) pages[key] = page;
        }
        await Promise.all(pageNumbers.map(async (pageNumber) => {
            const page = await pdfDocument.getPage(pageNumber);
            const geometry = this.geometryFromPage(page);
            const effectiveRotation = normalizeViewportCropRotation(geometry.rotation + viewerRotation);
            const ratios = viewportCropRatiosFromDisplay(displayRatios, effectiveRotation);
            pages[String(pageNumber)] = createViewportCropPageState(rectFromRatios(geometry.viewBox, ratios), geometry);
            await this.cachePageCharacters(pageNumber, page);
        }));
        await this.store.set(createViewportCropDocumentState(file.path, sourceSha256, pdfDocument.numPages, pages));
    }

    private async getSourceSha256(verifyCurrent = false): Promise<string> {
        if (this.identitySha256 && !verifyCurrent) return this.identitySha256;
        if (!this.child.file || this.child.isFileExternal) throw new Error('A vault PDF is required.');
        const sourceSha256 = await sha256Hex(await this.plugin.app.vault.readBinary(this.child.file));
        if (verifyCurrent && this.identitySha256 && this.identitySha256 !== sourceSha256) {
            throw new Error('The PDF changed after it was opened. Reopen it before applying a viewport crop.');
        }
        this.identitySha256 = sourceSha256;
        return this.identitySha256;
    }

    private geometryFromPage(page: PDFPageProxy): ViewportCropPageGeometry {
        const [x1, y1, x2, y2] = page.view;
        const viewBox = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
        return {
            viewBox,
            pageWidth: viewBox.width,
            pageHeight: viewBox.height,
            rotation: normalizeViewportCropRotation(page.rotate),
        };
    }

    private restorePage(pageView: PDFPageView, teardown = false): void {
        const legacyShell = this.unwrapLegacyShell(pageView);
        const style = this.pageStyles.get(pageView.id);
        if (!style) {
            if (legacyShell || pageView.div.hasClass('pdf-plus-viewport-cropped')) {
                pageView.div.style.width = `${pageView.viewport.width}px`;
                pageView.div.style.height = `${pageView.viewport.height}px`;
                pageView.div.style.overflow = '';
                pageView.div.style.position = '';
                pageView.div.style.clipPath = '';
                pageView.div.removeClass('pdf-plus-viewport-cropped');
                for (const property of VIEWPORT_CROP_STYLE_PROPERTIES) pageView.div.style.removeProperty(property);
            }
            return;
        }
        pageView.div.removeClass('pdf-plus-viewport-cropped');
        const originalValues = [
            style.originalCropOffsetX,
            style.originalCropOffsetY,
            style.originalPageWidth,
            style.originalPageHeight,
            style.originalCropWidth,
            style.originalCropHeight,
        ];
        VIEWPORT_CROP_STYLE_PROPERTIES.forEach((property, index) => {
            const value = originalValues[index];
            if (value) pageView.div.style.setProperty(property, value);
            else pageView.div.style.removeProperty(property);
        });
        if (teardown) {
            this.pageStyles.delete(pageView.id);
        }
    }

	private restoreAll(teardown = false): void {
		for (const pageView of this.child.pdfViewer?.pdfViewer?._pages ?? []) this.restorePage(pageView, teardown);
	}

	private ensurePageStyle(pageView: PDFPageView): PageStyle {
		const existing = this.pageStyles.get(pageView.id);
		if (existing) return existing;
		const style: PageStyle = {
			originalCropOffsetX: pageView.div.style.getPropertyValue('--pdf-plus-viewport-crop-offset-x'),
			originalCropOffsetY: pageView.div.style.getPropertyValue('--pdf-plus-viewport-crop-offset-y'),
			originalPageWidth: pageView.div.style.getPropertyValue('--pdf-plus-viewport-page-width'),
			originalPageHeight: pageView.div.style.getPropertyValue('--pdf-plus-viewport-page-height'),
			originalCropWidth: pageView.div.style.getPropertyValue('--pdf-plus-viewport-crop-width'),
			originalCropHeight: pageView.div.style.getPropertyValue('--pdf-plus-viewport-crop-height'),
		};
		this.pageStyles.set(pageView.id, style);
		return style;
	}

	/** Unwrap shells created by the previous viewport-crop implementation. */
    private unwrapLegacyShell(pageView: PDFPageView): boolean {
        const shell = Array.from(pageView.div.children)
			.find((child) => child.classList.contains('pdf-plus-viewport-shell')) as HTMLElement | undefined;
		if (!shell) return false;
        const content = Array.from(shell.children)
			.find((child) => child.classList.contains('pdf-plus-viewport-content')) as HTMLElement | undefined;
        if (content) {
            while (content.firstChild) pageView.div.insertBefore(content.firstChild, shell);
        }
		shell.remove();
		return true;
    }

    private getViewBox(pageView: PDFPageView): ViewportCropViewBox {
        const [x1, y1, x2, y2] = pageView.viewport.viewBox;
        return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    }

    private sameViewBox(a: ViewportCropViewBox, b: ViewportCropViewBox): boolean {
        return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6
            && Math.abs(a.width - b.width) < 1e-6 && Math.abs(a.height - b.height) < 1e-6;
    }

    private getCharacterData(pageView: PDFPageView): { characters: ViewportCropCharacter[]; nodes: Array<Text | null> } {
        const info = pageView.textLayer && getTextLayerInfo(pageView.textLayer);
        if (!info) return { characters: [], nodes: [] };
        const nodes = info.textDivs.map((div) => getFirstTextNodeIn(div));
        const characters: ViewportCropCharacter[] = [];
        let textOffset = 0;
        info.textContentItems.forEach((item: TextContentItem, itemIndex) => {
            const measured = item.chars?.length
                ? item.chars.map((character) => ({ char: character.u, rect: character.r }))
                : (info.textDivs[itemIndex]
                    ? Array.from(getCharactersWithBoundingBoxesInPDFCoords(pageView, info.textDivs[itemIndex]))
                    : []);
            let domOffset = 0;
            measured.forEach(({ char, rect }, measuredIndex) => {
                const [x1, y1, x2, y2] = rect;
                characters.push({
                    char,
                    rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) },
                    itemIndex,
                    itemOffset: domOffset,
                    textOffset: textOffset + domOffset,
                    lineBreakAfter: !!item.hasEOL && measuredIndex === measured.length - 1,
                });
                domOffset += char.length;
            });
            textOffset += item.str.length + (item.hasEOL ? 1 : 0);
        });
        return { characters, nodes };
    }

    private charactersFromItems(items: TextContentItem[]): ViewportCropCharacter[] {
        const characters: ViewportCropCharacter[] = [];
        let textOffset = 0;
        items.forEach((item, itemIndex) => {
            const measured = item.chars ?? [];
            let domOffset = 0;
            measured.forEach((character, measuredIndex) => {
                const [x1, y1, x2, y2] = character.r;
                characters.push({
                    char: character.u,
                    rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) },
                    itemIndex,
                    itemOffset: domOffset,
                    textOffset: textOffset + domOffset,
                    lineBreakAfter: !!item.hasEOL && measuredIndex === measured.length - 1,
                });
                domOffset += character.u.length;
            });
            textOffset += item.str.length + (item.hasEOL ? 1 : 0);
        });
        return characters;
    }

    private async cachePageCharacters(pageNumber: number, page: PDFPageProxy): Promise<void> {
        try {
            const textContent = await page.getTextContent({ includeChars: true } as never);
            const items = textContent.items.filter((item): item is TextContentItem => 'str' in item);
            this.characterCache.set(pageNumber, this.charactersFromItems(items));
        } catch (error) {
            this.characterCache.set(pageNumber, []);
            console.warn(`${this.plugin.manifest.name}: Character geometry is unavailable on page ${pageNumber}.`, error);
        }
    }

    private isCharacterSelected(range: Range, node: Text | null, offset: number): boolean {
        if (!node || offset >= node.length) return false;
        try {
            return range.intersectsNode(node)
                && range.comparePoint(node, offset + 1) !== -1
                && range.comparePoint(node, offset) !== 1;
        } catch {
            return false;
        }
    }

    private clampSelection(selection: Selection | null): void {
        if (this.selectionGuard || !selection || selection.rangeCount === 0 || !this.child.file) return;
        const state = this.store.get(this.child.file.path);
        if (!state) return;
        const range = selection.getRangeAt(0);
        const endpoints: SelectionEndpoint[] = [];
        let selectedHiddenCharacter = false;
        for (const pageView of this.child.pdfViewer?.pdfViewer?._pages ?? []) {
            const crop = state.pages[String(pageView.id)];
            const { characters, nodes } = this.getCharacterData(pageView);
            for (const character of characters) {
                const node = nodes[character.itemIndex];
                if (!this.isCharacterSelected(range, node, character.itemOffset)) continue;
                if ((!crop || crop.stale || isViewportCropCharacterVisible(character, crop.rect)) && node) {
                    endpoints.push({ node, offset: character.itemOffset });
                    endpoints.push({ node, offset: Math.min(node.length, character.itemOffset + character.char.length) });
                } else if (crop && !crop.stale) {
                    selectedHiddenCharacter = true;
                }
            }
        }
        if (!selectedHiddenCharacter) return;
        this.selectionGuard = true;
        try {
            if (endpoints.length >= 2) {
                selection.setBaseAndExtent(endpoints[0].node, endpoints[0].offset, endpoints.at(-1)!.node, endpoints.at(-1)!.offset);
            } else {
                selection.removeAllRanges();
            }
        } finally {
            this.selectionGuard = false;
        }
    }

    private showStaleNotice(pages: number[]): void {
        const key = pages.join(',');
        if (this.staleNoticeKey === key) return;
        this.staleNoticeKey = key;
        new Notice(`${this.plugin.manifest.name}: Viewport crop is paused for changed page${pages.length > 1 ? 's' : ''} ${key}. Re-crop or restore those pages.`);
    }
}
