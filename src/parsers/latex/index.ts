// LaTeX structural parser (docs/viewers/latex.md §2).
//
// Stage 1 scope (L10): document structure + math *extraction*. Math is never
// rendered here — the renderer is injected into the viewer (L2), so this parser
// only hands back the TeX source of each segment. Rendering-free means the
// output is deterministic: pure string scanning, no locale APIs, no engine.
//
// This is deliberately not a TeX interpreter. Macro expansion is Turing
// complete, so constructs this scanner does not model become `unsupported`
// blocks that keep their original source (L6) rather than being dropped.

import { decodeUtf8, type Diagnostic, type ParseOptions, type ParseOutcome } from '../types.js';

export interface LatexSpan { start: number; end: number; }

export interface LatexPackage { name: string; options: string[]; }

export interface LatexPreamble {
    documentClass?: string;
    classOptions: string[];
    packages: LatexPackage[];
    /**
     * Argument-less `\newcommand{\R}{\mathbb{R}}` substitutions only, keyed
     * without the leading backslash. Stage 2 passes these to KaTeX as `macros`.
     * Macros taking arguments are intentionally absent — expanding them is the
     * interpreter this parser refuses to be (§2).
     */
    macros: Record<string, string>;
    /**
     * `\newtheorem{thm}{Theorem}` declarations, keyed by environment name with
     * the printed title as value. Theorem-like environments are document
     * defined, so without this map they are indistinguishable from any other
     * unknown environment and their prose would be dumped as source.
     */
    theorems: Record<string, string>;
    /**
     * Characters `\MakeShortVerb` turned into inline-verbatim delimiters, as in
     * the `doc` package's `\MakeShortVerb{\|}`. Package documentation writes
     * `|\newcommand{\x}{…}|` to *show* code; without this the scanner would
     * execute what the author meant to display.
     */
    shortVerbs: string[];
    /**
     * `\input`/`\include` targets declared in the preamble. Documents routinely
     * keep their macros in a separate file, and those definitions decide whether
     * the body's formulas render, so the paths are surfaced for the viewer's
     * resolver even though the preamble itself produces no blocks.
     */
    inputs: string[];
    /** Verbatim preamble source, for display. */
    raw: string;
}

export type LatexEmphasis = 'it' | 'bf' | 'tt';

export type LatexInline =
    | { kind: 'text'; value: string }
    | { kind: 'math'; source: string; display: false }
    | { kind: 'emphasis'; style: LatexEmphasis; content: LatexInline[] }
    | { kind: 'ref'; target: string }
    | { kind: 'cite'; keys: string[] }
    | { kind: 'link'; url: string; text: string }
    | { kind: 'unsupported'; source: string };

export type LatexBlock =
    | { kind: 'heading'; level: number; id: string; title: LatexInline[]; label?: string; span: LatexSpan }
    | { kind: 'paragraph'; content: LatexInline[]; span: LatexSpan }
    | { kind: 'math'; source: string; display: boolean; label?: string; span: LatexSpan }
    | { kind: 'list'; ordered: boolean; items: LatexBlock[][]; span: LatexSpan }
    | { kind: 'theorem'; environment: string; title: string; note?: LatexInline[]; body: LatexBlock[]; label?: string; span: LatexSpan }
    | { kind: 'table'; columns: LatexColumnAlign[]; rows: LatexTableCell[][]; span: LatexSpan }
    | { kind: 'verbatim'; source: string; span: LatexSpan }
    /** A `figure`/`table` float. Its body is scanned like any other content —
     *  the caption is lifted out for display, not used as a replacement for it. */
    | { kind: 'float'; environment: string; caption?: LatexInline[]; blocks: LatexBlock[]; span: LatexSpan }
    | { kind: 'unresolved'; command: string; path: string; span: LatexSpan }
    /** A resolved `\input`/`\include`. Never produced by the parser — the core
     *  has no filesystem (L4); the viewer builds these from an injected
     *  resolver, so `blocks` carry spans into the *included* file, not this one. */
    | { kind: 'include'; command: string; path: string; blocks: LatexBlock[]; span: LatexSpan }
    | { kind: 'unsupported'; environment: string; source: string; span: LatexSpan };

export type LatexColumnAlign = 'left' | 'center' | 'right';
export interface LatexTableCell {
    content: LatexInline[];
    /** `\multicolumn{n}{…}{…}` — cells spanning one column omit this. */
    span?: number;
}

export interface LatexHeading {
    level: number;
    text: string;
    id: string;
    span: LatexSpan;
    /** Set when the heading came from an included file (span is into that file). */
    source?: string;
}

export interface LatexDocument {
    /** Complete decoded source, retained for source view / edit / writeback. */
    text: string;
    preamble: LatexPreamble;
    body: LatexBlock[];
    /** Flat outline in source order (§3 navigation). */
    outline: LatexHeading[];
    /** Region of `text` the block scanner covered. */
    bodySpan: LatexSpan;
}

export interface LatexStructuralLimits {
    maxBlocks: number;
    maxOutline: number;
    maxMathSegments: number;
    maxInlineMathLength: number;
    maxDisplayMathLength: number;
    maxDepth: number;
}

/** docs/viewers/latex.md §4. Inline/display math lengths match the markdown
 *  viewer's existing constants so the two paths agree on what is "a formula". */
export const LATEX_DEFAULT_LIMITS = {
    maxInputBytes: 10 * 1024 * 1024,
    maxBlocks: 200_000,
    maxOutline: 10_000,
    maxMathSegments: 5_000,
    maxInlineMathLength: 1_000,
    maxDisplayMathLength: 5_000,
    maxDepth: 64
} as const;

export interface LatexParseOptions extends ParseOptions {
    latexLimits?: Partial<LatexStructuralLimits>;
    /**
     * Parse a body fragment that has no `\documentclass` of its own — an
     * `\input`ed chapter file. Without this the parser refuses to guess at the
     * structure of a `.tex` file that might be plain TeX (§1); with it the
     * caller is asserting the file is a LaTeX fragment. Spans stay relative to
     * the fragment's own text, which is why this exists instead of wrapping the
     * source in a synthetic document.
     */
    fragment?: boolean;
}

/** Contents are copied verbatim; comments are *not* stripped inside these. */
const VERBATIM_ENVIRONMENTS = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'Verbatim', 'alltt']);
/** Handed to the math renderer whole — KaTeX parses these environments itself. */
/**
 * Passed to the renderer whole. Which of these the *engine* understands is not
 * core's business — KaTeX rejects `eqnarray`/`flalign`/`multline` while MathJax
 * accepts them, and the renderer is injected. Core hands them over and lets a
 * failure fall back to the TeX source rather than hard-coding one engine's
 * capability list.
 */
const MATH_ENVIRONMENTS = new Set([
    'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*',
    'displaymath', 'eqnarray', 'eqnarray*', 'alignat', 'alignat*', 'flalign', 'flalign*'
]);
/** `\begin{math}` is `$…$`, not a display block. */
const MATH_INLINE_ENVIRONMENTS = new Set(['math']);
const LIST_ENVIRONMENTS = new Map<string, boolean>([['itemize', false], ['enumerate', true], ['description', false]]);
/** Caption is extracted; the body is not typeset (L7). */
const FLOAT_ENVIRONMENTS = new Set(['figure', 'figure*', 'table', 'table*']);
/**
 * Structural wrappers with no typesetting of their own — scan through them.
 * `subequations` belongs here rather than in MATH_ENVIRONMENTS: it only renumbers
 * the equations it contains, so treating it as one formula would hide the
 * `align`/`gather` inside it from the renderer entirely.
 */
const TRANSPARENT_ENVIRONMENTS = new Set([
    'document', 'center', 'flushleft', 'flushright', 'quote', 'quotation', 'abstract',
    'sloppypar', 'small', 'footnotesize', 'subequations', 'em', 'verse', 'columns'
]);
/**
 * Wrappers that open with `[overlay]{Title}` (beamer's frame and block family).
 * Their children are spliced in like any transparent environment, but the title
 * has to be lifted out first or it leaks into the prose as stray text.
 */
const TITLED_WRAPPER_ENVIRONMENTS = new Set(['frame', 'block', 'exampleblock', 'alertblock']);
/** Layout wrappers taking one mandatory argument (a width) before their body. */
const SIZED_WRAPPER_ENVIRONMENTS = new Set(['column', 'minipage']);
/** Tabular-family environments, all of which open with a column spec (L14). */
const TABLE_ENVIRONMENTS = new Set(['tabular', 'array', 'longtable', 'tabular*', 'tabularx']);
/**
 * Theorem-like environments a document class declares for you (amsthm, and most
 * journal classes), so they never appear in a `\newtheorem` line in the file.
 * A `\newtheorem` declaration in the document always wins over these.
 * The title is the environment's own name — the same string the class prints —
 * so it is document vocabulary, not UI text needing a catalog key.
 */
