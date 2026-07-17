// Shapefile viewer stylesheet. Single source for both delivery forms
// (DESIGN.md §6). Only --omni-* tokens.

export const shapefileViewerCss = `
.omni-shp{box-sizing:border-box;min-height:100%;padding:16px;background:var(--omni-bg,#1e1e1e);color:var(--omni-fg,#ddd);font:14px/1.45 system-ui,sans-serif}
.omni-shp *{box-sizing:border-box}
.omni-shp__header{display:flex;justify-content:space-between;gap:16px;margin-bottom:12px}
.omni-shp__title{font-size:18px;font-weight:650}
.omni-shp__summary{color:var(--omni-muted,#aaa)}
.omni-shp__toolbar{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.omni-shp__btn{background:var(--omni-accent,#0e639c);color:var(--omni-accent-fg,#fff);border:none;padding:5px 11px;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit}
.omni-shp__btn:hover{background:var(--omni-accent-hover,#1177bb)}
.omni-shp__projection{margin-left:auto;color:var(--omni-muted,#aaa);font-size:12px}
.omni-shp__map{width:100%;height:min(62vh,640px);border:1px solid var(--omni-border,#444);border-radius:8px;background:#eef2f5;cursor:grab;touch-action:none}
.omni-shp__map.is-panning{cursor:grabbing}
.omni-shp__geometry{fill:rgba(47,126,216,.24);stroke:#1d66b1;stroke-width:1.5;vector-effect:non-scaling-stroke}
.omni-shp__geometry:hover{fill:rgba(47,126,216,.42)}
.omni-shp__point{fill:#d64045;stroke:#fff;vector-effect:non-scaling-stroke}
.omni-shp__point:hover{fill:#ff5a60}
.omni-shp__geometry.is-selected,.omni-shp__point.is-selected{stroke:#ffb020;stroke-width:2.5}
.omni-shp__attributes{margin-top:10px;border:1px solid var(--omni-border,#444);border-radius:8px;background:var(--omni-panel-bg,#252526);padding:10px 12px}
.omni-shp__attributes-title{font-weight:600;margin-bottom:6px}
.omni-shp__attributes-empty{color:var(--omni-muted,#aaa)}
.omni-shp__attributes table{border-collapse:collapse;width:100%}
.omni-shp__attributes th,.omni-shp__attributes td{text-align:left;border-bottom:1px solid var(--omni-border,#3a3a3a);padding:3px 8px;font-size:12px}
.omni-shp__attributes th{color:var(--omni-muted,#aaa);font-weight:500;width:35%}
.omni-shp__warning{margin-top:10px;padding:10px;border:1px solid #b98b2f;border-radius:6px;background:#3b2d10;color:#ffd98a;white-space:pre-wrap}
.omni-shp__warning[hidden]{display:none}
`;
