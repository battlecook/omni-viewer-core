export const dicomViewerCss = `
.omni-dicom{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;min-height:100%;padding:16px;background:var(--omni-bg,#181b20);color:var(--omni-fg,#e0e4ea);font:14px/1.5 system-ui,sans-serif}
.omni-dicom *{box-sizing:border-box}.omni-dicom [hidden]{display:none!important}
.omni-dicom__heading{margin:0;font-size:18px;overflow-wrap:anywhere}.omni-dicom__summary{color:var(--omni-muted,#aeb9c8)}
.omni-dicom__toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.omni-dicom label{display:flex;align-items:center;gap:6px}
.omni-dicom input,.omni-dicom button{font:inherit;color:inherit;background:var(--omni-bg,#181b20);border:1px solid var(--omni-border,#4b5563);border-radius:5px;padding:6px 9px}
.omni-dicom button{cursor:pointer}.omni-dicom button:disabled{opacity:.45;cursor:default}.omni-dicom input[type=number]{width:100px}.omni-dicom input[type=range]{width:150px}.omni-dicom input[type=search]{width:min(100%,480px)}
.omni-dicom :is(input,button):focus-visible{outline:2px solid var(--omni-accent,#69aaf5);outline-offset:2px}
.omni-dicom__stage{display:grid;place-items:center;min-height:300px;max-height:75vh;overflow:auto;background:#000;border:1px solid var(--omni-border,#4b5563);border-radius:7px;padding:8px}
.omni-dicom__canvas{display:block;max-width:100%;height:auto;image-rendering:pixelated}.omni-dicom__message{margin:0;white-space:pre-wrap;color:var(--omni-muted,#aeb9c8)}
.omni-dicom__metadata{display:flex;flex-direction:column;gap:10px;min-width:0}.omni-dicom__metadata h3{margin:0;font-size:16px}
.omni-dicom__table-wrap{overflow:auto;max-height:420px;border:1px solid var(--omni-border,#4b5563);border-radius:6px}.omni-dicom table{border-collapse:collapse;width:100%;text-align:left}
.omni-dicom th,.omni-dicom td{padding:6px 10px;border-bottom:1px solid var(--omni-border,#4b5563);vertical-align:top;overflow-wrap:anywhere;max-width:480px}.omni-dicom th{position:sticky;top:0;background:var(--omni-bg,#181b20)}
.omni-dicom__tag{font:12px/1.6 ui-monospace,monospace;white-space:nowrap}.omni-dicom__pagination{display:flex;align-items:center;gap:12px}
`;
