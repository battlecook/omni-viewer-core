export const mcapViewerCss = `
:host,.omni-viewer--mcap{display:block;height:100%;color:var(--omni-fg,#ddd);background:var(--omni-bg,#1e1e1e);font:13px var(--omni-font,system-ui)}
.omni-mcap{box-sizing:border-box;height:100%;display:flex;flex-direction:column;min-width:0;overflow:hidden}
.omni-mcap *{box-sizing:border-box}.omni-mcap [hidden]{display:none!important}
.omni-mcap__header{padding:14px 18px;border-bottom:1px solid var(--omni-border,#444);background:var(--omni-panel-bg,#252526)}
.omni-mcap__format{color:var(--omni-fg-muted,#999)}.omni-mcap__filename{font-size:20px;margin:4px 0;overflow-wrap:anywhere}
.omni-mcap__summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin:0;border-bottom:1px solid var(--omni-border,#444)}
.omni-mcap__summary>div{padding:9px 14px;min-width:0}.omni-mcap dt{color:var(--omni-fg-muted,#999);margin-bottom:5px}.omni-mcap dd{margin:0;overflow-wrap:anywhere}
.omni-mcap__tabs,.omni-mcap__toolbar,.omni-mcap__pagination,.omni-mcap__detail-controls{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:8px 12px}
.omni-mcap__tabs,.omni-mcap__toolbar{border-bottom:1px solid var(--omni-border,#444)}
.omni-mcap button,.omni-mcap input,.omni-mcap select{border:1px solid var(--omni-border,#555);border-radius:4px;background:var(--omni-button-bg,#333);color:inherit;font:inherit;padding:6px 9px;max-width:100%}
.omni-mcap button{cursor:pointer}.omni-mcap button:disabled{opacity:.5;cursor:default}
.omni-mcap button[aria-selected=true],.omni-mcap button[aria-pressed=true]{background:var(--omni-accent,#0e639c);color:var(--omni-accent-fg,#fff)}
.omni-mcap :is(button,input,select):focus-visible{outline:2px solid var(--omni-accent,#0e639c);outline-offset:2px}
.omni-mcap__search{flex:1;min-width:160px}.omni-mcap__topic{max-width:35%}
.omni-mcap__warnings{padding:10px 14px;background:var(--omni-warning-bg,#4d3b12);color:var(--omni-warning-fg,#f5d88a);white-space:pre-wrap}
.omni-mcap__content{flex:1;min-height:100px;overflow:auto}.omni-mcap table{width:100%;border-collapse:collapse}
.omni-mcap th,.omni-mcap td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--omni-border,#444);max-width:480px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.omni-mcap th{position:sticky;top:0;background:var(--omni-panel-bg,#252526);z-index:1}.omni-mcap tr:hover td{background:var(--omni-hover-bg,#2a2d2e)}
.omni-mcap__pagination{justify-content:center;border-top:1px solid var(--omni-border,#444)}.omni-mcap__empty{padding:20px;color:var(--omni-fg-muted,#999)}
.omni-mcap__detail{max-height:45%;overflow:auto;border-top:1px solid var(--omni-border,#444);padding:8px 14px}.omni-mcap__detail h2{font-size:15px;margin:0}
.omni-mcap__detail-controls{padding:8px 0}.omni-mcap__detail-note{color:var(--omni-fg-muted,#999);margin:0 0 8px}
.omni-mcap__payload{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:12px/1.5 var(--omni-font-mono,ui-monospace,monospace)}
.omni-mcap__status:not(:empty){padding:6px 12px}
@media(max-width:600px){.omni-mcap__summary{grid-template-columns:repeat(2,minmax(0,1fr))}.omni-mcap__topic{max-width:100%}.omni-mcap__toolbar{align-items:stretch;flex-direction:column}}
`;