const BUILTIN_THEOREM_ENVIRONMENTS = new Set([
    'theorem', 'lemma', 'corollary', 'proposition', 'definition', 'remark', 'example',
    'proof', 'conjecture', 'axiom', 'notation', 'claim', 'fact', 'observation'
]);

const SECTION_COMMANDS = ['subparagraph', 'subsubsection', 'subsection', 'paragraph', 'section', 'chapter', 'part'] as const;
const EMPHASIS_COMMANDS = new Map<string, LatexEmphasis>([
    ['emph', 'it'], ['textit', 'it'], ['textsl', 'it'], ['itshape', 'it'],
    ['textbf', 'bf'], ['bfseries', 'bf'], ['strong', 'bf'],
    ['texttt', 'tt'], ['ttfamily', 'tt'], ['textsc', 'tt']
]);
/** Wrappers whose content is plain text: unwrap rather than mark unsupported. */
const TRANSPARENT_COMMANDS = new Set(['textrm', 'textnormal', 'textup', 'mbox', 'text', 'centering', 'noindent']);
/**
 * Commands whose *last* mandatory argument is prose, mapped to how many earlier
 * arguments to discard (a colour, a link target). Presentation sources lean on
 * these — beamer's `\alert{…}` alone appears 35 times in one official example —
 * and treating them as unknown would dump the sentence's own words as source.
 */
const CONTENT_COMMANDS = new Map<string, number>([
    ['alert', 0], ['structure', 0], ['uncover', 0], ['only', 0], ['visible', 0],
    ['emphasize', 0], ['beamergotobutton', 0], ['beamerbutton', 0], ['beamerreturnbutton', 0],
    ['textcolor', 1], ['colorbox', 1], ['fcolorbox', 2], ['hyperlink', 1], ['hyperref', 1]
]);
const REF_COMMANDS = new Set(['ref', 'eqref', 'autoref', 'pageref', 'cref', 'Cref']);
const CITE_COMMANDS = new Set(['cite', 'citep', 'citet', 'citeauthor', 'citeyear', 'parencite', 'textcite']);
/** External file references. Never resolved — the core has no filesystem (L4). */
const INPUT_COMMANDS = new Set(['input', 'include', 'includegraphics', 'subfile', 'bibliography', 'addbibresource']);

/**
 * Commands that typeset nothing, mapped to how many mandatory arguments they
 * swallow. Dropping these is not the silent omission L6 forbids — like `\label`
 * they have no output at all, and leaving them in litters the prose with
 * `\setlength{\multlinegap}0pt` and stray definition bodies.
 */
const SILENT_COMMANDS = new Map<string, number>([
    ['index', 1], ['nocite', 1], ['bibliographystyle', 1], ['pagenumbering', 1],
    ['pagestyle', 1], ['thispagestyle', 1], ['markright', 1], ['sectionmark', 1],
    ['stepcounter', 1], ['refstepcounter', 1], ['markboth', 2],
    ['setcounter', 2], ['addtocounter', 2],
    ['setlength', 2], ['addtolength', 2], ['settowidth', 2], ['settoheight', 2],
    ['newcommand', 2], ['renewcommand', 2], ['providecommand', 2],
    ['DeclareMathOperator', 2], ['newtheorem', 2], ['newenvironment', 3],
    // Preamble declarations: normally above \begin{document}, but a fragment
    // without that split has them interleaved with the prose.
    ['documentclass', 1], ['documentstyle', 1], ['usepackage', 1], ['RequirePackage', 1],
    ['MakeShortVerb', 1], ['DeleteShortVerb', 1],
    ['title', 1], ['author', 1], ['date', 1], ['thanks', 1], ['keywords', 1], ['subjclass', 1],
    ['vspace', 1], ['hspace', 1],
    ['newpage', 0], ['clearpage', 0], ['cleardoublepage', 0], ['pagebreak', 0],
    ['nopagebreak', 0], ['linebreak', 0], ['nolinebreak', 0],
    ['noindent', 0], ['indent', 0], ['centering', 0], ['raggedright', 0], ['raggedleft', 0],
    ['bigskip', 0], ['medskip', 0], ['smallskip', 0], ['hfill', 0], ['vfill', 0],
    ['normalsize', 0], ['footnotesize', 0], ['scriptsize', 0], ['tiny', 0],
    ['large', 0], ['Large', 0], ['LARGE', 0], ['huge', 0], ['Huge', 0],
    ['normalfont', 0], ['maketitle', 0], ['tableofcontents', 0],
    ['listoffigures', 0], ['listoftables', 0], ['appendix', 0], ['sloppy', 0],
    // beamer: slide plumbing with nothing to show in a linear preview.
    ['column', 1], ['titlepage', 0], ['qedhere', 0], ['pause', 0],
    ['usetheme', 1], ['usefonttheme', 1], ['setbeamertemplate', 2], ['setbeamerfont', 2],
    ['setbeamercolor', 2], ['institute', 1], ['logo', 1], ['transdissolve', 0]
]);

const MAX_DIAGNOSTICS = 50;

interface ScanContext {
    text: string;
    limits: LatexStructuralLimits;
    signal?: AbortSignal;
    diagnostics: Diagnostic[];
    seen: Set<string>;
    outline: LatexHeading[];
    levels: Record<string, number>;
    theorems: Record<string, string>;
    shortVerbs: string[];
    blocks: number;
    mathSegments: number;
    ordinal: number;
    stop: 'aborted' | 'limit' | null;
    /** Offset the scan stopped at, reported as the limit diagnostic's location. */
    stoppedAt: number;
}

/** 1-based line number of `offset`, for diagnostic locations. */
function lineAt(text: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
    return line;
}

/**
 * Structure-only LaTeX parse. Input-caused problems never throw: unparseable
 * bytes become `failed`, everything the scanner cannot model becomes a
 * diagnostic plus an `unsupported`/`unresolved` block and a `partial` status.
 */
export function parseLatex(data: Uint8Array, options: LatexParseOptions = {}): ParseOutcome<LatexDocument> {
    const started = Date.now();
    const done = (result: ParseOutcome<LatexDocument>['result']): ParseOutcome<LatexDocument> => ({
        result,
        execution: { workerUsed: false, hardLimitEnforced: true, elapsedMillis: Date.now() - started }
    });
    const maxInputBytes = options.limits?.maxInputBytes ?? LATEX_DEFAULT_LIMITS.maxInputBytes;
    if (data.byteLength > maxInputBytes) {
        return done({ status: 'failed', failure: { code: 'limit-exceeded', retryable: false, messageKey: 'diag.latex.limit-exceeded' }, diagnostics: [] });
    }
    if (options.signal?.aborted) {
        return done({ status: 'failed', failure: { code: 'aborted', retryable: true, messageKey: 'diag.aborted' }, diagnostics: [] });
    }

    const text = decodeUtf8(data);
    const limits: LatexStructuralLimits = { ...LATEX_DEFAULT_LIMITS, ...options.latexLimits };
    const ctx: ScanContext = {
        text, limits, ...(options.signal ? { signal: options.signal } : {}), diagnostics: [], seen: new Set(),
        outline: [], levels: {}, theorems: {}, shortVerbs: [], blocks: 0, mathSegments: 0, ordinal: 0,
        stop: null, stoppedAt: 0
    };

    const documentAt = findOutsideVerbatim(text, '\\begin{document}', 0);
    // With no `\begin{document}` there is no preamble/body split, so the whole
    // file is read for declarations. Scanning only up to offset 0 (the obvious
    // reading) made `\documentclass` invisible and every such fragment was
    // rejected as "not LaTeX", which also left the recovery branch below dead.
    const preambleEnd = documentAt === -1 ? text.length : documentAt;
    const preamble = readPreamble(text.slice(0, preambleEnd));
    ctx.theorems = preamble.theorems;
    ctx.shortVerbs = preamble.shortVerbs;

    // plain TeX / ConTeXt share the `.tex` extension. Without \documentclass we
    // do not claim to understand the structure — the viewer falls back to the
    // source view rather than showing a confidently wrong outline (§1).
    if (!preamble.documentClass && !options.fragment) {
        addDiagnostic(ctx, 'warning', 'latex.not-latex', 'diag.latex.not-latex');
        const document: LatexDocument = { text, preamble, body: [], outline: [], bodySpan: { start: 0, end: 0 } };
        return done({ status: 'partial', document, diagnostics: ctx.diagnostics });
    }

    let bodyStart: number;
    let bodyEnd: number;
    if (documentAt === -1) {
        // A \documentclass without \begin{document} is a fragment, not a bug we
        // should refuse: scan what follows the preamble and say so. When the
        // caller already declared this a fragment there is nothing to report.
        if (!options.fragment) addDiagnostic(ctx, 'warning', 'latex.no-document-environment', 'diag.latex.no-document-environment');
        // The declarations are interleaved with the prose here, so the body scan
        // starts at the top; preamble commands are in SILENT_COMMANDS and drop out.
        bodyStart = 0;
        bodyEnd = text.length;
    } else {
        bodyStart = documentAt + '\\begin{document}'.length;
        const endAt = findOutsideVerbatim(text, '\\end{document}', bodyStart);
        bodyEnd = endAt === -1 ? text.length : endAt;
        if (endAt === -1) addDiagnostic(ctx, 'warning', 'latex.unbalanced-environment', 'diag.latex.unbalanced-environment', { environment: 'document' });
    }

    // Sectioning maps to heading levels 1..6 for accessibility, so the depth of
    // the deepest used command matters: \part only claims level 1 when present.
    const hasPart = findCommand(text, 'part', bodyStart, bodyEnd) !== -1;
    ctx.levels = hasPart
        ? { part: 1, chapter: 2, section: 3, subsection: 4, subsubsection: 5, paragraph: 6, subparagraph: 6 }
        : { part: 1, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };

    const body = scanBlocks(ctx, bodyStart, bodyEnd, 0);

    if (ctx.stop === 'aborted') {
        return done({ status: 'failed', failure: { code: 'aborted', retryable: true, messageKey: 'diag.aborted' }, diagnostics: ctx.diagnostics });
    }
    if (ctx.stop === 'limit') {
        // §4: say where the document stopped being scanned, not just that it did.
        addDiagnostic(
            ctx, 'warning', 'latex.limit-exceeded', 'diag.latex.limit-exceeded',
            undefined, () => `line ${lineAt(text, ctx.stoppedAt)}`
        );
    }

    const document: LatexDocument = { text, preamble, body, outline: ctx.outline, bodySpan: { start: bodyStart, end: bodyEnd } };
    const partial = ctx.stop === 'limit' || ctx.diagnostics.some(d => d.severity === 'warning');
    return done({ status: partial ? 'partial' : 'ok', document, diagnostics: ctx.diagnostics });
}

