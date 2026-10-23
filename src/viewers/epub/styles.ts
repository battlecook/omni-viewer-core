// EPUB viewer styles. Chrome reads only --omni-* custom properties, with
// literal fallbacks, so the sheet works in a shadow root with no host theme
// (DESIGN.md §6). Publisher CSS is not applied (docs/viewers/epub.md E4), so
// the reading pane carries its own book typography, scaled by --epub-scale.
export const epubViewerCss = `
.omni-epub{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--omni-bg,#181a1f);color:var(--omni-fg,#d8dee9);font:13px var(--omni-font-family,system-ui,sans-serif)}
.omni-epub *{box-sizing:border-box}
.omni-epub__header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:14px 20px 10px;border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-panel-bg,#20242b)}
.omni-epub__eyebrow{color:var(--omni-accent,#62a8ea);font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.omni-epub h1.omni-epub__title{margin:3px 0 4px;font-size:19px;line-height:1.3;overflow-wrap:anywhere}
.omni-epub__subtitle{color:var(--omni-muted,#929aa8);font-size:12px;overflow-wrap:anywhere}
.omni-epub__toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-toolbar-bg,#252a32)}
.omni-epub__group{display:flex;align-items:center;gap:4px}
.omni-epub__spacer{flex:1}
.omni-epub button{border:1px solid var(--omni-border,#343942);border-radius:5px;background:var(--omni-button-bg,#2c323b);color:inherit;cursor:pointer;font:inherit;padding:6px 10px}
.omni-epub button:hover:not(:disabled){background:var(--omni-hover,#343b46)}
.omni-epub button[aria-pressed=true]{border-color:var(--omni-accent,#3979b7);background:var(--omni-accent,#3979b7);color:#fff}
.omni-epub button:disabled{opacity:.5;cursor:default}
.omni-epub button:focus-visible,.omni-epub select:focus-visible,.omni-epub__toc-link:focus-visible{outline:2px solid var(--omni-focus,#007fd4);outline-offset:1px}
.omni-epub__select{max-width:min(320px,40vw);border:1px solid var(--omni-border,#343942);border-radius:5px;background:var(--omni-input-bg,#16181d);color:inherit;font:inherit;padding:6px 8px}
.omni-epub__position,.omni-epub__scale{min-width:44px;text-align:center;color:var(--omni-muted,#929aa8);font-variant-numeric:tabular-nums;white-space:nowrap}
.omni-epub__warnings{padding:7px 13px;border-bottom:1px solid var(--omni-border,#343942);background:var(--omni-warning-bg,#493b1c);color:var(--omni-warning-fg,#f0cf78)}
.omni-epub__warnings[hidden]{display:none}
.omni-epub__sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.omni-epub__body{min-height:0;flex:1;display:flex}
.omni-epub__side{flex:0 0 280px;min-width:0;overflow:auto;border-right:1px solid var(--omni-border,#343942);background:var(--omni-panel-bg,#1d2026)}
.omni-epub__side[hidden]{display:none}
.omni-epub__side-title{position:sticky;top:0;z-index:1;margin:0;padding:10px 14px;font-size:12px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--omni-muted,#929aa8);background:inherit;border-bottom:1px solid var(--omni-border,#343942)}
.omni-epub__toc,.omni-epub__toc ul{list-style:none;margin:0;padding:0}
.omni-epub__toc{padding:6px}
.omni-epub__toc ul{padding-left:14px}
.omni-epub__toc-link{display:block;width:100%;border:0!important;background:none!important;color:var(--omni-muted,#aab1bd)!important;text-align:left;padding:5px 8px!important;border-radius:5px!important;line-height:1.35;overflow-wrap:anywhere}
.omni-epub__toc-link:hover:not(:disabled){background:var(--omni-hover,#343b46)!important;color:var(--omni-fg,#d8dee9)!important}
.omni-epub__toc-link.is-active{background:color-mix(in srgb,var(--omni-accent,#3979b7) 24%,transparent)!important;color:var(--omni-fg,#d8dee9)!important;font-weight:600}
.omni-epub__toc-heading{display:block;padding:7px 8px 3px;color:var(--omni-fg,#d8dee9);font-weight:600}
.omni-epub__info{padding:12px 14px}
.omni-epub__cover{display:block;max-width:100%;max-height:260px;margin:0 auto 12px;border-radius:4px;box-shadow:0 2px 10px rgba(0,0,0,.35)}
.omni-epub__meta{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 10px;margin:0}
.omni-epub__meta dt{color:var(--omni-muted,#929aa8)}
.omni-epub__meta dd{margin:0;overflow-wrap:anywhere;white-space:pre-line}
.omni-epub__diagnostics{margin:14px 0 0;padding-left:18px;color:var(--omni-warning-fg,#f0cf78)}
.omni-epub__viewport{min-width:0;flex:1;overflow:auto;background:var(--omni-editor-bg,var(--omni-bg,#181a1f))}
.omni-epub__page{--epub-scale:1;max-width:46em;margin:0 auto;padding:32px clamp(18px,5vw,56px) 48px;font:calc(17px * var(--epub-scale))/1.65 var(--omni-reading-font,Georgia,'Iowan Old Style','Noto Serif',serif);color:var(--omni-fg,#d8dee9);overflow-wrap:break-word}
.omni-epub__chapter{display:contents}
.omni-epub__page h1,.omni-epub__page h2,.omni-epub__page h3,.omni-epub__page h4,.omni-epub__page h5,.omni-epub__page h6{line-height:1.3;margin:1.4em 0 .6em}
.omni-epub__page h1{font-size:1.7em}.omni-epub__page h2{font-size:1.4em}.omni-epub__page h3{font-size:1.2em}
.omni-epub__page p{margin:0 0 .9em}
.omni-epub__page a[role=link]{color:var(--omni-link,#4daafc);cursor:pointer}
.omni-epub__page a[aria-disabled=true]{color:inherit;text-decoration:underline dotted}
.omni-epub__page img,.omni-epub__page svg,.omni-epub__page video{max-width:100%;height:auto}
.omni-epub__page svg{max-height:85vh}
.omni-epub__page blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid var(--omni-border,#454b55)}
.omni-epub__page pre,.omni-epub__page code{font-family:var(--omni-mono,ui-monospace,monospace);font-size:.88em}
.omni-epub__page pre{overflow:auto;padding:10px 12px;border-radius:6px;background:var(--omni-code-bg,rgba(127,127,127,.14))}
.omni-epub__page table{border-collapse:collapse;margin:1em 0;display:block;overflow:auto}
.omni-epub__page th,.omni-epub__page td{border:1px solid var(--omni-border,#454b55);padding:4px 8px}
.omni-epub__page hr{border:0;border-top:1px solid var(--omni-border,#454b55);margin:1.6em 0}
.omni-epub__page aside{margin:1em 0;padding:.5em 1em;border-radius:6px;background:var(--omni-panel-bg,rgba(127,127,127,.08));font-size:.92em}
.omni-epub__page [data-omni-epub-blocked]{display:none}
.omni-epub__message{padding:14px 16px;border:1px solid var(--omni-border,#454b55);border-radius:6px;color:var(--omni-muted,#929aa8);font-family:var(--omni-font-family,system-ui,sans-serif);font-size:13px}
.omni-epub__message.is-error{border-color:var(--omni-error,#f44747);color:var(--omni-error,#f48771)}
.omni-epub__note{margin-top:2em;color:var(--omni-muted,#929aa8);font:12px var(--omni-font-family,system-ui,sans-serif)}
.omni-epub__pager{display:flex;justify-content:space-between;gap:12px;max-width:46em;margin:0 auto;padding:0 clamp(18px,5vw,56px) 40px}
@media(max-width:760px){.omni-epub__side{position:absolute;z-index:5;inset:auto;height:70%;width:min(86vw,320px);box-shadow:4px 0 16px rgba(0,0,0,.4)}.omni-epub__body{position:relative}}
@media print{.omni-epub__header,.omni-epub__toolbar,.omni-epub__side,.omni-epub__pager{display:none}.omni-epub__viewport{overflow:visible}}
`;
