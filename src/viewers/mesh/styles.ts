/** Shared source for shadow injection and dist/styles/mesh.css. */
export const meshViewerCss = `
.omni-viewer--mesh{all:initial;display:block}
.omni-viewer--mesh :where(h2,p,div,section,button,canvas){all:revert;box-sizing:border-box}
.omni-mesh{box-sizing:border-box;min-height:100%;padding:16px;background:var(--omni-bg,#1e1e1e);color:var(--omni-fg,#ddd);font:14px/1.5 system-ui,sans-serif}
.omni-mesh [hidden]{display:none}
.omni-mesh__title{margin:0;font-size:18px;overflow-wrap:anywhere}
.omni-mesh__summary,.omni-mesh__hint{margin:8px 0;color:var(--omni-muted,#aaa)}
.omni-mesh__toolbar{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.omni-mesh__toolbar button{font:inherit;padding:5px 10px;cursor:pointer;border:1px solid var(--omni-border,#555);border-radius:4px;color:var(--omni-fg,#ddd);background:var(--omni-panel-bg,#252526)}
.omni-mesh__toolbar button:hover,.omni-mesh__toolbar button[aria-pressed=true]{background:var(--omni-accent,#0e639c);color:var(--omni-accent-fg,#fff)}
.omni-mesh__stage{width:100%;height:60vh;min-height:280px;max-height:900px;position:relative;overflow:hidden;border:1px solid var(--omni-border,#444);border-radius:8px;background:var(--omni-mesh-bg,#171d28)}
.omni-mesh__canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab}
.omni-mesh__canvas:active{cursor:grabbing}
.omni-mesh :where(button,canvas):focus-visible{outline:2px solid var(--omni-accent,#0e639c);outline-offset:2px}
.omni-mesh__warnings{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--omni-warning,#ffd98a)}
`;
