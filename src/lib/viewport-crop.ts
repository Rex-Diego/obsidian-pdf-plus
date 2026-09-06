import type PDFPlus from 'main';

export type ViewportCropRotation = 0 | 90 | 180 | 270;

export interface ViewportCropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type ViewportCropViewBox = ViewportCropRect;

export interface ViewportCropRatios {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export interface ViewportCropPageGeometry {
    viewBox: ViewportCropViewBox;
    pageWidth: number;
    pageHeight: number;
    rotation: ViewportCropRotation;
}

export interface ViewportCropPageState extends ViewportCropPageGeometry {
    rect: ViewportCropRect;
    ratios: ViewportCropRatios;
    stale?: boolean;
    staleReason?: string;
}

export interface ViewportCropDocumentState {
    schemaVersion: 1;
    fileKey: string;
    sourceSha256: string;
    pageCount: number;
    pages: Record<string, ViewportCropPageState>;
    updatedAt: number;
}

export interface ViewportCropReconcileResult {
    state: ViewportCropDocumentState;
    changed: boolean;
    stalePages: number[];
}

export interface ViewportCropViewportBounds {
    left: number;
    top: number;
    width: number;
    height: number;
}

export type ViewportCropScope = 'current' | 'range' | 'all';

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const EPSILON = 1e-6;

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

const clone = <T>(value: T): T => structuredClone(value);

export function normalizeViewportCropRotation(value: number): ViewportCropRotation {
    if (!isFiniteNumber(value)) throw new Error('Viewport crop rotation must be finite.');
    const normalized = ((value % 360) + 360) % 360;
    const quarterTurn = [0, 90, 180, 270].find((candidate) => Math.abs(candidate - normalized) <= EPSILON);
    if (quarterTurn === undefined) throw new Error('Viewport crop supports only quarter-turn rotations.');
    return quarterTurn as ViewportCropRotation;
}

export function assertViewportCropViewBox(value: ViewportCropViewBox): ViewportCropViewBox {
    if (!value || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)
        || !isFiniteNumber(value.width) || !isFiniteNumber(value.height)
        || value.width <= 0 || value.height <= 0) {
        throw new Error('Invalid viewport crop page box.');
    }
    return value;
}

export function normalizeViewportCropRect(
    value: ViewportCropRect,
    viewBox?: ViewportCropViewBox,
): ViewportCropRect {
    if (!value || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)
        || !isFiniteNumber(value.width) || !isFiniteNumber(value.height)
        || value.width <= 0 || value.height <= 0) {
        throw new Error('Invalid viewport crop rectangle.');
    }

    if (!viewBox) return { ...value };
    assertViewportCropViewBox(viewBox);
    const left = Math.max(value.x, viewBox.x);
    const bottom = Math.max(value.y, viewBox.y);
    const right = Math.min(value.x + value.width, viewBox.x + viewBox.width);
    const top = Math.min(value.y + value.height, viewBox.y + viewBox.height);
    if (right - left <= EPSILON || top - bottom <= EPSILON) {
        throw new Error('Viewport crop rectangle is outside the page.');
    }
    return { x: left, y: bottom, width: right - left, height: top - bottom };
}

export function assertViewportCropRatios(value: ViewportCropRatios): ViewportCropRatios {
    for (const key of ['top', 'right', 'bottom', 'left'] as const) {
        if (!isFiniteNumber(value?.[key]) || value[key] < 0 || value[key] >= 1) {
            throw new Error('Invalid viewport crop ratios.');
        }
    }
    if (value.left + value.right >= 1 - EPSILON || value.top + value.bottom >= 1 - EPSILON) {
        throw new Error('Viewport crop ratios leave no visible page area.');
    }
    return value;
}

export function ratiosFromRect(
    rect: ViewportCropRect,
    viewBox: ViewportCropViewBox,
): ViewportCropRatios {
    const page = assertViewportCropViewBox(viewBox);
    const normalized = normalizeViewportCropRect(rect, page);
    return {
        top: (page.y + page.height - normalized.y - normalized.height) / page.height,
        right: (page.x + page.width - normalized.x - normalized.width) / page.width,
        bottom: (normalized.y - page.y) / page.height,
        left: (normalized.x - page.x) / page.width,
    };
}

