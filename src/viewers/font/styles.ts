export const fontViewerCss = `
.omni-font{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--omni-bg,#1e1e1e);color:var(--omni-fg,#d4d4d4);font:13px/1.5 system-ui,sans-serif;color-scheme:dark light}
.omni-font *{box-sizing:border-box}.omni-font [hidden]{display:none!important}
.omni-font__header{padding:16px 20px;border-bottom:1px solid var(--omni-border,#3c3c3c)}
.omni-font__title{margin:0;font-size:22px;overflow-wrap:anywhere}.omni-font__filename{margin:4px 0 0;color:var(--omni-muted,#aaa);overflow-wrap:anywhere}
.omni-font__content{flex:1;min-height:0;overflow:auto;padding:20px}.omni-font__metadata{display:grid;grid-template-columns:minmax(100px,160px) minmax(0,1fr);gap:8px 16px;margin:0 0 24px}
.omni-font__label{color:var(--omni-muted,#aaa)}.omni-font__value{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}
.omni-font__warnings{padding:8px 20px;background:var(--omni-warning-bg,#4d3b12);color:var(--omni-warning-fg,#f5d88a)}.omni-font__warning{margin:4px 0}
.omni-font__text-label,.omni-font__search-label{display:flex;flex-direction:column;gap:6px}.omni-font textarea,.omni-font input[type=search]{font:inherit;width:100%;padding:10px;border:1px solid var(--omni-border,#3c3c3c);border-radius:4px;background:var(--omni-input-bg,#303030);color:inherit}.omni-font textarea{resize:vertical}
.omni-font__controls{display:flex;flex-wrap:wrap;gap:16px;margin:16px 0}.omni-font__size-label,.omni-font__axis-label{display:flex;align-items:center;gap:8px}.omni-font input[type=range]{accent-color:var(--omni-accent,#3794ff);max-width:180px}
.omni-font__hint{font-size:12px;color:var(--omni-muted,#aaa);margin:6px 0}
.omni-font__specimen{min-height:160px;padding:20px;border:1px solid var(--omni-border,#3c3c3c);border-radius:6px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;font-synthesis:none}
.omni-font__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:8px;margin:16px 0}.omni-font__glyph{display:flex;align-items:center;flex-direction:column;padding:12px 4px;border:1px solid var(--omni-border,#3c3c3c);border-radius:4px;overflow:hidden}.omni-font__character{font-size:32px;line-height:1.6;min-height:52px;font-synthesis:none}.omni-font__code{font:11px ui-monospace,monospace;color:var(--omni-muted,#aaa)}
.omni-font__pagination{display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap}.omni-font button{padding:7px 12px;border:1px solid var(--omni-border,#3c3c3c);border-radius:4px;background:var(--omni-button-bg,#3a3d41);color:inherit;cursor:pointer}.omni-font button:disabled{opacity:.5;cursor:default}.omni-font :focus-visible{outline:2px solid var(--omni-accent,#3794ff);outline-offset:2px}
@media(max-width:480px){.omni-font__content{padding:12px}.omni-font__metadata{grid-template-columns:100px minmax(0,1fr);gap:6px}.omni-font__controls{flex-direction:column}}
`;
