// JUnit viewer styles. Only --omni-* custom properties are read, with literal
// fallbacks, so the sheet works in a shadow root with no host theme loaded
// (DESIGN.md §6). Outcome colours are fixed hues: they carry meaning the theme
// must not reassign, and every one is paired with a text label. The panel
// header has a fixed 42px box because the sticky column header is offset by it.
export const junitViewerCss = `
.omni-junit{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--omni-bg,#181a1f);color:var(--omni-fg,#d8dee9);font:13px system-ui,sans-serif}
.omni-junit *{box-sizing:border-box}
/* Author display rules (the toolbar's flex label) would override [hidden]. */
.omni-junit [hidden]{display:none!important}
.omni-junit__sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.omni-junit__header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 20px 12px;border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-panel-bg,#20242b)}
.omni-junit__eyebrow{color:var(--omni-accent,#62a8ea);font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.omni-junit h1{margin:3px 0 4px;font-size:20px;overflow-wrap:anywhere}
.omni-junit__subtitle{color:var(--omni-muted,#929aa8);font-size:12px;overflow-wrap:anywhere}
.omni-junit__verdict{flex:none;border-radius:4px;padding:5px 10px;font-weight:700}
.omni-junit__verdict--passed{background:#1e3b2a;color:#7ddfa2}
.omni-junit__verdict--failed{background:#44201f;color:#f29a94}
.omni-junit__verdict--empty,.omni-junit__verdict--skipped,.omni-junit__verdict--incomplete{background:#2c323b;color:#c8d5e6}
.omni-junit__meter{display:flex;height:6px;background:var(--omni-input-bg,#16181d)}
.omni-junit__meter span{min-width:0}
.omni-junit__summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:1px;background:var(--omni-border,#343942);border-bottom:1px solid var(--omni-border,#343942)}
.omni-junit__summary-item{min-height:57px;padding:9px 13px;background:var(--omni-bg,#181a1f)}
.omni-junit__summary-value{font-size:18px;font-weight:650;font-variant-numeric:tabular-nums}
.omni-junit__summary-label{margin-top:2px;color:var(--omni-muted,#929aa8);font-size:11px}
/* Theme tokens first: a light host theme needs its own error/warning hues. */
.omni-junit__summary-item--failed .omni-junit__summary-value{color:var(--omni-error,#f29a94)}
.omni-junit__summary-item--error .omni-junit__summary-value{color:var(--omni-warning-fg,#f5b26b)}
.omni-junit__toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-toolbar-bg,#252a32)}
.omni-junit__search{width:min(260px,30vw);min-width:150px}
.omni-junit__search,.omni-junit__select{border:1px solid var(--omni-border,#343942);border-radius:5px;background:var(--omni-input-bg,#16181d);color:inherit;font:inherit;padding:7px 9px}
.omni-junit__select{max-width:220px}
.omni-junit__toggle{display:flex;align-items:center;gap:5px;color:var(--omni-muted,#929aa8);white-space:nowrap}
.omni-junit__tabs{display:flex;flex-wrap:wrap;gap:4px;margin-left:auto}
.omni-junit button{border:1px solid var(--omni-border,#343942);border-radius:5px;background:var(--omni-button-bg,#2c323b);color:inherit;cursor:pointer;font:inherit;padding:7px 10px}
.omni-junit button:hover{background:var(--omni-hover,#343b46)}
.omni-junit button[aria-pressed=true]{border-color:var(--omni-accent,#3979b7);background:var(--omni-accent,#3979b7);color:#fff}
.omni-junit button:disabled{opacity:.5;cursor:default}
.omni-junit__live{color:var(--omni-muted,#929aa8);font-size:12px}
.omni-junit__warnings{padding:8px 13px;border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-warning-bg,#493b1c);color:var(--omni-warning-fg,#f0cf78)}
.omni-junit__content{min-height:0;flex:1;display:flex;flex-direction:column}
.omni-junit__layout{min-height:0;flex:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,440px)}
/* Keyboard focus scrolls a row into view; the padding keeps it clear of the
   sticky panel header (42px) and column header (~30px). */
.omni-junit__list{min-height:0;overflow:auto;scroll-padding-top:76px}
.omni-junit__panel-header{position:sticky;left:0;top:0;z-index:4;width:max-content;min-width:100%;height:42px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 13px;border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-bg,#181a1f)}
.omni-junit__panel-header h2{margin:0;font-size:14px}
.omni-junit__panel-header span{color:var(--omni-muted,#929aa8);font-size:11px}
.omni-junit table{width:100%;border-collapse:collapse}
.omni-junit th,.omni-junit td{border-bottom:1px solid var(--omni-border,#343942);padding:6px 9px;text-align:left;vertical-align:top;white-space:nowrap}
.omni-junit th{position:sticky;top:42px;z-index:2;background:var(--omni-header-bg,#20242b);font-weight:650}
.omni-junit th button{width:100%;border:0;border-radius:0;background:transparent;padding:0;text-align:left;font-weight:inherit}
.omni-junit th button:hover{background:transparent;color:var(--omni-accent,#62a8ea)}
.omni-junit th[aria-sort] button{color:var(--omni-accent,#62a8ea)}
.omni-junit td{max-width:420px;overflow:hidden;text-overflow:ellipsis}
.omni-junit .omni-junit__num{text-align:right;font-variant-numeric:tabular-nums}
.omni-junit th.omni-junit__num button{text-align:right}
.omni-junit__row{cursor:pointer}
.omni-junit__row:hover td{background:var(--omni-hover,#252a32)}
.omni-junit__row--selected td{background:var(--omni-selection-bg,#0a3a5e)}
.omni-junit__row--failed td:first-child{box-shadow:inset 3px 0 0 #e55}
.omni-junit__row--error td:first-child{box-shadow:inset 3px 0 0 #e8710a}
.omni-junit__name{display:flex;flex-direction:column}
.omni-junit__name small{color:var(--omni-muted,#929aa8)}
.omni-junit__status{display:inline-block;border-radius:3px;padding:1px 6px;font-size:11px;font-weight:650}
.omni-junit__status--passed{background:#1e3b2a;color:#7ddfa2}
.omni-junit__status--failed{background:#44201f;color:#f29a94}
.omni-junit__status--error{background:#47301a;color:#f5b26b}
.omni-junit__status--skipped{background:#2c323b;color:#c8d5e6}
.omni-junit__status--flaky{background:#3b2f4a;color:#d1a8f0}
.omni-junit__meter .omni-junit__status--passed{background:#34a853}
.omni-junit__meter .omni-junit__status--failed{background:#e5534b}
.omni-junit__meter .omni-junit__status--error{background:#e8710a}
.omni-junit__meter .omni-junit__status--skipped{background:#6b7280}
.omni-junit__mismatch{color:var(--omni-warning-fg,#f0cf78)}
.omni-junit__detail{min-height:0;display:flex;flex-direction:column;border-left:1px solid var(--omni-border,#343942);background:var(--omni-panel-bg,#20242b)}
.omni-junit__detail-header{padding:11px 13px;border-bottom:1px solid var(--omni-border,#343942)}
.omni-junit__detail-header h2{margin:0 0 4px;font-size:14px;overflow-wrap:anywhere}
.omni-junit__detail-header div{color:var(--omni-muted,#929aa8);font-size:11px;overflow-wrap:anywhere}
.omni-junit__detail-body{min-height:0;flex:1;overflow:auto;padding:12px 13px}
.omni-junit__detail-body h3{margin:14px 0 6px;color:var(--omni-muted,#a8b0bd);font-size:11px;text-transform:uppercase}
.omni-junit__detail-body h3:first-child{margin-top:0}
.omni-junit__result{margin-bottom:12px;border:1px solid var(--omni-border,#343942);border-radius:5px;overflow:hidden}
.omni-junit__result-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:7px 9px;background:var(--omni-bg,#181a1f)}
.omni-junit__result-type{color:var(--omni-muted,#929aa8);font-family:var(--omni-font-mono,ui-monospace,monospace);font-size:11px;overflow-wrap:anywhere}
.omni-junit__message{padding:7px 9px;border-top:1px solid var(--omni-border,#343942);white-space:pre-wrap;overflow-wrap:anywhere}
.omni-junit__result .omni-junit__pre{border:0;border-top:1px solid var(--omni-border,#343942);border-radius:0}
.omni-junit__props{display:grid;grid-template-columns:minmax(80px,34%) 1fr;gap:1px;margin:0;background:var(--omni-border,#343942)}
.omni-junit__props dt,.omni-junit__props dd{margin:0;padding:5px 7px;background:var(--omni-bg,#181a1f);overflow-wrap:anywhere;white-space:pre-wrap}
.omni-junit__props dt{color:var(--omni-muted,#929aa8)}
/* Traces scroll sideways rather than wrap: a wrapped frame reads as two. */
.omni-junit__pre{margin:0;padding:9px;border:1px solid var(--omni-border,#343942);border-radius:5px;background:var(--omni-bg,#181a1f);font-family:var(--omni-font-mono,ui-monospace,monospace);font-size:12px;line-height:1.5;white-space:pre;tab-size:4;max-height:420px;overflow:auto}
.omni-junit__source{flex:1;min-height:0;max-height:none;margin:12px;overflow:auto}
.omni-junit__note{color:var(--omni-muted,#929aa8);margin:6px 0}
.omni-junit__actions{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.omni-junit__empty{padding:24px;color:var(--omni-muted,#929aa8)}
@media(max-width:860px){
.omni-junit__header{align-items:flex-start;flex-direction:column}
.omni-junit__layout{grid-template-columns:minmax(0,1fr)}
.omni-junit__detail{max-height:340px;border-left:0;border-top:1px solid var(--omni-border,#343942)}
}`;