export function rectFromRatios(
    viewBox: ViewportCropViewBox,
    ratios: ViewportCropRatios,
): ViewportCropRect {
    const page = assertViewportCropViewBox(viewBox);
    const insets = assertViewportCropRatios(ratios);
    return normalizeViewportCropRect({
        x: page.x + page.width * insets.left,
        y: page.y + page.height * insets.bottom,
        width: page.width * (1 - insets.left - insets.right),
        height: page.height * (1 - insets.top - insets.bottom),
    }, page);
}

function ratioArray(value: ViewportCropRatios): [number, number, number, number] {
    assertViewportCropRatios(value);
    return [value.top, value.right, value.bottom, value.left];
}

function ratiosFromArray(value: [number, number, number, number]): ViewportCropRatios {
    return { top: value[0], right: value[1], bottom: value[2], left: value[3] };
}

/** Converts PDF-coordinate edge insets to top/right/bottom/left in the rendered orientation. */
export function viewportCropRatiosToDisplay(
    ratios: ViewportCropRatios,
    rotation: ViewportCropRotation,
): ViewportCropRatios {
    const source = ratioArray(ratios);
    const turns = normalizeViewportCropRotation(rotation) / 90;
    return ratiosFromArray([0, 1, 2, 3].map((index) => source[(index - turns + 4) % 4]) as [number, number, number, number]);
}

/** Converts rendered top/right/bottom/left insets back to PDF-coordinate edges. */
export function viewportCropRatiosFromDisplay(
    ratios: ViewportCropRatios,
    rotation: ViewportCropRotation,
): ViewportCropRatios {
    const source = ratioArray(ratios);
    const turns = normalizeViewportCropRotation(rotation) / 90;
    return ratiosFromArray([0, 1, 2, 3].map((index) => source[(index + turns) % 4]) as [number, number, number, number]);
}

export function viewportCropRectToViewportBounds(
    rect: ViewportCropRect,
    viewport: {
        width: number;
        height: number;
        convertToViewportPoint(x: number, y: number): number[];
    },
): ViewportCropViewportBounds {
    const first = viewport.convertToViewportPoint(rect.x, rect.y);
    const second = viewport.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height);
    const left = Math.max(0, Math.min(first[0], second[0]));
    const top = Math.max(0, Math.min(first[1], second[1]));
    return {
        left,
        top,
        width: Math.min(viewport.width - left, Math.abs(second[0] - first[0])),
        height: Math.min(viewport.height - top, Math.abs(second[1] - first[1])),
    };
}

export function createViewportCropPageState(
    rect: ViewportCropRect,
    geometry: ViewportCropPageGeometry,
): ViewportCropPageState {
    const viewBox = { ...assertViewportCropViewBox(geometry.viewBox) };
    const normalizedRect = normalizeViewportCropRect(rect, viewBox);
    if (!isFiniteNumber(geometry.pageWidth) || geometry.pageWidth <= 0
        || !isFiniteNumber(geometry.pageHeight) || geometry.pageHeight <= 0) {
        throw new Error('Invalid viewport crop page dimensions.');
    }
    return {
        rect: normalizedRect,
        viewBox,
        pageWidth: geometry.pageWidth,
        pageHeight: geometry.pageHeight,
        rotation: normalizeViewportCropRotation(geometry.rotation),
        ratios: ratiosFromRect(normalizedRect, viewBox),
    };
}

export function createViewportCropDocumentState(
    fileKey: string,
    sourceSha256: string,
    pageCount: number,
    pages: Record<string, ViewportCropPageState> = {},
    now = Date.now(),
): ViewportCropDocumentState {
    const state: ViewportCropDocumentState = {
        schemaVersion: 1,
        fileKey,
        sourceSha256: sourceSha256.toLowerCase(),
        pageCount,
        pages: clone(pages),
        updatedAt: now,
    };
    if (!isViewportCropDocumentState(state)) throw new Error('Invalid viewport crop document state.');
    return state;
}

