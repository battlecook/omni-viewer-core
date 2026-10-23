// Turns one EPUB content document into sanitized nodes ready for the reading
// pane (ADR 25 security boundary).
//
// Every step before insertion happens in an inert document (no browsing
// context), so an `<img src>` in a hostile chapter cannot fetch anything while
// it is being parsed, sanitized, or rewritten. References are then pulled out
// of the markup into data attributes — container images become blob URLs
// later, links route through the viewer — and nothing remote survives:
//
//   - publisher CSS (`<link>`, `<style>`, `style=""`) is dropped; the viewer's
//     own reading typography applies instead (docs/viewers/epub.md E4);
//   - scripts, forms, embedded frames and media are dropped by the profile;
//   - remote images and SVG references are removed and counted as blocked.

import { asciiLower } from '../../parsers/csv/index.js';
import { isExternalHref, resolveEpubHref, type EpubContentKind } from '../../parsers/epub/index.js';
import type { DomPurify } from '../math.js';

export const EPUB_SANITIZE_PROFILE = Object.freeze({
    USE_PROFILES: Object.freeze({ html: true, svg: true, mathMl: true }),
    FORBID_TAGS: Object.freeze([
        'style', 'script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input',
        'button', 'textarea', 'select', 'link', 'meta', 'base', 'audio', 'video', 'source', 'track', 'picture',
        'feImage', 'foreignObject', 'mglyph', 'template',
        // SMIL targets `href="#id"` anywhere in the document — in scoped mode
        // that includes host SVG.
        'animate', 'animateMotion', 'animateTransform', 'animateColor', 'set', 'mpath'
    ]),
    FORBID_ATTR: Object.freeze([
        'style', 'srcset', 'srcdoc', 'formaction', 'action', 'poster', 'background', 'ping', 'target',
        // The viewer's own markers must only ever be written by rewriteReferences.
        'data-omni-epub-src', 'data-omni-epub-href', 'data-omni-epub-blocked', 'data-omni-epub-anchor',
        // IDREF attributes that act on another element: in scoped mode the book
        // shares the host document, so `<label for>` could click a host button.
        'for', 'form', 'popovertarget', 'popovertargetaction', 'commandfor', 'command', 'invoketarget', 'invokeaction'
    ]),
    ALLOW_UNKNOWN_PROTOCOLS: false
});

/** Attribute holding a container path the viewer turns into a blob URL. */
export const RESOURCE_ATTRIBUTE = 'data-omni-epub-src';
/** Attribute holding a link the viewer routes (fragment, internal, or external). */
export const LINK_ATTRIBUTE = 'data-omni-epub-href';
/** Class of the viewer-owned wrapper around a prepared chapter (styled `display: contents`). */
export const CHAPTER_WRAPPER_CLASS = 'omni-epub__chapter';

/** An element's original (book) id; its `id` itself is namespaced per render (see confineIdReferences). */
export const ANCHOR_ATTRIBUTE = 'data-omni-epub-anchor';
/** Carries an element id past the sanitizer's DOM-clobbering guard (see prepareChapter). */
const ID_ATTRIBUTE = 'data-omni-epub-id';
/** Elements whose name (and, for img/object, id) become `document` named properties. */
// fieldset/output are form-listed: in scoped mode inside a host <form>, a name
// would join (and shadow) the host's own named controls.
const CLOBBERING_ELEMENTS = new Set(['img', 'form', 'iframe', 'embed', 'object', 'fieldset', 'output']);
/** Marks a reference that was removed because it pointed outside the container. */
export const BLOCKED_ATTRIBUTE = 'data-omni-epub-blocked';

/**
 * Elements a chapter may hold before it is refused instead of rendered: past
 * this, sanitizing and layout block the main thread for seconds (a dense
 * chapter compresses to a few KB, so the byte cap alone does not bound it).
 */
export const EPUB_MAX_CHAPTER_ELEMENTS = 100_000;

/**
 * Upper bound on the elements `text` would parse into: every element begins
 * with `<` + a letter. Linear, stops at `limit + 1`, and runs before any parse
 * so an over-dense document costs no DOMParser time at all.
 */
export function countTagStarts(text: string, limit: number): number {
    let count = 0;
    for (let at = text.indexOf('<'); at >= 0; at = text.indexOf('<', at + 1)) {
        const code = text.charCodeAt(at + 1);
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
            if (++count > limit) return count;
        }
    }
    return count;
}

/** Formatting elements the HTML parser reconstructs at each new block when left open. */
const FORMATTING_TAGS = new Set(['a', 'b', 'big', 'code', 'em', 'font', 'i', 'nobr', 's', 'small', 'strike', 'strong', 'tt', 'u']);
/** Start tags that close an open `<p>` and do not themselves reconstruct (the HTML spec's block group). */
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset',
    'figcaption', 'figure', 'footer', 'header', 'hgroup', 'main', 'menu', 'nav', 'ol', 'p', 'search', 'section', 'summary', 'ul',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'listing', 'form', 'li', 'dd', 'dt', 'plaintext', 'table', 'hr', 'xmp']);

function isTagNameChar(code: number): boolean {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45 || code === 58 || code === 95;
}

