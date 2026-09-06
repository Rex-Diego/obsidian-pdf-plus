import { Modal, Notice, Setting, type TextComponent } from 'obsidian';

import type PDFPlus from 'main';
import type { ViewportCropRatios, ViewportCropScope } from 'lib/viewport-crop';

type ViewportCropPreviewPage = {
    width: number;
    height: number;
};

export class ViewportCropModal extends Modal {
    private cropScope: ViewportCropScope = 'all';
    private rangeStart: number;
    private rangeEnd: number;
    private busy = false;

    constructor(
        private readonly plugin: PDFPlus,
        private readonly currentPage: number,
        private readonly pageCount: number,
        private readonly ratios: ViewportCropRatios,
        private readonly pageSize: ViewportCropPreviewPage,
        private readonly applyCrop: (scope: ViewportCropScope, start: number, end: number) => Promise<void>,
        private readonly restoreCrop: (scope: ViewportCropScope, start: number, end: number) => Promise<void>,
        private readonly finish: () => void,
    ) {
        super(plugin.app);
        this.rangeStart = currentPage;
        this.rangeEnd = currentPage;
    }

    onOpen(): void {
        this.setTitle('Viewport crop');
        this.contentEl.addClass('pdf-plus-viewport-crop-modal');
        this.renderPreview();

        const pageRange = new Setting(this.contentEl).setName('Page range');
        const rangeInputs: TextComponent[] = [];
        pageRange.addText((text) => {
            text.inputEl.type = 'number';
            text.inputEl.min = '1';
            text.inputEl.max = String(this.pageCount);
            text.setValue(String(this.rangeStart)).onChange((value) => this.rangeStart = Number(value));
            rangeInputs.push(text);
        });
        pageRange.controlEl.createSpan({ text: '–' });
        pageRange.addText((text) => {
            text.inputEl.type = 'number';
            text.inputEl.min = '1';
            text.inputEl.max = String(this.pageCount);
            text.setValue(String(this.rangeEnd)).onChange((value) => this.rangeEnd = Number(value));
            rangeInputs.push(text);
        });
        const updatePageRange = () => {
            const editable = this.cropScope === 'range';
            const start = this.cropScope === 'all' ? 1
                : this.cropScope === 'current' ? this.currentPage
                    : this.rangeStart;
            const end = this.cropScope === 'all' ? this.pageCount
                : this.cropScope === 'current' ? this.currentPage
                    : this.rangeEnd;
            rangeInputs[0].setValue(String(start)).setDisabled(!editable);
            rangeInputs[1].setValue(String(end)).setDisabled(!editable);
        };

        const applyTo = new Setting(this.contentEl)
            .setName('Apply to')
            .addDropdown((dropdown) => dropdown
                .addOption('current', `Current page (${this.currentPage})`)
                .addOption('range', 'Page range')
                .addOption('all', `All pages (1–${this.pageCount})`)
                .setValue(this.cropScope)
                .onChange((value) => {
                    this.cropScope = value as ViewportCropScope;
                    updatePageRange();
                }));
        applyTo.settingEl.after(pageRange.settingEl);
        updatePageRange();

        new Setting(this.contentEl)
            .addButton((button) => button
                .setCta()
                .setButtonText('Apply')
                .onClick(() => this.run(() => this.applyCrop(this.cropScope, this.rangeStart, this.rangeEnd))))
            .addButton((button) => button
                .setWarning()
                .setButtonText('Restore')
                .onClick(() => this.run(() => this.restoreCrop(this.cropScope, this.rangeStart, this.rangeEnd))))
            .addButton((button) => button
                .setButtonText('Cancel')
                .onClick(() => this.close()));

    }

    onClose(): void {
        this.contentEl.empty();
        this.finish();
    }

    private async run(action: () => Promise<void>): Promise<void> {
        if (this.busy) return;
        if (this.cropScope === 'range' && (!Number.isSafeInteger(this.rangeStart)
            || !Number.isSafeInteger(this.rangeEnd) || this.rangeStart < 1
            || this.rangeEnd > this.pageCount || this.rangeStart > this.rangeEnd)) {
            new Notice('Enter a valid page range.');
            return;
        }
        this.busy = true;
        try {
            await action();
            this.close();
        } catch (error) {
            console.error(error);
            new Notice(`${this.plugin.manifest.name}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.busy = false;
        }
    }

    private percent(value: number): string {
        return `${Math.round(value * 1000) / 10}%`;
    }

    private renderPreview(): void {
        const width = this.pageSize.width > 0 ? this.pageSize.width : 1;
        const height = this.pageSize.height > 0 ? this.pageSize.height : 1;
        const cropX = this.ratios.left * width;
        const cropY = this.ratios.top * height;
        const cropWidth = Math.max(0, (1 - this.ratios.left - this.ratios.right) * width);
        const cropHeight = Math.max(0, (1 - this.ratios.top - this.ratios.bottom) * height);
        const visibleArea = cropWidth * cropHeight / (width * height);

        const preview = this.contentEl.createDiv({ cls: 'pdf-plus-viewport-crop-preview' });
        const svg = preview.createSvg('svg', {
            cls: 'pdf-plus-viewport-crop-preview-page',
            attr: {
                viewBox: `0 0 ${width} ${height}`,
                preserveAspectRatio: 'xMidYMid meet',
                role: 'img',
                'aria-label': `Page ${this.currentPage} crop preview. ${this.percent(visibleArea)} of the page remains visible.`,
            },
        });
        svg.createSvg('rect', {
            cls: 'pdf-plus-viewport-crop-preview-paper',
            attr: { x: 0, y: 0, width, height },
        });
        svg.createSvg('rect', {
            cls: 'pdf-plus-viewport-crop-preview-excluded',
            attr: { x: 0, y: 0, width, height },
        });
        svg.createSvg('rect', {
            cls: 'pdf-plus-viewport-crop-preview-selection',
            attr: { x: cropX, y: cropY, width: cropWidth, height: cropHeight },
        });
        this.contentEl.createDiv({
            cls: 'pdf-plus-viewport-crop-preview-caption',
            text: `Page ${this.currentPage} · ${this.percent(visibleArea)} visible`,
        });
    }
}
