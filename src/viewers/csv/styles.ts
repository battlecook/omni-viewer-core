// CSV viewer stylesheet. Single source for both delivery forms (DESIGN.md §6):
// the build emits dist/styles/csv.css from this constant, and the renderer
// injects it into the shadow root. Only --omni-* tokens (with fallbacks) —
// never --vscode-* or platform variables.

export const csvViewerCss = `
/* Reverse-contamination guard (DESIGN.md §6): in 'scoped' mode the viewer
   renders inside host DOM, so host global styles (element selectors for
   button/table/input etc.) must be explicitly neutralized. Harmless in
   shadow mode. Custom properties are exempt from 'all', so the --omni-*
   theme tokens still pierce. Component rules below override the guard
   (later in the sheet + higher specificity). */
.omni-viewer--csv {
    all: initial;
}
.omni-viewer--csv :where(button, select, option, input, label, a,
    table, thead, tbody, tr, th, td, pre, code) {
    all: revert;
}

:host, .omni-viewer--csv {
    display: block;
    height: 100%;
    box-sizing: border-box;
    color: var(--omni-fg, #d4d4d4);
    background: var(--omni-bg, #1e1e1e);
    font-family: var(--omni-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    font-size: var(--omni-font-size, 13px);
}
.omni-csv {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
}
.omni-csv__toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px;
    border-bottom: 1px solid var(--omni-border, #3c3c3c);
}
.omni-csv__toolbar label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
}
.omni-csv__toolbar select,
.omni-csv__toolbar button {
    font: inherit;
    color: var(--omni-fg, #d4d4d4);
    background: var(--omni-button-bg, #3a3d41);
    border: 1px solid var(--omni-border, #3c3c3c);
    border-radius: 4px;
    padding: 4px 8px;
    cursor: pointer;
}
.omni-csv__toolbar button:hover:not(:disabled) {
    background: var(--omni-button-hover-bg, #45494e);
}
.omni-csv__toolbar button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.omni-csv__toolbar button[aria-pressed="true"] {
    background: var(--omni-accent, #0e639c);
    border-color: var(--omni-accent, #0e639c);
    color: var(--omni-accent-fg, #ffffff);
}
.omni-csv__toolbar input[type="search"] {
    font: inherit;
    color: var(--omni-fg, #d4d4d4);
    background: var(--omni-input-bg, #3c3c3c);
    border: 1px solid var(--omni-border, #3c3c3c);
    border-radius: 4px;
    padding: 4px 8px;
    min-width: 140px;
}
.omni-csv__spacer { flex: 1; }
.omni-csv__dirty {
    color: var(--omni-warning-fg, #cca700);
    white-space: nowrap;
}
.omni-csv__cell-input {
    font: inherit;
    color: var(--omni-fg, #d4d4d4);
    background: var(--omni-input-bg, #3c3c3c);
    border: 1px solid var(--omni-accent, #0e639c);
    border-radius: 2px;
    padding: 2px 4px;
    width: 100%;
    box-sizing: border-box;
}
.omni-csv__menu {
    position: absolute;
    z-index: 10;
    display: flex;
    flex-direction: column;
    min-width: 160px;
    background: var(--omni-bg-secondary, #252526);
    border: 1px solid var(--omni-border, #3c3c3c);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    padding: 4px;
}
.omni-csv__menu button {
    font: inherit;
    text-align: left;
    color: var(--omni-fg, #d4d4d4);
    background: transparent;
    border: none;
    border-radius: 4px;
    padding: 6px 10px;
    cursor: pointer;
}
.omni-csv__menu button:hover {
    background: var(--omni-button-hover-bg, #45494e);
}
.omni-csv__table .omni-csv__rownum {
    color: var(--omni-fg-muted, #9d9d9d);
    text-align: right;
    user-select: none;
}
.omni-csv__table thead th.omni-csv__rownum {
    cursor: default;
}
.omni-csv__table thead th.omni-csv__rownum:hover {
    background: var(--omni-bg-secondary, #252526);
}
.omni-csv__meta {
    color: var(--omni-fg-muted, #9d9d9d);
    white-space: nowrap;
}
.omni-csv__diagnostics {
    padding: 4px 8px;
    color: var(--omni-warning-fg, #cca700);
    border-bottom: 1px solid var(--omni-border, #3c3c3c);
}
.omni-csv__diag-error {
    color: var(--omni-error-fg, #f48771);
    font-weight: 600;
}
.omni-csv__body {
    flex: 1;
    min-height: 0;
    overflow: auto;
}
.omni-csv__table {
    border-collapse: collapse;
    width: max-content;
    min-width: 100%;
}
.omni-csv__table th,
.omni-csv__table td {
    border: 1px solid var(--omni-border, #3c3c3c);
    padding: 4px 8px;
    text-align: left;
    white-space: nowrap;
    max-width: 480px;
    overflow: hidden;
    text-overflow: ellipsis;
}
/* Empty cells do not create a line box by themselves, making a newly
   inserted blank row shorter than populated rows. Keep an invisible-width
   non-breaking space so every table row uses the normal cell height. */
.omni-csv__table td:empty::before {
    content: "\\00a0";
}
.omni-csv__table thead th {
    position: sticky;
    top: 0;
    background: var(--omni-bg-secondary, #252526);
    cursor: pointer;
    user-select: none;
}
.omni-csv__table thead th:hover {
    background: var(--omni-button-hover-bg, #45494e);
}
.omni-csv__table tbody tr:nth-child(even) td {
    background: var(--omni-bg-secondary, #252526);
}
.omni-csv__sort-indicator {
    margin-left: 4px;
    color: var(--omni-accent, #0e639c);
}
.omni-csv__resize-handle {
    position: absolute;
    top: 0;
    right: 0;
    width: 7px;
    height: 100%;
    cursor: col-resize;
    user-select: none;
    touch-action: none;
}
.omni-csv__resize-handle:hover {
    background: var(--omni-accent, #0e639c);
    opacity: 0.6;
}
.omni-csv__raw {
    margin: 0;
    padding: 8px;
    font-family: var(--omni-font-mono, "SF Mono", Monaco, Menlo, Consolas, monospace);
    white-space: pre;
}
.omni-csv__table thead .omni-csv__stats-row th {
    top: var(--omni-csv-head-h, 24px);
    cursor: default;
    color: var(--omni-fg-muted, #9d9d9d);
    font-weight: 400;
    font-size: 0.92em;
    white-space: nowrap;
}
.omni-csv__table thead .omni-csv__stats-row th:hover {
    background: var(--omni-bg-secondary, #252526);
}
.omni-csv__footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-top: 1px solid var(--omni-border, #3c3c3c);
}
.omni-csv__footer button {
    font: inherit;
    color: var(--omni-fg, #d4d4d4);
    background: var(--omni-button-bg, #3a3d41);
    border: 1px solid var(--omni-border, #3c3c3c);
    border-radius: 4px;
    padding: 2px 10px;
    cursor: pointer;
}
.omni-csv__footer button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.omni-csv__empty {
    padding: 24px;
    text-align: center;
    color: var(--omni-fg-muted, #9d9d9d);
}
.omni-csv__toast {
    position: absolute;
    right: 12px;
    bottom: 44px;
    background: var(--omni-accent, #0e639c);
    color: var(--omni-accent-fg, #ffffff);
    border-radius: 4px;
    padding: 4px 10px;
    opacity: 0.95;
}
`;
