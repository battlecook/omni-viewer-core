// JUnit XML test report parser — a contract parser (DESIGN.md §3-①): bytes or
// text in, `ParseOutcome<JUnitDocument>` out, input-caused failures returned as
// `status: 'failed'` instead of thrown.
//
// The report is XML, so the core XML scanner does the reading (no DOM, no
// external entities, bounded internal expansion); this layer only walks its
// node arena. Writers verified against real output (docs/viewers/junit.md §2):
// Gradle 8 (JUnit 5), the Android Gradle plugin's connected tests, pytest 9
// (xunit1 and xunit2 families), vitest 4, and the Jenkins JUnit plugin's
// nested-suite fixtures. Maven Surefire's flaky/rerun elements follow its
// published XSD; no real Surefire file was available to check them against.
//
// Counts are always recomputed from the cases. Writers disagree on what the
// declared attributes mean (Ant's `tests` includes failures, vitest counts an
// uncaught throw as a failure, Jenkins fixtures declare totals the file does
// not hold), so the declared values are kept for comparison only.

import { XML_DEFAULT_MAX_DEPTH, parseXml, type XmlDocument, type XmlNode } from '../xml/index.js';
import type { Diagnostic, ParseOptions, ParseOutcome, ParseResult } from '../types.js';
import { formatMillis } from '../har/index.js';
import type {
    JUnitCase,
    JUnitCounts,
    JUnitDeclaredCounts,
    JUnitDocument,
    JUnitProperty,
    JUnitResult,
    JUnitResultKind,
    JUnitStatus,
    JUnitSuite,
    JUnitSummaryItem
} from './model.js';

export { looksLikeJUnit } from './sniff.js';
export type {
    JUnitCase,
    JUnitCounts,
    JUnitDeclaredCounts,
    JUnitDocument,
    JUnitProperty,
    JUnitResult,
    JUnitResultKind,
    JUnitStatus,
    JUnitSuite,
    JUnitSummaryItem
} from './model.js';

/** Input ownership: borrows the input; the caller keeps the bytes (DESIGN §3-①). */
export const JUNIT_INPUT_OWNERSHIP = 'borrows' as const;
export const JUNIT_DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024;
/** Test cases kept; the rest are counted in `droppedCases`. */
export const JUNIT_DEFAULT_MAX_CASES = 100_000;
/** Suites kept. Each holds its counts, properties and a path of up to
 *  MAX_SUITE_DEPTH names, so an empty-suite flood must be bounded too. Suites
 *  past it are skipped with everything inside them. */
export const JUNIT_DEFAULT_MAX_SUITES = 50_000;
/** XML nodes scanned. A plain case is ~4 nodes (element and attributes) and
 *  one with captured output ~8, so ordinary reports reach the case cap first;
 *  property-heavy ones can stop here, which the model reports as a cut. Each
 *  node is a live object, so this is a memory bound, not just a count. */
export const JUNIT_DEFAULT_MAX_NODES = 2_000_000;
/** Characters kept per stack trace, skip reason, or stdout/stderr block. */
export const JUNIT_DEFAULT_MAX_TEXT_CHARS = 64 * 1024;
/** Characters kept across every stdout/stderr block of the report. Captured
 *  output is what makes a report large; the detail pane shows a preview. */
export const JUNIT_DEFAULT_MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
/** Suite nesting followed. Real reports nest a handful of levels. */
const MAX_SUITE_DEPTH = 64;
const MAX_PROPERTIES = 500;
/** Result elements kept per case. A hostile or broken report can attach
 *  millions to one case; past this only their kinds are kept, so the
 *  outcome still reflects every element. */
export const JUNIT_MAX_CASE_RESULTS = 100;
/** Cases between cooperative abort checkpoints. */
const CHECKPOINT_INTERVAL = 256;

export interface JUnitParseOptions extends ParseOptions {
    /** Characters kept per result text or output block (default JUNIT_DEFAULT_MAX_TEXT_CHARS). */
    maxTextChars?: number;
    /** Suites kept (default JUNIT_DEFAULT_MAX_SUITES). */
    maxSuites?: number;
    /** Characters kept across all output blocks (default JUNIT_DEFAULT_MAX_OUTPUT_CHARS). */
    maxOutputChars?: number;
}

/** XML errors the scanner recovers from without losing or moving a node:
 *  a bad character or entity reference, a stray '&' or '<' in text or an
 *  attribute, attribute spacing. Every other error or limit may cut content. */
const LEXICAL_XML_DIAGNOSTICS: ReadonlySet<string> = new Set([
    'xml-invalid-char-ref', 'xml-bare-ampersand', 'xml-lt-in-attribute', 'xml-entity-lt-in-attribute',
    'xml-duplicate-attribute', 'xml-missing-attribute-space', 'xml-undeclared-prefix', 'xml-undefined-entity',
    'xml-unescaped-lt', 'xml-unsupported-encoding',
    // A declaration or DOCTYPE in the wrong place (after a blank line, or
    // repeated) is skipped without touching the element tree.
    'xml-misplaced-declaration', 'xml-misplaced-doctype',
    // Text after the root (a trailing "EOF", a DOS Ctrl-Z) holds no element;
    // a second root is caught by the tree check instead.
    'xml-text-outside-root'
]);