export function getViewportCropPageNumbers(
    scope: ViewportCropScope,
    currentPage: number,
    pageCount: number,
    rangeStart = currentPage,
    rangeEnd = currentPage,
): number[] {
    if (!Number.isSafeInteger(currentPage) || currentPage < 1 || currentPage > pageCount
        || !Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('Invalid viewport crop page selection.');
    }
    if (scope === 'current') return [currentPage];
    if (scope === 'all') return Array.from({ length: pageCount }, (_, index) => index + 1);
    if (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd)
        || rangeStart < 1 || rangeEnd > pageCount || rangeStart > rangeEnd) {
        throw new Error('Invalid viewport crop page range.');
    }
    return Array.from({ length: rangeEnd - rangeStart + 1 }, (_, index) => rangeStart + index);
}

export function isViewportCropPageState(value: unknown): value is ViewportCropPageState {
    try {
        const state = value as ViewportCropPageState;
        assertViewportCropViewBox(state.viewBox);
        normalizeViewportCropRect(state.rect, state.viewBox);
        assertViewportCropRatios(state.ratios);
        normalizeViewportCropRotation(state.rotation);
        return isFiniteNumber(state.pageWidth) && state.pageWidth > 0
            && isFiniteNumber(state.pageHeight) && state.pageHeight > 0
            && (state.stale === undefined || typeof state.stale === 'boolean')
            && (state.staleReason === undefined || typeof state.staleReason === 'string');
    } catch {
        return false;
    }
}

export function isViewportCropDocumentState(value: unknown): value is ViewportCropDocumentState {
    if (!value || typeof value !== 'object') return false;
    const state = value as ViewportCropDocumentState;
    if (state.schemaVersion !== 1 || typeof state.fileKey !== 'string' || !state.fileKey
        || !SHA256_PATTERN.test(state.sourceSha256)
        || !Number.isSafeInteger(state.pageCount) || state.pageCount <= 0
        || !isFiniteNumber(state.updatedAt)
        || !state.pages || typeof state.pages !== 'object' || Array.isArray(state.pages)) {
        return false;
    }
    return Object.entries(state.pages).every(([page, pageState]) => {
        const pageNumber = Number(page);
        return /^\d+$/.test(page) && Number.isSafeInteger(pageNumber)
            && pageNumber >= 1 && pageNumber <= state.pageCount
            && isViewportCropPageState(pageState);
    });
}

function sameViewBox(a: ViewportCropViewBox, b: ViewportCropViewBox): boolean {
    return Math.abs(a.x - b.x) <= EPSILON
        && Math.abs(a.y - b.y) <= EPSILON
        && Math.abs(a.width - b.width) <= EPSILON
        && Math.abs(a.height - b.height) <= EPSILON;
}

function stalePage(page: ViewportCropPageState, reason: string): ViewportCropPageState {
    return { ...clone(page), stale: true, staleReason: reason };
}

