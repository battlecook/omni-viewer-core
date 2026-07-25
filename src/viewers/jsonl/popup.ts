export interface JsonlPopupPositionInput {
    mouseX: number;
    mouseY: number;
    popupWidth: number;
    popupHeight: number;
    viewportWidth: number;
    viewportHeight: number;
    margin?: number;
    offsetX?: number;
    offsetY?: number;
}

/** Place a cursor-following popup inside the visible viewport. */
export function clampJsonlPopupPosition(input: JsonlPopupPositionInput): { left: number; top: number } {
    const margin = input.margin ?? 12;
    const offsetX = input.offsetX ?? 16;
    const offsetY = input.offsetY ?? 12;
    const maxLeft = Math.max(margin, input.viewportWidth - input.popupWidth - margin);
    const maxTop = Math.max(margin, input.viewportHeight - input.popupHeight - margin);
    let left = input.mouseX + offsetX;
    if (left + input.popupWidth > input.viewportWidth - margin) {
        const flipped = input.mouseX - offsetX - input.popupWidth;
        left = flipped >= margin ? flipped : maxLeft;
    }
    let top = input.mouseY + offsetY;
    if (top + input.popupHeight > input.viewportHeight - margin) top = maxTop;
    return {
        left: Math.max(margin, Math.min(left, maxLeft)),
        top: Math.max(margin, Math.min(top, maxTop))
    };
}