const RESULT_KINDS: ReadonlySet<string> = new Set(['failure', 'error', 'skipped', 'flakyFailure', 'flakyError', 'rerunFailure', 'rerunError']);
export function parseJUnit(input: Uint8Array | string, options: JUnitParseOptions = {}): ParseOutcome<JUnitDocument> {
    const started = Date.now();
    const finish = (result: ParseResult<JUnitDocument>): ParseOutcome<JUnitDocument> => ({
        result,
        execution: { workerUsed: false, hardLimitEnforced: false, elapsedMillis: Date.now() - started }
    });
    const xml = parseXml(input, {
        ...(options.signal ? { signal: options.signal } : {}),
        limits: {
            maxInputBytes: options.limits?.maxInputBytes ?? JUNIT_DEFAULT_MAX_INPUT_BYTES,
            maxEntries: JUNIT_DEFAULT_MAX_NODES
        },
        // The XML scanner stops the whole scan at its depth cap, so it gets the
        // generic viewer's generous one; suites past MAX_SUITE_DEPTH are skipped
        // here instead, and the suites after them still read.
        maxDepth: XML_DEFAULT_MAX_DEPTH
    }).result;
    if (xml.status === 'failed') return finish(xml);
    const root = xml.document.root!;
    if (root.prefix !== '' || (root.name !== 'testsuites' && root.name !== 'testsuite')) {
        return finish({
            status: 'failed',
            failure: { code: 'invalid-format', retryable: false, messageKey: 'diag.junit.notJunit', args: { root: root.name } },
            diagnostics: xml.diagnostics
        });
    }
    const diagnostics: Diagnostic[] = [...xml.diagnostics];
    // A scan that recovered from a structural error may have stopped early or
    // skipped content (a second root, as concatenated reports have), so no
    // verdict may be drawn from the cases alone. Lexical errors — Surefire
    // writes `&#27;` for ANSI escapes, which XML 1.0 forbids — keep every node.
    // The diagnostic list is capped (XML_MAX_DIAGNOSTICS), and Surefire's
    // colored logs alone can fill it, so the tree itself is checked too: a
    // second top-level element or an element left unclosed means lost content.
    // Codes come from the uncapped list on the document: Surefire's `&#27;`
    // alone can fill the capped diagnostic list. The scanner's two info-level
    // codes (markup in an internal entity, an unread external entity) drop
    // elements too, so only the lexical set and the list-overflow note pass.
    const reportedCodes = xml.document.diagnosticCodes ?? xml.diagnostics.map(diagnostic => diagnostic.code);
    const structuralLoss = reportedCodes.some(code => !LEXICAL_XML_DIAGNOSTICS.has(code) && code !== 'xml-more-diagnostics')
        || xml.document.topLevel.filter(node => node.kind === 'element').length > 1
        || xml.document.nodes.some(node => node.kind === 'element' && node.closed === false);
    const reader = new JUnitReader(xml.document, options, diagnostics, structuralLoss);
    const model = reader.read(root);
    if (model === null) return finish({ status: 'failed', failure: { code: 'aborted', retryable: true, messageKey: 'diag.aborted' }, diagnostics });
    if (structuralLoss) model.incomplete = true;
    // Clipped stack traces and output are previews, flagged per item. Only
    // content that may be missing — the case or depth cap, a structural XML
    // recovery — makes the model partial; lexical XML errors such as
    // Surefire's `&#27;` leave every node in place and stay diagnostics.
    const partial = model.incomplete;
    return finish({ status: partial ? 'partial' : 'ok', document: model, diagnostics });
}

class JUnitReader {
    readonly suites: JUnitSuite[] = [];
    readonly cases: JUnitCase[] = [];
    private readonly maxCases: number;
    private readonly maxTextChars: number;
    private outputBudget: number;
    private dropped = 0;
    /** Suites (with their ancestors) that may hold fewer cases than the file:
     *  the case cap, the suite depth cap, or a scan cut short. */
    private readonly truncatedSuites = new Set<number>();
    private aborted = false;
    depthCut = false;
    /** The report is pytest's: its `line` counts from 0, and it splits a test
     *  that errors on teardown into extra records. */
    private pytest = false;
    private outputExhausted = false;
    /** The latest non-synthetic case by suite, classname and name. */
    /** Per test, the records a pytest teardown record may still fold into
     *  (failed call, no teardown error yet), latest last. Only candidates are
     *  kept, so finding the target is O(1) however often a name repeats. */
    private readonly foldCandidates = new Map<string, JUnitCase[]>();
    /** Test case records seen, for abort checkpoints on paths that add no case. */
    private records = 0;
    /** A case directly under the root was cut or miscounted (see markIncomplete). */
    private rootUncomparable = false;
    private droppedSuites = 0;
    private readonly maxSuites: number;
    /** Result elements past JUNIT_MAX_CASE_RESULTS, by case. */
    private readonly overflows = new Map<JUnitCase, ResultOverflow>();