/** Start tags that create implied ancestors (tbody, tr, colgroup) in the HTML parser. */
const TABLE_STRUCTURE_TAGS = new Set(['caption', 'colgroup', 'col', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th']);
/**
 * Start tags that can neither pop the open-element stack nor run the adoption
 * agency: everything else may implicitly close something (a `<p>`, a list
 * item, an `<option>`, a table, a misnested `<a>`/`<nobr>` …).
 */
const NON_POPPING_START_TAGS = new Set(['b', 'big', 'code', 'em', 'font', 'i', 's', 'small', 'strike', 'strong', 'tt', 'u',
    'span', 'abbr', 'acronym', 'bdi', 'bdo', 'cite', 'data', 'dfn', 'kbd', 'mark', 'q', 'samp', 'sub', 'sup', 'time', 'var',
    'img', 'br', 'wbr', 'label']);
/**
 * Start tags after which the parser may *ignore* a formatting end tag, leaving
 * the element active: markers (cells, caption, applet, object, marquee,
 * template), scope boundaries (table, MathML text-integration points, SVG
 * HTML-integration points), and select mode.
 */
const MARKER_SCOPE_TAGS = new Set(['td', 'th', 'caption', 'applet', 'object', 'marquee', 'template', 'table', 'select',
    'mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml', 'foreignobject', 'desc', 'title']);
/** Upper bound on the clones one adoption-agency run creates (8 outer × (1 + 3 inner) iterations). */
const ADOPTION_CLONES = 32;

/**
 * Tree-builder steps that walk the stack of open elements (an end tag looking
 * for its element, a block start tag checking for an open `<p>`, the adoption
 * agency, the Noah's Ark scan) cost O(depth) each, so a deep stack makes even a
 * small document quadratic. A chapter is refused once the summed bound on that
 * work passes this budget (a few tenths of a second of Chrome parse time);
 * ordinary books use well under a tenth of it.
 */
export const EPUB_MAX_PARSE_WORK = 100_000_000;

/** The HTML spec's "special" category, plus svg/math (whose content the bound below does not model). */
const SPECIAL_TAGS = new Set(['address', 'applet', 'area', 'article', 'aside', 'base', 'basefont', 'bgsound', 'blockquote', 'body',
    'br', 'button', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'embed', 'fieldset',
    'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup',
    'hr', 'html', 'iframe', 'img', 'input', 'keygen', 'li', 'link', 'listing', 'main', 'marquee', 'menu', 'meta', 'nav', 'noembed',
    'noframes', 'noscript', 'object', 'ol', 'p', 'param', 'plaintext', 'pre', 'script', 'search', 'section', 'select', 'source',
    'style', 'summary', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul', 'wbr',
    'xmp', 'mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml', 'foreignobject', 'desc', 'svg', 'math']);
/** Special only as MathML/SVG elements. */
const FOREIGN_SPECIAL_TAGS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml', 'foreignobject', 'desc', 'svg', 'math']);
/** Boundaries of "has an element in scope", plus svg/math and select (an older parser's select mode ignores end tags). */
const SCOPE_TAGS = new Set(['applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template', 'mi', 'mo', 'mn',
    'ms', 'mtext', 'annotation-xml', 'foreignobject', 'desc', 'title', 'svg', 'math', 'select']);
/** Elements that keep a table-structure tag from acting on the table below them. */
const TABLE_BLOCKERS = new Set(['table', 'template', 'svg', 'math', 'select']);
const VOID_TAGS = new Set(['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'image', 'img', 'input',
    'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const TABLE_SECTIONS = new Set(['tbody', 'thead', 'tfoot']);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const TABLE_END_TAGS = new Set(['caption', 'colgroup', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th']);

/** Start tags that close an open `<p>` (BLOCK_TAGS less plaintext/xmp/listing duplicates, plus no-quirks `<table>`). */
const CLOSES_P_TAGS = new Set([...BLOCK_TAGS, 'table', 'form']);
/** Elements "generate implied end tags" pops. */
const IMPLIED_END_TAGS = ['dd', 'dt', 'li', 'optgroup', 'option', 'p', 'rb', 'rp', 'rt', 'rtc'];
/** HTML start tags that end foreign content (the spec's breakout list; `font` only with attributes). */
const BREAKOUT_TAGS = new Set(['b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed', 'h1',
    'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 's',
    'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var', 'font']);
/** Start tags a pre-2025 parser's select mode still acts on; it ignores every other one. */
const SELECT_MODE_TAGS = new Set(['option', 'optgroup', 'hr', 'select', 'input', 'keygen', 'textarea', 'script', 'template']);

/**
 * Upper bound on the depth of the HTML parser's stack of open elements.
 *
 * Every non-void start tag is pushed (with the tbody/tr a cell or row implies),
 * so a tag the parser ignores only makes the bound larger. For every token the
 * bound computes a *floor*: the deepest entry any parser state could pop for
 * it (an end tag's same-name entries, the `<p>` a block tag closes, the cloned
 * formatting elements an adoption may reach, foreign content a breakout tag
 * ends …). Where the bound can follow the parser exactly — the target is the
 * nearest entry of its name, certainly still open, and nothing that would stop
 * the parser lies above it — it pops the same entries. Otherwise every entry
 * from the floor up is marked *suspect*: the parser may have popped it, so it
 * is never again used as a target (it stays counted, which only overestimates).
 * Entries pushed by a tag that may be text or that the parser may ignore are
 * likewise never targets. Formatting clones the parser reconstructs are not
 * pushed; the caller adds the active-list bound instead.
 */
class OpenElementBound {
    private readonly names: string[] = [];
    private readonly doubtful: boolean[] = [];
    /** Per formatting entry, its name's `closedBy` count when it was pushed. */
    private readonly closedAtPush: number[] = [];
    private readonly byName = new Map<string, number[]>();
    private readonly closedBy = new Map<string, number>();
    private readonly special: number[] = [];
    /** Special elements other than address, div and p (what stops an implied `</li>`). */
    private readonly specialNotAdp: number[] = [];
    private readonly scope: number[] = [];
    private readonly listScope: number[] = [];
    private readonly buttonScope: number[] = [];
    private readonly tableBlockers: number[] = [];
    /** Disjoint, ascending [low, high] index ranges of suspect entries. */
    private readonly suspectLow: number[] = [];
    private readonly suspectHigh: number[] = [];
    /** Lowest depth at which reconstructed or adopted formatting clones may sit. */
    private cloneFloor = Infinity;
    /** The lowest index this token's unmodeled effects could pop. */
    private floor = Infinity;
    /** This token's table-structure handling was followed exactly. */
    private tableExact = false;

    get depth(): number {
        return this.names.length;
    }

    /**
     * The parser rebuilt formatting clones on top of the stack. Open clones
     * number at most one per active-list entry (`listBound`), plus those the
     * Noah's Ark clause dropped from the list while they stayed open. They are
     * pushed as never-target entries, up to that bound, as early as possible —
     * so however the parser places its clones, at least as many entries sit at
     * or below them here.
     */
    reconstructed(listBound: number): void {
        this.cloneFloor = Math.min(this.cloneFloor, this.names.length);
        for (let live = this.clones(); live < listBound + this.orphans; live++) this.push('#clone', true);
    }

    /** A formatting push may have dropped an open clone from the active list (it stays open). */
    arkDropped(): void {
        this.orphans = Math.min(this.orphans + 1, this.clones());
    }

    /** Open clones dropped from the active list; never more than the clone entries still here. */
    private orphans = 0;

    private clones(): number {
        return this.byName.get('#clone')?.length ?? 0;
    }

    /** True when this start tag's adoption (an open `<a>`/`<nobr>`) was followed exactly. */
    adopted = false;

    /** `rebuild` runs the reconstruction this tag triggers, between its own closes and its push. */
    start(name: string, clean: boolean, selfClosing: boolean, rebuild?: () => void): void {
        this.floor = Infinity;
        this.adopted = false;
        this.tableExact = false;
        if (this.has('svg') || this.has('math')) {
            if (BREAKOUT_TAGS.has(name)) this.lower(Math.min(this.lowest('svg'), this.lowest('math')));
        }
        if (clean) this.modelStart(name);
        else this.unmodeledStart(name);
        this.settle();
        rebuild?.();
        if (VOID_TAGS.has(name) || name === 'html' || name === 'head' || name === 'body') return;
        // The parser may ignore the tag (or close it on its own): a self-closing tag in foreign content, a
        // form, a select inside a select, anything in an older select mode
        // or after a frameset. Such an entry is counted but never a target.
        // A colgroup, and a noscript in the head (DOMParser runs without scripting),
        // is popped by whatever tag follows it, so the parser may already have
        // closed it when its end tag comes.
        const ignorable = !clean || name === 'form' || name === 'colgroup' || name === 'noscript' || (selfClosing && (this.has('svg') || this.has('math') || name === 'svg' || name === 'math')) ||
            (this.has('select') && !SELECT_MODE_TAGS.has(name)) || (name === 'select' && this.has('select')) || this.has('frameset');
        // Outside a table followed exactly, a table-structure tag may be ignored.
        const table = TABLE_STRUCTURE_TAGS.has(name);
        if (name === 'td' || name === 'th' || name === 'tr') {
            const top = this.names[this.names.length - 1] ?? '';
            if (name !== 'tr' && top !== 'tr') {
                if (!TABLE_SECTIONS.has(top)) this.push('tbody', ignorable || !this.tableExact);
                this.push('tr', ignorable || !this.tableExact);
            } else if (name === 'tr' && !TABLE_SECTIONS.has(top)) this.push('tbody', ignorable || !this.tableExact);
        }
        this.push(name, ignorable || (table && !this.tableExact));
    }

    end(name: string, clean: boolean): void {
        this.floor = Infinity;
        if ((name === 'p' || name === 'br') && (this.has('svg') || this.has('math'))) this.lower(Math.min(this.lowest('svg'), this.lowest('math')));
        if (name === 'html' || name === 'body' || name === 'br' || name === 'form') {
            this.settle();
            return;
        }
        const heading = HEADING_TAGS.has(name);
        // `</h2>` closes the nearest heading of any level, not the nearest h2.
        const lowest = heading ? Math.min(...[...HEADING_TAGS].map(h => this.lowest(h))) : this.lowest(name);
        const formatting = FORMATTING_TAGS.has(name);
        let modeled = false;
        if (clean && formatting) {
            modeled = this.adoptWithoutFurthestBlock(name);
        } else if (clean) {
            const target = heading ? this.nearest(...HEADING_TAGS) : this.nearest(name);
            if (target >= 0) {
                if (name === 'table') modeled = last(this.tableBlockers) === target;
                else if (TABLE_END_TAGS.has(name)) modeled = this.inTable(target);
                else if (SPECIAL_TAGS.has(name)) {
                    // A MathML/SVG name may be an ordinary HTML element (`<mi>` outside
                    // <math>), which a special element above keeps open.
                    modeled = (!FOREIGN_SPECIAL_TAGS.has(name) || last(this.special) <= target) && last(this.scope) <= target &&
                        (name !== 'li' || last(this.listScope) <= target) && (name !== 'p' || last(this.buttonScope) <= target);
                } else modeled = last(this.special) < target;
                if (modeled) this.popTo(target, false);
            }
        }
        if (!modeled) {
            this.lower(lowest);
            if (formatting) {
                // Only an element of this name closed by another tag leaves an
                // active-list entry that reconstruction can clone.
                if (this.closedBy.has(name)) this.lower(this.cloneFloor);
                // The adoption agency rebuilds clones of this name as low as it pops.
                this.cloneFloor = Math.min(this.cloneFloor, this.floor);
                this.closedBy.set(name, (this.closedBy.get(name) ?? 0) + 1);
            }
            if (name === 'optgroup') this.lower(this.lowest('option'));
            if (name === 'tr' || name === 'tbody' || name === 'thead' || name === 'tfoot' || name === 'table' || name === 'caption') {
                // "Close the cell" first.
                this.lower(Math.min(this.lowest('td'), this.lowest('th')));
            }
        }
        this.settle();
    }

    /**
     * The adoption agency for `name` when the bound can follow it exactly: its
     * element is the nearest entry of that name, certainly open, still the
     * newest active one (no element of the name closed by another tag since),
     * in scope, and with no special element above it — so there is no
     * furthest block and the parser pops down to it.
     */
    private adoptWithoutFurthestBlock(name: string): boolean {
        const target = this.nearestAny(name);
        if (target < 0 || !this.valid(target) || this.closedAtPush[target] !== (this.closedBy.get(name) ?? 0)) return false;
        if (last(this.special) > target || last(this.scope) > target) return false;
        this.popTo(target, true);
        return true;
    }

    /** A start tag known to be markup: apply the closes it certainly makes, flag the rest. */
    private modelStart(name: string): void {
        if (name === 'li' || name === 'dd' || name === 'dt') {
            const target = name === 'li' ? this.nearest('li') : this.nearest('dd', 'dt');
            const low = name === 'li' ? this.lowest('li') : Math.min(this.lowest('dd'), this.lowest('dt'));
            if (target >= 0 && last(this.specialNotAdp) <= target) this.popTo(target, false);
            else this.lower(low);
        }
        if (CLOSES_P_TAGS.has(name) && name !== 'table' && name !== 'form') {
            const target = this.nearest('p');
            if (target >= 0 && last(this.scope) < target && last(this.buttonScope) < target) this.popTo(target, false);
            else this.lower(this.lowest('p'));
        }
        if (TABLE_STRUCTURE_TAGS.has(name) || name === 'table') this.modelTable(name);
        this.unmodeledStart(name, true);
    }

    /** Floors for a start tag's closes that are not modeled (all of them for a tag that may be text). */
    private unmodeledStart(name: string, modeledDone = false): void {
        if (!modeledDone) {
            if (CLOSES_P_TAGS.has(name)) this.lower(this.lowest('p'));
            if (name === 'li') this.lower(this.lowest('li'));
            if (name === 'dd' || name === 'dt') this.lower(Math.min(this.lowest('dd'), this.lowest('dt')));
            if (TABLE_STRUCTURE_TAGS.has(name) || name === 'table') this.lower(this.tableFloor(name));
        } else if (name === 'table' || name === 'form') this.lower(this.lowest('p')); // no-quirks <table>; <form> unless one is open
        if (HEADING_TAGS.has(name)) this.lower(Math.min(...[...HEADING_TAGS].map(h => this.lowest(h))));
        if (name === 'button') this.lower(this.lowest('button'));
        if ((name === 'a' || name === 'nobr') && modeledDone && this.adoptWithoutFurthestBlock(name)) this.adopted = true;
        else if (name === 'a' || name === 'nobr') {
            this.lower(Math.min(this.lowest(name), this.closedBy.has(name) ? this.cloneFloor : Infinity));
            if (this.floor < Infinity) {
                this.cloneFloor = Math.min(this.cloneFloor, this.floor);
                this.closedBy.set(name, (this.closedBy.get(name) ?? 0) + 1);
            }
        }
        if (name === 'option' || name === 'optgroup' || name === 'hr') this.lower(this.lowest('option'));
        if (name === 'optgroup' || name === 'hr') this.lower(this.lowest('optgroup'));
        if (name === 'rb' || name === 'rp' || name === 'rt' || name === 'rtc') {
            this.lower(Math.min(...IMPLIED_END_TAGS.map(implied => this.lowest(implied))));
        }
        if (name === 'select' || name === 'input' || name === 'keygen' || name === 'textarea') this.lower(this.lowest('select'));
        if (this.has('select') && (TABLE_STRUCTURE_TAGS.has(name) || name === 'table')) this.lower(this.lowest('select'));
        if (name === 'frameset') this.lower(0);
    }

    /**
     * A table-structure start tag inside a table: close an open cell or caption,
     * then clear back to the table, section or row context — exactly, when every
     * entry involved is certainly open.
     */
    private modelTable(name: string): void {
        const table = this.nearest('table');
        if (table < 0 || last(this.tableBlockers) !== table) {
            this.lower(this.tableFloor(name));
            return;
        }
        const cell = Math.max(this.lowestAbove('td', table), this.lowestAbove('th', table));
        const caption = this.lowestAbove('caption', table);
        if (name === 'table' && (cell > table || caption > table)) return; // in a cell or caption: a nested table
        for (const part of ['td', 'th', 'caption', 'tr', 'tbody', 'thead', 'tfoot']) {
            const index = this.nearestAny(part);
            if (index > table && !this.valid(index)) {
                this.lower(table + 1);
                return;
            }
        }
        this.tableExact = true;
        if (cell > table) this.popTo(Math.min(cell, caption > table ? caption : cell), false);
        if (caption > table) this.popTo(caption, false);
        if (name === 'table') {
            this.popTo(table, false);
            return;
        }
        let context = table;
        if (name === 'td' || name === 'th' || name === 'tr') {
            const section = Math.max(this.nearestAny('tbody'), this.nearestAny('thead'), this.nearestAny('tfoot'));
            if (section > context) context = section;
            const row = this.nearestAny('tr');
            if (row > context) context = name === 'tr' ? row - 1 : row;
        }
        this.popTo(context + 1, false);
    }

    /** Floor for a table-structure tag outside a modeled table: it may clear back to any table or template. */
    private tableFloor(name: string): number {
        const table = this.lowest('table');
        const template = this.lowest('template');
        return Math.min(table < 0 ? Infinity : name === 'table' ? table : table + 1, template < 0 ? Infinity : template + 1);
    }

    private lower(index: number): void {
        if (index >= 0 && index < this.floor) this.floor = index;
    }

    /** Marks entries from this token's floor up as suspect. */
    private settle(): void {
        const low = this.floor;
        const high = this.names.length - 1;
        this.floor = Infinity;
        if (low > high) return;
        while (this.suspectLow.length > 0 && last(this.suspectLow) >= low) {
            this.suspectLow.pop();
            this.suspectHigh.pop();
        }
        if (this.suspectHigh.length > 0 && last(this.suspectHigh) >= low - 1) this.suspectHigh[this.suspectHigh.length - 1] = high;
        else {
            this.suspectLow.push(low);
            this.suspectHigh.push(high);
        }
    }

    private suspect(index: number): boolean {
        let lo = 0;
        let hi = this.suspectLow.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.suspectHigh[mid]! < index) lo = mid + 1;
            else if (this.suspectLow[mid]! > index) hi = mid - 1;
            else return true;
        }
        return false;
    }

    private valid(index: number): boolean {
        return !this.doubtful[index] && !this.suspect(index);
    }

    private has(name: string): boolean {
        return (this.byName.get(name)?.length ?? 0) > 0;
    }

    private lowest(name: string): number {
        const same = this.byName.get(name);
        return same && same.length > 0 ? same[0]! : Infinity;
    }

    private lowestAbove(name: string, floor: number): number {
        const index = this.nearestAny(name);
        return index > floor ? index : -1;
    }

    private nearestAny(name: string): number {
        return last(this.byName.get(name) ?? []);
    }

    /** The nearest entry with one of `names`, when it is certainly still open; -1 otherwise. */
    private nearest(...names: string[]): number {
        let index = -1;
        for (const name of names) index = Math.max(index, this.nearestAny(name));
        return index >= 0 && this.valid(index) ? index : -1;
    }

    /** `index` sits in the nearest table, with nothing above that table to stop table-structure tags. */
    private inTable(index: number): boolean {
        const table = this.nearest('table');
        return table >= 0 && table < index && last(this.tableBlockers) === table;
    }

    private push(name: string, doubtful: boolean): void {
        const index = this.names.length;
        this.names.push(name);
        this.doubtful.push(doubtful);
        this.closedAtPush.push(this.closedBy.get(name) ?? 0);
        let same = this.byName.get(name);
        if (!same) this.byName.set(name, same = []);
        same.push(index);
        if (SPECIAL_TAGS.has(name)) {
            this.special.push(index);
            if (name !== 'address' && name !== 'div' && name !== 'p') this.specialNotAdp.push(index);
        }
        if (SCOPE_TAGS.has(name)) this.scope.push(index);
        if (name === 'ol' || name === 'ul') this.listScope.push(index);
        if (name === 'button') this.buttonScope.push(index);
        if (TABLE_BLOCKERS.has(name)) this.tableBlockers.push(index);
    }

    /** Pops entries down to and including `index`; `ownEnd` marks a formatting element closed by its own end tag. */
    private popTo(index: number, ownEnd: boolean): void {
        if (index < this.cloneFloor) this.cloneFloor = Infinity;
        while (this.names.length > index) {
            const at = this.names.length - 1;
            const name = this.names.pop()!;
            this.doubtful.pop();
            this.closedAtPush.pop();
            this.byName.get(name)!.pop();
            for (const list of [this.special, this.specialNotAdp, this.scope, this.listScope, this.buttonScope, this.tableBlockers]) {
                if (list[list.length - 1] === at) list.pop();
            }
            // Closed by another tag, its active-list entry stays behind.
            if (FORMATTING_TAGS.has(name) && !ownEnd) this.closedBy.set(name, (this.closedBy.get(name) ?? 0) + 1);
        }
        while (this.suspectLow.length > 0 && last(this.suspectLow) >= index) {
            this.suspectLow.pop();
            this.suspectHigh.pop();
        }
        if (this.suspectHigh.length > 0 && last(this.suspectHigh) >= index) this.suspectHigh[this.suspectHigh.length - 1] = index - 1;
        this.orphans = Math.min(this.orphans, this.clones());
    }
}