// ---------------------------------------------------------------------------
// Preamble
// ---------------------------------------------------------------------------

function readPreamble(raw: string): LatexPreamble {
    const preamble: LatexPreamble = { classOptions: [], packages: [], macros: {}, theorems: {}, shortVerbs: [], inputs: [], raw };
    let i = 0;
    while (i < raw.length) {
        if (raw[i] === '%' && !isEscaped(raw, i)) { i = skipComment(raw, i); continue; }
        if (raw[i] !== '\\') { i++; continue; }
        const name = readControlWord(raw, i);
        if (!name) { i += 2; continue; }
        let at = name.end;
        if (name.value === 'documentclass' || name.value === 'documentstyle') {
            const optional = readOptional(raw, at, raw.length);
            if (optional) at = optional.end;
            const group = readGroup(raw, at, raw.length);
            if (group) {
                preamble.documentClass = group.content.trim();
                preamble.classOptions = splitList(optional?.content ?? '');
                at = group.end;
            }
        } else if (name.value === 'usepackage' || name.value === 'RequirePackage') {
            const optional = readOptional(raw, at, raw.length);
            if (optional) at = optional.end;
            const group = readGroup(raw, at, raw.length);
            if (group) {
                const options = splitList(optional?.content ?? '');
                for (const pkg of splitList(group.content)) preamble.packages.push({ name: pkg, options });
                at = group.end;
            }
        } else if (name.value === 'newcommand' || name.value === 'renewcommand' || name.value === 'providecommand') {
            at = readMacroDefinition(raw, at, preamble.macros);
        } else if (name.value === 'newtheorem') {
            at = readTheoremDefinition(raw, at, preamble.theorems);
        } else if (name.value === 'DeclareMathOperator') {
            at = readMathOperator(raw, at, preamble.macros);
        } else if (INPUT_COMMANDS.has(name.value) && name.value !== 'includegraphics') {
            let cursor = at;
            const optional = readOptional(raw, cursor, raw.length);
            if (optional) cursor = optional.end;
            const group = readGroup(raw, cursor, raw.length);
            if (group?.content.trim()) preamble.inputs.push(group.content.trim());
            at = group ? group.end : cursor;
        } else if (name.value === 'let') {
            at = readLetAlias(raw, at, preamble.macros);
        } else if (name.value === 'MakeShortVerb' || name.value === 'DeleteShortVerb') {
            const cursor = raw[at] === '*' ? at + 1 : at;
            const group = readGroup(raw, skipSpace(raw, cursor), raw.length);
            const character = /^\s*\\(.)\s*$/.exec(group?.content ?? '')?.[1];
            if (character) {
                const existing = preamble.shortVerbs.indexOf(character);
                if (name.value === 'MakeShortVerb') { if (existing === -1) preamble.shortVerbs.push(character); }
                else if (existing !== -1) preamble.shortVerbs.splice(existing, 1);
            }
            at = group ? group.end : cursor;
        }
        i = Math.max(at, i + 1);
    }
    return preamble;
}

/**
 * `\newcommand{\R}{\mathbb{R}}`, `\newcommand\R{\mathbb{R}}`, and the
 * parameterized `\newcommand{\abs}[1]{\lvert#1\rvert}`.
 *
 * Parameterized macros are collected because the *engine* expands them —
 * KaTeX's `macros` option takes `#1`…`#9` — so passing them through is
 * delegation, not the macro interpreter the core refuses to become. What is
 * still skipped is the optional-argument form
 * `\newcommand{\f}[1][default]{…}`: that default has no representation in the
 * engine's macro map, so collecting it would expand to something wrong, which
 * is worse than not expanding at all.
 */
function readMacroDefinition(raw: string, at: number, macros: Record<string, string>): number {
    let name: string | undefined;
    let cursor = skipSpace(raw, at);
    const braced = readGroup(raw, cursor, raw.length);
    if (braced) {
        name = /^\s*\\([a-zA-Z]+)\s*$/.exec(braced.content)?.[1];
        cursor = braced.end;
    } else {
        const control = raw[cursor] === '\\' ? readControlWord(raw, cursor) : null;
        if (control) { name = control.value; cursor = control.end; }
    }
    const arity = readOptional(raw, cursor, raw.length);
    if (arity) cursor = arity.end;
    const optionalDefault = readOptional(raw, cursor, raw.length);
    if (optionalDefault) cursor = optionalDefault.end;
    const bodyGroup = readGroup(raw, cursor, raw.length);
    if (!bodyGroup) return cursor;
    if (name && !optionalDefault) macros[name] = bodyGroup.content;
    return bodyGroup.end;
}

/**
 * `\let\abs=\envert` (the `=` is optional in TeX). Stored as an alias rather
 * than resolved here: engines expand macros recursively, so pointing `\abs` at
 * `\envert` is enough and stays correct whatever `\envert` turns out to be.
 */
function readLetAlias(raw: string, at: number, macros: Record<string, string>): number {
    const alias = readControlWord(raw, skipSpace(raw, at));
    if (!alias) return at;
    let cursor = skipSpace(raw, alias.end);
    if (raw[cursor] === '=') cursor = skipSpace(raw, cursor + 1);
    const target = readControlWord(raw, cursor);
    if (!target) return cursor;
    macros[alias.value] = `\\${target.value}`;
    return target.end;
}

/**
 * amsmath's `\DeclareMathOperator{\per}{per}` — the standard way to define an
 * operator like `\sin`. It is exactly the argument-less substitution shape the
 * macro map already carries, so it is collected as `\operatorname{…}`; without
 * this the engine meets an unknown control sequence and draws its error marker
 * in the middle of an otherwise correct formula. The starred form is
 * `\operatorname*` (limits set below the operator).
 */
function readMathOperator(raw: string, at: number, macros: Record<string, string>): number {
    const starred = raw[at] === '*';
    let cursor = skipSpace(raw, starred ? at + 1 : at);
    let name: string | undefined;
    const braced = readGroup(raw, cursor, raw.length);
    if (braced) {
        name = /^\s*\\([a-zA-Z]+)\s*$/.exec(braced.content)?.[1];
        cursor = braced.end;
    } else {
        const control = raw[cursor] === '\\' ? readControlWord(raw, cursor) : null;
        if (control) { name = control.value; cursor = control.end; }
    }
    const body = readGroup(raw, cursor, raw.length);
    if (!body) return cursor;
    if (name) macros[name] = `\\operatorname${starred ? '*' : ''}{${body.content}}`;
    return body.end;
}

/**
 * `\newtheorem{thm}{Theorem}[section]`, `\newtheorem{cor}[thm]{Corollary}` and
 * the unnumbered `\newtheorem*{notation}{Notation}`. Only the environment name
 * and its printed title are kept — numbering needs a compile pass.
 */