    constructor(
        private readonly xml: XmlDocument,
        private readonly options: JUnitParseOptions,
        private readonly diagnostics: Diagnostic[],
        /** The XML scan lost or may have lost content (see parseJUnit). */
        private readonly structuralLoss: boolean
    ) {
        this.maxCases = options.limits?.maxEntries ?? JUNIT_DEFAULT_MAX_CASES;
        // At least the root suite of a single-suite report is always read.
        this.maxSuites = Math.max(1, options.maxSuites ?? JUNIT_DEFAULT_MAX_SUITES);
        this.maxTextChars = options.maxTextChars ?? JUNIT_DEFAULT_MAX_TEXT_CHARS;
        this.outputBudget = options.maxOutputChars ?? JUNIT_DEFAULT_MAX_OUTPUT_CHARS;
    }

    read(root: XmlNode): JUnitDocument | null {
        // pytest names its root `<testsuites name="pytest tests">` (pytest 8+),
        // an unnamed `<testsuites>` around `<testsuite name="pytest">` (5.1–7),
        // or a bare `<testsuite name="pytest">` (before 5.1).
        this.pytest = attr(root, 'name') === 'pytest tests' || attr(root, 'name') === 'pytest' || looksLikePytest7(root);
        let properties: JUnitProperty[] = [];
        if (root.name === 'testsuite') {
            this.readSuite(root, -1, []);
        } else {
            for (const child of root.children) {
                if (this.aborted) break;
                if (child.kind !== 'element') continue;
                if (child.name === 'testsuite') this.readSuite(child, -1, []);
                // Some writers (Jest-JUnit with `includeConsoleOutput`, CTest)
                // place cases straight under the root.
                else if (child.name === 'testcase') this.readCase(child, -1);
                else if (child.name === 'properties') properties = this.readProperties(child);
            }
        }
        if (this.aborted) return null;
        if (this.droppedSuites > 0) {
            this.diagnostics.push({ severity: 'warning', code: 'junit-suite-limit', messageKey: 'diag.junit.suiteLimit', args: { max: this.maxSuites } });
        }
        if (this.depthCut) {
            this.diagnostics.push({ severity: 'warning', code: 'junit-depth-limit', messageKey: 'diag.junit.depthLimit', args: { depth: MAX_SUITE_DEPTH } });
        }
        if (this.outputExhausted) {
            this.diagnostics.push({ severity: 'info', code: 'junit-output-budget', messageKey: 'diag.junit.outputBudget', args: { chars: this.options.maxOutputChars ?? JUNIT_DEFAULT_MAX_OUTPUT_CHARS } });
        }
        if (this.dropped > 0) {
            // Cases the scan or the depth cap never reached (a node-limit stop,
            // a second root, suites nested too deep) are not in the count, so
            // the total is then only a lower bound.
            const messageKey = this.structuralLoss || this.depthCut || this.droppedSuites > 0 ? 'diag.junit.caseLimitAtLeast' : 'diag.junit.caseLimit';
            this.diagnostics.push({ severity: 'warning', code: 'junit-case-limit', messageKey, args: { shown: this.cases.length, total: this.cases.length + this.dropped } });
        }

        // Roll each suite's own cases up through its ancestors. Suites are in
        // pre-order, so walking backwards finishes every child before its parent.
        for (const testCase of this.cases) if (testCase.suite >= 0) tally(this.suites[testCase.suite]!.counts, testCase);
        for (let i = this.suites.length - 1; i >= 0; i--) {
            const suite = this.suites[i]!;
            if (suite.parent >= 0) addCounts(this.suites[suite.parent]!.counts, suite.counts);
        }
        const counts = emptyCounts();
        for (const testCase of this.cases) tally(counts, testCase);

        const single = root.name === 'testsuite';
        const declared = single ? this.suites[0]!.declared : declaredCounts(root);
        // Counts short only because the case cap dropped cases are not a
        // disagreement in the file; the case-limit diagnostic explains them.
        const rootCut = this.dropped > 0 || this.droppedSuites > 0 || this.depthCut || root.closed === false;
        // Any suite left out of the comparison takes the root with it: the
        // root's totals cover that suite's cases too.
        // A structural XML recovery can move cases anywhere (into an unclosed
        // <system-out>, say), so no declared total is compared after one.
        const countMismatch = !rootCut && !this.structuralLoss && !this.rootUncomparable && this.truncatedSuites.size === 0 && declaredMismatch(declared, counts);
        let mismatchedSuites = single || !countMismatch ? 0 : 1;
        for (const suite of this.suites) {
            suite.countMismatch = !this.structuralLoss && !this.truncatedSuites.has(suite.index) && declaredMismatch(suite.declared, suite.counts);
            if (suite.countMismatch) mismatchedSuites++;
        }
        if (mismatchedSuites > 0) {
            this.diagnostics.push({ severity: 'info', code: 'junit-count-mismatch', messageKey: 'diag.junit.countMismatch', args: { count: mismatchedSuites } });
        }

        let time = single ? this.suites[0]!.time : parseSeconds(attr(root, 'time'));
        if (time === null) {
            const topLevel = this.suites.filter(suite => suite.parent === -1 && suite.time !== null);
            if (topLevel.length) time = topLevel.reduce((sum, suite) => sum + suite.time!, 0);
        }
        const classnames: string[] = [];
        const seen = new Set<string>();
        for (const testCase of this.cases) {
            if (testCase.classname && !seen.has(testCase.classname)) { seen.add(testCase.classname); classnames.push(testCase.classname); }
        }
        const timestamp = single ? this.suites[0]!.timestamp
            : attr(root, 'timestamp') || this.suites.find(suite => suite.timestamp)?.timestamp || '';
        return {
            format: 'junit',
            rootKind: single ? 'testsuite' : 'testsuites',
            name: single ? '' : attr(root, 'name'),
            time,
            timestamp,
            declared,
            counts,
            countMismatch,
            incomplete: rootCut,
            suites: this.suites,
            cases: this.cases,
            properties,
            classnames,
            mismatchedSuites,
            droppedCases: this.dropped,
            text: this.xml.text,
            summary: summaryOf(counts, time, this.suites.length)
        };
    }

