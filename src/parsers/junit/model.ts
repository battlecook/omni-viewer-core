// JUnit XML test report model (docs/viewers/junit.md §2).
//
// "JUnit XML" is a family, not a schema: Ant, Maven Surefire, Gradle, pytest,
// vitest/Jest, Go and Android tooling each write their own variant. The model
// keeps what they share — nested suites, test cases and their result elements —
// and recomputes every count from the cases, because the declared attribute
// totals disagree between writers (and, in hand-edited files, with the file).

/** Outcome of one test case. `error` outranks `failure`, which outranks `skipped`. */
export type JUnitStatus = 'passed' | 'failed' | 'error' | 'skipped';

/**
 * A result element under `<testcase>`. `failure`/`error`/`skipped` are the
 * common core; the `flaky*` and `rerun*` kinds are Maven Surefire's record of
 * attempts made by `rerunFailingTestsCount`.
 */
export type JUnitResultKind = 'failure' | 'error' | 'skipped' | 'flakyFailure' | 'flakyError' | 'rerunFailure' | 'rerunError';

export interface JUnitResult {
    kind: JUnitResultKind;
    /** `message` attribute ('' when absent). */
    message: string;
    /** `type` attribute — usually the exception class ('' when absent). */
    type: string;
    /** Element text: the stack trace or skip reason, bounded by `maxTextChars`. */
    text: string;
    truncated: boolean;
    /** Surefire nests per-attempt output inside flaky/rerun elements. */
    systemOut: string;
    systemErr: string;
    /** True when that output was cut to the text or output budget. */
    outputTruncated: boolean;
}

export interface JUnitProperty {
    name: string;
    value: string;
}

/** Counts recomputed from the cases a suite holds, nested suites included. */
export interface JUnitCounts {
    tests: number;
    passed: number;
    failed: number;
    errors: number;
    skipped: number;
    /** Cases that passed on a Surefire retry (flakyFailure/flakyError recorded). */
    flaky: number;
}

/** Totals a writer declared on a suite or the root. null = attribute absent or unreadable. */
export interface JUnitDeclaredCounts {
    tests: number | null;
    failures: number | null;
    errors: number | null;
    skipped: number | null;
}

export interface JUnitCase {
    /** Position in `JUnitDocument.cases` (document order). */
    index: number;
    /** Owning suite's index, or -1 for a case directly under `<testsuites>`. */
    suite: number;
    name: string;
    classname: string;
    /** pytest xunit1 / some Jest writers record the source location. */
    file: string;
    /** 1-based; pytest's 0-based `line` is shifted on read. */
    line: number | null;
    /** Seconds, or null when the attribute is absent or not a number. */
    time: number | null;
    status: JUnitStatus;
    /** True when the case passed on a Surefire retry: a flakyFailure/flakyError
     *  was recorded. rerunFailure/rerunError (failed every rerun) do not count. */
    flaky: boolean;
    /** At most JUNIT_MAX_CASE_RESULTS; `status` and `flaky` count every one. */
    results: JUnitResult[];
    /** Result elements past the cap, not in `results`. */
    droppedResults: number;
    properties: JUnitProperty[];
    systemOut: string;
    systemErr: string;
    /** True when stdout/stderr text was cut to the output budget. */
    outputTruncated: boolean;
    /**
     * True for a case the parser made from a `<failure>`/`<error>` placed
     * directly in a `<testsuite>` (a suite-level setup error, as Jenkins
     * fixtures and some C++ runners write). It carries the suite's name.
     */
    synthetic: boolean;
}

export interface JUnitSuite {
    /** Position in `JUnitDocument.suites` (document order, parents first). */
    index: number;
    /** Parent suite's index, or -1 for a top-level suite. */
    parent: number;
    depth: number;
    name: string;
    /** Names from the outermost suite down to this one. */
    path: string[];
    id: string;
    package: string;
    hostname: string;
    timestamp: string;
    file: string;
    time: number | null;
    declared: JUnitDeclaredCounts;
    /** Includes cases of nested suites. */
    counts: JUnitCounts;
    /** A declared total disagrees with `counts`. */
    countMismatch: boolean;
    /** Number of cases directly in this suite (not nested ones). */
    ownCases: number;
    properties: JUnitProperty[];
    systemOut: string;
    systemErr: string;
    outputTruncated: boolean;
}

export interface JUnitSummaryItem {
    labelKey: string;
    value: string;
}

export interface JUnitDocument {
    format: 'junit';
    /** Root element name. A single-suite report has `testsuite` as its root. */
    rootKind: 'testsuites' | 'testsuite';
    /** `name` of the `<testsuites>` root ('' for a single-suite report). */
    name: string;
    /** Root `time` in seconds, falling back to the summed top-level suite time. */
    time: number | null;
    timestamp: string;
    declared: JUnitDeclaredCounts;
    counts: JUnitCounts;
    /** The root's declared totals disagree with `counts`. */
    countMismatch: boolean;
    /** The file may hold cases the model does not: the case cap or suite
     *  depth cap dropped some, or the XML scan had to recover (an unclosed
     *  root, a second root after the first). A verdict drawn from `counts`
     *  alone would overstate a pass. */
    incomplete: boolean;
    suites: JUnitSuite[];
    cases: JUnitCase[];
    /** Properties of a `<testsuites>` root (rare, but Jest-JUnit writes them). */
    properties: JUnitProperty[];
    /** Distinct `classname`s in first-seen order. */
    classnames: string[];
    /** Suites (and a `<testsuites>` root) whose declared totals disagree with
     *  the cases they hold. */
    mismatchedSuites: number;
    /** Cases the report holds past `maxCases`; they are not in `cases`. */
    droppedCases: number;
    /** Decoded source text, for the source tab and copy actions. */
    text: string;
    summary: JUnitSummaryItem[];
}
