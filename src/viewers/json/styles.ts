// JSON viewer stylesheet. Single source for both delivery forms (DESIGN.md §6):
// the build emits dist/styles/json.css from this constant, and the renderer
// injects it into the shadow root. Only --omni-* tokens (with fallbacks).

export const jsonViewerCss = `
/* Reverse-contamination guard (DESIGN.md §6): neutralize host global element
   styles in 'scoped' mode; harmless in shadow mode. Custom properties are
   exempt from 'all', so --omni-* theme tokens still pierce. */
.omni-viewer--json {
    all: initial;
}
.omni-viewer--json :where(button, select, option, input, label, textarea,
    pre, code, ul, li, span, div) {
    all: revert;
}

:host, .omni-viewer--json {
    display: block;
    height: 100%;
    box-sizing: border-box;
    color: var(--omni-fg, #d4d4d4);
    background: var(--omni-bg, #1e1e1e);
    font-family: var(--omni-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    font-size: var(--omni-font-size, 13px);
}
.omni-json {
    display: flex;
    flex-direction: column;
    height: 100%;
    box-sizing: border-box;
}
.omni-json__toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    padding: 6px;
    border-bottom: 1px solid var(--omni-border, #333);
}
.omni-json__toolbar button,
.omni-json__toolbar select {
    background: var(--omni-button-bg, #2d2d2d);
    color: inherit;
    border: 1px solid var(--omni-border, #333);
    border-radius: 3px;
    padding: 3px 8px;
    cursor: pointer;
    font: inherit;
}
.omni-json__toolbar button[aria-pressed="true"] {
    background: var(--omni-accent, #0e639c);
    color: #fff;
}
.omni-json__toolbar button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.omni-json__tool-group {
    margin-left: auto;
    display: inline-flex;
    flex-wrap: wrap;
    gap: 6px;
}
.omni-json__save-actions {
    display: inline-flex;
    gap: 6px;
}
.omni-json__search {
    background: var(--omni-input-bg, #3c3c3c);
    color: inherit;
    border: 1px solid var(--omni-border, #333);
    border-radius: 3px;
    padding: 3px 6px;
    font: inherit;
}
.omni-json__meta,
.omni-json__matchinfo,
.omni-json__status {
    color: var(--omni-fg-muted, #999);
    padding: 0 6px;
    white-space: nowrap;
}
.omni-json__status {
    padding: 4px 8px;
    border-bottom: 1px solid var(--omni-border, #333);
}
.omni-json__diagnostics {
    padding: 4px 8px;
    border-bottom: 1px solid var(--omni-border, #333);
}
.omni-json__diag-error {
    color: var(--omni-error, #f48771);
}
.omni-json__body {
    flex: 1 1 auto;
    overflow: hidden;
    padding: 12px;
    min-height: 0;
}
.omni-json__source-workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 12px;
    height: 100%;
    min-height: 360px;
}
.omni-json__pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--omni-border, #333);
    border-radius: 10px;
    background: var(--omni-input-bg, #1e1e1e);
}
.omni-json__pane-header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    padding: 12px 14px;
    border-bottom: 1px solid var(--omni-border, #333);
    font-family: var(--omni-font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
    font-size: 1.05em;
}
.omni-json__pane-header span {
    color: var(--omni-fg-muted, #999);
    text-align: right;
}
.omni-json__pane-header button {
    margin-left: auto;
    background: var(--omni-button-bg, #2d2d2d);
    color: inherit;
    border: 1px solid var(--omni-border, #333);
    border-radius: 3px;
    padding: 3px 8px;
    cursor: pointer;
    font: inherit;
}
.omni-json__pane-header button[aria-pressed="true"] {
    background: var(--omni-accent, #0e639c);
    color: #fff;
}
.omni-json__editor-surface,
.omni-json__preview-content {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
}
.omni-json__editor-surface {
    overflow: hidden;
}
.omni-json__preview-content {
    overflow: auto;
}
.omni-json__source {
    margin: 0;
    white-space: pre;
    font-family: var(--omni-font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
    overflow: auto;
    padding: 28px;
    flex: 1 1 auto;
}
.omni-json__editor {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    resize: none;
    background: transparent;
    color: transparent;
    -webkit-text-fill-color: transparent;
    caret-color: var(--omni-fg, #d4d4d4);
    border: none;
    outline: none;
    padding: 28px;
    font-family: var(--omni-font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
    font-size: inherit;
    line-height: 1.5;
}
.omni-json__editor-highlight {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    min-width: 100%;
    margin: 0;
    padding: 28px;
    white-space: pre;
    overflow: hidden;
    pointer-events: none;
    font-family: var(--omni-font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
    font-size: inherit;
    line-height: 1.5;
}
.omni-json__tree,
.omni-json__tree ul {
    list-style: none;
    margin: 0;
    padding: 0;
    font-family: var(--omni-font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
}
.omni-json__tree ul {
    padding-left: 16px;
}
.omni-json__row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 1px 0;
}
.omni-json__row.is-matched {
    background: var(--omni-match-bg, rgba(255, 214, 0, 0.25));
}
.omni-json__row.is-current {
    outline: 1px solid var(--omni-accent, #0e639c);
}
.omni-json__toggle {
    cursor: pointer;
    width: 1.2em;
    box-sizing: border-box;
    user-select: none;
    color: var(--omni-fg-muted, #999);
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    text-align: left;
}
.omni-json__toggle:focus-visible {
    outline: 1px solid var(--omni-accent, #0e639c);
}
.omni-json__key { color: var(--omni-json-key, #9cdcfe); }
.omni-json__type { color: var(--omni-fg-muted, #808080); font-size: 0.85em; }
.omni-json__val-string { color: var(--omni-json-string, #ce9178); }
.omni-json__val-number { color: var(--omni-json-number, #b5cea8); }
.omni-json__val-boolean { color: var(--omni-json-boolean, #569cd6); }
.omni-json__val-null { color: var(--omni-json-null, #569cd6); }
/* Kept in layout (not display:none) so the copy buttons stay in the tab order
   for keyboard users; revealed on hover or when a child is focused (P2b). */
.omni-json__node-actions {
    display: inline-flex;
    gap: 2px;
    opacity: 0;
}
.omni-json__row:hover .omni-json__node-actions,
.omni-json__row:focus-within .omni-json__node-actions {
    opacity: 1;
}
.omni-json__result {
    border-top: 1px solid var(--omni-border, #333);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 220px;
    max-height: 40%;
    overflow: hidden;
}
.omni-json__result-output {
    width: 100%;
    min-height: 120px;
    box-sizing: border-box;
    background: var(--omni-input-bg, #1e1e1e);
    color: inherit;
    border: 1px solid var(--omni-border, #333);
    font-family: var(--omni-font-mono, ui-monospace, Menlo, monospace);
    font-size: inherit;
}
.omni-json__result-markup {
    width: 100%;
    min-height: 120px;
    box-sizing: border-box;
    margin: 0;
    padding: 8px;
    overflow: auto;
    background: var(--omni-input-bg, #1e1e1e);
    border: 1px solid var(--omni-border, #333);
    font-family: var(--omni-font-mono, ui-monospace, Menlo, monospace);
    font-size: inherit;
    white-space: pre-wrap;
}
.omni-json__result-tag { color: #569cd6; }
.omni-json__result-key { color: #9cdcfe; }
.omni-json__result-value { color: #ce9178; }
.omni-json__result-table-wrap {
    flex: 1 1 auto;
    min-height: 160px;
    overflow: auto;
    border: 1px solid var(--omni-border, #333);
}
.omni-json__result-table {
    border-collapse: collapse;
    width: max-content;
    min-width: 100%;
    font-family: var(--omni-font-mono, ui-monospace, Menlo, monospace);
}
.omni-json__result-table th,
.omni-json__result-table td {
    padding: 6px 10px;
    border-right: 1px solid var(--omni-border, #333);
    border-bottom: 1px solid var(--omni-border, #333);
    text-align: left;
    white-space: pre-wrap;
    vertical-align: top;
}
.omni-json__result-table th {
    position: sticky;
    top: 0;
    background: var(--omni-button-bg, #2d2d2d);
}
.omni-json__result-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}
.omni-json__result-actions button {
    background: var(--omni-button-bg, #2d2d2d);
    color: inherit;
    border: 1px solid var(--omni-border, #333);
    border-radius: 3px;
    padding: 3px 8px;
    cursor: pointer;
    font: inherit;
}
.jv-tok-key { color: var(--omni-json-key, #9cdcfe); }
.jv-tok-string { color: var(--omni-json-string, #ce9178); }
.jv-tok-number { color: var(--omni-json-number, #b5cea8); }
.jv-tok-bool { color: var(--omni-json-boolean, #569cd6); }
.jv-tok-null { color: var(--omni-json-null, #569cd6); }
.jv-tok-unknown { color: var(--omni-error, #f48771); }
.omni-json__search-hit {
    color: inherit;
    background: var(--omni-match-bg, rgba(255, 214, 0, 0.35));
    border-radius: 2px;
    padding: 0;
}
@media (max-width: 760px) {
    .omni-json__source-workspace {
        grid-template-columns: 1fr;
        height: auto;
    }
    .omni-json__pane {
        min-height: 320px;
    }
}
`;