    private readSuite(node: XmlNode, parent: number, parentPath: readonly string[]): void {
        const depth = parentPath.length;
        if (++this.records % CHECKPOINT_INTERVAL === 0 && this.options.signal?.aborted) { this.aborted = true; return; }
        if (depth >= MAX_SUITE_DEPTH) { this.depthCut = true; this.markIncomplete(parent); return; }
        if (this.suites.length >= this.maxSuites) { this.droppedSuites++; this.markIncomplete(parent); return; }
        const name = attr(node, 'name');
        const suite: JUnitSuite = {
            index: this.suites.length,
            parent,
            depth,
            name,
            path: [...parentPath, name],
            id: attr(node, 'id'),
            package: attr(node, 'package'),
            hostname: attr(node, 'hostname'),
            timestamp: attr(node, 'timestamp'),
            file: attr(node, 'file') || attr(node, 'filepath'),
            time: parseSeconds(attr(node, 'time')),
            declared: declaredCounts(node),
            counts: emptyCounts(),
            countMismatch: false,
            ownCases: 0,
            properties: [],
            systemOut: '',
            systemErr: '',
            outputTruncated: false
        };
        this.suites.push(suite);
        // An end tag the scanner never reached (a truncated file, or the node
        // or depth limit) means this suite's content may be cut short.
        if (node.closed === false) this.markIncomplete(suite.index);
        const out: string[] = [];
        const err: string[] = [];
        // Suite-level <failure>/<error> become one synthetic case, placed where
        // the first of them stands so cases keep document order (a setup error
        // usually comes first), and so it shows in the list and the totals.
        let synthetic: JUnitCase | undefined;
        let syntheticDropped = false;
        for (const child of node.children) {
            if (this.aborted) return;
            if (child.kind !== 'element' || child.prefix !== '') continue;
            switch (child.name) {
                case 'testcase': if (this.readCase(child, suite.index)) suite.ownCases++; break;
                case 'testsuite': this.readSuite(child, suite.index, suite.path); break;
                case 'properties': suite.properties = this.readProperties(child); break;
                case 'system-out': out.push(textOf(child)); break;
                case 'system-err': err.push(textOf(child)); break;
                case 'failure': case 'error': {
                    if (synthetic) this.addResult(synthetic, child);
                    else if (!syntheticDropped) {
                        if (this.pushCase({
                            suite: suite.index, name, classname: suite.package || name, file: suite.file, line: null, time: null,
                            results: [this.readResult(child)], droppedResults: 0, properties: [], systemOut: '', systemErr: '', outputTruncated: false, synthetic: true
                        })) {
                            synthetic = this.cases[this.cases.length - 1]!;
                            suite.ownCases++;
                        } else syntheticDropped = true;
                    }
                    break;
                }
            }
        }
        const output = this.takeOutput(out, err);
        suite.systemOut = output.out;
        suite.systemErr = output.err;
        suite.outputTruncated = output.truncated;
        // Later results may outrank the first (an <error> after a <failure>).
        if (synthetic) this.refresh(synthetic);
    }

