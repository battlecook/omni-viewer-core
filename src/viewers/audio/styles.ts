// Audio viewer stylesheet. Single source for both delivery forms (DESIGN.md
// §6): the build emits dist/styles/audio.css from this constant, and the
// renderer injects it into the shadow root. Only --omni-* tokens.
// The media-viewer sheet is included because the audio viewer falls back to
// the plain media player when no waveform engine is available.

import { mediaViewerCss } from '../media.js';

export const audioViewerCss = mediaViewerCss + `
/* Reverse-contamination guard (DESIGN.md §6). */
.omni-viewer--audio {
    all: initial;
}
.omni-viewer--audio :where(button, select, option, input, label, audio) {
    all: revert;
}

:host, .omni-viewer--audio {
    display: block;
    height: 100%;
    box-sizing: border-box;
    color: var(--omni-fg, #d4d4d4);
    background: var(--omni-bg, #1e1e1e);
    font-family: var(--omni-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    font-size: var(--omni-font-size, 13px);
}

.omni-audio { display: flex; flex-direction: column; gap: 12px; box-sizing: border-box; min-height: 100%; padding: 16px; }
.omni-audio * { box-sizing: border-box; }

.omni-audio__header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
.omni-audio__title { font-size: 16px; font-weight: 650; overflow-wrap: anywhere; }
.omni-audio__meta { color: var(--omni-muted, #9d9d9d); white-space: nowrap; }

.omni-audio__info { display: flex; flex-wrap: wrap; gap: 18px; padding: 6px 10px; border: 1px solid var(--omni-border, #444); border-radius: 6px; background: var(--omni-panel-bg, #252526); }
.omni-audio__info-item { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.omni-audio__info-label { font-size: 10px; opacity: 0.7; }
.omni-audio__info-value { font-family: var(--omni-mono, ui-monospace, Menlo, monospace); font-weight: 500; }

.omni-audio__controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 6px; border: 1px solid var(--omni-border, #444); border-radius: 8px; background: var(--omni-panel-bg, #252526); }
.omni-audio__group { display: flex; align-items: center; gap: 6px; }
.omni-audio__group-label { font-size: 12px; color: var(--omni-muted, #9d9d9d); }

.omni-audio__btn {
    background: var(--omni-accent, #0e639c); color: var(--omni-accent-fg, #fff);
    border: none; padding: 5px 11px; border-radius: 4px; cursor: pointer; font-size: 12px; font-family: inherit;
}
.omni-audio__btn:hover { background: var(--omni-accent-hover, #1177bb); }
.omni-audio__btn:disabled { opacity: 0.5; cursor: not-allowed; }
.omni-audio__btn.is-active { outline: 2px solid var(--omni-focus, #007fd4); }

.omni-audio__select {
    background: var(--omni-input-bg, #3c3c3c); color: var(--omni-fg, #d4d4d4);
    border: 1px solid var(--omni-border, #444); padding: 4px 8px; border-radius: 4px; font-size: 12px; font-family: inherit;
}
.omni-audio__slider { width: 90px; }
.omni-audio__zoom-label { font-family: var(--omni-mono, ui-monospace, Menlo, monospace); font-size: 12px; min-width: 34px; text-align: center; color: var(--omni-muted, #9d9d9d); }
.omni-audio__time { font-family: var(--omni-mono, ui-monospace, Menlo, monospace); font-size: 12px; min-width: 100px; }

.omni-audio__stage { border: 1px solid var(--omni-border, #444); border-radius: 8px; background: var(--omni-panel-bg, #202021); padding: 12px; overflow: hidden; }
.omni-audio__timeline { min-height: 20px; }
.omni-audio__waveform { min-height: 128px; }
.omni-audio__spectrogram { min-height: 0; }
.omni-audio__spectrogram--active { min-height: 200px; }

/* Keep the WaveSurfer playhead (cursor + played-region overlay) pinned to the
   waveform strip. Some wavesurfer spectrogram builds render the spectrogram
   inside the main wrapper instead of our dedicated container; without this the
   full-height playhead sweeps down across the spectrogram ("progress bar"
   running along the bottom) rather than staying with the waveform at the top. */
.omni-audio__waveform ::part(cursor),
.omni-audio__waveform ::part(progress) { height: 128px !important; }

.omni-audio__status { color: var(--omni-muted, #9d9d9d); font-size: 12px; min-height: 16px; }

.omni-audio__loading { display: flex; justify-content: center; align-items: center; min-height: 120px; color: var(--omni-muted, #9d9d9d); }

.omni-audio__warning {
    padding: 10px 12px; border: 1px solid #b98b2f; border-radius: 7px;
    background: #3b2d10; color: #ffd98a; white-space: pre-wrap;
}
.omni-audio__warning[hidden] { display: none; }
`;
