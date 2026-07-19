// PDF viewer stylesheet. Single source for both delivery forms (DESIGN.md §6).
// Only --omni-* tokens (with fallbacks); the white page background is the
// deliberate "paper" color, not a theme value.

export const pdfViewerCss = `
/* Reverse-contamination guard for 'scoped' mode — see csv/styles.ts. */
.omni-viewer--pdf {
    all: initial;
}
.omni-viewer--pdf :where(button, input, canvas, img, span, div) {
    all: revert;
}

:host, .omni-viewer--pdf {
    display: block;
    height: 100%;
    box-sizing: border-box;
    color: var(--omni-fg, #e8e8e8);
    background: var(--omni-bg, #1e1e1e);
    font-family: var(--omni-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    font-size: var(--omni-font-size, 13px);
}
.omni-pdf, .omni-pdf * { box-sizing: border-box; }
.omni-pdf {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
}
.omni-pdf__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    background: var(--omni-bg-secondary, #252526);
    border-bottom: 1px solid var(--omni-border, #3c3c3c);
    flex: none;
}
.omni-pdf__title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40%;
}
.omni-pdf__toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
}
.omni-pdf__page-info {
    color: var(--omni-fg-muted, #9d9d9d);
    margin-right: 8px;
}
.omni-pdf__save-mode {
    padding: 2px 6px;
    color: var(--omni-fg-muted, #9d9d9d);
    border: 1px solid var(--omni-border, #3c3c3c);
    border-radius: 999px;
    font-size: 11px;
    white-space: nowrap;
}
.omni-pdf__page-input {
    width: 52px;
    padding: 3px 5px;
    margin-right: 5px;
    color: var(--omni-fg, #e8e8e8);
    background: var(--omni-input-bg, #3c3c3c);
    border: 1px solid var(--omni-border, #3c3c3c);
    border-radius: 4px;
    font: inherit;
    text-align: center;
}
.omni-pdf__page-input:focus {
    outline: 1px solid var(--omni-accent, #0e639c);
    border-color: var(--omni-accent, #0e639c);
}
.omni-pdf button {
    font: inherit;
    color: var(--omni-fg, #e8e8e8);
    background: var(--omni-button-bg, #3a3d41);
    border: 1px solid var(--omni-border, #3c3c3c);
    border-radius: 4px;
    cursor: pointer;
}
.omni-pdf button:hover:not(:disabled) {
    background: var(--omni-button-hover-bg, #45494e);
}
.omni-pdf button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}
.omni-pdf button[aria-pressed="true"] {
    background: var(--omni-accent, #0e639c);
    border-color: var(--omni-accent, #0e639c);
    color: var(--omni-accent-fg, #ffffff);
}
.omni-pdf__tool { padding: 5px 10px; }
.omni-pdf__markup-wrap {
    position: relative;
    display: inline-flex;
}
.omni-pdf__markup-wrap .omni-pdf__tool {
    min-width: 34px;
    padding: 4px 8px;
    font-size: 21px;
    line-height: 1;
    border-radius: 4px 0 0 4px;
}
.omni-pdf__markup-menu-btn {
    min-width: 28px;
    padding: 0 6px;
    border-radius: 0 4px 4px 0;
}
.omni-pdf__markup-menu {
    position: absolute;
    z-index: 20;
    top: calc(100% + 4px);
    left: 0;
    display: none;
    min-width: 170px;
    padding: 7px;
    background: var(--omni-bg-secondary, #252526);
    border: 1px solid var(--omni-border, #3c3c3c);
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
}
.omni-pdf__markup-menu.is-open { display: block; }
.omni-pdf__markup-choice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    box-sizing: border-box;
    min-height: 32px;
    padding: 2px 0;
}
.omni-pdf__markup-menu button {
    flex: 1;
    min-height: 32px;
    padding: 5px 8px;
    color: inherit;
    font: inherit;
}
.omni-pdf__markup-menu button {
    text-align: left;
    background: transparent;
    border-color: transparent;
}
.omni-pdf__markup-menu button:hover,
.omni-pdf__markup-menu button[aria-checked="true"] { background: var(--omni-button-hover-bg, #45494e); }
.omni-pdf__markup-menu button[aria-checked="true"]::before { content: "✓ "; }
.omni-pdf__highlight-color {
    width: 30px;
    height: 28px;
    padding: 2px;
    border: 1px solid var(--omni-border, #3c3c3c);
    border-radius: 4px;
    background: var(--omni-button-bg, #3a3d41);
    cursor: pointer;
}
.omni-pdf__highlight-color:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}
.omni-pdf__zoom {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 6px;
    background: var(--omni-bg-secondary, #252526);
    border-bottom: 1px solid var(--omni-border, #3c3c3c);
    flex: none;
}
.omni-pdf__zoom-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    font-size: 18px;
    line-height: 1;
}
.omni-pdf__zoom-level {
    min-width: 56px;
    text-align: center;
}
.omni-pdf__view-menu-wrap { position: relative; }
.omni-pdf__view-menu-btn {
    width: 30px;
    height: 28px;
    padding: 0;
    font-size: 22px;
    line-height: 1;
}
.omni-pdf__view-menu {
    position: absolute;
    z-index: 20;
    top: calc(100% + 4px);
    right: 0;
    display: none;
    min-width: 210px;
    padding: 6px;
    background: var(--omni-bg-secondary, #252526);
    border: 1px solid var(--omni-border, #3c3c3c);
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
}
.omni-pdf__view-menu.is-open { display: block; }
.omni-pdf__view-menu button {
    display: block;
    width: 100%;
    padding: 7px 10px;
    text-align: left;
    background: transparent;
    border-color: transparent;
}
.omni-pdf__view-menu button:hover,
.omni-pdf__view-menu button[aria-checked="true"] {
    background: var(--omni-button-hover-bg, #45494e);
}
.omni-pdf__view-menu button[aria-checked="true"]::before {
    content: "✓ ";
}
.omni-pdf__view-menu hr {
    height: 1px;
    margin: 5px 2px;
    border: 0;
    background: var(--omni-border, #3c3c3c);
}
.omni-pdf__body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 160px minmax(0, 1fr);
    overflow: hidden;
}
.omni-pdf__thumbs {
    overflow: auto;
    min-height: 0;
    background: var(--omni-bg-secondary, #252526);
    border-right: 1px solid var(--omni-border, #3c3c3c);
    padding: 8px;
}
.omni-pdf__thumb {
    position: relative;
    display: flex;
    width: 100%;
    min-height: 130px;
    margin: 0 0 8px;
    padding: 6px;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 4px;
    background: transparent;
}
.omni-pdf__thumb:hover,
.omni-pdf__thumb[aria-current] {
    background: var(--omni-button-hover-bg, #45494e);
    border-color: var(--omni-accent, #0e639c);
}
.omni-pdf__thumb.is-dragging { opacity: 0.5; }
.omni-pdf__thumb.drop-before::before,
.omni-pdf__thumb.drop-after::after {
    content: "";
    position: absolute;
    left: -4px;
    right: -4px;
    height: 3px;
    background: var(--omni-accent, #0e639c);
    border-radius: 2px;
    z-index: 4;
}
.omni-pdf__thumb.drop-before::before { top: -6px; }
.omni-pdf__thumb.drop-after::after { bottom: -6px; }
.omni-pdf__thumb canvas {
    display: block;
    max-width: 100%;
    background: #ffffff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
}
.omni-pdf__thumb-page {
    position: relative;
    max-width: 100%;
}
.omni-pdf__thumb-annotation {
    position: absolute;
    z-index: 1;
    overflow: hidden;
    pointer-events: none;
    color: #111111; /* ink on paper */
    white-space: nowrap;
}
.omni-pdf__thumb-annotation img { display: block; }
.omni-pdf__thumb-annotation.omni-pdf__underline::after,
.omni-pdf__thumb-annotation.omni-pdf__strikeout::after {
    height: 1px;
}
.omni-pdf__thumb-label {
    font-family: var(--omni-font-mono, Monaco, Menlo, monospace);
    font-size: 10px;
    color: var(--omni-fg-muted, #9d9d9d);
}
.omni-pdf__thumb-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: 50%;
}
.omni-pdf__pages {
    overflow: auto;
    position: relative;
    padding: 20px;
    min-width: 0;
    min-height: 0;
}
.omni-pdf__pages--spread {
    display: grid;
    grid-template-columns: repeat(2, max-content);
    align-content: start;
    justify-content: center;
    column-gap: 16px;
}
.omni-pdf__spread-blank {
    min-width: 1px;
}
.omni-pdf__pages--theme .omni-pdf__page {
    background: var(--omni-bg-secondary, #252526);
}
.omni-pdf__pages--theme .omni-pdf__page canvas {
    filter: invert(0.92) hue-rotate(180deg);
}
.omni-pdf__page {
    position: relative;
    margin: 0 auto 16px;
    background: #ffffff; /* paper */
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
}
.omni-pdf__page canvas {
    display: block;
    max-width: 100%;
    height: auto;
}
.omni-pdf__placeholder {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    color: var(--omni-fg-muted, #9d9d9d);
}
.omni-pdf__text-layer {
    position: absolute;
    inset: 0;
    z-index: 1;
    overflow: clip;
    opacity: 1;
    line-height: 1;
    text-align: initial;
    text-size-adjust: none;
    forced-color-adjust: none;
    transform-origin: 0 0;
    caret-color: CanvasText;
    pointer-events: auto;
    user-select: text;
    -webkit-user-select: text;
}
.omni-pdf__text-layer span,
.omni-pdf__text-layer br {
    position: absolute;
    white-space: pre;
    color: transparent;
    cursor: text;
    transform-origin: 0 0;
    user-select: text;
    -webkit-user-select: text;
}
.omni-pdf__text-layer ::selection {
    background: rgba(14, 99, 156, 0.35);
}
/* While placing text/signature, let clicks fall through to the canvas. */
.omni-pdf__pages--placing .omni-pdf__text-layer {
    pointer-events: none;
    user-select: none;
}
.omni-pdf__annotation {
    position: absolute;
    z-index: 2;
    padding: 0;
    color: #111111; /* ink on paper */
    cursor: move;
    touch-action: none;
}
.omni-pdf button.omni-pdf__annotation {
    background: transparent;
    border: 0;
    font: inherit;
}
.omni-pdf__annotation img {
    display: block;
    pointer-events: none;
}
.omni-pdf__annotation.is-selected,
.omni-pdf__annotation:hover,
.omni-pdf__annotation.is-hovered,
.omni-pdf__annotation:focus-visible,
.omni-pdf__annotation:focus-within {
    outline: 1px solid var(--omni-accent, #0e639c);
    outline-offset: 2px;
}
.omni-pdf__annotation-delete {
    position: absolute;
    top: -10px;
    right: -10px;
    z-index: 1;
    display: none;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 1px solid var(--omni-border, #3c3c3c);
    border-radius: 50%;
    background: var(--omni-bg-secondary, #252526);
    color: var(--omni-fg, #e8e8e8);
    font-size: 15px;
    line-height: 14px;
    cursor: pointer;
}
.omni-pdf__annotation.is-selected .omni-pdf__annotation-delete,
.omni-pdf__annotation:hover .omni-pdf__annotation-delete,
.omni-pdf__annotation:focus-visible .omni-pdf__annotation-delete,
.omni-pdf__annotation:focus-within .omni-pdf__annotation-delete {
    display: block;
}
.omni-pdf__highlight {
    background: var(--omni-hl-color, #ffeb3b);
    mix-blend-mode: multiply;
    cursor: pointer;
}
.omni-pdf__strikeout {
    background: transparent;
    cursor: pointer;
}
.omni-pdf__strikeout::after {
    position: absolute;
    top: calc(50% - 1px);
    left: 0;
    width: 100%;
    height: 2px;
    content: '';
    background: var(--omni-hl-color, #ffeb3b);
}
.omni-pdf__underline {
    background: transparent;
    cursor: pointer;
}
.omni-pdf__underline::after {
    position: absolute;
    bottom: 8%;
    left: 0;
    width: 100%;
    height: 2px;
    content: '';
    background: var(--omni-hl-color, #ffeb3b);
}
.omni-pdf__text-editor {
    position: absolute;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px;
    background: var(--omni-bg-secondary, #252526);
    border: 1px solid var(--omni-accent, #0e639c);
    border-radius: 3px;
}
.omni-pdf__text-input {
    min-width: 160px;
    font: inherit;
    color: #111111;
    background: #ffffff;
    border: 0;
    border-radius: 2px;
    padding: 2px 4px;
}
.omni-pdf__text-size-input {
    width: 52px;
    font: inherit;
}
.omni-pdf__color-input {
    width: 28px;
    height: 24px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
}
.omni-pdf__status {
    padding: 8px 12px;
    color: var(--omni-fg-muted, #9d9d9d);
    border-top: 1px solid var(--omni-border, #3c3c3c);
    flex: none;
}
.omni-pdf__status--error {
    color: var(--omni-error-fg, #f48771);
    font-weight: 600;
}
.omni-pdf__modal {
    /* A dialog must be positioned against the visible viewport.  Anchoring it
       to the flex viewer made it drift when the host or page list scrolled. */
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
}
.omni-pdf__modal.is-open { display: flex; }
.omni-pdf__panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px;
    background: var(--omni-bg-secondary, #252526);
    border: 1px solid var(--omni-border, #3c3c3c);
    border-radius: 8px;
}
.omni-pdf__panel input {
    font: inherit;
    color: var(--omni-fg, #e8e8e8);
    background: var(--omni-input-bg, #3c3c3c);
    border: 1px solid var(--omni-border, #3c3c3c);
    border-radius: 4px;
    padding: 6px 8px;
}
.omni-pdf__field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}
.omni-pdf__field input[type="color"] {
    width: 40px;
    height: 26px;
    padding: 0;
    background: transparent;
    cursor: pointer;
}
.omni-pdf__panel button { padding: 5px 12px; }
.omni-pdf__panel-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}
.omni-pdf__error {
    color: var(--omni-error-fg, #f48771);
}
.omni-pdf__signature-pad {
    display: block;
    width: min(480px, 80vw);
    height: auto;
    background: #ffffff;
    touch-action: none;
}
@media (max-width: 720px) {
    .omni-pdf__body {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: minmax(120px, 30vh) minmax(0, 1fr);
    }
    .omni-pdf__thumbs {
        border-right: 0;
        border-bottom: 1px solid var(--omni-border, #3c3c3c);
    }
    .omni-pdf__pages { grid-row: 2; }
}
`;