function readTheoremDefinition(raw: string, at: number, theorems: Record<string, string>): number {
    let cursor = raw[at] === '*' ? at + 1 : at;
    cursor = skipSpace(raw, cursor);
    const nameGroup = readGroup(raw, cursor, raw.length);
    if (!nameGroup) return cursor;
    cursor = nameGroup.end;
    // Optional shared counter: \newtheorem{cor}[thm]{Corollary}
    const shared = readOptional(raw, cursor, raw.length);
    if (shared) cursor = shared.end;
    const titleGroup = readGroup(raw, cursor, raw.length);
    if (!titleGroup) return cursor;
    const name = nameGroup.content.trim();
    if (name) theorems[name] = titleGroup.content.trim() || name;
    cursor = titleGroup.end;
    // Optional "numbered within": \newtheorem{thm}{Theorem}[section]
    const within = readOptional(raw, cursor, raw.length);
    return within ? within.end : cursor;
}

// ---------------------------------------------------------------------------
// Block scanning
// ---------------------------------------------------------------------------

function scanBlocks(ctx: ScanContext, start: number, end: number, depth: number): LatexBlock[] {
    const blocks: LatexBlock[] = [];
    const { text } = ctx;
    if (depth > ctx.limits.maxDepth) {
        addDiagnostic(ctx, 'warning', 'latex.depth-exceeded', 'diag.latex.depth-exceeded');
        blocks.push({ kind: 'unsupported', environment: 'nesting', source: text.slice(start, end), span: { start, end } });
        return blocks;
    }

    let i = start;
    let guard = 0;
    while (i < end) {
        if (ctx.stop) break;
        // Cooperative cancellation: block boundaries are the checkpoints.
        if ((guard++ & 0xff) === 0 && ctx.signal?.aborted) { ctx.stop = 'aborted'; break; }
        if (ctx.blocks >= ctx.limits.maxBlocks) { ctx.stop = 'limit'; ctx.stoppedAt = i; break; }

        const ch = text[i]!;
        if (ch === '%' && !isEscaped(text, i)) { i = skipComment(text, i); continue; }
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }

        const read = readBlock(ctx, i, end, depth);
        if (read) {
            blocks.push(...read.blocks);
            i = Math.max(read.next, i + 1);
            continue;
        }

        const paragraphEnd = findParagraphEnd(text, i, end, ctx.shortVerbs);
        const content = parseInline(ctx, text.slice(i, paragraphEnd), depth + 1);
        if (content.length) { blocks.push({ kind: 'paragraph', content, span: { start: i, end: paragraphEnd } }); ctx.blocks++; }
        i = Math.max(paragraphEnd, i + 1);
    }
    return blocks;
}

/** Reads one block-level construct at `at`, or null when a paragraph starts.
 *  Returns a list because transparent environments splice their children in. */
function readBlock(ctx: ScanContext, at: number, end: number, depth: number): { blocks: LatexBlock[]; next: number } | null {
    const { text } = ctx;
    if (text[at] !== '\\' && text[at] !== '$') return null;

    // Display math: $$…$$ and \[…\]
    if (text.startsWith('$$', at)) {
        const close = indexOfCode(text, '$$', at + 2, end);
        if (close !== -1) return { blocks: made(ctx, mathBlock(ctx, text.slice(at + 2, close), at, close + 2, true)), next: close + 2 };
    }
    if (text.startsWith('\\[', at)) {
        const close = indexOfCode(text, '\\]', at + 2, end);
        if (close !== -1) return { blocks: made(ctx, mathBlock(ctx, text.slice(at + 2, close), at, close + 2, true)), next: close + 2 };
    }

    const control = readControlWord(text, at);
    if (!control) return null;

    if (control.value === 'begin') {
        const group = readGroup(text, control.end, end);
        if (!group) return null;
        return readEnvironment(ctx, group.content.trim(), at, group.end, end, depth);
    }
    // A stray `\end` — one whose `\begin` is missing or misspelled. Ending the
    // scan here (the old behaviour) discarded the rest of the document with no
    // diagnostic and a status of `ok`, which is exactly the silent loss L6
    // forbids. It is consumed as an unsupported block so scanning continues and
    // the reader is told the structure is broken.
    if (control.value === 'end') {
        const group = readGroup(text, control.end, end);
        const name = group?.content.trim() || 'end';
        const next = group ? group.end : control.end;
        addDiagnostic(ctx, 'warning', 'latex.unbalanced-environment', 'diag.latex.unbalanced-environment', { environment: name });
        return {
            blocks: made(ctx, { kind: 'unsupported', environment: name, source: text.slice(at, next), span: { start: at, end: next } }),
            next
        };
    }

    const level = ctx.levels[control.value];
    if (level !== undefined && SECTION_COMMANDS.includes(control.value as typeof SECTION_COMMANDS[number])) {
        return readSection(ctx, control.value, level, at, control.end, end, depth);
    }

    if (INPUT_COMMANDS.has(control.value)) {
        let cursor = control.end;
        const optional = readOptional(text, cursor, end);
        if (optional) cursor = optional.end;
        const group = readGroup(text, cursor, end);
        const path = group ? group.content.trim() : '';
        const next = group ? group.end : cursor;
        addDiagnostic(ctx, 'warning', 'latex.unresolved-input', 'diag.latex.unresolved-input', { command: control.value, path: path || '?' });
        return { blocks: made(ctx, { kind: 'unresolved', command: control.value, path, span: { start: at, end: next } }), next };
    }

    return null;
}

function readEnvironment(
    ctx: ScanContext, name: string, start: number, contentStart: number, end: number, depth: number
): { blocks: LatexBlock[]; next: number } {
    const { text } = ctx;
    const verbatim = VERBATIM_ENVIRONMENTS.has(name);
    const closing = findEnvironmentEnd(text, name, contentStart, end, verbatim, ctx.shortVerbs);
    if (!closing) {
        addDiagnostic(ctx, 'warning', 'latex.unbalanced-environment', 'diag.latex.unbalanced-environment', { environment: name });
        return { blocks: made(ctx, { kind: 'unsupported', environment: name, source: text.slice(start, end), span: { start, end } }), next: end };
    }
    const span = { start, end: closing.after };
    const inner = text.slice(contentStart, closing.contentEnd);

    if (verbatim) return { blocks: made(ctx, { kind: 'verbatim', source: inner, span }), next: closing.after };

    if (MATH_ENVIRONMENTS.has(name)) {
        // The renderer parses the environment itself, so delimiters stay in (§2).
        return { blocks: made(ctx, mathBlock(ctx, text.slice(start, closing.after), start, closing.after, true)), next: closing.after };
    }
    if (MATH_INLINE_ENVIRONMENTS.has(name)) {
        return { blocks: made(ctx, mathBlock(ctx, inner, start, closing.after, false)), next: closing.after };
    }

    const theoremTitle = ctx.theorems[name]
        ?? (BUILTIN_THEOREM_ENVIRONMENTS.has(name) ? name.charAt(0).toUpperCase() + name.slice(1) : undefined);
    if (theoremTitle !== undefined) {
        // `\begin{thm}[Cauchy's theorem]` — the optional argument names this
        // particular instance and is part of what the reader needs to see.
        let bodyStart = contentStart;
        const note = readOptional(text, skipSpace(text, bodyStart), closing.contentEnd);
        if (note) bodyStart = note.end;
        const label = readLabel(text, bodyStart, closing.contentEnd);
        if (label) bodyStart = label.end;
        const body = scanBlocks(ctx, bodyStart, closing.contentEnd, depth + 1);
        const noteContent = note ? parseInline(ctx, note.content, depth + 1) : [];
        return {
            blocks: made(ctx, {
                kind: 'theorem', environment: name, title: theoremTitle,
                ...(noteContent.length ? { note: noteContent } : {}),
                ...(label ? { label: label.value } : {}),
                body, span
            }),
            next: closing.after
        };
    }

    // beamer slides and blocks: `\begin{frame}[t]{Title}`, `\begin{block}{Title}`.
    if (TITLED_WRAPPER_ENVIRONMENTS.has(name)) {
        let bodyStart = contentStart;
        const overlay = readOptional(text, skipSpace(text, bodyStart), closing.contentEnd);
        if (overlay) bodyStart = overlay.end;
        const titleGroup = readGroup(text, skipSpace(text, bodyStart), closing.contentEnd);
        if (titleGroup) bodyStart = titleGroup.end;
        const blocks = scanBlocks(ctx, bodyStart, closing.contentEnd, depth + 1);
        const title = titleGroup ? parseInline(ctx, titleGroup.content, depth + 1) : [];
        if (title.length) {
            blocks.unshift({ kind: 'paragraph', content: [{ kind: 'emphasis', style: 'bf', content: title }], span: { start, end: bodyStart } });
            ctx.blocks++;
        }
        return { blocks, next: closing.after };
    }

    // `\begin{column}{0.5\textwidth}` — the width is layout, not content.
    if (SIZED_WRAPPER_ENVIRONMENTS.has(name)) {
        const width = readGroup(text, skipSpace(text, contentStart), closing.contentEnd);
        const bodyStart = width ? width.end : contentStart;
        return { blocks: scanBlocks(ctx, bodyStart, closing.contentEnd, depth + 1), next: closing.after };
    }

    // Transparent wrappers contribute no block of their own — their children are
    // spliced into the parent list so `center`/`abstract` do not read as gaps.
    if (TRANSPARENT_ENVIRONMENTS.has(name)) {
        return { blocks: scanBlocks(ctx, contentStart, closing.contentEnd, depth + 1), next: closing.after };
    }

    const list = LIST_ENVIRONMENTS.get(name);
    if (list !== undefined) {
        return { blocks: made(ctx, readList(ctx, list, inner, contentStart, span, depth, 'item')), next: closing.after };
    }

    if (TABLE_ENVIRONMENTS.has(name)) {
        // `\begin{tabular}{|l|r|}`; tabular*/tabularx take a width first.
        let cursor = skipSpace(text, contentStart);
        if (name === 'tabular*' || name === 'tabularx') {
            const width = readGroup(text, cursor, closing.contentEnd);
            if (width) cursor = skipSpace(text, width.end);
        }
        const position = readOptional(text, cursor, closing.contentEnd);
        if (position) cursor = skipSpace(text, position.end);
        const spec = readGroup(text, cursor, closing.contentEnd);
        const bodyStart = spec ? spec.end : cursor;
        return {
            blocks: made(ctx, readTable(ctx, spec?.content ?? '', text.slice(bodyStart, closing.contentEnd), span, depth)),
            next: closing.after
        };
    }

    if (name === 'thebibliography') {
        // Entries are split on \bibitem, and the environment opens with a
        // mandatory widest-label argument (`\begin{thebibliography}{99}`).
        const widest = readGroup(text, skipSpace(text, contentStart), closing.contentEnd);
        const from = widest ? widest.end : contentStart;
        return {
            blocks: made(ctx, readList(ctx, false, text.slice(from, closing.contentEnd), from, span, depth, 'bibitem')),
            next: closing.after
        };
    }

    if (FLOAT_ENVIRONMENTS.has(name)) {
        // The caption is lifted out for display, but the body is scanned like
        // any other content (L22). Extracting only the caption — the original
        // L7 reading, from before tables rendered — discarded the `tabular` that
        // is the whole point of a `table` float, and not even as source.
        const caption = readCaption(ctx, inner, depth);
        const blocks = scanBlocks(ctx, contentStart, closing.contentEnd, depth + 1);
        return {
            blocks: made(ctx, { kind: 'float', environment: name, ...(caption ? { caption } : {}), blocks, span }),
            next: closing.after
        };
    }

    addDiagnostic(ctx, 'warning', 'latex.unsupported-environment', 'diag.latex.unsupported-environment', { environment: name });
    return { blocks: made(ctx, { kind: 'unsupported', environment: name, source: text.slice(start, closing.after), span }), next: closing.after };
}

