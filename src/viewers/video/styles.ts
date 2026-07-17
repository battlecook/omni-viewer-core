// Video viewer stylesheet. Single source for both delivery forms (DESIGN.md
// §6): the build emits dist/styles/video.css from this constant, and the
// renderer injects it into the shadow root. Only --omni-* tokens (with
// fallbacks) — never --vscode-* or platform variables.

export const videoViewerCss = `
/* Reverse-contamination guard (DESIGN.md §6). */
.omni-viewer--video {
    all: initial;
}
.omni-viewer--video :where(button, select, option, input, label, video) {
    all: revert;
}

:host, .omni-viewer--video {
    display: block;
    height: 100%;
    box-sizing: border-box;
    color: var(--omni-fg, #d4d4d4);
    background: var(--omni-bg, #1e1e1e);
    font-family: var(--omni-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    font-size: var(--omni-font-size, 13px);
}

.omni-video { display: flex; flex-direction: column; gap: 12px; box-sizing: border-box; height: 100%; padding: 16px; }
.omni-video * { box-sizing: border-box; }

.omni-video__header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
.omni-video__title { font-size: 16px; font-weight: 650; overflow-wrap: anywhere; }
.omni-video__meta { color: var(--omni-muted, #9d9d9d); white-space: nowrap; }

.omni-video__info { display: flex; gap: 18px; padding: 6px 10px; border: 1px solid var(--omni-border, #444); border-radius: 6px; background: var(--omni-panel-bg, #252526); }
.omni-video__info[hidden] { display: none; }
.omni-video__info-item { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.omni-video__info-label { font-size: 10px; opacity: 0.7; }
.omni-video__info-value { font-family: var(--omni-mono, ui-monospace, Menlo, monospace); font-weight: 500; }

.omni-video__controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 6px; border: 1px solid var(--omni-border, #444); border-radius: 8px; background: var(--omni-panel-bg, #252526); }
.omni-video__group { display: flex; align-items: center; gap: 5px; }
.omni-video__group-label { font-size: 12px; color: var(--omni-muted, #9d9d9d); }

.omni-video__btn {
    background: var(--omni-accent, #0e639c); color: var(--omni-accent-fg, #fff);
    border: none; padding: 5px 11px; border-radius: 4px; cursor: pointer; font-size: 12px; font-family: inherit;
}
.omni-video__btn:hover { background: var(--omni-accent-hover, #1177bb); }
.omni-video__btn:disabled { opacity: 0.5; cursor: not-allowed; }

.omni-video__select {
    background: var(--omni-input-bg, #3c3c3c); color: var(--omni-fg, #d4d4d4);
    border: 1px solid var(--omni-border, #444); padding: 4px 8px; border-radius: 4px; font-size: 12px; font-family: inherit;
}
.omni-video__zoom-label { font-family: var(--omni-mono, ui-monospace, Menlo, monospace); font-size: 12px; min-width: 42px; text-align: center; color: var(--omni-muted, #9d9d9d); }

.omni-video__progress-row { display: flex; align-items: center; gap: 10px; padding: 4px 6px; border: 1px solid var(--omni-border, #444); border-radius: 8px; background: var(--omni-panel-bg, #252526); }
.omni-video__time { font-family: var(--omni-mono, ui-monospace, Menlo, monospace); font-size: 12px; min-width: 52px; text-align: center; }
.omni-video__bar { flex: 1; height: 8px; background: var(--omni-input-bg, #3c3c3c); border-radius: 4px; cursor: pointer; position: relative; }
.omni-video__bar:hover, .omni-video__bar--dragging { height: 12px; }
.omni-video__bar-filled { height: 100%; width: 0%; background: var(--omni-accent, #0e639c); border-radius: 4px; pointer-events: none; position: relative; }
.omni-video__bar-handle {
    width: 14px; height: 14px; background: var(--omni-accent-fg, #fff); border: 2px solid var(--omni-accent, #0e639c);
    border-radius: 50%; position: absolute; right: -7px; top: 50%; transform: translateY(-50%);
    opacity: 0; transition: opacity 0.15s; pointer-events: none;
}
.omni-video__bar:hover .omni-video__bar-handle, .omni-video__bar--dragging .omni-video__bar-handle { opacity: 1; }

.omni-video__stage {
    flex: 1; min-height: 240px; display: flex; justify-content: center; align-items: center;
    border: 1px solid var(--omni-border, #444); border-radius: 8px; background: #000; overflow: hidden; position: relative;
}
.omni-video__stage--zoomed { overflow: auto; }
.omni-video__wrapper { transition: transform 0.2s ease; transform-origin: center center; }
.omni-video video { display: block; max-width: 100%; max-height: 70vh; background: #000; }

.omni-video__warning {
    padding: 10px 12px; border: 1px solid #b98b2f; border-radius: 7px;
    background: #3b2d10; color: #ffd98a; white-space: pre-wrap;
}
.omni-video__warning[hidden] { display: none; }
`;
