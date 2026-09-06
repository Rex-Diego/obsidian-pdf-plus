import type PDFPlus from 'main';
import type { PDFViewerChild } from 'typings';
import { isViewportCropMatchVisible, ViewportCropCharacter } from './viewport-crop-text';

type CompatibleFindController = {
	_pageMatches: number[][];
	_pageMatchesLength: number[][];
	_matchesCountTotal: number;
	_selected: FindCursor;
	_offset: FindCursor;
};

type FindCursor = { pageIdx: number; matchIdx: number | null };
type CursorTarget = { pageIdx: number; start?: number };

/**
 * Filters PDF.js' match arrays in-place. It is deliberately feature-detected:
 * unknown host layouts are skipped so an Obsidian viewer update cannot block
 * PDF rendering or plugin startup.
 */
export class ViewportCropSearchAdapter {
    private readonly listeners: Array<[string, (data?: unknown) => void]> = [];
    private running = false;
    private readonly originals = new Map<number, { filtered: number[]; matches: number[]; lengths?: number[] }>();

    constructor(
        private readonly plugin: PDFPlus,
        private readonly child: PDFViewerChild,
        private readonly getCharacters: (pageNumber: number) => ViewportCropCharacter[],
    ) {}

    attach(): void {
        const bus = this.child.pdfViewer?.eventBus;
        if (!bus) return;
        const refresh = () => this.filterMatches();
        for (const event of ['updatetextlayermatches', 'updatefindmatchescount', 'updatefindcontrolstate']) {
            bus.on(event as never, refresh as never);
            this.listeners.push([event, refresh]);
        }
    }

    unload(): void {
        const bus = this.child.pdfViewer?.eventBus;
        if (bus) {
            for (const [event, listener] of this.listeners) bus.off(event as never, listener as never);
        }
        this.listeners.length = 0;
        const raw = this.child.pdfViewer?.findController;
        if (this.isCompatible(raw)) this.restoreOriginals(raw, false);
    }

	filterMatches(): boolean {
		if (this.running || !this.child.file) return false;
		const raw = this.child.pdfViewer?.findController;
		const documentState = this.plugin.viewportCropStore.get(this.child.file.path);
		if ((!documentState || !Object.values(documentState.pages).some((page) => !page.stale))
			&& this.originals.size === 0) {
			return true;
		}
		if (!this.isCompatible(raw)) {
            return false;
        }
		if (!documentState || !Object.values(documentState.pages).some((page) => !page.stale)) {
			return this.restoreOriginals(raw, true);
		}

		for (let pageIndex = 0; pageIndex < raw._pageMatches.length; pageIndex++) {
			const crop = documentState.pages[String(pageIndex + 1)];
			const matches = raw._pageMatches[pageIndex];
			if (crop && !crop.stale && Array.isArray(matches)) {
				const lengths = raw._pageMatchesLength[pageIndex];
				if (!Array.isArray(lengths) || lengths.length !== matches.length
					|| (matches.length > 0 && this.getCharacters(pageIndex + 1).length === 0)) {
					return false;
				}
			}
		}

		this.running = true;
		try {
			const selectedTarget = this.captureCursor(raw, raw._selected);
			const offsetTarget = this.captureCursor(raw, raw._offset);
			for (let pageIndex = 0; pageIndex < raw._pageMatches.length; pageIndex++) {
                const crop = documentState.pages[String(pageIndex + 1)];
                if (!crop || crop.stale) {
                    const saved = this.originals.get(pageIndex);
                    if (saved && raw._pageMatches[pageIndex] === saved.filtered) {
                        raw._pageMatches[pageIndex] = [...saved.matches];
                        if (raw._pageMatchesLength && saved.lengths) raw._pageMatchesLength[pageIndex] = [...saved.lengths];
                    }
                    this.originals.delete(pageIndex);
                    continue;
                }
                const currentMatches = raw._pageMatches[pageIndex];
                const saved = this.originals.get(pageIndex);
                const matches = saved && currentMatches === saved.filtered ? saved.matches : currentMatches;
                if (!Array.isArray(matches)) continue;
				const currentLengths = raw._pageMatchesLength[pageIndex];
				const lengths = saved && currentMatches === saved.filtered ? saved.lengths : currentLengths;
				if (!Array.isArray(lengths) || lengths.length !== matches.length) {
					return false;
				}
                const characters = this.getCharacters(pageIndex + 1);
                const keptMatches: number[] = [];
                const keptLengths: number[] = [];
                matches.forEach((start, matchIndex) => {
					const length = lengths[matchIndex];
                    if (isViewportCropMatchVisible(characters, start, length, crop.rect)) {
                        keptMatches.push(start);
                        keptLengths.push(length);
                    }
                });
                raw._pageMatches[pageIndex] = keptMatches;
				raw._pageMatchesLength[pageIndex] = keptLengths;
                this.originals.set(pageIndex, {
                    filtered: keptMatches,
                    matches: [...matches],
					lengths: [...lengths],
				});
			}

			this.remapCursor(raw, raw._selected, selectedTarget, -1);
			this.remapCursor(raw, raw._offset, offsetTarget, null);
			const total = raw._pageMatches.reduce((sum, matches) => sum + (matches?.length ?? 0), 0);
			raw._matchesCountTotal = total;
			const selected = raw._selected;
			let current = 0;
			if (selected.matchIdx !== null && selected.matchIdx >= 0) {
				for (let page = 0; page < selected.pageIdx; page++) current += raw._pageMatches[page]?.length ?? 0;
				current += selected.matchIdx + 1;
            }
            const bus = this.child.pdfViewer?.eventBus;
            bus?.dispatch('updatetextlayermatches', { source: raw, pageIndex: -1 });
            bus?.dispatch('updatefindmatchescount', { source: raw, matchesCount: { current, total } });
            return true;
        } finally {
            this.running = false;
        }
    }