    /** Returns false when the case cap dropped it. */
    private readCase(node: XmlNode, suite: number): boolean {
        // Dropped and folded records add no case, so pushCase's checkpoint
        // alone would never see them.
        if (++this.records % CHECKPOINT_INTERVAL === 0 && this.options.signal?.aborted) { this.aborted = true; return false; }
        // At the cap a record is still read when its test already has a case:
        // a pytest teardown record folds into it and adds no case.
        if (this.cases.length >= this.maxCases
            && !this.foldTarget(caseKey(suite, attr(node, 'classname') || attr(node, 'class'), attr(node, 'name')))) {
            this.drop(suite);
            return false;
        }
        const results: JUnitResult[] = [];
        const overflow: ResultOverflow = { count: 0, kinds: new Set() };
        let properties: JUnitProperty[] = [];
        const out: string[] = [];
        const err: string[] = [];
        for (const child of node.children) {
            if (child.kind !== 'element' || child.prefix !== '') continue;
            if (RESULT_KINDS.has(child.name)) {
                if (results.length < JUNIT_MAX_CASE_RESULTS) results.push(this.readResult(child));
                else { overflow.count++; overflow.kinds.add(child.name); }
            }
            else if (child.name === 'properties') properties = this.readProperties(child);
            // pytest writes one pair per captured phase, so a skipped case can
            // carry two of each; they are joined rather than the first kept.
            else if (child.name === 'system-out') out.push(textOf(child));
            else if (child.name === 'system-err') err.push(textOf(child));
        }
        // GoogleTest marks a DISABLED_ test with attributes alone
        // (`status="notrun" result="suppressed"`), no <skipped> element.
        if (!results.some(result => result.kind === 'skipped' || result.kind === 'failure' || result.kind === 'error')
            && (attr(node, 'status') === 'notrun' || attr(node, 'result') === 'suppressed' || attr(node, 'result') === 'skipped')) {
            results.push({ kind: 'skipped', message: attr(node, 'result'), type: '', text: '', truncated: false, systemOut: '', systemErr: '', outputTruncated: false });
        }
        // A case whose end tag the file never reached (a truncated report) has
        // an unknown outcome unless a result element made it in: counting it as
        // passed would inflate the pass rate. The model is already incomplete.
        if (node.closed === false) {
            // Whatever the scanner nested into an unclosed case (the cases
            // after it, under a mistyped end tag) is lost to the suite, so its
            // declared totals are not compared.
            this.markIncomplete(suite);
            if (!results.some(result => result.kind === 'failure' || result.kind === 'error' || result.kind === 'skipped')) return false;
        }
        const output = this.takeOutput(out, err);
        // pytest's own wording, so this holds whatever the suite is named.
        if (results.some(isTeardownError)) {
            // pytest counts a teardown error in its own way — a test that failed
            // its call and errored on teardown is written as two records but
            // counted once, and one that passed its call is counted twice — so
            // the declared totals above it are not compared.
            this.markIncomplete(suite);
            // The second record of the same test carries only the teardown
            // error: fold it into the first, so one test stays one case. Under
            // pytest-xdist other workers' records land in between, and with
            // `--dist each` every worker runs the test, so the target is the
            // test's latest record that has not taken a teardown error yet.
            const key = caseKey(suite, attr(node, 'classname') || attr(node, 'class'), attr(node, 'name'));
            const previous = this.foldTarget(key);
            if (previous && results.every(result => result.kind === 'error') && overflow.count === 0) {
                for (const result of results) {
                    if (previous.results.length < JUNIT_MAX_CASE_RESULTS) previous.results.push(result);
                    else this.overflowOf(previous, result.kind);
                }
                previous.systemOut = [previous.systemOut, output.out].filter(text => text).join('\n');
                previous.systemErr = [previous.systemErr, output.err].filter(text => text).join('\n');
                previous.outputTruncated ||= output.truncated;
                // The teardown record carries its own phase time (often the only
                // nonzero one, as the call recorded 0.000); the test took both.
                const time = parseSeconds(attr(node, 'time'));
                if (time !== null) previous.time = (previous.time ?? 0) + time;
                this.refresh(previous);
                // It now holds a teardown error: no longer a candidate.
                this.foldCandidates.get(key)!.pop();
                return false;
            }
        }
        const line = attr(node, 'line');
        return this.pushCase({
            suite,
            name: attr(node, 'name'),
            classname: attr(node, 'classname') || attr(node, 'class'),
            file: attr(node, 'file'),
            // pytest records the 0-based line of the `def`; every other writer
            // (PHPUnit, GoogleTest) is 1-based, which is what the model holds.
            line: /^\d+$/.test(line) ? Number(line) + (this.pytest ? 1 : 0) : null,
            time: parseSeconds(attr(node, 'time')),
            results,
            properties,
            systemOut: output.out,
            systemErr: output.err,
            outputTruncated: output.truncated,
            droppedResults: 0,
            synthetic: false
        }, overflow) && this.rememberLatest();
    }