function last(list: readonly number[]): number {
    return list.length > 0 ? list[list.length - 1]! : -1;
}

/**
 * Index where a script body starting at `from` ends (its `</script`), following
 * the tokenizer's escaped and double-escaped states; text end otherwise.
 */
function scriptEnd(text: string, from: number): number {
    const DATA = 0, ESCAPED = 1, DOUBLE = 2;
    let state = DATA;
    const delimited = (at: number): boolean => {
        const code = text.charCodeAt(at);
        return code === 32 || code === 9 || code === 10 || code === 12 || code === 13 || code === 47 || code === 62;
    };
    const scriptAt = (at: number): boolean => asciiLower(text.slice(at, at + 6)) === 'script' && delimited(at + 6);
    for (let at = from; at < text.length; at++) {
        const code = text.charCodeAt(at);
        if (code === 45 /* - */ && state !== DATA && text.startsWith('-->', at)) state = DATA;
        else if (code !== 60 /* < */) continue;
        else if (text.charCodeAt(at + 1) === 47 && scriptAt(at + 2)) {
            if (state === DOUBLE) state = ESCAPED;
            else return at;
        } else if (state === DATA && text.startsWith('<!--', at)) {
            state = ESCAPED;
            at += 1; // `<!-->` closes again at its `-->`
        } else if (state === ESCAPED && scriptAt(at + 1)) state = DOUBLE;
    }
    return text.length;
}

