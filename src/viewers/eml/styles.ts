export const emlViewerCss = `
.omni-viewer--eml{all:initial}
:host,.omni-viewer--eml{display:block;min-height:0;height:100%}
.omni-eml{box-sizing:border-box;color:var(--omni-fg,#d4d4d4);background:var(--omni-bg,#1e1e1e);font:14px/1.5 var(--omni-font,system-ui,sans-serif);padding:20px;height:100%;overflow:auto;color-scheme:dark light}
.omni-eml *{box-sizing:border-box}.omni-eml [hidden]{display:none!important}
.omni-eml__header h1{font-size:24px;line-height:1.3;margin:4px 0 20px;overflow-wrap:anywhere}
.omni-eml__filename,.omni-eml__attachment-type{font-size:12px;color:var(--omni-muted,#68758a);overflow-wrap:anywhere}
.omni-eml__metadata{display:grid;grid-template-columns:minmax(75px,auto) minmax(0,1fr);gap:6px 16px;margin:0 0 20px}
.omni-eml__metadata dt{font-weight:600}.omni-eml__metadata dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.omni-eml__toolbar{display:flex;flex-wrap:wrap;gap:6px;border-bottom:1px solid var(--omni-border,#d9dfe7);padding-bottom:10px;margin-bottom:12px}
.omni-eml button{font:inherit;color:inherit;background:var(--omni-bg,#1e1e1e);border:1px solid var(--omni-border,#d9dfe7);border-radius:6px;padding:5px 12px;cursor:pointer}
.omni-eml button[aria-pressed=true]{background:var(--omni-accent,#2563eb);border-color:var(--omni-accent,#2563eb);color:#fff}
.omni-eml button:disabled{opacity:.5;cursor:default}.omni-eml button:focus-visible{outline:2px solid var(--omni-accent,#2563eb);outline-offset:2px}
.omni-eml__html{display:block;width:100%;height:60vh;min-height:300px;border:1px solid var(--omni-border,#d9dfe7);background:#fff;border-radius:6px}
.omni-eml__text,.omni-eml__source{font:13px/1.6 var(--omni-font-mono,monospace);white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:12px}
.omni-eml__status{color:var(--omni-warning-fg,#f5d88a)}.omni-eml__status:empty{display:none}
.omni-eml__attachments{border-top:1px solid var(--omni-border,#d9dfe7);margin-top:20px;padding-top:12px}.omni-eml__attachments h2{font-size:16px;margin:0 0 12px}
.omni-eml__attachments ul{list-style:none;padding:0;margin:0;display:grid;gap:8px}.omni-eml__attachments li{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px;border:1px solid var(--omni-border,#d9dfe7);border-radius:6px}
.omni-eml__attachment-name{overflow-wrap:anywhere;flex:1 1 180px}.omni-eml__empty{color:var(--omni-muted,#68758a)}
`;
