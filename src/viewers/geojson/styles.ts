/** Shared source for shadow-root injection and dist/styles/geojson.css. */
export const geoJsonViewerCss = `
.omni-viewer--geojson{all:initial;display:block}
.omni-viewer--geojson :where(h2,h3,p,div,section,button,select,option,label,table,thead,tbody,tr,th,td,svg){all:revert}
/* Reset SVG appearance and interaction without clearing geometry properties
   such as d/cx/cy/r supplied through presentation attributes. */
.omni-viewer--geojson :where(g,path,circle){display:inline;position:static;transform:none;opacity:1;visibility:visible;pointer-events:visiblePainted;filter:none;clip-path:none;mask:none;fill-opacity:1;stroke-opacity:1;stroke-dasharray:none;stroke-dashoffset:0}
.omni-geojson{box-sizing:border-box;min-height:100%;padding:16px;background:var(--omni-bg,#1e1e1e);color:var(--omni-fg,#ddd);font:14px/1.45 system-ui,sans-serif}
.omni-geojson *{box-sizing:border-box}
.omni-geojson [hidden]{display:none}
.omni-geojson__title{margin:0;font-size:18px;overflow-wrap:anywhere}
.omni-geojson__summary,.omni-geojson__hint,.omni-geojson__empty{color:var(--omni-muted,#aaa)}
.omni-geojson__toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0}
.omni-geojson__button,.omni-geojson__select{display:inline-block;position:static;font:inherit;border:1px solid var(--omni-border,#555);border-radius:4px;padding:5px 10px;color:var(--omni-fg,#ddd);background:var(--omni-panel-bg,#252526)}
.omni-geojson__button{cursor:pointer}
.omni-geojson__button:hover{background:var(--omni-accent,#0e639c);color:var(--omni-accent-fg,#fff)}
.omni-geojson__select{min-width:120px;max-width:100%}
.omni-geojson__map{display:block;position:static;transform:none;width:100%;height:min(60vh,600px);min-height:240px;border:1px solid var(--omni-border,#444);border-radius:8px;background:var(--omni-map-bg,#eef2f5);cursor:grab;touch-action:none}
.omni-geojson__map.is-panning{cursor:grabbing}
.omni-geojson__geometry{fill:var(--omni-map-fill,rgba(47,126,216,.24));fill-rule:evenodd;stroke:var(--omni-map-stroke,#1d66b1);stroke-width:1.5;vector-effect:non-scaling-stroke}
.omni-geojson__point{fill:var(--omni-map-point,#d64045);stroke:var(--omni-map-point-border,#fff);vector-effect:non-scaling-stroke}
.omni-geojson__feature{cursor:pointer}
.omni-geojson__feature:hover .omni-geojson__geometry{fill:var(--omni-map-hover,rgba(47,126,216,.42))}
.omni-geojson__feature.is-selected .omni-geojson__geometry,.omni-geojson__feature.is-selected .omni-geojson__point{stroke:var(--omni-map-selection,#ffb020);stroke-width:3}
.omni-geojson__map:focus-visible,.omni-geojson__button:focus-visible,.omni-geojson__select:focus-visible{outline:2px solid var(--omni-accent,#0e639c);outline-offset:2px}
.omni-geojson__properties{margin-top:12px;border:1px solid var(--omni-border,#444);border-radius:8px;padding:12px;overflow:auto}
.omni-geojson__properties h3{margin:0 0 8px;font-size:14px}
.omni-geojson__properties table{border-collapse:collapse;width:100%;table-layout:fixed}
.omni-geojson__properties th,.omni-geojson__properties td{text-align:left;vertical-align:top;border-bottom:1px solid var(--omni-border,#444);padding:5px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
.omni-geojson__properties th{width:30%;font-weight:500;color:var(--omni-muted,#aaa)}
.omni-geojson__warning{white-space:pre-wrap;margin-top:12px;padding:10px;border:1px solid var(--omni-warning,#b98b2f);border-radius:6px}
`;