/** Records one newly created block against the block budget. Transparent
 *  environments deliberately do not pass through here — their children were
 *  already counted by the nested scan. */
function made(ctx: ScanContext, block: LatexBlock): LatexBlock[] {
    ctx.blocks++;
    return [block];
}

function readSection(
    ctx: ScanContext, command: string, level: number, start: number, after: number, end: number, depth: number
): { blocks: LatexBlock[]; next: number } {
    const { text } = ctx;
    let cursor = after;
    if (text[cursor] === '*') cursor++;
    cursor = skipSpace(text, cursor);
    const optional = readOptional(text, cursor, end);
    if (optional) cursor = optional.end;
    const group = readGroup(text, cursor, end);
    if (!group) {
        addDiagnostic(ctx, 'warning', 'latex.unsupported-command', 'diag.latex.unsupported-command', { command });
        return { blocks: made(ctx, { kind: 'unsupported', environment: command, source: text.slice(start, cursor), span: { start, end: cursor } }), next: cursor };
    }
    const span = { start, end: group.end };
    const title = parseInline(ctx, group.content, depth + 1);
    const label = readLabel(text, group.end, end);
    const id = `heading-${ctx.ordinal++}`;
    if (ctx.outline.length < ctx.limits.maxOutline) {
        ctx.outline.push({ level, text: plainText(title), id, span });
    }
    return { blocks: made(ctx, { kind: 'heading', level, id, title, ...(label ? { label: label.value } : {}), span }), next: label ? label.end : group.end };
}

function readList(
    ctx: ScanContext, ordered: boolean, inner: string, offset: number, span: LatexSpan, depth: number,
    itemCommand: 'item' | 'bibitem'
): LatexBlock {
    const items: LatexBlock[][] = [];
    for (const item of splitItems(inner, itemCommand, ctx.shortVerbs)) {
        const term = item.term ? parseInline(ctx, item.term, depth + 1) : [];
        const blocks = scanBlocks(ctx, offset + item.start, offset + item.end, depth + 1);
        if (term.length) {
            // `\item[Term]` in a description list: the term is the item's whole
            // point, so it leads the first paragraph instead of being dropped.
            const first = blocks[0];
            const lead: LatexInline = { kind: 'emphasis', style: 'bf', content: term };
            if (first?.kind === 'paragraph') first.content.unshift(lead, { kind: 'text', value: ' ' });
            else blocks.unshift({ kind: 'paragraph', content: [lead], span: { start: offset + item.start, end: offset + item.start } });
        }
        items.push(blocks);
    }
    return { kind: 'list', ordered, items, span };
}

/**
 * Splits an environment body on top-level `\item` (or `\bibitem`), keeping the
 * term that labels each entry: `\item[Term]` for description lists and
 * `\bibitem{key}` for bibliographies, whose key is the only handle a reader has
 * without a bibliography pass.
 */
function splitItems(
    inner: string, command: 'item' | 'bibitem' = 'item', shortVerbs: readonly string[] = []
): Array<{ start: number; end: number; term?: string }> {
    const items: Array<{ start: number; end: number; term?: string }> = [];
    let current: { start: number; end: number; term?: string } | null = null;
    let i = 0;
    let braces = 0;
    let nested = 0;
    while (i < inner.length) {
        const ch = inner[i]!;
        if (ch === '%' && !isEscaped(inner, i)) { i = skipComment(inner, i); continue; }
        // A printed `\item` — `\item show \verb|\item| literally` — is content,
        // not a new entry.
        if (shortVerbs.includes(ch)) {
            const close = inner.indexOf(ch, i + 1);
            if (close !== -1) { i = close + 1; continue; }
        }
        if (ch === '\\') {
            const verb = readVerb(inner, i, inner.length);
            if (verb) { i = verb.end; continue; }
            const control = readControlWord(inner, i);
            if (control?.value === 'begin') nested++;
            else if (control?.value === 'end') nested--;
            else if (control?.value === command && braces === 0 && nested === 0) {
                if (current) { current.end = i; items.push(current); }
                let cursor = skipSpace(inner, control.end);
                const optional = readOptional(inner, cursor, inner.length);
                if (optional) cursor = optional.end;
                // \bibitem's key is a mandatory group, \item's term an optional one.
                const key = command === 'bibitem' ? readGroup(inner, cursor, inner.length) : null;
                if (key) cursor = key.end;
                const term = key?.content ?? optional?.content;
                current = { start: cursor, end: inner.length, ...(term ? { term } : {}) };
                i = cursor;
                continue;
            }
            i += control ? control.end - i : 2;
            continue;
        }
        if (ch === '{') braces++;
        else if (ch === '}') braces = Math.max(0, braces - 1);
        i++;
    }
    if (current) { current.end = inner.length; items.push(current); }
    return items;
}

/**
 * `tabular` and friends (L14). Rows split on `\\`, cells on top-level `&`;
 * rules (`\hline`, `\toprule`, `\cline{…}`) carry no content and are dropped.
 * `\multicolumn{n}{spec}{body}` keeps its span so the viewer can emit colspan;
 * `\multirow` is not modelled and degrades to a plain cell.
 */
function readTable(ctx: ScanContext, spec: string, body: string, span: LatexSpan, depth: number): LatexBlock {
    const columns = parseColumnSpec(spec);
    const rows: LatexTableCell[][] = [];
    for (const rawRow of splitTopLevel(body, '\\\\')) {
        const stripped = rawRow.replace(/\\(?:hline|toprule|midrule|bottomrule|cline\s*\{[^}]*\}|noalign\s*\{[^}]*\})/g, '');
        if (!stripped.trim()) continue;
        const cells: LatexTableCell[] = [];
        for (const rawCell of splitTopLevel(stripped, '&')) {
            const multi = readMulticolumn(ctx, rawCell, depth);
            cells.push(multi ?? { content: parseInline(ctx, rawCell, depth + 1) });
        }
        rows.push(cells);
    }
    return { kind: 'table', columns, rows, span };
}

