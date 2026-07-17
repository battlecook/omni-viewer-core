export const fallbackViewerCss = `
/* Reverse-contamination guard for 'scoped' mode — see csv/styles.ts. */
.omni-viewer--fallback {
    all: initial;
}
.omni-viewer--fallback :where(pre, code, div) {
    all: revert;
}

:host, .omni-viewer--fallback {
    display: block;
    height: 100%;
    box-sizing: border-box;
    color: var(--omni-fg, #d4d4d4);
    background: var(--omni-bg, #1e1e1e);
    font-family: var(--omni-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    font-size: var(--omni-font-size, 13px);
}
.omni-fallback {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
}
.omni-fallback__reason {
    padding: 6px 8px;
    color: var(--omni-warning-fg, #cca700);
    border-bottom: 1px solid var(--omni-border, #3c3c3c);
}
.omni-fallback__title {
    padding: 6px 8px;
    color: var(--omni-fg-muted, #9d9d9d);
    border-bottom: 1px solid var(--omni-border, #3c3c3c);
}
.omni-fallback__content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    margin: 0;
    padding: 8px;
    font-family: var(--omni-font-mono, "SF Mono", Monaco, Menlo, Consolas, monospace);
    white-space: pre;
}
.omni-fallback__note {
    padding: 4px 8px;
    color: var(--omni-fg-muted, #9d9d9d);
    border-top: 1px solid var(--omni-border, #3c3c3c);
}
`;