	private isCompatible(value: unknown): value is CompatibleFindController {
		if (!value || typeof value !== 'object') return false;
		const controller = value as CompatibleFindController;
		return Array.isArray(controller._pageMatches)
			&& Array.isArray(controller._pageMatchesLength)
			&& typeof controller._matchesCountTotal === 'number'
			&& this.isCursor(controller._selected)
			&& this.isCursor(controller._offset);
	}

	private restoreOriginals(raw: CompatibleFindController, notify: boolean): boolean {
		if (this.originals.size === 0) return true;
		const selectedTarget = this.captureCursor(raw, raw._selected);
		const offsetTarget = this.captureCursor(raw, raw._offset);
		for (const [pageIndex, saved] of this.originals) {
			if (raw._pageMatches[pageIndex] === saved.filtered) {
				raw._pageMatches[pageIndex] = [...saved.matches];
				if (saved.lengths) raw._pageMatchesLength[pageIndex] = [...saved.lengths];
			}
		}
		this.originals.clear();
		this.remapCursor(raw, raw._selected, selectedTarget, -1);
		this.remapCursor(raw, raw._offset, offsetTarget, null);
        raw._matchesCountTotal = raw._pageMatches.reduce((sum, matches) => sum + (matches?.length ?? 0), 0);
        if (notify) {
            const bus = this.child.pdfViewer?.eventBus;
            bus?.dispatch('updatetextlayermatches', { source: raw, pageIndex: -1 });
            bus?.dispatch('updatefindmatchescount', { source: raw, matchesCount: { current: 0, total: raw._matchesCountTotal } });
        }
		return true;
	}

	private isCursor(value: unknown): value is FindCursor {
		if (!value || typeof value !== 'object') return false;
		const cursor = value as FindCursor;
		return Number.isSafeInteger(cursor.pageIdx)
			&& (cursor.matchIdx === null || Number.isSafeInteger(cursor.matchIdx));
	}

	private captureCursor(raw: CompatibleFindController, cursor: FindCursor): CursorTarget | null {
		if (cursor.matchIdx === null || cursor.matchIdx < 0) return null;
		const matches = raw._pageMatches[cursor.pageIdx];
		return {
			pageIdx: cursor.pageIdx,
			start: Array.isArray(matches) ? matches[cursor.matchIdx] : undefined,
		};
	}

	private remapCursor(
		raw: CompatibleFindController,
		cursor: FindCursor,
		target: CursorTarget | null,
		missingValue: -1 | null,
	): void {
		if (!target) return;
		cursor.pageIdx = target.pageIdx;
		const matches = raw._pageMatches[target.pageIdx];
		const index = target.start === undefined || !Array.isArray(matches) ? -1 : matches.indexOf(target.start);
		cursor.matchIdx = index >= 0 ? index : missingValue;
	}
}