    /** Counts a case the cap dropped against its suite and every ancestor. */
    private drop(suite: number): void {
        this.dropped++;
        this.markIncomplete(suite);
    }

    /** Marks a suite and its ancestors as not comparable with their declared
     *  totals: they hold fewer cases than the file, or (pytest teardown errors)
     *  the writer's totals count differently. */
    private markIncomplete(suite: number): void {
        // A case directly under <testsuites> has no suite; the root takes it.
        if (suite < 0) this.rootUncomparable = true;
        for (let current = suite; current >= 0 && !this.truncatedSuites.has(current); current = this.suites[current]!.parent) {
            this.truncatedSuites.add(current);
        }
    }

    private pushCase(fields: Omit<JUnitCase, 'index' | 'status' | 'flaky'>, overflow?: ResultOverflow): boolean {
        if (this.cases.length >= this.maxCases) { this.drop(fields.suite); return false; }
        if (this.cases.length % CHECKPOINT_INTERVAL === 0 && this.options.signal?.aborted) { this.aborted = true; return false; }
        const testCase: JUnitCase = { ...fields, index: this.cases.length, status: 'passed', flaky: false };
        if (overflow && overflow.count > 0) this.overflows.set(testCase, overflow);
        this.refresh(testCase);
        this.cases.push(testCase);
        return true;
    }

    /** Appends a result element to a case, past the cap by kind only. */
    private addResult(testCase: JUnitCase, node: XmlNode): void {
        if (testCase.results.length < JUNIT_MAX_CASE_RESULTS) testCase.results.push(this.readResult(node));
        else this.overflowOf(testCase, node.name);
    }

    private overflowOf(testCase: JUnitCase, kind: string): void {
        let overflow = this.overflows.get(testCase);
        if (!overflow) { overflow = { count: 0, kinds: new Set() }; this.overflows.set(testCase, overflow); }
        overflow.count++;
        overflow.kinds.add(kind);
    }

    /** Records the case just pushed as a fold candidate when pytest could
     *  still split a teardown error from it; true for chaining. */
    private rememberLatest(): true {
        const testCase = this.cases[this.cases.length - 1]!;
        if (testCase.results.some(result => result.kind === 'failure') && !testCase.results.some(isTeardownError)) {
            const key = caseKey(testCase.suite, testCase.classname, testCase.name);
            const candidates = this.foldCandidates.get(key);
            if (candidates) candidates.push(testCase);
            else this.foldCandidates.set(key, [testCase]);
        }
        return true;
    }

    /** The test's latest record that pytest would have split: its call failed
     *  (pytest writes a passed or skipped call and its teardown error as one
     *  record) and it has not taken a teardown error yet. */
    private foldTarget(key: string): JUnitCase | undefined {
        const candidates = this.foldCandidates.get(key);
        return candidates?.[candidates.length - 1];
    }

    /** Status and flakiness from every result element, kept or not. */
    private refresh(testCase: JUnitCase): void {
        const overflow = this.overflows.get(testCase);
        const kinds = testCase.results.map(result => result.kind as string);
        if (overflow) kinds.push(...overflow.kinds);
        testCase.status = statusOf(kinds);
        testCase.flaky = kinds.some(isFlakyPass);
        testCase.droppedResults = overflow?.count ?? 0;
    }

    private readResult(node: XmlNode): JUnitResult {
        const out: string[] = [];
        const err: string[] = [];
        let body = '';
        for (const child of node.children) {
            if (child.kind === 'text' || child.kind === 'cdata') body += child.value;
            // Surefire: <stackTrace>, <system-out>, <system-err> inside flaky/rerun elements.
            else if (child.kind === 'element') {
                if (child.name === 'stackTrace') body += textOf(child);
                else if (child.name === 'system-out') out.push(textOf(child));
                else if (child.name === 'system-err') err.push(textOf(child));
            }
        }
        const text = this.clip(trimBlock(body));
        const output = this.takeOutput(out, err);
        return {
            kind: node.name as JUnitResultKind,
            message: attr(node, 'message'),
            type: attr(node, 'type'),
            text: text.value,
            truncated: text.truncated,
            systemOut: output.out,
            systemErr: output.err,
            outputTruncated: output.truncated
        };
    }

    private readProperties(node: XmlNode): JUnitProperty[] {
        const properties: JUnitProperty[] = [];
        for (const child of node.children) {
            if (child.kind !== 'element' || child.name !== 'property') continue;
            if (properties.length >= MAX_PROPERTIES) break;
            // A multi-line value is written as element text by some writers
            // (pytest `record_property` with newlines, Surefire for long values).
            const value = child.attributes.find(attribute => attribute.name === 'value');
            properties.push({ name: attr(child, 'name'), value: this.clip(value ? value.value : textOf(child)).value });
        }
        return properties;
    }

