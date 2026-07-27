/**
 * Shared link hardening for in-document fragment anchors (`<a href="#name">`).
 *
 * Renderers emit intra-document references as fragments: docx-preview turns Word
 * bookmarks into `<span id="name">` and table-of-contents entries, cross-references
 * and footnote back-links into `<a href="#name">`. Viewers strip `href` when they
 * harden the DOM, so the browser's default fragment navigation is gone — and it
 * would not work anyway once the viewer lives in a shadow root, where a
 * document-level fragment lookup cannot see the target.
 */

/** An anchor's `href`, classified as far as link hardening is concerned. */
export type AnchorTarget =
    | { kind: 'fragment'; name: string }
    | { kind: 'absolute'; url: URL }
    | { kind: 'unsupported' };

/**
 * Splits fragment references from everything else. A URL that merely *carries* a
 * fragment (`https://example.com/x#frag`) is an external link, not an in-document
 * one, and stays on the host navigation path.
 */
export function classifyAnchorTarget(href: string): AnchorTarget {
    if (href.startsWith('#')) {
        const name = href.slice(1);
        return name ? { kind: 'fragment', name } : { kind: 'unsupported' };
    }
    try {
        return { kind: 'absolute', url: new URL(href) };
    } catch {
        return { kind: 'unsupported' };
    }
}

/**
 * Finds the element a fragment points at, without leaving `scope`.
 *
 * `getElementById` is used rather than a selector because bookmark names are not
 * CSS identifiers — Word emits names that start with a digit, contain `_`, or are
 * non-ASCII — and `CSS.escape` is absent from some hosts and test environments.
 * The lookup is confined to `scope` on purpose: under `styleIsolation: 'scoped'`
 * the root node is the host `document`, where an unrelated page element may share
 * the id. Duplicate ids resolve to the first match in document order.
 */
export function findFragmentTarget(scope: HTMLElement, name: string): HTMLElement | null {
    const root = scope.getRootNode() as Partial<Document>;
    for (const candidate of fragmentCandidates(name)) {
        const byId = root.getElementById?.(candidate) ?? null;
        if (byId && scope.contains(byId)) return byId as HTMLElement;
        // Either the root node has no match, or the match sits outside the viewer;
        // a duplicate may still exist inside it.
        const scoped = [...scope.querySelectorAll<HTMLElement>('[id]')]
            .find((node) => node.id === candidate);
        if (scoped) return scoped;
    }
    return null;
}

/** Raw name first, then percent-decoded, since renderers differ on encoding. */
function fragmentCandidates(name: string): string[] {
    try {
        const decoded = decodeURIComponent(name);
        return decoded === name ? [name] : [name, decoded];
    } catch {
        // Malformed escape sequence: the raw name is all we have.
        return [name];
    }
}

/**
 * Brings a fragment target into view and moves focus to it.
 *
 * The viewer's own scrollport is adjusted instead of calling `scrollIntoView`,
 * which also scrolls every ancestor scrollport and would drag the host page
 * around when the viewer is embedded in one.
 */
export function revealFragmentTarget(target: HTMLElement, viewport: HTMLElement | null): void {
    if (viewport) {
        viewport.scrollTop +=
            target.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    } else {
        target.scrollIntoView?.({ block: 'start' });
    }
    // Bookmark markers are empty spans, so they need to be made focusable first.
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
}

/**
 * Wires `anchor` to scroll to its in-document target, registering the teardown on
 * `disposers`. Returns `false` when nothing matches the fragment — a broken
 * cross-reference, which callers surface the same way they surface a blocked link.
 */
export function bindFragmentAnchor(
    anchor: HTMLElement,
    name: string,
    scope: HTMLElement,
    viewport: HTMLElement | null,
    disposers: Array<() => void>
): boolean {
    if (!findFragmentTarget(scope, name)) return false;
    anchor.setAttribute('role', 'link');
    anchor.tabIndex = 0;
    const activate = (event: Event): void => {
        event.preventDefault();
        // Resolved on activation rather than up front: viewers prune content after
        // hardening (page limits, re-renders), so the target may be gone by now.
        const target = findFragmentTarget(scope, name);
        if (target) revealFragmentTarget(target, viewport);
    };
    const onKeyDown = (event: Event): void => {
        const { key } = event as KeyboardEvent;
        if (key === 'Enter' || key === ' ' || key === 'Spacebar') activate(event);
    };
    anchor.addEventListener('click', activate);
    anchor.addEventListener('keydown', onKeyDown);
    disposers.push(() => {
        anchor.removeEventListener('click', activate);
        anchor.removeEventListener('keydown', onKeyDown);
    });
    return true;
}
