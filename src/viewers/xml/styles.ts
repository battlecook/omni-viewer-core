// XML viewer styles. Only --omni-* custom properties are read, with literal
// fallbacks, so the sheet works in a shadow root with no host theme loaded
// (DESIGN.md §6). Row heights match XML_TREE_ROW_HEIGHT (24px) and
// XML_SOURCE_ROW_HEIGHT (20px): the panes are virtualized on them.
export const xmlViewerCss = `
.omni-xml{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--omni-bg,#181a1f);color:var(--omni-fg,#d8dee9);font:13px system-ui,sans-serif}
.omni-xml *{box-sizing:border-box}
.omni-xml__header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:14px 20px 10px;border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-panel-bg,#20242b)}
.omni-xml__eyebrow{color:var(--omni-accent,#62a8ea);font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.omni-xml h1{margin:3px 0 4px;font-size:20px;overflow-wrap:anywhere}
.omni-xml h2{margin:0;font-size:14px}
.omni-xml h3{margin:16px 0 6px;font-size:12px;color:var(--omni-muted,#929aa8);text-transform:uppercase;letter-spacing:.06em}
.omni-xml__subtitle{color:var(--omni-muted,#929aa8);font-size:12px;overflow-wrap:anywhere}
.omni-xml__summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:1px;background:var(--omni-border,#343942);border-bottom:1px solid var(--omni-border,#343942)}
.omni-xml__summary-item{padding:8px 13px;background:var(--omni-bg,#181a1f)}
.omni-xml__summary-value{font-size:17px;font-weight:650}
.omni-xml__summary-label{margin-top:2px;color:var(--omni-muted,#929aa8);font-size:11px}
.omni-xml__toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-toolbar-bg,#252a32)}
.omni-xml__search{width:min(280px,40vw);min-width:150px}
.omni-xml__search,.omni-xml__select{border:1px solid var(--omni-border,#343942);border-radius:5px;background:var(--omni-input-bg,#16181d);color:inherit;font:inherit;padding:6px 9px}
.omni-xml button{border:1px solid var(--omni-border,#343942);border-radius:5px;background:var(--omni-button-bg,#2c323b);color:inherit;cursor:pointer;font:inherit;padding:6px 10px}
.omni-xml button:hover{background:var(--omni-hover,#343b46)}
.omni-xml button:disabled{opacity:.5;cursor:default}
.omni-xml__icon-button{min-width:30px;padding:6px 8px}
.omni-xml__match-status{min-width:70px;color:var(--omni-muted,#929aa8);font-variant-numeric:tabular-nums}
.omni-xml__toggle{display:flex;align-items:center;gap:5px;color:var(--omni-muted,#929aa8);white-space:nowrap}
.omni-xml__diagnostics{border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-warning-bg,#493b1c);color:var(--omni-warning-fg,#f0cf78);padding:6px 13px;max-height:30%;overflow:auto}
.omni-xml__diagnostics summary{cursor:pointer;font-weight:600}
.omni-xml__diagnostics ul{margin:6px 0 2px;padding-left:18px}
.omni-xml__diagnostic--error{color:var(--omni-error,#ff8b8b)}
.omni-xml__diagnostic--info{color:var(--omni-muted,#c6cbd4)}
.omni-xml__link{border:0!important;background:transparent!important;padding:1px 0!important;color:inherit;text-align:left;text-decoration:underline dotted}
.omni-xml__layout{min-height:0;flex:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,46%)}
.omni-xml__pane{min-height:0;display:flex;flex-direction:column}
.omni-xml__pane-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 13px;border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-bg,#181a1f)}
.omni-xml__pane-header span{color:var(--omni-muted,#929aa8);font-size:11px}
.omni-xml__tree-pane{border-right:1px solid var(--omni-border,#343942)}
.omni-xml__tree,.omni-xml__source{position:relative;min-height:0;flex:1;overflow:auto;outline:none}
.omni-xml__tree:focus-visible,.omni-xml__source:focus-visible{box-shadow:inset 0 0 0 2px var(--omni-accent,#3979b7)}
.omni-xml__canvas{position:relative;min-width:100%;width:max-content}
.omni-xml__window{position:absolute;top:0;left:0;min-width:100%}
.omni-xml__row{height:24px;line-height:24px;display:flex;align-items:center;gap:0;padding-right:12px;white-space:pre;cursor:pointer;font:12px var(--omni-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
.omni-xml__row:hover{background:var(--omni-hover,#262c35)}
.omni-xml__row--match{background:var(--omni-match-bg,rgba(240,207,120,.12))}
.omni-xml__row--current{box-shadow:inset 3px 0 0 var(--omni-warning-fg,#f0cf78)}
.omni-xml__row[aria-selected=true]{background:var(--omni-selection-bg,#2f4a66)}
.omni-xml__twisty{display:inline-block;width:16px;flex:none;text-align:center;color:var(--omni-muted,#929aa8)}
.omni-xml__tag,.omni-xml__src-tag{color:var(--omni-syntax-tag,#7cc4f8)}
.omni-xml__attr-name,.omni-xml__src-attr{color:var(--omni-syntax-attr,#e0b071)}
.omni-xml__attr-value,.omni-xml__src-value{color:var(--omni-syntax-string,#a5d6a7)}
.omni-xml__punct{color:var(--omni-muted,#929aa8)}
.omni-xml__inline-text{margin-left:8px;color:var(--omni-fg,#d8dee9)}
.omni-xml__text{color:var(--omni-fg,#d8dee9)}
.omni-xml__comment,.omni-xml__src-comment,.omni-xml__src-meta,.omni-xml__muted{color:var(--omni-muted,#7f8796)}
.omni-xml__row--comment,.omni-xml__row--pi,.omni-xml__row--doctype{font-style:italic}
.omni-xml__badge{display:inline-block;margin-right:6px;padding:0 5px;border-radius:3px;background:var(--omni-badge-bg,#343b46);color:var(--omni-muted,#c6cbd4);font:600 10px/16px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.04em}
.omni-xml__side{min-height:0;display:grid;grid-template-rows:minmax(160px,45%) minmax(0,1fr)}
.omni-xml__inspector{overflow:auto;padding:12px 14px;border-bottom:1px solid var(--omni-border,#343942)}
.omni-xml__inspector h2{display:flex;align-items:center;gap:2px;overflow-wrap:anywhere}
.omni-xml__actions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.omni-xml__facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:0}
.omni-xml__facts dt{color:var(--omni-muted,#929aa8)}
.omni-xml__facts dd{margin:0;overflow-wrap:anywhere}
.omni-xml__xpath{font:12px var(--omni-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);overflow-wrap:anywhere}
.omni-xml__table{width:100%;border-collapse:collapse;font-size:12px}
.omni-xml__table th,.omni-xml__table td{padding:4px 8px;border-bottom:1px solid var(--omni-border,#343942);text-align:left;vertical-align:top;overflow-wrap:anywhere}
.omni-xml__table th{color:var(--omni-muted,#929aa8);font-weight:600}
.omni-xml__clickable{cursor:pointer}
.omni-xml__clickable:hover{background:var(--omni-hover,#262c35)}
.omni-xml__value{margin:0;padding:8px;max-height:240px;overflow:auto;border:1px solid var(--omni-border,#343942);border-radius:4px;background:var(--omni-input-bg,#16181d);white-space:pre-wrap;overflow-wrap:anywhere;font:12px var(--omni-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
.omni-xml__source-row{height:20px;line-height:20px;display:flex;white-space:pre;font:12px var(--omni-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);cursor:text}
.omni-xml__source-row--range{background:var(--omni-range-bg,rgba(98,168,234,.08))}
.omni-xml__ln{position:sticky;left:0;flex:none;width:56px;padding-right:10px;text-align:right;color:var(--omni-muted,#5d6573);background:var(--omni-bg,#181a1f);user-select:none}
.omni-xml__code{padding-right:16px}
.omni-xml__src-focus{background:var(--omni-focus-bg,rgba(98,168,234,.32));border-radius:2px}
.omni-xml__failure{margin:20px;padding:16px;border:1px solid var(--omni-error,#ff8b8b);border-radius:6px}
.omni-xml__failure p{margin:6px 0 0}
.omni-xml__failure-list{margin:10px 0 0;padding-left:18px;color:var(--omni-muted,#929aa8)}
.omni-xml__sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:720px){.omni-xml__layout{grid-template-columns:1fr;grid-template-rows:minmax(240px,1fr) minmax(320px,1fr)}.omni-xml__tree-pane{border-right:0;border-bottom:1px solid var(--omni-border,#343942)}}
`;
