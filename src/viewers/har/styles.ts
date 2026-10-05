// HAR viewer styles. Only --omni-* custom properties are read, with literal
// fallbacks, so the sheet works in a shadow root with no host theme loaded
// (DESIGN.md §6). Phase and status colours are fixed hues: they carry meaning
// the theme must not reassign.
export const harViewerCss = `
.omni-har{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--omni-bg,#181a1f);color:var(--omni-fg,#d8dee9);font:13px system-ui,sans-serif}
.omni-har *{box-sizing:border-box}
.omni-har__header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 20px 12px;border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-panel-bg,#20242b)}
.omni-har__eyebrow{color:var(--omni-accent,#62a8ea);font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.omni-har h1{margin:3px 0 4px;font-size:20px;overflow-wrap:anywhere}
.omni-har__subtitle{color:var(--omni-muted,#929aa8);font-size:12px}
.omni-har__summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;background:var(--omni-border,#343942);border-bottom:1px solid var(--omni-border,#343942)}
.omni-har__summary-item{min-height:57px;padding:9px 13px;background:var(--omni-bg,#181a1f)}
.omni-har__summary-value{font-size:18px;font-weight:650}
.omni-har__summary-label{margin-top:2px;color:var(--omni-muted,#929aa8);font-size:11px}
.omni-har__toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-toolbar-bg,#252a32)}
.omni-har__search{width:min(260px,30vw);min-width:150px}
.omni-har__search,.omni-har__select{border:1px solid var(--omni-border,#343942);border-radius:5px;background:var(--omni-input-bg,#16181d);color:inherit;font:inherit;padding:7px 9px}
.omni-har__select{max-width:180px}
.omni-har__toggle{display:flex;align-items:center;gap:5px;color:var(--omni-muted,#929aa8);white-space:nowrap}
.omni-har__tabs{display:flex;flex-wrap:wrap;gap:4px;margin-left:auto}
.omni-har button{border:1px solid var(--omni-border,#343942);border-radius:5px;background:var(--omni-button-bg,#2c323b);color:inherit;cursor:pointer;font:inherit;padding:7px 10px}
.omni-har button:hover{background:var(--omni-hover,#343b46)}
.omni-har button[aria-pressed=true]{border-color:var(--omni-accent,#3979b7);background:var(--omni-accent,#3979b7);color:#fff}
.omni-har button:disabled{opacity:.5;cursor:default}
.omni-har__warnings{padding:8px 13px;border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-warning-bg,#493b1c);color:var(--omni-warning-fg,#f0cf78)}
.omni-har__content{min-height:0;flex:1;display:flex;flex-direction:column}
.omni-har__layout{min-height:0;flex:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,380px)}
.omni-har__list{min-height:0;overflow:auto}
.omni-har__panel-header{position:sticky;left:0;top:0;z-index:4;width:max-content;min-width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 13px;border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-bg,#181a1f)}
.omni-har__panel-header h2{margin:0;font-size:14px}
.omni-har__panel-header span{color:var(--omni-muted,#929aa8);font-size:11px}
.omni-har table{width:100%;border-collapse:collapse}
.omni-har th,.omni-har td{border-bottom:1px solid var(--omni-border,#343942);padding:6px 9px;text-align:left;vertical-align:top;white-space:nowrap}
.omni-har th{position:sticky;top:42px;z-index:2;background:var(--omni-header-bg,#20242b);font-weight:650}
.omni-har th button{width:100%;border:0;border-radius:0;background:transparent;padding:0;text-align:left;font-weight:inherit}
.omni-har th button:hover{background:transparent;color:var(--omni-accent,#62a8ea)}
.omni-har th[aria-sort] button{color:var(--omni-accent,#62a8ea)}
.omni-har td{max-width:360px;overflow:hidden;text-overflow:ellipsis}
.omni-har__row{cursor:pointer}
.omni-har__row:hover td{background:var(--omni-hover,#252a32)}
.omni-har__row--selected td{background:var(--omni-selection-bg,#0a3a5e)}
.omni-har__row--error td:first-child{box-shadow:inset 3px 0 0 #e55}
.omni-har__name{display:flex;flex-direction:column}
.omni-har__name small{color:var(--omni-muted,#929aa8)}
.omni-har__status{border-radius:3px;padding:1px 6px;font-variant-numeric:tabular-nums}
.omni-har__status--1xx{background:#2c323b;color:#c8d5e6}
.omni-har__status--2xx{background:#1e3b2a;color:#7ddfa2}
.omni-har__status--3xx{background:#1e3246;color:#8ec6f5}
.omni-har__status--4xx{background:#443315;color:#f0cf78}
.omni-har__status--5xx{background:#44201f;color:#f29a94}
.omni-har__status--none{background:#3a2326;color:#e58a8a}
.omni-har__chip{border:1px solid var(--omni-border,#47505e);border-radius:3px;padding:1px 5px;color:var(--omni-muted,#a8b0bd);font-size:11px}
.omni-har__waterfall{width:220px;min-width:180px}
.omni-har__track{position:relative;height:13px;border-radius:2px;background:var(--omni-input-bg,#16181d)}
.omni-har__bar{position:absolute;top:0;bottom:0;display:flex;min-width:2px;overflow:hidden;border-radius:2px}
.omni-har__phase{min-width:1px}
.omni-har__phase--blocked{background:#8b919c}
.omni-har__phase--dns{background:#12b5cb}
.omni-har__phase--connect{background:#e8710a}
.omni-har__phase--ssl{background:#b069d6}
.omni-har__phase--send{background:#4285f4}
.omni-har__phase--wait{background:#f2a900}
.omni-har__phase--receive{background:#34a853}
.omni-har__phase--untimed{background:#596273}
.omni-har__legend{display:flex;flex-wrap:wrap;gap:10px;padding:8px 13px;border-top:1px solid var(--omni-border,#343942);background:var(--omni-panel-bg,#20242b);color:var(--omni-muted,#929aa8);font-size:11px}
.omni-har__legend span{display:flex;align-items:center;gap:4px}
.omni-har__swatch{width:9px;height:9px;border-radius:2px}
.omni-har__detail{min-height:0;display:flex;flex-direction:column;border-left:1px solid var(--omni-border,#343942);background:var(--omni-panel-bg,#20242b)}
.omni-har__detail-header{padding:11px 13px;border-bottom:1px solid var(--omni-border,#343942)}
.omni-har__detail-header h2{margin:0 0 3px;font-size:14px;overflow-wrap:anywhere}
.omni-har__detail-header div{color:var(--omni-muted,#929aa8);font-size:11px;overflow-wrap:anywhere}
.omni-har__detail-tabs{display:flex;flex-wrap:wrap;gap:4px;padding:8px 13px;border-bottom:1px solid var(--omni-border,#343942)}
.omni-har__detail-tabs button{padding:4px 8px;font-size:12px}
.omni-har__detail-body{min-height:0;flex:1;overflow:auto;padding:12px 13px}
.omni-har__detail-body h3{margin:14px 0 6px;color:var(--omni-muted,#a8b0bd);font-size:11px;text-transform:uppercase}
.omni-har__detail-body h3:first-child{margin-top:0}
.omni-har__props{display:grid;grid-template-columns:minmax(80px,38%) 1fr;gap:1px;margin:0;background:var(--omni-border,#343942)}
.omni-har__props dt,.omni-har__props dd{margin:0;padding:5px 7px;background:var(--omni-bg,#181a1f);overflow-wrap:anywhere}
.omni-har__props dt{color:var(--omni-muted,#929aa8)}
.omni-har__body{margin:0;padding:9px;border:1px solid var(--omni-border,#343942);border-radius:5px;background:var(--omni-bg,#181a1f);font-family:var(--omni-font-mono,ui-monospace,monospace);font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto}
.omni-har__json-key{color:var(--omni-syntax-property,#9cdcfe)}
.omni-har__json-string{color:var(--omni-syntax-string,#ce9178)}
.omni-har__json-number{color:var(--omni-syntax-number,#b5cea8)}
.omni-har__json-boolean,.omni-har__json-null{color:var(--omni-syntax-keyword,#569cd6)}
.omni-har__note{color:var(--omni-muted,#929aa8);margin:6px 0}
.omni-har__phase-row{display:grid;grid-template-columns:70px 1fr 72px;align-items:center;gap:8px;margin-bottom:5px}
.omni-har__phase-row span:first-child{color:var(--omni-muted,#929aa8)}
.omni-har__phase-row span:last-child{text-align:right;font-variant-numeric:tabular-nums}
.omni-har__phase-bar{height:9px;border-radius:2px}
.omni-har__actions{display:flex;gap:6px;margin-bottom:8px}
.omni-har__empty{padding:24px;color:var(--omni-muted,#929aa8)}
@media(max-width:860px){
.omni-har__header{align-items:stretch;flex-direction:column}
.omni-har__layout{grid-template-columns:minmax(0,1fr)}
.omni-har__detail{max-height:300px;border-left:0;border-top:1px solid var(--omni-border,#343942)}
.omni-har__waterfall{display:none}
}`;