/**
 * Upper bound on the elements the HTML parser builds from `text` (which
 * htmlSafe has already normalized), sound by construction rather than by
 * imitating the tree builder:
 *
 * - one element per start tag, plus the ancestors a table-structure tag implies
 *   and the element a stray `</p>` or `</br>` creates;
 * - the parser reconstructs active formatting elements at text and at non-block
 *   start tags. The active list is over-approximated by the formatting start
 *   tags not yet matched by a same-name end tag, and its whole size is charged
 *   at the first reconstruction point after any token that could have popped
 *   the stack (any end tag, any start tag outside NON_POPPING_START_TAGS).
 *   Between such tokens a reconstruction rebuilds nothing new;
 * - a formatting end tag that is misnested around a possible "furthest block"
 *   (any popping start tag since its own start) is charged the adoption
 *   agency's clone bound.
 *
 * Properly nested markup estimates close to its tag count; a formatting
 * wrapper around many blocks is charged its size once per block. Linear: each
 * tag is scanned only up to the next `<`, per-name state is O(1) per tag, and
 * the scan stops once `limit` is passed.
 */
export function estimateHtmlElements(text: string, limit: number): number {
    let estimate = 3; // html, head, body
    let activeFormatting = 0;
    // Per name, the counters at each still-unmatched start: [popping starts, marker starts].
    const openFormatting = new Map<string, Array<[number, number]>>();
    let poppingStarts = 0;
    let markerStarts = 0;
    let dirty = false;
    // The spec's "Noah's Ark" clause keeps at most three entries with the same
    // name and attributes in the active list, so a reconstruction never rebuilds
    // more than three per distinct start tag. A bare `<i>` is keyed by its name;
    // a tag with anything else between name and `>` counts as distinct.
    const arkCounts = new Map<string, number>();
    let arkBound = 0;
    /** Per name, the formatting starts that may still have an active-list entry. */
    const activeByName = new Map<string, number>();
    const unlist = (name: string): void => {
        activeFormatting--;
        activeByName.set(name, activeByName.get(name)! - 1);
    };
    const reconstruct = (): void => {
        if (!dirty) return;
        estimate += Math.min(activeFormatting, arkBound);
        if (Math.min(activeFormatting, arkBound) > 0) open.reconstructed(Math.min(activeFormatting, arkBound));
        dirty = false;
    };
    const length = text.length;
    /** Index just past the tag's closing `>`, honouring quoted attribute values as the tokenizer does. */
    const isSpace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
    /**
     * Index just past the tag's closing `>`, following the tokenizer's
     * attribute states: a quote opens a value only right after `name=`; an `=`
     * where a name would start is part of that name; `/` re-enters the
     * before-name state.
     */
    const tagEnd = (from: number): number => {
        const BEFORE_NAME = 0, NAME = 1, AFTER_NAME = 2, BEFORE_VALUE = 3, QUOTED = 4, UNQUOTED = 5, AFTER_QUOTED = 6;
        let state = BEFORE_NAME;
        let quote = 0;
        for (let at = from; at < length; at++) {
            const code = text.charCodeAt(at);
            switch (state) {
                case QUOTED:
                    if (code === quote) state = AFTER_QUOTED;
                    break;
                case UNQUOTED:
                    if (code === 62) return at + 1;
                    if (isSpace(code)) state = BEFORE_NAME;
                    break;
                case BEFORE_VALUE:
                    if (code === 62) return at + 1;
                    if (code === 34 || code === 39) { quote = code; state = QUOTED; }
                    else if (!isSpace(code)) state = UNQUOTED;
                    break;
                case NAME:
                    if (code === 62) return at + 1;
                    if (code === 61) state = BEFORE_VALUE;
                    else if (isSpace(code)) state = AFTER_NAME;
                    else if (code === 47) state = BEFORE_NAME;
                    break;
                case AFTER_NAME:
                    if (code === 62) return at + 1;
                    if (code === 61) state = BEFORE_VALUE;
                    else if (code === 47) state = BEFORE_NAME;
                    else if (!isSpace(code)) state = NAME;
                    break;
                default: // BEFORE_NAME, AFTER_QUOTED
                    if (code === 62) return at + 1;
                    if (code !== 47 && !isSpace(code)) state = NAME; // `=` here starts a name
                    else state = BEFORE_NAME;
            }
        }
        return length;
    };
    let pos = 0;
    let textPending = false;
    const open = new OpenElementBound();
    /** Summed bound on the parser's stack walks (see EPUB_MAX_PARSE_WORK), plus the estimator's own lookahead. */
    let work = 0;
    /**
     * Pessimistically, the end of the furthest span that some earlier `<` could
     * have opened as a comment, a tag with quoted values, raw text or CDATA: a
     * `<` before it may be text, one at or after it is certainly markup.
     */
    let ambiguousUntil = 0;
    const findGt = cachedIndexOf(text, '>');
    const findCommentClose = cachedIndexOf(text, '-->');
    const findBangCommentClose = cachedIndexOf(text, '--!>');
    const findCdataClose = cachedIndexOf(text, ']]>');
    const findNameEnd = cachedSearch(text, /[\t\n\f\r />]/g);
    const rawTextEnds = new Map<string, (from: number) => number>();
    let lastTagFrom = -1;
    let lastTagEnd = 0;
    const spanEnd = (found: number, skip: number): number => (found < 0 ? length : found + skip);
    // Until the first <svg>/<math>/<select>/<template>/<frameset> the tokenizer's state is unambiguous: HTML
    // raw-text bodies, comments, bogus comments (CDATA included) and quoted
    // values can be skipped exactly. Once foreign content is possible — or a
    // script body may have entered its escaped states — a raw-text tag, a
    // CDATA section or a quote has two readings, so from there on everything
    // is read pessimistically: every `<` is examined (nothing is skipped), and
    // no end tag closes a formatting element.
    let pessimistic = false;
    while (pos < length) {
        const at = text.indexOf('<', pos);
        if (at < 0) {
            if (pos < length) textPending = true;
            break;
        }
        if (at > pos) textPending = true;
        const next = text.charCodeAt(at + 1);
        if (!pessimistic && text.startsWith('<!--', at)) {
            pos = commentEnd(text, at);
            continue;
        }
        // `<!…>` (CDATA included, outside foreign content) and `<?…>` are bogus comments to the first `>`.
        if (!pessimistic && (next === 33 /* ! */ || next === 63 /* ? */)) {
            const close = text.indexOf('>', at + 2);
            pos = close < 0 ? length : close + 1;
            continue;
        }
        const closing = next === 47;
        const nameStart = closing ? at + 2 : at + 1;
        const first = text.charCodeAt(nameStart);
        const isLetter = (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
        if (closing && !isLetter && !pessimistic) {
            // `</` + non-letter: a bogus comment up to `>` (`</>` is dropped).
            const close = text.indexOf('>', at + 2);
            pos = close < 0 ? length : close + 1;
            continue;
        }
        const clean = !pessimistic || at >= ambiguousUntil;
        if (pessimistic && ambiguousUntil < length && !isLetter) {
            let end = at + 1;
            if (text.startsWith('<!--', at)) {
                // The first `-->` or `--!>` ends it (an earlier `<!-->` only shortens it).
                end = Math.min(spanEnd(findCommentClose(at + 2), 3), spanEnd(findBangCommentClose(at + 2), 4));
            } else if (next === 33 || next === 63 || closing) {
                end = spanEnd(findGt(at + 2), 1);
                if (text.startsWith('<![CDATA[', at)) end = Math.max(end, spanEnd(findCdataClose(at + 9), 3));
            }
            ambiguousUntil = Math.max(ambiguousUntil, end);
        }
        if (!isLetter) {
            // A lone `<` (or, pessimistically, anything that is not a tag) is text.
            textPending = true;
            pos = at + 1;
            continue;
        }
        // Any character token before this tag reconstructs (whitespace included).
        if (textPending) {
            reconstruct();
            textPending = false;
        }
        // The tokenizer's tag name runs to whitespace, `/` or `>`; a name with any
        // other character (`div.`, `p\u00e9`) is an unknown element, which the
        // sets below treat as popping and reconstructing.
        // Pessimistically `pos` advances one `<` at a time, so the name scan is
        // capped there: only its first 64 characters matter.
        let nameEnd = nameStart;
        while (nameEnd < length && (!pessimistic || nameEnd < nameStart + 64)) {
            const code = text.charCodeAt(nameEnd);
            if (isSpace(code) || code === 47 || code === 62) break;
            nameEnd++;
        }
        const name = asciiLower(text.slice(nameStart, Math.min(nameEnd, nameStart + 64)));
        // Pessimistically, the rest of this "tag" may be text holding more tags.
        pos = pessimistic ? at + 1 : tagEnd(nameEnd);
        if (pessimistic && ambiguousUntil < length) {
            // The span this tag would cover if it is one: its quoted values and,
            // for a raw-text element, its body. Tags inside one name run share an end.
            const from = nameEnd < nameStart + 64 ? nameEnd : findNameEnd(nameEnd);
            const tagFrom = from < 0 ? length : from;
            if (tagFrom !== lastTagFrom) {
                lastTagFrom = tagFrom;
                lastTagEnd = tagEnd(tagFrom);
                work += lastTagEnd - tagFrom;
            }
            let end = lastTagEnd;
            if (!closing && name === 'script') {
                const close = scriptEnd(text, end);
                work += close - end;
                end = close;
            } else if (!closing && RAW_TEXT_TAGS.has(name)) {
                let find = rawTextEnds.get(name);
                if (!find) rawTextEnds.set(name, find = cachedRawTextEnd(text, name));
                end = find(end);
            } else if (!closing && name === 'plaintext') end = length;
            ambiguousUntil = Math.max(ambiguousUntil, end);
        }
        // A real parser's walks here are bounded by the stack depth, the
        // formatting clones above the pushed entries, and the implied html/body;
        // the adoption agency repeats its walk up to eight times.
        const walk = 2 * open.depth + Math.min(activeFormatting, arkBound) + 4;
        work += FORMATTING_TAGS.has(name) ? 9 * walk : walk;
        if (work > EPUB_MAX_PARSE_WORK) return Math.max(estimate, limit + 1);
        if (closing) open.end(name, clean);
        if (closing) {
            dirty = true;
            const opened = openFormatting.get(name);
            if (FORMATTING_TAGS.has(name) && opened && opened.length > 0) {
                const [poppedBefore, markersBefore] = opened.pop()!;
                // After a marker or scope boundary opened since (see MARKER_SCOPE_TAGS)
                // the parser may ignore this end tag and the element stays active.
                if (markerStarts === markersBefore && clean) unlist(name);
                if (poppingStarts > poppedBefore) estimate += ADOPTION_CLONES;
            } else if (name === 'p' || name === 'br') estimate++;
        } else {
            const popping = !NON_POPPING_START_TAGS.has(name);
            if (popping) {
                // The tag's own pops (an open `<a>`/`<nobr>` runs the adoption
                // agency, `<button>`/`<option>` close their kind) come before its
                // reconstruction.
                dirty = true;
                poppingStarts++;
                if ((name === 'a' || name === 'nobr') && (openFormatting.get(name)?.length ?? 0) > 0) estimate += ADOPTION_CLONES;
            }
            if (TABLE_STRUCTURE_TAGS.has(name)) estimate += 2;
            const rebuilds = !BLOCK_TAGS.has(name) && !TABLE_STRUCTURE_TAGS.has(name);
            open.start(name, clean, text.charCodeAt((pessimistic ? lastTagEnd : pos) - 2) === 47 /* / */, rebuilds ? reconstruct : undefined);
            const openA = name === 'a' ? openFormatting.get('a') : undefined;
            if ((openA && openA.length > 0 && openA[openA.length - 1]![1] === markerStarts && clean) || (name === 'nobr' && open.adopted)) {
                // An <a> start always takes an active <a> after the last marker
                // off the list (adopting or just dropping it); an exactly followed
                // <nobr> adoption does the same.
                openFormatting.get(name)!.pop();
                unlist(name);
            }
            if (MARKER_SCOPE_TAGS.has(name)) markerStarts++;
            estimate++;
            if (FORMATTING_TAGS.has(name)) {
                const opened = openFormatting.get(name) ?? [];
                const listed = activeByName.get(name) ?? 0;
                if (listed >= 3) open.arkDropped();
                activeByName.set(name, listed + 1);
                opened.push([poppingStarts, markerStarts]);
                openFormatting.set(name, opened);
                activeFormatting++;
                if (text.charCodeAt(nameEnd) === 62 /* > */) {
                    const seen = arkCounts.get(name) ?? 0;
                    arkCounts.set(name, seen + 1);
                    if (seen < 3) arkBound++;
                } else arkBound++;
            }
            // Foreign content makes raw text ambiguous; in select mode the tree
            // builder ignores <plaintext> and the raw-text start tags, so the
            // tokenizer never switches and what follows is markup after all.
            // The same happens in a <template>'s column-group mode and in frameset modes.
            if (name === 'svg' || name === 'math' || name === 'select' || name === 'template' || name === 'frameset') pessimistic = true;
            if (!pessimistic && name === 'plaintext') {
                // In HTML content, everything after is text.
                if (pos < length) textPending = true;
                break;
            }
            if (!pessimistic && RAW_TEXT_TAGS.has(name)) {
                const close = findRawTextEnd(text, pos, name);
                if (name === 'script' && text.slice(pos, close).includes('<!--')) {
                    // Escaped / double-escaped script states: `</script>` may not end it.
                    pessimistic = true;
                    ambiguousUntil = scriptEnd(text, pos);
                } else {
                    if (close > pos) textPending = true;
                    pos = close;
                }
            }
        }
        if (estimate > limit) return estimate;
    }
    // End of input: a pending character token, or a last tag's own pops, still reconstruct.
    if (textPending) dirty = true;
    reconstruct();
    return estimate;
}

/** Index just past a comment starting at `at`: `<!-->`, `<!--->`, or the first `-->` / `--!>`; text end otherwise. */
function commentEnd(text: string, at: number): number {
    if (text.startsWith('<!-->', at)) return at + 5;
    if (text.startsWith('<!--->', at)) return at + 6;
    for (let from = at + 4; ;) {
        const dashes = text.indexOf('--', from);
        if (dashes < 0) return text.length;
        if (text.charCodeAt(dashes + 2) === 62) return dashes + 3;
        if (text.charCodeAt(dashes + 2) === 33 && text.charCodeAt(dashes + 3) === 62) return dashes + 4;
        from = dashes + 1;
    }
}

/**
 * HTML elements whose content the tokenizer reads as text up to their own end
 * tag. Not `noscript`: DOMParser runs with scripting disabled, where its
 * content is ordinary markup.
 */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'textarea', 'title']);