    private takeOutput(out: readonly string[], err: readonly string[]): { out: string; err: string; truncated: boolean } {
        const a = this.budgeted(out.filter(block => block.trim()).join('\n'));
        const b = this.budgeted(err.filter(block => block.trim()).join('\n'));
        return { out: a.value, err: b.value, truncated: a.truncated || b.truncated };
    }

    private budgeted(text: string): { value: string; truncated: boolean } {
        const clipped = this.clip(text);
        if (clipped.value.length <= this.outputBudget) {
            this.outputBudget -= clipped.value.length;
            return clipped;
        }
        let end = Math.max(0, this.outputBudget);
        // Never split a surrogate pair at the cut.
        const code = clipped.value.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end--;
        const value = clipped.value.slice(0, end);
        this.outputBudget = 0;
        this.outputExhausted = true;
        return { value, truncated: true };
    }

    private clip(text: string): { value: string; truncated: boolean } {
        if (text.length <= this.maxTextChars) return { value: text, truncated: false };
        // Never split a surrogate pair at the cut.
        let end = this.maxTextChars;
        const code = text.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end--;
        return { value: text.slice(0, end), truncated: true };
    }
}

/**
 * pytest without a pytest name on the root: 5.1–7 (unnamed `<testsuites>`),
 * and `junitparser merge` output (which drops the root's name). Suites named
 * `pytest` settle it; renamed ones (`junit_suite_name`) are judged by shape —
 * every suite carries `hostname` and `timestamp`, and every case-bearing
 * suite's first case with a `line` has `file` but none of PHPUnit's
 * `assertions` or GoogleTest's `status` (both write 1-based lines). A shard
 * that holds only line-less records (a collection error, a module skip) is
 * neutral, but at least one suite must show a `line`.
 */
function looksLikePytest7(root: XmlNode): boolean {
    if (root.name !== 'testsuites' || root.attributes.some(attribute => attribute.name === 'name')) return false;
    const suites = root.children.filter(child => child.kind === 'element');
    // The default suite name settles it — also for several of them, as
    // `junitparser merge` writes for sharded runs (it drops the root's name).
    if (suites.length === 0 || suites.some(suite => suite.name !== 'testsuite')) return false;
    if (suites.every(suite => attr(suite, 'name') === 'pytest')) return true;
    let lined = false;
    for (const suite of suites) {
        if (!has(suite, 'hostname') || !has(suite, 'timestamp')) return false;
        // A module-level skip or a collection error is written first and has
        // no `line`, so the first case that has one decides.
        const first = suite.children.find(child => child.kind === 'element' && child.name === 'testcase' && has(child, 'line'));
        if (!first) continue;
        if (!has(first, 'file') || has(first, 'assertions') || has(first, 'status')) return false;
        lined = true;
    }
    return lined;
}

function has(node: XmlNode, name: string): boolean {
    return node.attributes.some(attribute => attribute.name === name);
}

function attr(node: XmlNode, name: string): string {
    for (const attribute of node.attributes) if (attribute.name === name) return attribute.value;
    return '';
}

/** Concatenated character data of an element and its descendants. */
function textOf(node: XmlNode): string {
    let text = '';
    const stack: XmlNode[] = [node];
    while (stack.length) {
        const current = stack.pop()!;
        if (current.kind === 'text' || current.kind === 'cdata') { text += current.value; continue; }
        if (current.kind !== 'element') continue;
        for (let i = current.children.length - 1; i >= 0; i--) stack.push(current.children[i]!);
    }
    return text;
}

/** Strips the indentation-only lines writers put around a block (vitest opens
 *  and closes every <failure> with a newline and the closing tag's indent):
 *  leading whitespace through its last newline, and all trailing whitespace.
 *  Scanned by hand — an unanchored `/\s+$/` is quadratic on a long whitespace
 *  run followed by text, and this runs before any clipping. */
function trimBlock(text: string): string {
    let start = 0;
    for (let i = 0; i < text.length && /\s/.test(text[i]!); i++) if (text[i] === '\n') start = i + 1;
    let end = text.length;
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    return text.slice(start, end);
}

/**
 * Seconds from a `time` attribute. Accepts the plain decimal every current
 * writer uses, and the grouped form Ant's locale-dependent `NumberFormat`
 * emitted for runs over 1000 s ("1,234.567") — only with its decimal part,
 * since "1,234" is just as likely a comma-decimal 1.234 s. Anything else — a
 * negative, NaN, or a locale comma decimal ("0,123") — is unknown rather than
 * guessed.
 */
export function parseSeconds(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = /^[1-9]\d{0,2}(?:,\d{3})+\.\d+$/.test(trimmed) ? trimmed.replace(/,/g, '') : trimmed;
    if (!/^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?$|^\.\d+$/.test(normalized)) return null;
    const seconds = Number(normalized);
    return Number.isFinite(seconds) ? seconds : null;
}