function readMulticolumn(ctx: ScanContext, cell: string, depth: number): LatexTableCell | null {
    const at = findCommand(cell, 'multicolumn', 0, cell.length);
    if (at === -1) return null;
    const control = readControlWord(cell, at);
    if (!control) return null;
    const count = readGroup(cell, control.end, cell.length);
    if (!count) return null;
    const spec = readGroup(cell, count.end, cell.length);
    if (!spec) return null;
    const content = readGroup(cell, spec.end, cell.length);
    if (!content) return null;
    const width = Number.parseInt(count.content.trim(), 10);
    return {
        content: parseInline(ctx, content.content, depth + 1),
        ...(Number.isFinite(width) && width > 1 ? { span: width } : {})
    };
}

/** `|l|r|c|`, `p{3cm}`, `@{}` … — only the alignment letters carry meaning here. */
function parseColumnSpec(spec: string): LatexColumnAlign[] {
    const columns: LatexColumnAlign[] = [];
    let i = 0;
    while (i < spec.length) {
        const ch = spec[i]!;
        if (ch === '{') { const group = readGroup(spec, i, spec.length); i = group ? group.end : i + 1; continue; }
        if (ch === 'l') columns.push('left');
        else if (ch === 'c') columns.push('center');
        else if (ch === 'r') columns.push('right');
        else if (ch === 'p' || ch === 'm' || ch === 'b' || ch === 'X') columns.push('left');
        i++;
    }
    return columns;
}

/**
 * Splits on a delimiter that is not inside braces or escaped.
 *
 * The delimiter is tested *before* escapes are skipped, because the row
 * delimiter is itself a backslash pair: checking escapes first would either eat
 * `\\` as an escape (losing every row break) or, skipping escapes only for the
 * cell delimiter, let `\{` open a brace that never closes — which collapsed a
 * whole table into one row.
 */
function splitTopLevel(source: string, delimiter: string): string[] {
    const parts: string[] = [];
    let start = 0;
    let braces = 0;
    // Environments are tracked as well as braces: a nested `tabular` brings its
    // own `&` and `\\`, which would otherwise be read as the outer table's.
    let environments = 0;
    let i = 0;
    while (i < source.length) {
        const ch = source[i]!;
        if (ch === '%' && !isEscaped(source, i)) { i = skipComment(source, i); continue; }
        if (source.startsWith('\\begin', i)) { environments++; i += 6; continue; }
        if (source.startsWith('\\end', i)) { environments = Math.max(0, environments - 1); i += 4; continue; }
        if (braces === 0 && environments === 0 && source.startsWith(delimiter, i)) {
            parts.push(source.slice(start, i));
            i += delimiter.length;
            // `\\[2pt]` — a row break may carry a vertical-space argument.
            if (delimiter === '\\\\') {
                const optional = readOptional(source, i, source.length);
                if (optional) i = optional.end;
            }
            start = i;
            continue;
        }
        // Any escape — `\{`, `\}`, `\&` — is two characters of content.
        if (ch === '\\') { i += 2; continue; }
        if (ch === '{') { braces++; i++; continue; }
        if (ch === '}') { braces = Math.max(0, braces - 1); i++; continue; }
        i++;
    }
    parts.push(source.slice(start));
    return parts;
}

function readCaption(ctx: ScanContext, inner: string, depth: number): LatexInline[] | undefined {
    const at = findCommand(inner, 'caption', 0, inner.length);
    if (at === -1) return undefined;
    const control = readControlWord(inner, at);
    if (!control) return undefined;
    let cursor = control.end;
    if (inner[cursor] === '*') cursor++;
    const optional = readOptional(inner, cursor, inner.length);
    if (optional) cursor = optional.end;
    const group = readGroup(inner, cursor, inner.length);
    if (!group) return undefined;
    const content = parseInline(ctx, group.content, depth + 1);
    return content.length ? content : undefined;
}

function readGraphicPath(inner: string, at: number): string {
    const control = readControlWord(inner, at);
    if (!control) return '?';
    let cursor = control.end;
    const optional = readOptional(inner, cursor, inner.length);
    if (optional) cursor = optional.end;
    return readGroup(inner, cursor, inner.length)?.content.trim() || '?';
}

/** A `\label{…}` immediately following a construct belongs to it. */
function readLabel(text: string, at: number, end: number): { value: string; end: number } | undefined {
    const cursor = skipSpace(text, at);
    const control = cursor < end && text[cursor] === '\\' ? readControlWord(text, cursor) : null;
    if (control?.value !== 'label') return undefined;
    const group = readGroup(text, control.end, end);
    return group ? { value: group.content.trim(), end: group.end } : undefined;
}

function mathBlock(ctx: ScanContext, source: string, start: number, end: number, display: boolean): LatexBlock {
    const trimmed = source.trim();
    const limit = display ? ctx.limits.maxDisplayMathLength : ctx.limits.maxInlineMathLength;
    if (ctx.mathSegments >= ctx.limits.maxMathSegments || trimmed.length > limit) {
        addDiagnostic(
            ctx, 'warning', 'latex.math-limit-exceeded', 'diag.latex.math-limit-exceeded',
            undefined, () => `line ${lineAt(ctx.text, start)}`
        );
        return { kind: 'unsupported', environment: 'math', source: ctx.text.slice(start, end), span: { start, end } };
    }
    ctx.mathSegments++;
    const label = /\\label\{([^}]*)\}/.exec(trimmed)?.[1];
    return { kind: 'math', source: trimmed, display, ...(label ? { label } : {}), span: { start, end } };
}

/**
 * Paragraph runs to a blank line or the next block-level construct.
 *
 * Inline math is tracked because `$…$` may span source lines and contain
 * environments of its own — `$\left(\begin{smallmatrix}…\end{smallmatrix}\right)$`
 * is one formula, not a paragraph followed by an environment. A blank line still
 * ends the paragraph regardless, which also bounds an unbalanced `$`.
 */
function findParagraphEnd(text: string, from: number, end: number, shortVerbs: readonly string[] = []): number {
    let i = from;
    let inMath = false;
    while (i < end) {
        const ch = text[i]!;
        if (ch === '%' && !isEscaped(text, i)) { i = skipComment(text, i); continue; }
        if (shortVerbs.includes(ch)) {
            const close = text.indexOf(ch, i + 1);
            if (close !== -1 && close < end) { i = close + 1; continue; }
        }
        if (ch === '\\') {
            const verb = readVerb(text, i, end);
            if (verb) { i = verb.end; continue; }
            if (text.startsWith('\\(', i)) { inMath = true; i += 2; continue; }
            if (text.startsWith('\\)', i)) { inMath = false; i += 2; continue; }
            if (!inMath && text.startsWith('\\[', i) && i > from) return i;
            const control = readControlWord(text, i);
            if (!inMath && control && isBlockCommand(control.value) && i > from) return i;
            i += control ? control.end - i : 2;
            continue;
        }
        if (text.startsWith('$$', i)) {
            if (!inMath && i > from) return i;
            i += 2;
            continue;
        }
        if (ch === '$') { inMath = !inMath; i++; continue; }
        if (ch === '\n') {
            const next = skipHorizontalSpace(text, i + 1);
            if (next >= end || text[next] === '\n') return next >= end ? end : next;
            i = next;
            continue;
        }
        i++;
    }
    return end;
}

function isBlockCommand(name: string): boolean {
    return name === 'begin' || name === 'end' || name === 'item'
        || INPUT_COMMANDS.has(name)
        || SECTION_COMMANDS.includes(name as typeof SECTION_COMMANDS[number]);
}

// ---------------------------------------------------------------------------
// Inline scanning
// ---------------------------------------------------------------------------