/** Index of `</name` (followed by whitespace, `/` or `>`), case-insensitive, at or after `from`; text end otherwise. */
function findRawTextEnd(text: string, from: number, name: string): number {
    for (let at = text.indexOf('</', from); at >= 0; at = text.indexOf('</', at + 2)) {
        if (asciiLower(text.slice(at + 2, at + 2 + name.length)) !== name) continue;
        const after = text.charCodeAt(at + 2 + name.length);
        if (Number.isNaN(after) || after === 62 || after === 47 || after === 32 || after === 9 || after === 10 || after === 12 || after === 13) return at;
    }
    return text.length;
}

/**
 * `text.indexOf(needle, from)` for non-decreasing `from`, rescanning only past
 * the last hit, so a run of queries costs one pass over the text.
 */
function cachedIndexOf(text: string, needle: string): (from: number) => number {
    let lastFrom = Infinity;
    let hit = -1;
    return from => {
        if (from < lastFrom || (hit >= 0 && from > hit)) hit = text.indexOf(needle, from);
        lastFrom = from;
        return hit;
    };
}

/** Like cachedIndexOf, for the first match of a global `pattern`. */
function cachedSearch(text: string, pattern: RegExp): (from: number) => number {
    let lastFrom = Infinity;
    let hit = -1;
    return from => {
        if (from < lastFrom || (hit >= 0 && from > hit)) {
            pattern.lastIndex = from;
            hit = pattern.exec(text)?.index ?? -1;
        }
        lastFrom = from;
        return hit;
    };
}

/** findRawTextEnd for non-decreasing `from`, with the same caching. */
function cachedRawTextEnd(text: string, name: string): (from: number) => number {
    let lastFrom = Infinity;
    let hit = text.length;
    return from => {
        if (from < lastFrom || from > hit) hit = findRawTextEnd(text, from, name);
        lastFrom = from;
        return hit;
    };
}

/**
 * Drops internal-subset entity declarations whose value could expand to
 * markup: a literal `<`, or any `&` (character references such as `&#60;` are
 * expanded at declaration time). Expanded, such an entity multiplies elements
 * without bound; plain text entities such as Illustrator's `&ns_svg;` URL are
 * kept. A dropped entity's references then fail the XML parse and the document
 * takes the HTML recovery path, where they stay literal text. The DOCTYPE is
 * looked for in the whole prolog, and the subset's end is found quote-aware.
 */
export function dropMarkupEntities(text: string): string {
    const rootStart = text.search(/<[A-Za-z]/);
    const doctype = text.slice(0, rootStart < 0 ? text.length : rootStart).search(/<!DOCTYPE/i);
    if (doctype < 0) return text;
    let open = -1;
    for (let at = doctype + 9; at < text.length; at++) {
        const code = text.charCodeAt(at);
        if (code === 91 /* [ */) { open = at; break; }
        if (code === 62 /* > */) return text;
    }
    if (open < 0) return text;
    // Quote-aware: a `]` inside an entity value does not end the subset.
    let quote = 0;
    let close = -1;
    for (let at = open + 1; at < text.length; at++) {
        const code = text.charCodeAt(at);
        if (quote) {
            if (code === quote) quote = 0;
        } else if (code === 34 || code === 39) quote = code;
        else if (code === 93 /* ] */) { close = at; break; }
    }
    if (close < 0) return text;
    const subset = text.slice(open, close);
    if (!subset.includes('<!ENTITY')) return text;
    const cleaned = subset.replace(/<!ENTITY\s+(?:%\s+)?[^\s>]+\s+("[^"]*"|'[^']*')\s*>/g,
        (declaration, value: string) => (value.includes('<') || value.includes('&') ? '' : declaration));
    return text.slice(0, open) + cleaned + text.slice(close);
}

