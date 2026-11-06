export const textViewerCss = `
.omni-viewer--text{all:initial}
:host,.omni-viewer--text{display:block;height:100%;box-sizing:border-box;color:var(--omni-fg,#d4d4d4);background:var(--omni-bg,#1e1e1e);font:var(--omni-font-size,13px)/1.4 var(--omni-font,system-ui,sans-serif)}
.omni-text,.omni-text *{box-sizing:border-box}
.omni-text{display:flex;flex-direction:column;height:100%;min-height:0}
.omni-text__header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--omni-border,#3c3c3c)}
.omni-text__title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.omni-text__encoding{flex:none}
.omni-text__wrap{flex:none;font:inherit;color:inherit;background:transparent;border:1px solid var(--omni-border,#3c3c3c);border-radius:4px;padding:4px 10px;cursor:pointer}
.omni-text__wrap[aria-pressed=true]{background:var(--omni-accent,#0e639c);color:var(--omni-accent-fg,#fff)}
.omni-text__wrap:focus-visible,.omni-text__content:focus-visible{outline:2px solid var(--omni-accent,#0e639c);outline-offset:-2px}
.omni-text__content{flex:1;min-height:0;overflow:auto;margin:0;padding:12px;font:13px/1.5 var(--omni-font-mono,monospace);white-space:pre;tab-size:4;user-select:text}
.omni-text__content--wrap{white-space:pre-wrap;overflow-wrap:anywhere}
.omni-text__note{margin:0;padding:8px 12px;color:var(--omni-warning-fg,#cca700);border-bottom:1px solid var(--omni-border,#3c3c3c)}
`;