function parseInline(ctx: ScanContext, source: string, depth: number): LatexInline[] {
    const out: LatexInline[] = [];
    if (depth > ctx.limits.maxDepth) {
        return source.trim() ? [{ kind: 'unsupported', source }] : [];
    }
    let text = '';
    const flush = (): void => {
        if (!text) return;
        out.push({ kind: 'text', value: text });
        text = '';
    };
    const append = (value: string): void => {
        // TeX collapses whitespace runs; doing it here keeps the viewer from
        // having to reason about source line wrapping.
        text += value;
    };

    let i = 0;
    while (i < source.length) {
        const ch = source[i]!;
        if (ch === '%' && !isEscaped(source, i)) { i = skipComment(source, i); continue; }
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
            if (!text.endsWith(' ')) append(' ');
            i++;
            continue;
        }
        if (ch === '~') { append(' '); i++; continue; }
        if (ch === '-' && source.startsWith('---', i)) { append('—'); i += 3; continue; }
        if (ch === '-' && source.startsWith('--', i)) { append('–'); i += 2; continue; }

        if (ch === '$') {
            const close = indexOfCode(source, '$', i + 1, source.length);
            if (close !== -1) {
                flush();
                out.push(inlineMath(ctx, source.slice(i + 1, close)));
                i = close + 1;
                continue;
            }
        }
        if (source.startsWith('\\(', i)) {
            const close = indexOfCode(source, '\\)', i + 2, source.length);
            if (close !== -1) {
                flush();
                out.push(inlineMath(ctx, source.slice(i + 2, close)));
                i = close + 2;
                continue;
            }
        }

        // `\MakeShortVerb{\|}` makes `|…|` inline verbatim; package docs use it
        // to *show* code, so its content must never be interpreted.
        if (ctx.shortVerbs.includes(ch)) {
            const close = source.indexOf(ch, i + 1);
            if (close !== -1) {
                flush();
                out.push({ kind: 'emphasis', style: 'tt', content: [{ kind: 'text', value: source.slice(i + 1, close) }] });
                i = close + 1;
                continue;
            }
        }
        if (ch === '\\') {
            const verb = readVerb(source, i, source.length);
            if (verb) {
                flush();
                out.push({ kind: 'emphasis', style: 'tt', content: [{ kind: 'text', value: verb.content }] });
                i = verb.end;
                continue;
            }
            const control = readControlWord(source, i);
            if (!control) {
                const symbol = source[i + 1] ?? '';
                if ('%$&_#{}'.includes(symbol)) { append(symbol); i += 2; continue; }
                if (symbol === '\\') { if (!text.endsWith(' ')) append(' '); i += 2; continue; }
                if (symbol === ' ') { append(' '); i += 2; continue; }
                flush();
                out.push({ kind: 'unsupported', source: source.slice(i, i + 2) });
                i += 2;
                continue;
            }
            const consumed = readInlineCommand(ctx, source, control, depth, out, flush);
            if (consumed !== null) { i = consumed; continue; }
            flush();
            const group = readGroup(source, control.end, source.length);
            const next = group ? group.end : control.end;
            out.push({ kind: 'unsupported', source: source.slice(i, next) });
            i = next;
            continue;
        }

        if (ch === '{' || ch === '}') { i++; continue; }
        append(ch);
        i++;
    }
    flush();
    return trimInline(out);
}

function readInlineCommand(
    ctx: ScanContext,
    source: string,
    control: { value: string; end: number },
    depth: number,
    out: LatexInline[],
    flush: () => void
): number | null {
    const emphasis = EMPHASIS_COMMANDS.get(control.value);
    if (emphasis) {
        const group = readGroup(source, control.end, source.length);
        if (!group) return null;
        flush();
        out.push({ kind: 'emphasis', style: emphasis, content: parseInline(ctx, group.content, depth + 1) });
        return group.end;
    }
    if (TRANSPARENT_COMMANDS.has(control.value)) {
        const group = readGroup(source, control.end, source.length);
        if (!group) return control.end;
        flush();
        out.push(...parseInline(ctx, group.content, depth + 1));
        return group.end;
    }
    if (REF_COMMANDS.has(control.value)) {
        const group = readGroup(source, control.end, source.length);
        if (!group) return null;
        flush();
        // Cross-reference numbers require a full compile pass; the target key is
        // shown instead of an invented number (§1).
        out.push({ kind: 'ref', target: group.content.trim() });
        return group.end;
    }
    if (CITE_COMMANDS.has(control.value)) {
        let cursor = control.end;
        const optional = readOptional(source, cursor, source.length);
        if (optional) cursor = optional.end;
        const group = readGroup(source, cursor, source.length);
        if (!group) return null;
        flush();
        out.push({ kind: 'cite', keys: splitList(group.content) });
        return group.end;
    }
    if (control.value === 'url') {
        const group = readGroup(source, control.end, source.length);
        if (!group) return null;
        flush();
        const url = group.content.trim();
        out.push({ kind: 'link', url, text: url });
        return group.end;
    }
    if (control.value === 'href') {
        const target = readGroup(source, control.end, source.length);
        if (!target) return null;
        const label = readGroup(source, target.end, source.length);
        if (!label) return null;
        flush();
        out.push({ kind: 'link', url: target.content.trim(), text: plainText(parseInline(ctx, label.content, depth + 1)) });
        return label.end;
    }
    if (control.value === 'label') {
        const group = readGroup(source, control.end, source.length);
        return group ? group.end : control.end;
    }
    // The float's caption is lifted out separately, so the copy in the body is
    // consumed here. `\caption*` and the optional short form both occur, which
    // is why this is not a plain entry in SILENT_COMMANDS.
    if (control.value === 'caption') {
        let cursor = control.end;
        if (source[cursor] === '*') cursor++;
        const optional = readOptional(source, cursor, source.length);
        if (optional) cursor = optional.end;
        const group = readGroup(source, skipSpace(source, cursor), source.length);
        return group ? group.end : cursor;
    }

    // `\let\abs=\envert` — the `=` is optional, so a fixed argument count would
    // leave part of it behind as prose.
    if (control.value === 'let') {
        const alias = readControlWord(source, skipSpace(source, control.end));
        if (!alias) return control.end;
        let cursor = skipSpace(source, alias.end);
        if (source[cursor] === '=') cursor = skipSpace(source, cursor + 1);
        return readControlWord(source, cursor)?.end ?? cursor;
    }

    const discard = CONTENT_COMMANDS.get(control.value);
    if (discard !== undefined) {
        const cursor = skipArguments(source, skipOverlay(source, control.end), discard);
        const group = readGroup(source, skipSpace(source, cursor), source.length);
        if (!group) return cursor;
        flush();
        // `\alert` and friends mark emphasis; the rest merely wrap prose.
        const content = parseInline(ctx, group.content, depth + 1);
        if (control.value === 'alert' || control.value === 'structure') {
            out.push({ kind: 'emphasis', style: 'bf', content });
        } else {
            out.push(...content);
        }
        return group.end;
    }

    const silentArgs = SILENT_COMMANDS.get(control.value);
    if (silentArgs !== undefined) return skipArguments(source, skipOverlay(source, control.end), silentArgs);
    return null;
}

/** beamer overlay specification — `\alert<2->{…}`. It selects a slide, so it
 *  carries nothing a linear preview can show. */
function skipOverlay(source: string, at: number): number {
    if (source[at] !== '<') return at;
    const close = source.indexOf('>', at + 1);
    return close === -1 ? at : close + 1;
}

/**
 * Consumes `count` mandatory arguments after a command. Braces are the usual
 * form, but TeX also accepts a bare token — `\setlength{\multlinegap}0pt` — so a
 * missing group falls back to skipping one unbraced token rather than leaving
 * `0pt` behind as prose.
 */
function skipArguments(source: string, at: number, count: number): number {
    let cursor = at;
    const optional = readOptional(source, cursor, source.length);
    if (optional) cursor = optional.end;
    for (let i = 0; i < count; i++) {
        cursor = skipSpace(source, cursor);
        const group = readGroup(source, cursor, source.length);
        if (group) { cursor = group.end; continue; }
        const control = readControlWord(source, cursor);
        if (control) { cursor = control.end; continue; }
        const bare = /^[^\s{}\\]+/.exec(source.slice(cursor));
        if (!bare) break;
        cursor += bare[0].length;
    }
    return cursor;
}

function inlineMath(ctx: ScanContext, source: string): LatexInline {
    const trimmed = source.trim();
    if (ctx.mathSegments >= ctx.limits.maxMathSegments || trimmed.length > ctx.limits.maxInlineMathLength) {
        addDiagnostic(ctx, 'warning', 'latex.math-limit-exceeded', 'diag.latex.math-limit-exceeded');
        return { kind: 'unsupported', source: `$${source}$` };
    }
    ctx.mathSegments++;
    return { kind: 'math', source: trimmed, display: false };
}

function trimInline(nodes: LatexInline[]): LatexInline[] {
    const first = nodes[0];
    if (first?.kind === 'text') {
        const value = first.value.replace(/^\s+/, '');
        if (value) nodes[0] = { kind: 'text', value }; else nodes.shift();
    }
    const last = nodes[nodes.length - 1];
    if (last?.kind === 'text') {
        const value = last.value.replace(/\s+$/, '');
        if (value) nodes[nodes.length - 1] = { kind: 'text', value }; else nodes.pop();
    }
    return nodes;
}