/** Most attributes one element, and the whole document, may carry: sanitizing is quadratic in attributes per element. */
export const EPUB_MAX_ATTRIBUTES_PER_ELEMENT = 256;
export const EPUB_MAX_ATTRIBUTES_TOTAL = 1_000_000;

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
/** MathML nesting kept; Chrome's MathML layout cost grows steeply with depth (real equations nest far less). */
export const EPUB_MAX_MATHML_DEPTH = 32;

/** True when any MathML element sits under more than EPUB_MAX_MATHML_DEPTH MathML ancestors. */
export function mathTooDeep(scope: Document | Element): boolean {
    for (const element of scope.querySelectorAll('*')) {
        if (element.namespaceURI !== MATHML_NS || element.firstElementChild === null) continue;
        let depth = 0;
        for (let node = element.parentElement; node && node.namespaceURI === MATHML_NS; node = node.parentElement) {
            if (++depth > EPUB_MAX_MATHML_DEPTH) return true;
        }
    }
    return false;
}

/** One linear pass over a parsed tree; true when it is too heavy to sanitize. */
export function tooManyAttributes(scope: Document | Element): boolean {
    let total = 0;
    for (const element of scope.querySelectorAll('*')) {
        const count = element.attributes.length;
        if (count > EPUB_MAX_ATTRIBUTES_PER_ELEMENT) return true;
        total += count;
        if (total > EPUB_MAX_ATTRIBUTES_TOTAL) return true;
    }
    return false;
}

export interface PreparedChapter {
    /** Sanitized top-level nodes (children of the wrapper in `fragment`). */
    nodes: Node[];
    /**
     * One inert fragment holding a single `display: contents` wrapper
     * (CHAPTER_WRAPPER_CLASS) around `nodes`: adopt and insert it in one step
     * (`document.adoptNode(fragment)`) rather than node by node.
     */
    fragment: DocumentFragment;
    /** `lang`/`xml:lang` and `dir` declared on the document's root or body. */
    lang: string;
    dir: string;
    /** Remote resources removed from the markup. */
    blocked: number;
    /** The document was not well-formed XHTML and was read as HTML instead. */
    recovered: boolean;
    /** No readable content survived (at most the id-marker spans for <html>/<body>). */
    empty: boolean;
    /** The chapter exceeded EPUB_MAX_CHAPTER_ELEMENTS and was not rendered. */
    tooLarge: boolean;
}

const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/**
 * Parses, sanitizes and rewrites one content document. `path` is the
 * document's container path, against which its relative references resolve.
 */
export function prepareChapter(
    text: string,
    kind: Exclude<EpubContentKind, 'unsupported'>,
    path: string,
    purifier: DomPurify,
    hostDocument: Document,
    maxElements: number = EPUB_MAX_CHAPTER_ELEMENTS
): PreparedChapter {
    const refused: PreparedChapter = { nodes: [], fragment: hostDocument.createDocumentFragment(), lang: '', dir: '', blocked: 0, recovered: false, empty: true, tooLarge: true };
    // Every check that can refuse runs before the parse it protects: parsing
    // (and the HTML parser's reconstruction of open formatting) is the cost.
    const parseHtml = (markup: string): Document | null => {
        const safe = htmlSafe(markup);
        return estimateHtmlElements(safe, maxElements) > maxElements ? null : parser.parseFromString(safe, 'text/html');
    };
    if (countTagStarts(text, maxElements) > maxElements) return refused;
    const parser = new DOMParser();
    let recovered = false;
    let source: Document | null;
    if (kind === 'html') {
        source = parseHtml(text);
    } else {
        text = dropMarkupEntities(text);
        source = parser.parseFromString(text, kind === 'svg' ? 'image/svg+xml' : 'application/xhtml+xml');
        if (source.getElementsByTagName('parsererror').length > 0) {
            // Plenty of shipped books carry XHTML that is not well-formed (an
            // undeclared `&nbsp;`, a stray `<br>`); the HTML parser still reads them.
            source = parseHtml(text);
            recovered = true;
        } else if (source.getElementsByTagName('*').length > maxElements) {
            return refused;
        } else if (kind === 'xhtml' && source.documentElement?.localName === 'html' && source.documentElement.namespaceURI === null) {
            // An `<html>` without xmlns parses into the null namespace, and the
            // HTML serializer then writes `<br/>` as `<br></br>` — two breaks
            // once reparsed. Reparse as XML with the XHTML namespace declared
            // (not as HTML, which would swallow self-closing `<a id="…"/>`).
            const declared = parser.parseFromString(text.replace(/<html\b/, '<html xmlns="http://www.w3.org/1999/xhtml"'), 'application/xhtml+xml');
            if (declared.getElementsByTagName('parsererror').length === 0) source = declared;
        }
    }

    if (!source) return { ...refused, recovered };
    // Exact counts after parsing too, before any per-element work: elements
    // (whatever the estimate missed) and attributes (sanitizing is quadratic in
    // attributes per element).
    // <template> content is invisible to the counts below but would still be
    // cloned and sanitized; it renders nothing in a book, so drop it first.
    for (const template of [...source.querySelectorAll('template')]) template.remove();
    if (source.getElementsByTagName('*').length > maxElements || tooManyAttributes(source) || mathTooDeep(source)) {
        return { ...refused, recovered };
    }

    const root = source.documentElement;
    const body = kind === 'svg' && !recovered ? null : source.body ?? source.getElementsByTagName('body')[0] ?? null;
    const lang = attr(body, 'lang') || attr(body, 'xml:lang') || attr(root, 'lang') || attr(root, 'xml:lang');
    const dir = attr(body, 'dir') || attr(root, 'dir');

    if (body ?? root) {
        resolveEpubSwitches(body ?? root!);
        normalizeXmlOnlyNodes(body ?? root!);
    }
    const inert = hostDocument.implementation.createHTMLDocument('');
    const staging = inert.createElement('div');
    if (body) {
        // Only body children are imported, so ids on <html>/<body> (InDesign's
        // `<body id="top">`) would stop being link targets; keep them as markers.
        for (const holderElement of [root, body]) {
            const id = holderElement?.getAttribute('id');
            if (!id) continue;
            const marker = inert.createElement('span');
            marker.setAttribute('id', id);
            staging.append(marker);
        }
        // Moved, not cloned (deep-cloning a wide MathML element is quadratic),
        // and adopted as one subtree: adopting children one by one is itself
        // quadratic in some DOMs.
        const adopted = inert.adoptNode(body);
        while (adopted.firstChild) staging.appendChild(adopted.firstChild);
    }
    else if (root) staging.append(inert.adoptNode(root));

    // DOMPurify's DOM-clobbering guard deletes ids that share a name with a
    // `document` property (`title`, `images`, `links` …) — ordinary anchor and
    // section ids in real books. Carry every id through in a private marker and
    // restore it in rewriteReferences. Markers already in the book are dropped
    // first, so only ours survive to be restored.
    for (const element of [...staging.querySelectorAll(`[${ID_ATTRIBUTE}]`)]) element.removeAttribute(ID_ATTRIBUTE);
    for (const element of [...staging.querySelectorAll('[id]')]) element.setAttribute(ID_ATTRIBUTE, element.getAttribute('id')!);
    // `<a name="x">` is a fragment target too (HTML's indicated-part fallback;
    // OEB 1.x and Word bookmarks use it). Give it the name as an id, through the
    // same clobber-checked restore.
    for (const element of [...staging.querySelectorAll('a[name]:not([id])')]) {
        const name = element.getAttribute('name')!.trim();
        if (name) element.setAttribute(ID_ATTRIBUTE, name);
    }

    // An element parsed with `is="x"` keeps that "is value" for life — removing
    // the attribute does not clear it — and would upgrade into a customized
    // built-in the host page registered. Rebuild such elements fresh.
    for (const element of [...staging.querySelectorAll('[is]')]) {
        const fresh = inert.createElementNS(element.namespaceURI, element.localName);
        for (const attribute of [...element.attributes]) {
            // Cloned Attr nodes, not re-created by name: the HTML parser makes
            // `epub:type` / `xml:lang` with no namespace, which setAttributeNS rejects.
            if (attribute.name !== 'is') fresh.setAttributeNode(attribute.cloneNode() as Attr);
        }
        while (element.firstChild) fresh.appendChild(element.firstChild);
        element.replaceWith(fresh);
    }
    // Sanitized in place, never serialized and re-parsed: an HTML round trip
    // of a tree the XML parser built (block inside open formatting) would
    // rebuild formatting elements and could multiply elements by orders of
    // magnitude; it is also where mutation-XSS lives.
    const holder = (purifier as DomPurify & { sanitize(node: Node, options: Record<string, unknown>): Node })
        .sanitize(staging, { ...EPUB_SANITIZE_PROFILE, IN_PLACE: true }) as HTMLElement;
    const blocked = rewriteReferences(holder, path);
    // Only the empty id-marker spans (or whitespace) left means nothing readable survived.
    // Sibling walks, never `childNodes`: a live child list on a parent that is
    // then emptied makes every removal O(n) in some DOMs (quadratic overall).
    let empty = true;
    for (let node = holder.firstChild; node && empty; node = node.nextSibling) {
        empty = node.nodeType === 3
            ? !(node.textContent ?? '').trim()
            : node.nodeType === 1 && (node as Element).localName === 'span' && !node.hasChildNodes();
    }
    // The sanitized container itself is delivered (as a `display: contents`
    // wrapper) instead of draining its children: moving many children out of a
    // tree the sanitizer just walked is quadratic in some DOMs.
    holder.className = CHAPTER_WRAPPER_CLASS;
    const nodes: Node[] = [];
    for (let node = holder.firstChild; node; node = node.nextSibling) nodes.push(node);
    const fragment = inert.createDocumentFragment();
    fragment.appendChild(holder);
    return { nodes, fragment, lang, dir, blocked, recovered, empty, tooLarge: false };
}

