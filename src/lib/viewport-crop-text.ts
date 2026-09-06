import type { ViewportCropRect } from './viewport-crop';

export interface ViewportCropCharacter {
    char: string;
    rect: ViewportCropRect;
    itemIndex: number;
    itemOffset: number;
    /** Offset in PDF.js' concatenated page text, used by the find controller. */
    textOffset: number;
    selected?: boolean;
    lineBreakAfter?: boolean;
}
export function isViewportCropCharacterVisible(
    character: Pick<ViewportCropCharacter, 'rect'>,
    crop: ViewportCropRect,
): boolean {
    const x = character.rect.x + character.rect.width / 2;
    const y = character.rect.y + character.rect.height / 2;
    return x >= crop.x && x <= crop.x + crop.width
        && y >= crop.y && y <= crop.y + crop.height;
}

export function filterViewportCropCharacters(
    characters: readonly ViewportCropCharacter[],
    crop: ViewportCropRect,
    selectedOnly = false,
): string {
    let text = '';
    for (const character of characters) {
        if ((!selectedOnly || character.selected) && isViewportCropCharacterVisible(character, crop)) {
            text += character.char;
            if (character.lineBreakAfter) text += '\n';
        }
    }
    return text;
}

export function isViewportCropMatchVisible(
    characters: readonly ViewportCropCharacter[],
    start: number,
    length: number,
    crop: ViewportCropRect,
): boolean {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0) return false;
    const end = start + length;
    const matched = characters.filter(({ textOffset, char }) =>
        textOffset >= start && textOffset < end && char.trim().length > 0);
    return matched.length > 0 && matched.every((character) => isViewportCropCharacterVisible(character, crop));
}
