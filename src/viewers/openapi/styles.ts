/** Shared by shadow injection and styles/openapi.css. */
export const openApiViewerCss = `
.omni-viewer--openapi{all:initial;display:block}
.omni-viewer--openapi :where(header,nav,section,article,aside,div,h1,h2,h3,p,pre,code,button,input,select,option,table,thead,tbody,tr,th,td,details,summary,span,strong){all:revert}
.omni-openapi{box-sizing:border-box;background:var(--omni-bg,#1e1e1e);color:var(--omni-fg,#ddd);font:14px/1.5 system-ui,sans-serif;padding:20px;min-height:100%}
.omni-openapi *{box-sizing:border-box}
.omni-openapi [hidden]{display:none!important}
.omni-openapi h1{font-size:24px;margin:0 0 4px;overflow-wrap:anywhere}
.omni-openapi h2{font-size:19px;margin:0 0 12px;overflow-wrap:anywhere}
.omni-openapi h3{font-size:14px;margin:20px 0 8px}
.omni-openapi__muted{color:var(--omni-muted,#aaa);overflow-wrap:anywhere}
.omni-openapi__description{white-space:pre-wrap;overflow-wrap:anywhere}
.omni-openapi__tabs,.omni-openapi__filters,.omni-openapi__pager,.omni-openapi__actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:16px 0}
.omni-openapi button,.omni-openapi input,.omni-openapi select{position:static;font:inherit;border:1px solid var(--omni-border,#555);border-radius:5px;background:var(--omni-panel-bg,#252526);color:inherit;padding:7px 10px;max-width:100%}
.omni-openapi button{cursor:pointer}
.omni-openapi button[aria-selected=true],.omni-openapi button[aria-pressed=true]{border-color:var(--omni-accent,#48a8e8);background:var(--omni-selected-bg,#18374e)}
.omni-openapi button:disabled{opacity:.5;cursor:default}
.omni-openapi :where(button,input,select,summary):focus-visible{outline:2px solid var(--omni-accent,#48a8e8);outline-offset:2px}
.omni-openapi__search{flex:1;min-width:160px}
.omni-openapi__workspace{display:grid;grid-template-columns:minmax(220px,32%) minmax(0,1fr);gap:16px;align-items:start}
.omni-openapi__list{display:flex;flex-direction:column;gap:6px;max-height:72vh;overflow:auto}
.omni-openapi .omni-openapi__operation{text-align:left;padding:10px;display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere}
.omni-openapi__method{font:700 12px/1.4 ui-monospace,monospace;color:var(--omni-accent,#6fc1ff)}
.omni-openapi__method[data-method=POST]{color:var(--omni-success,#74c99b)}
.omni-openapi__method[data-method=DELETE]{color:var(--omni-error,#f29191)}
.omni-openapi__method[data-method=PUT],.omni-openapi__method[data-method=PATCH]{color:var(--omni-warning,#e8c875)}
.omni-openapi__detail,.omni-openapi__card{padding:16px;border:1px solid var(--omni-border,#444);border-radius:8px;min-width:0}
.omni-openapi__card{margin:10px 0}
.omni-openapi__badge{display:inline-block;font-size:12px;border:1px solid var(--omni-border,#555);border-radius:12px;padding:1px 8px;margin:0 5px 4px 0}
.omni-openapi__warning{border:1px solid var(--omni-warning,#b98b2f);border-radius:6px;padding:10px;white-space:pre-wrap;margin:10px 0}
.omni-openapi__status{min-height:1.5em;overflow-wrap:anywhere}
.omni-openapi pre{font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:60vh;padding:12px;background:var(--omni-code-bg,#161616);border:1px solid var(--omni-border,#444);border-radius:5px;margin:8px 0}
.omni-openapi__table-wrap{overflow:auto}
.omni-openapi table{border-collapse:collapse;width:100%;font-size:12px}
.omni-openapi th,.omni-openapi td{text-align:left;vertical-align:top;border-bottom:1px solid var(--omni-border,#444);padding:7px;overflow-wrap:anywhere;white-space:pre-wrap}
.omni-openapi th{color:var(--omni-muted,#aaa)}
.omni-openapi summary{cursor:pointer;overflow-wrap:anywhere}
.omni-openapi code{font-family:ui-monospace,monospace;overflow-wrap:anywhere}
@media(max-width:700px){.omni-openapi{padding:12px}.omni-openapi__workspace{grid-template-columns:1fr}.omni-openapi__list{max-height:35vh}}
`;