const OPS_NS = 'http://www.idpf.org/2007/ops';
const SWITCH_CASE_NAMESPACES = new Set(['http://www.w3.org/1998/Math/MathML', 'http://www.w3.org/2000/svg']);

/**
 * The HTML parser ignores `/>` on non-void elements, so an XHTML-style
 * `<script src="…"/>` or `<title/>` would swallow the rest of the document and
 * `<b/>` would bold it. Give them explicit end tags before an HTML parse.
 */
function htmlSafe(text: string): string {
    // Every non-void element: `<video/>`, `<b/>`, `<a id="x"/>` would otherwise
    // open and wrap (or, for raw-text tags, swallow) the rest of the chapter.
    // Both groups exclude `<` and `>`, so a failed attempt never scans past the
    // next tag delimiter: linear time even on hostile `<a<a<a…` input.
    // The `/>` must follow the tag name, whitespace or a closing quote: after an
    // unquoted value (`href=http://x/>`) the HTML tokenizer keeps the slash in
    // the value, so that tag is not self-closed.
    // A bare attribute name may also precede the slash (`allowfullscreen/>`,
    // `<span hidden/>`): after an attribute name the tokenizer treats `/` as
    // self-closing.
    return text.replace(/<(?!(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b)([A-Za-z][^\s/<>]*)(\s(?:[^<>]*?[\s"'])?(?:(?<=\s)[^\s"'=<>/]+)?)?\/>/gi,
        (_whole, name: string, attributes: string | undefined) => `<${name}${attributes ?? ''}></${name}>`);
}

/** Matches an OPS element whether parsed as XML (`ops:switch`) or recovered as HTML (`epub:switch`). */
function isOps(element: Element, local: string): boolean {
    return element.namespaceURI === OPS_NS ? element.localName === local : element.localName === `epub:${local}`;
}

/**
 * EPUB 3.0 content switches (`epub:switch` / `epub:case` / `epub:default`).
 * After serialization DOMPurify sees a bare `switch`, an SVG-only tag, and
 * drops the whole subtree — fallback included. Resolve each switch first: the
 * first case whose required namespace the viewer renders (MathML, SVG), else
 * the default. `epub:trigger` (media control) is dropped.
 */
function resolveEpubSwitches(scope: Element): void {
    const elements = [...scope.querySelectorAll('*')];
    for (const trigger of elements.filter(node => isOps(node, 'trigger'))) trigger.remove();
    // One pass in document order. A switch inside a discarded branch has left
    // the tree and is skipped; one inside the chosen branch is moved, not
    // recreated, so it is still in the list and resolved in turn.
    for (const node of elements.filter(element => isOps(element, 'switch'))) {
        if (!scope.contains(node)) continue;
        const branches = [...node.children];
        const chosen = branches.find(branch => isOps(branch, 'case') && SWITCH_CASE_NAMESPACES.has(branch.getAttribute('required-namespace') ?? ''))
            ?? branches.find(branch => isOps(branch, 'default'));
        // A fragment, not argument spread: a huge branch would overflow the stack.
        const fragment = node.ownerDocument.createDocumentFragment();
        if (chosen) while (chosen.firstChild) fragment.append(chosen.firstChild);
        node.replaceWith(fragment);
    }
}

/**
 * CDATA sections and processing instructions exist only in XML documents, and
 * importing a CDATA section into an HTML document throws (DOM `importNode`).
 * Inline `<style>`/`<script>` blocks in XHTML often wrap their text in CDATA.
 */
function normalizeXmlOnlyNodes(scope: Node): void {
    const owner = scope.ownerDocument ?? (scope as Document);
    const walker = owner.createTreeWalker(scope, 0x8 /* CDATA_SECTION */ | 0x40 /* PROCESSING_INSTRUCTION */);
    const found: Node[] = [];
    while (walker.nextNode()) found.push(walker.currentNode);
    // XHTML 1.1 (EPUB 2) has only `xml:lang`, which the sanitizer drops; keep it as `lang`.
    const elements = scope.nodeType === 1 ? [scope as Element, ...(scope as Element).querySelectorAll('*')] : [];
    for (const element of elements) {
        const xmlLang = element.getAttributeNS(XML_NS, 'lang') ?? element.getAttribute('xml:lang');
        if (xmlLang && !element.hasAttribute('lang')) element.setAttribute('lang', xmlLang);
    }
    for (const node of found) {
        if (node.nodeType === 4) node.parentNode?.replaceChild(owner.createTextNode(node.nodeValue ?? ''), node);
        else node.parentNode?.removeChild(node);
    }
}

function attr(element: Element | null, name: string): string {
    return element?.getAttribute(name)?.trim() ?? '';
}

/** Moves every fetchable reference out of the markup. Returns how many were remote. */
function rewriteReferences(holder: HTMLElement, path: string): number {
    let blocked = 0;
    for (const element of [...holder.querySelectorAll('*')]) {
        // The viewer's own markers drive blob-URL assignment and link routing,
        // so a book must never be able to plant them (defense in depth: the
        // sanitizer profile forbids them too).
        for (const marker of [RESOURCE_ATTRIBUTE, LINK_ATTRIBUTE, BLOCKED_ATTRIBUTE, ANCHOR_ATTRIBUTE]) element.removeAttribute(marker);
        // HTML exposes `name` on embed/form/iframe/img/object — and an img's
        // `id` too once it has a `name` — as `document` named properties, which
        // shadow builtins (`document.getElementById`). Of those only img survives
        // the profile, and nothing here reads its `name`, so drop it.
        if (CLOBBERING_ELEMENTS.has(element.localName)) element.removeAttribute('name');
        // `<details name>` joins an exclusive accordion group document-wide.
        if (element.localName === 'details') element.removeAttribute('name');
        // A positive tabindex would put book text ahead of the host in tab order.
        const tabIndex = element.getAttribute('tabindex');
        if (tabIndex !== null && Number.parseInt(tabIndex, 10) > 0) element.setAttribute('tabindex', '0');
        const preservedId = element.getAttribute(ID_ATTRIBUTE);
        if (preservedId !== null) {
            element.removeAttribute(ID_ATTRIBUTE);
            // Restored as written: confineIdReferences prefixes every id per
            // render, so no book id can name a document, window or form member.
            element.setAttribute('id', preservedId);
        }
        // SVG presentation attributes (`fill`, `mask`, `clip-path`, `filter`,
        // `marker-*`, `cursor` …) fetch any non-fragment `url(…)` they name.
        for (const { name, value } of [...element.attributes]) {
            // URL attributes are handled as URLs below; a file named `image (1).jpg` is not CSS.
            if (!CSS_URL_ATTRIBUTES.has(asciiLower(name)) || !fetchesResource(value)) continue;
            element.removeAttribute(name);
            blocked++;
        }
        // The viewer's own class names must not be claimable by book markup.
        if (element.classList.length > 0) {
            for (const name of [...element.classList]) if (name.startsWith('omni-')) element.classList.remove(name);
        }
        const tag = element.localName;
        if (tag === 'img' || tag === 'image') {
            const reference = element.getAttribute('src') ?? element.getAttribute('href') ?? element.getAttributeNS(XLINK_NS, 'href') ?? element.getAttribute('xlink:href') ?? '';
            removeReference(element);
            const trimmed = reference.trim();
            if (!trimmed) continue;
            if (/^data:image\//i.test(trimmed) && !/^data:image\/svg/i.test(trimmed)) {
                // An inline raster image fetches nothing; keep it as written.
                element.setAttribute(tag === 'img' ? 'src' : 'href', trimmed);
                continue;
            }
            if (isExternalHref(trimmed)) {
                blocked++;
                element.setAttribute(BLOCKED_ATTRIBUTE, '');
                continue;
            }
            const resolved = resolveEpubHref(path, trimmed);
            if (resolved) element.setAttribute(RESOURCE_ATTRIBUTE, resolved.path);
            continue;
        }
        if (tag === 'a' || tag === 'area') {
            const href = element.getAttribute('href') ?? element.getAttributeNS(XLINK_NS, 'href') ?? element.getAttribute('xlink:href');
            removeReference(element);
            if (href !== null && href.trim()) element.setAttribute(LINK_ATTRIBUTE, href.trim());
            continue;
        }
        // Any other SVG reference (`<use href="other.svg#id">`) could fetch a
        // file; only same-document references are harmless.
        for (const name of ['href', 'xlink:href', 'src']) {
            const value = element.getAttribute(name);
            if (value !== null && (name === 'src' || !value.trim().startsWith('#'))) {
                element.removeAttribute(name);
                if (isExternalHref(value)) blocked++;
            }
        }
        if (element.hasAttributeNS(XLINK_NS, 'href') && !(element.getAttributeNS(XLINK_NS, 'href') ?? '').trim().startsWith('#')) {
            element.removeAttributeNS(XLINK_NS, 'href');
        }
    }
    confineIdReferences(holder);
    return blocked;
}

/** ARIA attributes whose value is a list of element ids. */
export const ARIA_IDREF_ATTRIBUTES = ['aria-owns', 'aria-activedescendant', 'aria-controls', 'aria-flowto', 'aria-labelledby', 'aria-describedby', 'aria-details', 'aria-errormessage'];
let imageMapToken = 0;
let chapterNamespace = 0;

/**
 * Namespaces the chapter's ids. In scoped mode the chapter shares the host
 * document, and every id-based reference — ARIA lists, `headers`, `usemap`,
 * SVG `href="#…"`, `url(#…)` — resolves to the *first* element with that id in
 * the whole tree, which may be host UI, or become host UI once a detached
 * container is attached. Prefixing every chapter id (and every reference to
 * one) with a per-render token makes a collision impossible wherever the page
 * ends up. The original name is kept in ANCHOR_ATTRIBUTE for fragment
 * navigation; references to ids the chapter does not have are dropped.
 */
function confineIdReferences(holder: HTMLElement): void {
    const prefix = `omni-epub-${++chapterNamespace}-`;
    const ids = new Set([...holder.querySelectorAll('[id]')].map(element => element.id));
    const scoped = (id: string): string | null => (ids.has(id) ? prefix + id : null);

    // `usemap="#x"` binds to the first map whose id or name is x (XHTML 1.1 /
    // EPUB 2 maps carry only an id). Register both keys, first map wins, and
    // give every map a unique name so none keeps a name the host could share.
    const maps = new Map<string, Element>();
    for (const map of [...holder.querySelectorAll('map')]) {
        for (const key of [map.getAttribute('id'), map.getAttribute('name')]) {
            if (key && !maps.has(key)) maps.set(key, map);
        }
        map.setAttribute('name', `${prefix}map-${++imageMapToken}`);
    }
    for (const element of [...holder.querySelectorAll('[usemap]')]) {
        const map = maps.get((element.getAttribute('usemap') ?? '').replace(/^#/, ''));
        if (map) element.setAttribute('usemap', `#${map.getAttribute('name')}`);
        else element.removeAttribute('usemap');
    }

    for (const element of [...holder.querySelectorAll('[id]')]) {
        element.setAttribute(ANCHOR_ATTRIBUTE, element.id);
        element.id = prefix + element.id;
    }
    for (const name of [...ARIA_IDREF_ATTRIBUTES, 'headers']) {
        for (const element of [...holder.querySelectorAll(`[${name}]`)]) {
            const kept = [...new Set((element.getAttribute(name) ?? '').split(/\s+/))]
                .map(scoped).filter((id): id is string => id !== null);
            if (kept.length > 0) element.setAttribute(name, kept.join(' '));
            else element.removeAttribute(name);
        }
    }
    for (const element of [...holder.querySelectorAll('*')]) {
        // Links (`a`, `area`) carry their target in LINK_ATTRIBUTE; any `#`
        // href left here is an SVG-internal reference (gradients, textPath).
        for (const [namespace, name] of [[null, 'href'], [XLINK_NS, 'href']] as const) {
            const value = element.getAttributeNS(namespace, name);
            if (value === null) continue;
            // An inline raster on an SVG <image> fetches nothing; rewriteReferences kept it on purpose.
            if (element.localName === 'image' && /^data:image\/(?!svg)/i.test(value.trim())) continue;
            const target = value.trim().startsWith('#') ? scoped(value.trim().slice(1)) : null;
            if (target) element.setAttributeNS(namespace, namespace ? 'xlink:href' : 'href', `#${target}`);
            else element.removeAttributeNS(namespace, name);
        }
        for (const attribute of [...element.attributes]) {
            if (!CSS_URL_ATTRIBUTES.has(asciiLower(attribute.name))) continue;
            const rewritten = confineCssUrls(attribute.value, scoped);
            if (rewritten === null) element.removeAttribute(attribute.name);
            else if (rewritten !== attribute.value) element.setAttribute(attribute.name, rewritten);
        }
    }
}

/**
 * Rewrites the `url(…)` references of one CSS-parsed attribute value. CSS
 * escapes are decoded first (`\\23 x`, `u\\72l(` would otherwise slip past),
 * quotes and surrounding whitespace are tolerated, and the only reference kept
 * is `url(#<chapter id>)`, namespaced; any other `url(…)` becomes `none`. The
 * match class excludes parentheses, so it is linear on hostile input. Returns
 * null when an unterminated `url(` remains (drop the attribute).
 */
function confineCssUrls(value: string, scoped: (id: string) => string | null): string | null {
    const css = unescapeCss(value);
    if (!/url\(/i.test(css)) return value;
    const rewritten = css.replace(/url\(([^()]*)\)/gi, (_whole, inner: string) => {
        let reference = inner.trim();
        const quote = reference[0];
        if ((quote === '"' || quote === "'") && reference.endsWith(quote) && reference.length >= 2) reference = reference.slice(1, -1).trim();
        const target = reference.startsWith('#') ? scoped(reference.slice(1)) : null;
        return target ? `url(#${target})` : 'none';
    });
    if (/url\((?!#omni-epub-)/i.test(rewritten)) return null;
    // The value is written back unescaped, so check it again as written: an
    // escaped `\\69 mage-set\\28` is inert text but becomes a fetch once decoded.
    return fetchesResource(rewritten) ? null : rewritten;
}

/** Human-readable attributes that are never parsed as CSS. */
/**
 * Attributes the browser parses as CSS that can name a resource: the SVG
 * presentation attributes whose property takes a `<url>` (paint servers,
 * clipping, masking, filters, markers, cursors), plus `style`. Prose attributes
 * (`summary`, `alt`, `data-*` …) are never parsed as CSS, so text that merely
 * reads like `image (left)` is left alone. URL attributes (`src`, `href`) are
 * handled as URLs by the tag-specific rules.
 */
const CSS_URL_ATTRIBUTES = new Set([
    'style', 'fill', 'stroke', 'mask', 'clip-path', 'filter', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor', 'color-profile'
]);

/** Resolves CSS escapes (`\\75 rl(` → `url(`) so they cannot hide a function name. */
function unescapeCss(value: string): string {
    return value.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\r\n\f]?|([\s\S]))/g, (_whole, hex: string | undefined, char: string | undefined) => {
        if (hex === undefined) return char ?? '';
        const code = Number.parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
    });
}

/**
 * True when a value, read as CSS, can make the browser fetch something: a
 * `url(…)` other than a same-document `#fragment`, or an image function that
 * takes a bare string (`image-set('…')`, `image()`, `src()`, `cross-fade()`).
 * CSS escapes are resolved first.
 */
export function fetchesResource(value: string): boolean {
    // Unescape first: `\\28` is a `(` too, so a raw-text shortcut would miss
    // an escaped function call.
    const css = asciiLower(unescapeCss(value));
    if (!css.includes('(')) return false;
    if (/(?:^|[^a-z0-9_-])(?:-webkit-)?(?:image-set|image|cross-fade|element|src)\s*\(/.test(css)) return true;
    const pattern = /(?:^|[^a-z0-9_-])url\s*\(\s*['"]?\s*([^'")\s]*)/g;
    for (let match = pattern.exec(css); match; match = pattern.exec(css)) {
        if (!match[1]!.startsWith('#')) return true;
    }
    return false;
}

/**
 * Applies the chapter reference rules to a sanitized standalone SVG image: a
 * blob opened in its own tab is a document, so it must not fetch either.
 * Drops non-fragment hrefs, any `src`, CSS-fetching attribute values, and
 * `<style>` blocks. Returns how many references were removed.
 */
export function stripSvgReferences(root: Element): number {
    let removed = 0;
    for (const element of [root, ...root.querySelectorAll('*')]) {
        if (element.localName === 'style') {
            element.remove();
            removed++;
            continue;
        }
        for (const { name, namespaceURI, localName, value } of [...element.attributes]) {
            const isHref = localName === 'href' && (namespaceURI === null || namespaceURI === XLINK_NS);
            // Same rule as chapter images: an inline raster fetches nothing (Inkscape/Illustrator embed these).
            const drop = isHref ? !value.trim().startsWith('#') && !/^data:image\/(?!svg)/i.test(value.trim())
                : name === 'src' || (CSS_URL_ATTRIBUTES.has(asciiLower(name)) && fetchesResource(value));
            if (!drop) continue;
            element.removeAttributeNS(namespaceURI, localName);
            removed++;
        }
    }
    return removed;
}

function removeReference(element: Element): void {
    element.removeAttribute('src');
    element.removeAttribute('href');
    element.removeAttribute('xlink:href');
    element.removeAttributeNS(XLINK_NS, 'href');
}

/** Media type for an image the manifest did not describe. */
export function guessImageType(path: string): string {
    const extension = asciiLower(path.slice(path.lastIndexOf('.') + 1));
    switch (extension) {
        case 'jpg': case 'jpeg': return 'image/jpeg';
        case 'png': return 'image/png';
        case 'gif': return 'image/gif';
        case 'webp': return 'image/webp';
        case 'svg': return 'image/svg+xml';
        case 'avif': return 'image/avif';
        case 'bmp': return 'image/bmp';
        default: return 'application/octet-stream';
    }
}
