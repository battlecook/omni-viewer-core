// Image viewer stylesheet (DESIGN.md §6). Single source: the build emits
// dist/styles/image.css and the renderer injects this constant into the shadow
// root. Only --omni-* tokens (with fallbacks) — never platform variables.

export const imageViewerCss = `
/* Reverse-contamination guard (DESIGN.md §6): scoped mode neutralizes host
   element styles; custom properties still pierce. Shadow mode: harmless. */
.omni-viewer--image {
    all: initial;
}
.omni-viewer--image :where(button, select, option, input, label, canvas, img) {
    all: revert;
}

:host, .omni-viewer--image {
    display: block;
    height: 100%;
    box-sizing: border-box;
    color: var(--omni-fg, #d4d4d4);
    background: var(--omni-bg, #1e1e1e);
    font-family: var(--omni-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    font-size: var(--omni-font-size, 13px);
}
.omni-image {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
}
.omni-image__toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--omni-border, #333);
}
.omni-image__toolbar button,
.omni-image__toolbar select {
    background: var(--omni-button-bg, #2a2a2a);
    color: inherit;
    border: 1px solid var(--omni-border, #444);
    border-radius: 4px;
    padding: 3px 8px;
    cursor: pointer;
}
.omni-image__toolbar button[aria-pressed="true"] {
    background: var(--omni-accent, #0e639c);
    border-color: var(--omni-accent, #0e639c);
}
.omni-image__toolbar button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.omni-image__spacer { flex: 1; }
.omni-image__meta { opacity: 0.8; font-variant-numeric: tabular-nums; }
.omni-image__diagnostics {
    padding: 4px 8px;
    border-bottom: 1px solid var(--omni-border, #333);
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.omni-image__diag-error { color: var(--omni-error, #f14c4c); }

/* Scrollable stage; checkerboard shows transparency (image.md §5). */
.omni-image__stage {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: grid;
    place-items: center;
    background-color: var(--omni-bg, #1e1e1e);
    background-image:
        linear-gradient(45deg, var(--omni-checker, #2a2a2a) 25%, transparent 25%),
        linear-gradient(-45deg, var(--omni-checker, #2a2a2a) 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, var(--omni-checker, #2a2a2a) 75%),
        linear-gradient(-45deg, transparent 75%, var(--omni-checker, #2a2a2a) 75%);
    background-size: 20px 20px;
    background-position: 0 0, 0 10px, 10px -10px, -10px 0;
}
.omni-image__canvas-wrap {
    position: relative;
    line-height: 0;
    transform-origin: center center;
}
.omni-image__canvas-wrap canvas,
.omni-image__canvas-wrap img {
    display: block;
    max-width: none;
}
.omni-image__overlay {
    position: absolute;
    inset: 0;
    outline: none;
}
.omni-image__aria-live {
    position: absolute;
    width: 1px; height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
}
.omni-image__empty {
    padding: 16px;
    opacity: 0.8;
}
.omni-image__toast {
    position: absolute;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    background: var(--omni-toast-bg, #333);
    color: var(--omni-fg, #d4d4d4);
    padding: 6px 12px;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}
`;