export function reconcileViewportCropDocument(
    input: ViewportCropDocumentState,
    sourceSha256: string,
    pageCount: number,
    geometries: Record<number, ViewportCropPageGeometry>,
    now = Date.now(),
): ViewportCropReconcileResult {
    if (!isViewportCropDocumentState(input)) throw new Error('Invalid viewport crop document state.');
    if (!SHA256_PATTERN.test(sourceSha256) || !Number.isSafeInteger(pageCount) || pageCount <= 0) {
        throw new Error('Invalid PDF identity for viewport crop reconciliation.');
    }

    const state = clone(input);
    const hashMatches = state.sourceSha256.toLowerCase() === sourceSha256.toLowerCase();
    const pageCountMatches = state.pageCount === pageCount;
    const stalePages: number[] = [];
    let changed = false;

    for (const [key, saved] of Object.entries(state.pages)) {
        const pageNumber = Number(key);
        const geometry = geometries[pageNumber];
        let next: ViewportCropPageState;
        if (!pageCountMatches) {
            next = stalePage(saved, 'The PDF page count changed.');
        } else if (!geometry) {
            next = stalePage(saved, 'The page geometry is unavailable.');
        } else {
            try {
                const normalizedGeometry: ViewportCropPageGeometry = {
                    viewBox: { ...assertViewportCropViewBox(geometry.viewBox) },
                    pageWidth: geometry.pageWidth,
                    pageHeight: geometry.pageHeight,
                    rotation: normalizeViewportCropRotation(geometry.rotation),
                };
                if (saved.rotation !== normalizedGeometry.rotation) {
                    next = stalePage(saved, 'The page rotation changed.');
                } else if (hashMatches) {
                    next = sameViewBox(saved.viewBox, normalizedGeometry.viewBox)
                        ? { ...saved, stale: false, staleReason: undefined }
                        : stalePage(saved, 'The page box no longer matches the saved PDF.');
                } else {
                    next = createViewportCropPageState(
                        rectFromRatios(normalizedGeometry.viewBox, saved.ratios),
                        normalizedGeometry,
                    );
                }
            } catch {
                next = stalePage(saved, 'The page box is incompatible with the saved crop.');
            }
        }
        if (next.stale) stalePages.push(pageNumber);
        if (JSON.stringify(next) !== JSON.stringify(saved)) changed = true;
        state.pages[key] = next;
    }

    if (!hashMatches && pageCountMatches && stalePages.length === 0) {
        state.sourceSha256 = sourceSha256.toLowerCase();
        state.pageCount = pageCount;
        changed = true;
    }
    if (changed) state.updatedAt = now;
    return { state, changed, stalePages };
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class ViewportCropStore {
    private states: Record<string, ViewportCropDocumentState> = {};
    private saveQueue: Promise<void> = Promise.resolve();

    constructor(private readonly plugin: PDFPlus) {}

    load(raw: unknown): void {
        this.states = {};
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        for (const [fileKey, candidate] of Object.entries(raw)) {
            if (isViewportCropDocumentState(candidate) && candidate.fileKey === fileKey) {
                this.states[fileKey] = clone(candidate);
            }
        }
    }

    get(fileKey: string): ViewportCropDocumentState | undefined {
        const state = this.states[fileKey];
        return state ? clone(state) : undefined;
    }

    snapshot(): Record<string, ViewportCropDocumentState> {
        return clone(this.states);
    }

    async set(state: ViewportCropDocumentState): Promise<void> {
        if (!isViewportCropDocumentState(state)) throw new Error('Invalid viewport crop document state.');
        this.states[state.fileKey] = clone(state);
        await this.persist(state.fileKey);
    }

    async clear(fileKey: string, pages?: Iterable<number>): Promise<void> {
        const state = this.states[fileKey];
        if (!state) return;
        if (pages === undefined) {
            delete this.states[fileKey];
        } else {
            for (const page of pages) {
                if (Number.isSafeInteger(page) && page >= 1) delete state.pages[String(page)];
            }
            state.updatedAt = Date.now();
            if (Object.keys(state.pages).length === 0) delete this.states[fileKey];
        }
        await this.persist(fileKey);
    }

    async rename(oldPath: string, newPath: string, sourceSha256: string): Promise<boolean> {
        const state = this.states[oldPath];
        if (!state || !SHA256_PATTERN.test(sourceSha256)
            || state.sourceSha256.toLowerCase() !== sourceSha256.toLowerCase()
            || (this.states[newPath] && newPath !== oldPath)) {
            return false;
        }
        delete this.states[oldPath];
        state.fileKey = newPath;
        state.updatedAt = Date.now();
        this.states[newPath] = state;
        await this.persist(newPath);
        return true;
    }

    async reconcile(
        fileKey: string,
        sourceSha256: string,
        pageCount: number,
        geometries: Record<number, ViewportCropPageGeometry>,
    ): Promise<ViewportCropReconcileResult | undefined> {
        const current = this.states[fileKey];
        if (!current) return undefined;
        const result = reconcileViewportCropDocument(current, sourceSha256, pageCount, geometries);
        if (result.changed) {
            this.states[fileKey] = clone(result.state);
            await this.persist(fileKey);
        }
        return { ...result, state: clone(result.state), stalePages: [...result.stalePages] };
    }

    private async persist(fileKey: string): Promise<void> {
        const snapshot = this.snapshot();
        const task = this.saveQueue.then(async () => {
            this.plugin.settings.viewportCropDocuments = clone(snapshot);
            await this.plugin.saveSettings();
        });
        this.saveQueue = task.catch(() => undefined);
        await task;
        this.plugin.trigger('viewport-crop-state-change', fileKey);
    }
}