/** Duration label for a time in seconds — '—' when the writer recorded none. */
export function formatSeconds(seconds: number | null): string {
    return seconds === null ? '—' : formatMillis(seconds * 1000);
}

function parseCount(value: string): number | null {
    return /^\s*\d+\s*$/.test(value) ? Number(value) : null;
}

function declaredCounts(node: XmlNode): JUnitDeclaredCounts {
    // `disabled` (the Jenkins/Ant schema, GoogleTest) counts tests that never
    // ran, which this model files as skipped; GoogleTest writes it beside
    // `skipped` without including one in the other. GoogleTest's root carries
    // `disabled` alone although GTEST_SKIP cases exist too, so `disabled`
    // without `skipped` is not a skip total and is not compared.
    const skipped = parseCount(attr(node, 'skipped'));
    const disabled = parseCount(attr(node, 'disabled'));
    return {
        tests: parseCount(attr(node, 'tests')),
        failures: parseCount(attr(node, 'failures')),
        errors: parseCount(attr(node, 'errors')),
        skipped: skipped === null ? null : skipped + (disabled ?? 0)
    };
}

/** A declared total disagrees with the cases. `failures` and `errors` are
 *  compared as a sum: vitest and Gradle file a thrown exception under
 *  failures where Ant and pytest write an error, and neither is wrong. */
function declaredMismatch(declared: JUnitDeclaredCounts, counts: JUnitCounts): boolean {
    if (declared.tests !== null && declared.tests !== counts.tests) return true;
    if (declared.failures !== null || declared.errors !== null) {
        if ((declared.failures ?? 0) + (declared.errors ?? 0) !== counts.failed + counts.errors) return true;
    }
    return declared.skipped !== null && declared.skipped !== counts.skipped;
}

/** Surefire writes flakyFailure/flakyError only for a test that passed on a
 *  retry; one that failed every rerun keeps its <failure>/<error> and lists the
 *  attempts as rerunFailure/rerunError — that test is broken, not flaky. */
function isFlakyPass(kind: string): boolean {
    return kind === 'flakyFailure' || kind === 'flakyError';
}

interface ResultOverflow { count: number; kinds: Set<string> }

/** pytest's own wording for an error raised while tearing a test down. */
function isTeardownError(result: JUnitResult): boolean {
    return result.kind === 'error' && result.message.startsWith('failed on teardown with ');
}

function caseKey(suite: number, classname: string, name: string): string {
    return `${suite}\u0000${classname}\u0000${name}`;
}

function statusOf(kinds: readonly string[]): JUnitStatus {
    let status: JUnitStatus = 'passed';
    for (const kind of kinds) {
        if (kind === 'error') return 'error';
        if (kind === 'failure') status = 'failed';
        else if (kind === 'skipped' && status === 'passed') status = 'skipped';
    }
    return status;
}

function emptyCounts(): JUnitCounts {
    return { tests: 0, passed: 0, failed: 0, errors: 0, skipped: 0, flaky: 0 };
}

function tally(counts: JUnitCounts, testCase: JUnitCase): void {
    counts.tests++;
    if (testCase.status === 'passed') counts.passed++;
    else if (testCase.status === 'failed') counts.failed++;
    else if (testCase.status === 'error') counts.errors++;
    else counts.skipped++;
    if (testCase.flaky) counts.flaky++;
}

function addCounts(target: JUnitCounts, source: JUnitCounts): void {
    target.tests += source.tests;
    target.passed += source.passed;
    target.failed += source.failed;
    target.errors += source.errors;
    target.skipped += source.skipped;
    target.flaky += source.flaky;
}

/** Pass rate over the cases that ran (skipped ones excluded), one decimal. */
export function passRate(counts: JUnitCounts): string {
    const ran = counts.tests - counts.skipped;
    if (ran <= 0) return '—';
    const rate = Math.floor((counts.passed / ran) * 1000) / 10;
    return `${rate.toFixed(1)}%`;
}

function summaryOf(counts: JUnitCounts, time: number | null, suites: number): JUnitSummaryItem[] {
    const items: JUnitSummaryItem[] = [
        { labelKey: 'junit.summary.tests', value: String(counts.tests) },
        { labelKey: 'junit.summary.passed', value: String(counts.passed) },
        { labelKey: 'junit.summary.failed', value: String(counts.failed) },
        { labelKey: 'junit.summary.errors', value: String(counts.errors) },
        { labelKey: 'junit.summary.skipped', value: String(counts.skipped) },
        { labelKey: 'junit.summary.passRate', value: passRate(counts) },
        { labelKey: 'junit.summary.duration', value: formatSeconds(time) },
        { labelKey: 'junit.summary.suites', value: String(suites) }
    ];
    if (counts.flaky > 0) items.splice(5, 0, { labelKey: 'junit.summary.flaky', value: String(counts.flaky) });
    return items;
}