/** Flattened text of inline nodes — outline labels, link text, copy output. */
export function plainText(nodes: readonly LatexInline[]): string {
    let out = '';
    for (const node of nodes) {
        if (node.kind === 'text') out += node.value;
        else if (node.kind === 'emphasis') out += plainText(node.content);
        else if (node.kind === 'math') out += `$${node.source}$`;
        else if (node.kind === 'ref') out += node.target;
        else if (node.kind === 'cite') out += node.keys.join(', ');
        else if (node.kind === 'link') out += node.text;
        else out += node.source;
    }
    return out.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Low-level scanning helpers
// ---------------------------------------------------------------------------

/** True when the character at `at` is preceded by an odd run of backslashes. */
function isEscaped(text: string, at: number): boolean {
    let slashes = 0;
    for (let i = at - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
    return slashes % 2 === 1;
}

/** Index just past the newline ending the comment at `at` (TeX eats it too). */
function skipComment(text: string, at: number): number {
    const newline = text.indexOf('\n', at);
    return newline === -1 ? text.length : newline + 1;
}

function skipSpace(text: string, at: number): number {
    let i = at;
    while (i < text.length && /\s/.test(text[i]!)) i++;
    return i;
}

function skipHorizontalSpace(text: string, at: number): number {
    let i = at;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r')) i++;
    return i;
}

/**
 * `\verb<delim>…<delim>` inline verbatim. Its body is *not* LaTeX, so it has to
 * be recognized before anything else scans it — `\verb|\section|` in a manual
 * would otherwise start a section and swallow the rest of the paragraph.
 * The delimiter is the character right after `\verb`, so trailing-space eating
 * (readControlWord) must not be applied here.
 */
function readVerb(text: string, at: number, limit: number): { content: string; end: number } | null {
    let i = at + 1;
    while (i < limit && /[a-zA-Z]/.test(text[i]!)) i++;
    if (text.slice(at + 1, i) !== 'verb') return null;
    if (text[i] === '*') i++;
    const delimiter = text[i];
    if (delimiter === undefined || delimiter === '\n' || i >= limit) return null;
    const close = text.indexOf(delimiter, i + 1);
    if (close === -1 || close >= limit) return null;
    return { content: text.slice(i + 1, close), end: close + 1 };
}

/** `\name` (letters only, TeX control-word rule), with trailing spaces eaten. */
function readControlWord(text: string, at: number): { value: string; end: number } | null {
    if (text[at] !== '\\') return null;
    let i = at + 1;
    while (i < text.length && /[a-zA-Z]/.test(text[i]!)) i++;
    if (i === at + 1) return null;
    return { value: text.slice(at + 1, i), end: skipHorizontalSpace(text, i) };
}

function readGroup(text: string, at: number, limit: number): { content: string; end: number } | null {
    if (text[at] !== '{') return null;
    let depth = 0;
    let i = at;
    while (i < limit) {
        const ch = text[i]!;
        if (ch === '%' && !isEscaped(text, i)) { i = skipComment(text, i); continue; }
        if (ch === '\\') { i += 2; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return { content: text.slice(at + 1, i), end: i + 1 }; }
        i++;
    }
    return null;
}

function readOptional(text: string, at: number, limit: number): { content: string; end: number } | null {
    if (text[at] !== '[') return null;
    let braces = 0;
    let i = at + 1;
    while (i < limit) {
        const ch = text[i]!;
        if (ch === '%' && !isEscaped(text, i)) { i = skipComment(text, i); continue; }
        if (ch === '\\') { i += 2; continue; }
        if (ch === '{') braces++;
        else if (ch === '}') braces = Math.max(0, braces - 1);
        else if (ch === ']' && braces === 0) return { content: text.slice(at + 1, i), end: i + 1 };
        i++;
    }
    return null;
}

/**
 * Locates a document boundary, ignoring matches inside comments, `\verb` spans
 * and verbatim environments. Package documentation prints `\end{document}`
 * inside a `verbatim` block as an example; treating that as the real end
 * truncated everything after it — body, outline and all.
 */
function findOutsideVerbatim(text: string, needle: string, from: number): number {
    let i = from;
    while (i < text.length) {
        const ch = text[i]!;
        if (ch === '%' && !isEscaped(text, i)) { i = skipComment(text, i); continue; }
        if (ch === '\\') {
            const verb = readVerb(text, i, text.length);
            if (verb) { i = verb.end; continue; }
            const opening = /^\\begin\s*\{([^}]+)\}/.exec(text.slice(i));
            const environment = opening?.[1]?.trim();
            if (environment && VERBATIM_ENVIRONMENTS.has(environment)) {
                const closing = `\\end{${environment}}`;
                const at = text.indexOf(closing, i + opening![0].length);
                i = at === -1 ? text.length : at + closing.length;
                continue;
            }
            if (text.startsWith(needle, i)) return i;
            i += 2;
            continue;
        }
        i++;
    }
    return -1;
}

/** indexOf that ignores matches inside comments. */
function indexOfCode(text: string, needle: string, from: number, limit = text.length): number {
    let i = from;
    while (i < limit) {
        const ch = text[i]!;
        if (ch === '%' && !isEscaped(text, i)) { i = skipComment(text, i); continue; }
        if (text.startsWith(needle, i) && !isEscaped(text, i)) return i + needle.length <= limit ? i : -1;
        i++;
    }
    return -1;
}

/** Position of `\name` outside comments, or -1. */
function findCommand(text: string, name: string, from: number, limit: number): number {
    let i = from;
    while (i < limit) {
        const ch = text[i]!;
        if (ch === '%' && !isEscaped(text, i)) { i = skipComment(text, i); continue; }
        if (ch === '\\') {
            const control = readControlWord(text, i);
            if (control?.value === name) return i;
            i += control ? Math.max(1, control.end - i) : 2;
            continue;
        }
        i++;
    }
    return -1;
}

/**
 * Matching `\end{name}`, honoring nesting of the same environment.
 *
 * Quoted regions are skipped, because a document that *prints* `\end{itemize}`
 * — via `\verb`, a short-verb delimiter, or a nested verbatim block — would
 * otherwise close the environment at the printed text, spilling the rest of the
 * list into the body and leaving a stray `\end` behind.
 */
function findEnvironmentEnd(
    text: string, name: string, from: number, limit: number, verbatim: boolean,
    shortVerbs: readonly string[] = []
): { contentEnd: number; after: number } | null {
    const closing = `\\end{${name}}`;
    if (verbatim) {
        const at = text.indexOf(closing, from);
        return at === -1 || at > limit ? null : { contentEnd: at, after: at + closing.length };
    }
    const opening = `\\begin{${name}}`;
    let depth = 1;
    let i = from;
    while (i < limit) {
        const ch = text[i]!;
        if (ch === '%' && !isEscaped(text, i)) { i = skipComment(text, i); continue; }
        if (shortVerbs.includes(ch)) {
            const close = text.indexOf(ch, i + 1);
            if (close !== -1 && close < limit) { i = close + 1; continue; }
        }
        if (ch !== '\\') { i++; continue; }
        const verb = readVerb(text, i, limit);
        if (verb) { i = verb.end; continue; }
        const nested = /^\\begin\s*\{([^}]+)\}/.exec(text.slice(i, limit));
        const nestedName = nested?.[1]?.trim();
        if (nestedName && nestedName !== name && VERBATIM_ENVIRONMENTS.has(nestedName)) {
            const nestedClose = `\\end{${nestedName}}`;
            const at = text.indexOf(nestedClose, i + nested![0].length);
            i = at === -1 || at >= limit ? limit : at + nestedClose.length;
            continue;
        }
        if (text.startsWith(opening, i)) { depth++; i += opening.length; continue; }
        if (text.startsWith(closing, i)) {
            depth--;
            if (depth === 0) return { contentEnd: i, after: i + closing.length };
            i += closing.length;
            continue;
        }
        i += 2;
    }
    return null;
}

function splitList(value: string): string[] {
    return value.split(',').map(item => item.trim()).filter(item => item.length > 0);
}

function addDiagnostic(
    ctx: ScanContext, severity: Diagnostic['severity'], code: string, messageKey: string,
    args?: Record<string, string | number>,
    // A thunk, because computing a location is a scan from the top of the file
    // and almost every call is a duplicate that gets dropped below. Evaluating
    // it eagerly made one O(n) pass per *occurrence*: a 700 KB document of
    // formulas past the segment limit took 71 s instead of 79 ms.
    location?: string | (() => string)
): void {
    // One diagnostic per distinct cause: a document with 400 tikzpictures should
    // report "tikzpicture is unsupported" once, not 400 times.
    const key = `${code}|${JSON.stringify(args ?? {})}`;
    if (ctx.seen.has(key) || ctx.seen.size >= MAX_DIAGNOSTICS) return;
    ctx.seen.add(key);
    const resolved = typeof location === 'function' ? location() : location;
    ctx.diagnostics.push({
        severity, code, messageKey,
        ...(args ? { args } : {}),
        ...(resolved ? { location: resolved } : {})
    });
}
