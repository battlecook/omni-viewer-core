// DOM-free reading state for the EPUB viewer: which spine document is open,
// the text scale, and which side panels are shown. Kept apart from the
// renderer so navigation rules can be verified without a DOM (DESIGN.md §3-②).

import type { EpubSpineItem } from '../../parsers/epub/index.js';

export const EPUB_MIN_FONT_SCALE = 70;
export const EPUB_MAX_FONT_SCALE = 200;
export const EPUB_FONT_SCALE_STEP = 10;
export const EPUB_DEFAULT_FONT_SCALE = 100;

export type EpubPanel = 'toc' | 'info' | 'none';

export interface EpubViewState {
    /** Spine index of the open document. */
    index: number;
    /** Fragment to reveal after the document renders; empty for the top. */
    fragment: string;
    /** Percent of the default reading size. */
    fontScale: number;
    panel: EpubPanel;
}

export type EpubAction =
    | { type: 'next' }
    | { type: 'previous' }
    | { type: 'go'; index: number; fragment?: string }
    | { type: 'font'; delta: number }
    | { type: 'font-reset' }
    | { type: 'panel'; panel: EpubPanel }
    | { type: 'toggle-panel'; panel: Exclude<EpubPanel, 'none'> };

export interface EpubController {
    readonly state: EpubViewState;
    /** Applies an action; returns true when the state changed. */
    dispatch(action: EpubAction): boolean;
    /** Spine index next/previous would open, or -1 at either end. */
    neighbor(direction: 1 | -1): number;
    /** 1-based position among linear documents, and their count. */
    progress(): { position: number; total: number };
}

/**
 * Next/previous walk the linear spine (`linear="no"` documents — covers, pop-up
 * notes — are reached only through links or the contents). Opening a
 * non-linear document by link and pressing next continues from its spine
 * position, as reading systems do.
 */
export function createEpubController(
    spine: readonly Pick<EpubSpineItem, 'linear'>[],
    initial: Partial<EpubViewState> = {}
): EpubController {
    const linear = spine.map((item, index) => (item.linear ? index : -1)).filter(index => index >= 0);
    // A spine that marks everything non-linear still has to be readable.
    const order = linear.length > 0 ? linear : spine.map((_, index) => index);
    // A non-finite index (a host restoring a missing saved position) means "the start".
    const clampIndex = (index: number): number => Number.isFinite(index)
        ? Math.max(0, Math.min(spine.length - 1, Math.trunc(index)))
        : order[0] ?? 0;
    const clampScale = (scale: number): number =>
        Math.max(EPUB_MIN_FONT_SCALE, Math.min(EPUB_MAX_FONT_SCALE, Math.round(scale / EPUB_FONT_SCALE_STEP) * EPUB_FONT_SCALE_STEP));

    let state: EpubViewState = {
        index: clampIndex(initial.index ?? order[0] ?? 0),
        fragment: initial.fragment ?? '',
        fontScale: clampScale(initial.fontScale ?? EPUB_DEFAULT_FONT_SCALE),
        panel: initial.panel ?? 'toc'
    };

    const neighbor = (direction: 1 | -1): number => {
        if (direction === 1) return order.find(index => index > state.index) ?? -1;
        for (let i = order.length - 1; i >= 0; i--) if (order[i]! < state.index) return order[i]!;
        return -1;
    };

    const reduce = (action: EpubAction): EpubViewState => {
        switch (action.type) {
            case 'next':
            case 'previous': {
                const target = neighbor(action.type === 'next' ? 1 : -1);
                return target < 0 ? state : { ...state, index: target, fragment: '' };
            }
            case 'go': {
                if (spine.length === 0) return state;
                return { ...state, index: clampIndex(action.index), fragment: action.fragment ?? '' };
            }
            case 'font':
                return { ...state, fontScale: clampScale(state.fontScale + action.delta) };
            case 'font-reset':
                return { ...state, fontScale: EPUB_DEFAULT_FONT_SCALE };
            case 'panel':
                return { ...state, panel: action.panel };
            case 'toggle-panel':
                return { ...state, panel: state.panel === action.panel ? 'none' : action.panel };
        }
    };

    return {
        get state() {
            return state;
        },
        dispatch(action) {
            const next = reduce(action);
            // `go` to the open document with a new fragment still has to scroll.
            const changed = next !== state && (
                next.index !== state.index || next.fragment !== state.fragment || next.fontScale !== state.fontScale ||
                next.panel !== state.panel || action.type === 'go'
            );
            state = next;
            return changed;
        },
        neighbor,
        progress() {
            const at = order.indexOf(state.index);
            if (at >= 0) return { position: at + 1, total: order.length };
            // A non-linear document sits between linear neighbors; report the one before it.
            const before = order.filter(index => index < state.index).length;
            return { position: Math.max(1, before), total: order.length };
        }
    };
}
