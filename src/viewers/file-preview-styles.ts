export const filePreviewCss = `
.omni-file-preview { color: var(--omni-fg, #202124); background: var(--omni-bg, #fff); padding: 1rem; box-sizing: border-box; min-width: 0; overflow-wrap: anywhere; font: 14px/1.45 system-ui, sans-serif; }
.omni-file-preview * { box-sizing: border-box; }
.omni-file-preview h2, .omni-file-preview h3 { margin: .5rem 0; }
.omni-file-preview p { margin: .5rem 0; }
.omni-file-preview .preview-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; margin-block: .75rem; }
.omni-file-preview .preview-toolbar label { display: inline-flex; align-items: center; gap: .25rem; }
.omni-file-preview :is(button,input,select) { color: inherit; background: var(--omni-button-bg, var(--omni-input-bg, transparent)); border: 1px solid var(--omni-border, #ccd3dc); border-radius: .25rem; padding: .3rem .45rem; font: inherit; max-width: 100%; }
.omni-file-preview button:enabled { cursor: pointer; }
.omni-file-preview button:disabled { opacity: .55; }
.omni-file-preview button[aria-pressed="true"] { background: var(--omni-accent, #1769aa); border-color: var(--omni-accent, #1769aa); color: var(--omni-accent-fg, #fff); }
.omni-file-preview tr.is-selected { background: var(--omni-selection-bg, rgba(23, 105, 170, .18)); }
.omni-file-preview .preview-scroll { overflow: auto; max-height: 68vh; border: 1px solid var(--omni-border, #ccd3dc); }
.omni-file-preview table { border-collapse: collapse; width: 100%; }
.omni-file-preview :is(th,td) { text-align: start; vertical-align: top; padding: .35rem .5rem; border: 1px solid var(--omni-border, #ccd3dc); }
.omni-file-preview th { font-weight: 600; }
.omni-file-preview :is(td,th) button { text-align: start; }
.omni-file-preview pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 40vh; overflow: auto; }
.omni-file-preview dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .25rem .75rem; }
.omni-file-preview dd { margin: 0; white-space: pre-wrap; }
.omni-file-preview .preview-warning { color: var(--omni-warning, #975a16); }
.omni-file-preview .preview-status { margin-block: .4rem; }
.omni-file-preview iframe { display: block; width: 100%; min-height: 24rem; border: 1px solid var(--omni-border, #ccd3dc); background: #fff; }
.omni-file-preview .preview-artboard { display: block; }
.omni-file-preview .preview-slide { position: relative; overflow: hidden; color: #202124; background: #fff; transform-origin: top left; }
.omni-file-preview .preview-shape { position: absolute; overflow: hidden; }
.omni-file-preview .preview-shape p { margin: 0; }
.omni-file-preview .preview-line-label { width: max-content; max-width: 70%; margin-top: 2px; overflow-wrap: anywhere; text-align: center; transform: translateX(-50%); }
.omni-file-preview .preview-document { max-width: 56rem; margin-inline: auto; padding: 1rem 1.25rem; }
.omni-file-preview :is(.preview-document, .preview-shape) :is(p, td, th, li, h1, h2, h3, h4, h5, h6) { white-space: pre-wrap; }
.omni-file-preview .preview-track { display: grid; grid-template-columns: minmax(6rem, 20%) minmax(12rem, 1fr); align-items: start; border-bottom: 1px solid var(--omni-border, #ccd3dc); }
.omni-file-preview .preview-track-label { padding: .3rem; }
.omni-file-preview .preview-track-plot { position: relative; overflow: hidden; min-height: 1.5rem; }
.omni-file-preview .preview-event { position: absolute; display: block; overflow: hidden; text-align: start; white-space: nowrap; text-overflow: ellipsis; min-width: 4px; padding: 0 .2rem; background: var(--omni-accent, #1769aa); color: var(--omni-accent-fg, #fff); line-height: 1.15rem; font-size: .75rem; }
`;
