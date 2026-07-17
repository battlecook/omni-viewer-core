// Excel viewer stylesheet. Single source for both delivery forms (DESIGN.md §6):
// the build emits dist/styles/excel.css from this constant, and the renderer
// injects it into the shadow root. Only --omni-* tokens (with fallbacks).

export const excelViewerCss = `
/* Reverse-contamination guard (DESIGN.md §6, ADR 40): in 'scoped' mode host
   global element selectors (button/table/input…) must be neutralized. Harmless
   in shadow mode. Custom properties pierce 'all', so --omni-* tokens still
   apply. Component rules below win (later + higher specificity). */
.omni-viewer--excel {
    all: initial;
}
.omni-viewer--excel :where(button, select, option, input, label,
    table, thead, tbody, tr, th, td, pre) {
    all: revert;
}

:host, .omni-viewer--excel {
    display: block;
    height: 100%;
    box-sizing: border-box;
    color: var(--omni-fg, #d4d4d4);
    background: var(--omni-bg, #1e1e1e);
    font-family: var(--omni-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    font-size: var(--omni-font-size, 13px);
}
.omni-excel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
}
.omni-excel__toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--omni-border, #333);
}
.omni-excel__toolbar label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
}
.omni-excel__toolbar select,
.omni-excel__search {
    background: var(--omni-input-bg, #2a2a2a);
    color: inherit;
    border: 1px solid var(--omni-border, #333);
    border-radius: 3px;
    padding: 2px 6px;
}
.omni-excel__toolbar button {
    background: var(--omni-button-bg, #333);
    color: inherit;
    border: 1px solid var(--omni-border, #333);
    border-radius: 3px;
    padding: 2px 8px;
    cursor: pointer;
}
.omni-excel__toolbar button:disabled {
    opacity: 0.5;
    cursor: default;
}
.omni-excel__spacer { flex: 1 1 auto; }
.omni-excel__meta { color: var(--omni-fg-muted, #999); white-space: nowrap; }
.omni-excel__diagnostics {
    padding: 4px 8px;
    border-bottom: 1px solid var(--omni-border, #333);
    color: var(--omni-fg-muted, #999);
    font-size: 0.92em;
}
.omni-excel__diag-error { color: var(--omni-error, #f48771); }
.omni-excel__body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
}
.omni-excel__empty {
    padding: 24px;
    text-align: center;
    color: var(--omni-fg-muted, #999);
}
.omni-excel__raw {
    margin: 0;
    padding: 8px 12px;
    white-space: pre;
    font-family: var(--omni-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.omni-excel__table {
    border-collapse: collapse;
    width: max-content;
    min-width: 100%;
}
.omni-excel__table th,
.omni-excel__table td {
    border: 1px solid var(--omni-border, #333);
    padding: 3px 8px;
    text-align: left;
    white-space: pre;
    vertical-align: top;
}
.omni-excel__table thead th {
    position: sticky;
    top: 0;
    background: var(--omni-header-bg, #252525);
    cursor: pointer;
    user-select: none;
}
.omni-excel__table tbody td {
    cursor: text;
}
.omni-excel__cell-input {
    box-sizing: border-box;
    width: 100%;
    min-width: 80px;
    margin: -3px -8px;
    padding: 3px 8px;
    border: 1px solid var(--omni-accent, #0e639c);
    background: var(--omni-input-bg, #2a2a2a);
    color: inherit;
    font: inherit;
}
.omni-excel__resize-handle {
    position: absolute;
    top: 0;
    right: 0;
    width: 7px;
    height: 100%;
    cursor: col-resize;
    user-select: none;
    touch-action: none;
}
.omni-excel__resize-handle:hover {
    background: var(--omni-accent, #0e639c);
    opacity: 0.6;
}
.omni-excel__sort-indicator { margin-left: 4px; }
.omni-excel__hit { background: var(--omni-highlight, rgba(255, 214, 0, 0.25)); }
.omni-excel__footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 4px 8px;
    border-top: 1px solid var(--omni-border, #333);
}
.omni-excel__footer button {
    background: var(--omni-button-bg, #333);
    color: inherit;
    border: 1px solid var(--omni-border, #333);
    border-radius: 3px;
    padding: 2px 8px;
    cursor: pointer;
}
.omni-excel__footer button:disabled { opacity: 0.5; cursor: default; }
.omni-excel__toast {
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--omni-toast-bg, #333);
    color: var(--omni-fg, #d4d4d4);
    border: 1px solid var(--omni-border, #333);
    border-radius: 4px;
    padding: 6px 12px;
    pointer-events: none;
}
.omni-excel__dirty { color: var(--omni-warn, #d7a017); white-space: nowrap; }
.omni-excel__cell-input {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    color: inherit;
    background: var(--omni-input-bg, #2a2a2a);
    border: 1px solid var(--omni-accent, #3794ff);
    padding: 2px 6px;
}
.omni-excel__menu {
    position: absolute;
    z-index: 10;
    display: flex;
    flex-direction: column;
    min-width: 140px;
    background: var(--omni-menu-bg, #2a2a2a);
    border: 1px solid var(--omni-border, #333);
    border-radius: 4px;
    padding: 4px 0;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
.omni-excel__menu button {
    background: none;
    border: none;
    color: inherit;
    text-align: left;
    padding: 4px 12px;
    cursor: pointer;
}
.omni-excel__menu button:hover { background: var(--omni-hover-bg, #333); }

/* Grid render mode (X3): WYSIWYG. Cell inline styles (from the file) win over
   these base rules; borders/alignment default here when the file omits them. */
.omni-excel__grid {
    border-collapse: collapse;
    table-layout: fixed;
    width: max-content;
}
.omni-excel__grid td {
    border: 1px solid var(--omni-border, #333);
    padding: 2px 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: top;
}
`;
