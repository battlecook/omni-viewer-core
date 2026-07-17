export const hwpViewerCss = `
:host{display:block;height:100%;color:var(--omni-fg,#d4d4d4);background:var(--omni-bg,#1e1e1e)}
.omni-hwp{display:flex;flex-direction:column;height:100%;font:13px system-ui,-apple-system,"Segoe UI","Noto Sans KR",sans-serif}
.omni-hwp__header,.omni-hwp__toolbar{display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--omni-panel-bg,#252526);border-bottom:1px solid var(--omni-border,#3c3c3c)}
.omni-hwp__header{justify-content:space-between}.omni-hwp__title{overflow:hidden;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.omni-hwp__meta{opacity:.7;font-size:12px;white-space:nowrap}
.omni-hwp__toolbar{justify-content:center}.omni-hwp__toolbar button{min-width:34px;padding:6px 10px;color:inherit;background:var(--omni-control-bg,#3a3d41);border:1px solid var(--omni-border,#555);border-radius:6px;cursor:pointer}.omni-hwp__zoom{min-width:52px;text-align:center;opacity:.8}
.omni-hwp__viewport{position:relative;flex:1;overflow:auto;padding:28px 24px 48px;background:radial-gradient(circle at top,#ffffff0d,transparent 28%)}
.omni-hwp__content{display:grid;width:max-content;min-width:100%;gap:24px;justify-items:center;transform-origin:top center}
.omni-hwp__page{display:block;overflow:hidden;background:#fff;border-radius:4px;box-shadow:0 18px 40px #00000047}.omni-hwp__page svg{display:block;max-width:100%;height:auto}
.omni-hwp__status,.omni-hwp__error{margin:auto;padding:24px;text-align:center}.omni-hwp__error{color:var(--omni-danger,#f48771)}
.omni-hwp__status{display:flex;align-items:center;gap:12px}.omni-hwp__load-more{padding:7px 12px;color:inherit;background:var(--omni-control-bg,#3a3d41);border:1px solid var(--omni-border,#555);border-radius:6px;cursor:pointer}.omni-hwp__load-more:disabled{opacity:.5}
@media print{.omni-hwp__header,.omni-hwp__toolbar{display:none}.omni-hwp__viewport{overflow:visible;padding:0}.omni-hwp__content{display:block;transform:none!important}.omni-hwp__page{box-shadow:none;break-after:page}}
`;
