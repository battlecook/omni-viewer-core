export const htmlViewerCss = `
.omni-viewer--html{all:initial}
:host,.omni-viewer--html{display:block;height:100%;box-sizing:border-box;color:var(--omni-fg,#d4d4d4);background:var(--omni-bg,#1e1e1e);font:var(--omni-font-size,13px)/1.4 var(--omni-font,system-ui,sans-serif)}
.omni-html,.omni-html *{box-sizing:border-box}
.omni-html{display:flex;flex-direction:column;height:100%;min-height:0}
.omni-html__header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;border-bottom:1px solid var(--omni-border,#3c3c3c)}
.omni-html__title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.omni-html__tabs{display:flex;gap:4px;flex:none}
.omni-html__tabs button{font:inherit;color:inherit;background:transparent;border:1px solid var(--omni-border,#3c3c3c);border-radius:4px;padding:4px 10px;cursor:pointer}
.omni-html__tabs button[aria-pressed=true]{background:var(--omni-accent,#0e639c);color:var(--omni-accent-fg,#fff)}
.omni-html__tabs button:disabled{opacity:.5;cursor:default}
.omni-html__preview{display:block;flex:1;min-height:0;width:100%;border:0;background:#fff}
.omni-html__source{flex:1;min-height:0;overflow:auto;margin:0;padding:12px;font:13px/1.5 var(--omni-font-mono,monospace);white-space:pre;tab-size:4}
.omni-html__note{margin:0;padding:8px 12px;color:var(--omni-warning-fg,#cca700);border-bottom:1px solid var(--omni-border,#3c3c3c)}
.omni-html [hidden]{display:none!important}
`;
