import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatSeconds, looksLikeJUnit, parseJUnit, parseSeconds, passRate, type JUnitDocument } from './index.js';

// Real writer output (examples/junit/README.md records how each was produced).
const sample = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../../examples/junit/${name}`, import.meta.url)));
const parsed = (input: Uint8Array | string, options = {}): JUnitDocument => {
    const { result } = parseJUnit(input, options);
    if (result.status === 'failed') throw new Error(result.failure.messageKey);
    return result.document;
};
const outcome = (input: Uint8Array | string, options = {}) => parseJUnit(input, options).result;

describe('parseJUnit on real writer output', () => {
    // golden.json is an independent ElementTree decode of the same files
    // (__tests__/golden.py), so every field of every case is checked against
    // a reader that shares no code with this parser.
    const golden = JSON.parse(readFileSync(new URL('./__tests__/golden.json', import.meta.url), 'utf8')) as Record<string, unknown[]>;
    it.each(Object.keys(golden))('matches an independent decode case by case: %s', name => {
        const model = parsed(sample(name));
        expect(model.cases.map(item => ({
            name: item.name, classname: item.classname, file: item.file, line: item.line, time: item.time,
            status: item.status, synthetic: item.synthetic,
            results: item.results.map(result => ({ kind: result.kind, message: result.message, type: result.type, text: result.text })),
            systemOut: item.systemOut, systemErr: item.systemErr
        }))).toEqual(golden[name]);
    });

    it('reads a Gradle 8 / JUnit 5 report: assumptions, @Disabled, parameterized names, suite-level CDATA output', () => {
        const model = parsed(sample('gradle-junit5.xml'));
        expect(model.rootKind).toBe('testsuite');
        expect(model.suites).toHaveLength(1);
        expect(model.suites[0]!.name).toBe('Calculator ✓');
        expect(model.counts).toEqual({ tests: 7, passed: 2, failed: 3, errors: 0, skipped: 2, flaky: 0 });
        expect(model.countMismatch).toBe(false);
        expect(model.mismatchedSuites).toBe(0);
        expect(model.cases.map(item => item.name)).toEqual(['aborted()', 'passes()', 'fails()', '[1] 1', '[2] 2', 'disabled()', 'throwsError()']);
        const aborted = model.cases[0]!;
        expect(aborted.status).toBe('skipped');
        expect(aborted.results[0]).toMatchObject({ kind: 'skipped', type: 'org.opentest4j.TestAbortedException', message: 'Assumption failed: assumption failed' });
        expect(aborted.results[0]!.text).toMatch(/^org\.opentest4j\.TestAbortedException/);
        // Gradle files an unexpected exception under <failure>, not <error>.
        expect(model.cases[6]).toMatchObject({ status: 'failed', classname: 'demo.CalcTest' });
        expect(model.cases[6]!.results[0]!.type).toBe('java.lang.IllegalStateException');
        expect(model.cases[2]!.results[0]!.message).toBe('org.opentest4j.AssertionFailedError: strings differ ==> expected: <a> but was: <b>');
        expect(model.cases[5]!.results[0]).toMatchObject({ kind: 'skipped', message: '', text: '' });
        expect(model.suites[0]!.systemOut).toBe('stdout <hello> & ok\n');
        expect(model.suites[0]!.systemErr).toBe('stderr line\n');
        expect(model.time).toBe(0.043);
        expect(model.timestamp).toBe('2026-10-30T10:44:38.008Z');
    });

    it('reads pytest xunit2: setup errors, xfail as skipped, duplicated output pairs, offset timestamps', () => {
        const model = parsed(sample('pytest-xunit2.xml'));
        expect(model.rootKind).toBe('testsuites');
        expect(model.name).toBe('pytest tests');
        expect(model.counts).toEqual({ tests: 8, passed: 3, failed: 2, errors: 1, skipped: 2, flaky: 0 });
        expect(model.countMismatch).toBe(false);
        expect(model.mismatchedSuites).toBe(0);
        const error = model.cases.find(item => item.name === 'test_error')!;
        expect(error.status).toBe('error');
        expect(error.results[0]!.message).toBe('failed on setup with "RuntimeError: fixture exploded"');
        expect(model.cases.find(item => item.name === 'test_xfail')!.results[0]).toMatchObject({ kind: 'skipped', type: 'pytest.xfail', message: 'known bug' });
        const failed = model.cases.find(item => item.name === 'test_fail')!;
        // pytest escapes newlines in the attribute as &#10;, so they survive
        // attribute-value normalization (XML 1.0 §3.3.3).
        expect(failed.results[0]!.message.startsWith('AssertionError: dicts differ\nassert {')).toBe(true);
        expect(failed.results[0]!.text).toContain('E       AssertionError: dicts differ');
        expect(failed.systemOut).toContain('before failure <tag> & ünïcode');
        expect(failed.systemErr).toContain('err line');
        // The skipped case carries two system-out elements; both are kept.
        const skipped = model.cases.find(item => item.name === 'test_skip')!;
        expect(skipped.systemOut.split('Captured Out').length - 1).toBe(2);
        expect(model.cases.find(item => item.name === 'test_method')!.classname).toBe('test_sample.TestGroup');
        expect(model.timestamp).toBe('2026-10-30T19:43:21.525659+09:00');
    });

    it('shifts pytest 5.1–7 xunit1 lines (unnamed root around <testsuite name="pytest">) to 1-based', () => {
        const model = parsed(sample('pytest7-xunit1.xml'));
        // The defs sit on lines 3 and 7 of test_y.py; pytest wrote 2 and 6.
        expect(model.cases.map(item => [item.name, item.line])).toEqual([['test_ok', 3], ['test_bad', 7]]);
    });

    it('recognizes pytest 7 by shape when junit_suite_name renames the suite', () => {
        const model = parsed(sample('pytest7-suite-name.xml'));
        expect(model.suites[0]!.name).toBe('myproj');
        // test_ok and test_bad are defined on lines 1 and 5; pytest wrote 0 and 4.
        expect(model.cases.map(item => [item.name, item.line])).toEqual([['test_ok', 1], ['test_bad', 5]]);
        // PHPUnit and GoogleTest shapes, which are 1-based, are left alone.
        expect(parsed('<testsuites><testsuite name="p" hostname="h" timestamp="t"><testcase name="a" file="a.php" line="4" assertions="1"/></testsuite></testsuites>').cases[0]!.line).toBe(4);
        expect(parsed('<testsuites><testsuite name="p" hostname="h" timestamp="t"><testcase name="a" file="a.cc" line="4" status="run"/></testsuite></testsuites>').cases[0]!.line).toBe(4);
    });

    it('still shifts pytest 7 lines when a line-less module skip comes first', () => {
        // Real pytest 7.4 output with junit_suite_name and an importorskip module.
        const model = parsed(sample('pytest7-module-skip.xml'));
        expect(model.cases.map(item => [item.name, item.line])).toEqual([['tests.test_a_gpu', null], ['test_ok', 3], ['test_bad', 7]]);
        // The default suite name decides on its own, whatever comes first.
        const named = parsed('<testsuites><testsuite name="pytest"><testcase name="skip" file="a.py"><skipped/></testcase><testcase name="t" file="b.py" line="0"/></testsuite></testsuites>');
        expect(named.cases[1]!.line).toBe(1);
    });

    it('folds pytest\'s second record of a test that also errored on teardown into one case', () => {
        // Real pytest 9: test_a fails its call and errors on teardown (two
        // records), test_b passes, test_c passes its call and errors on teardown.
        const model = parsed(sample('pytest-teardown-error.xml'));
        expect(model.cases.map(item => [item.name, item.status, item.results.map(result => result.kind)])).toEqual([
            ['test_a', 'error', ['failure', 'error']], ['test_b', 'passed', []], ['test_c', 'error', ['error']]
        ]);
        expect(model.counts).toMatchObject({ tests: 3, passed: 1, failed: 0, errors: 2 });
        // pytest declares tests="4": its totals count teardown errors differently.
        expect(model.suites[0]!.countMismatch).toBe(false);
        expect(model.countMismatch).toBe(false);
        expect(outcome(sample('pytest-teardown-error.xml')).diagnostics).toEqual([]);
        // Without pytest's own wording, two records with one name stay two cases.
        expect(parsed('<testsuite><testcase name="a"><failure/></testcase><testcase name="a"><error message="teardown failed"/></testcase></testsuite>').cases).toHaveLength(2);
        // pytest 5.1–7 xunit2 with junit_suite_name carries no pytest name or
        // line attributes; the wording alone identifies the record.
        const renamed = parsed('<testsuites><testsuite name="mysuite" tests="1" hostname="h" timestamp="t"><testcase classname="m" name="t"><failure message="x"/></testcase><testcase classname="m" name="t"><error message="failed on teardown with &quot;E&quot;"/></testcase></testsuite></testsuites>');
        expect(renamed.cases.map(item => [item.name, item.status, item.results.length])).toEqual([['t', 'error', 2]]);
    });

    it('folds a teardown record that pytest-xdist wrote after other workers\' records', () => {
        // Real pytest 9 + pytest-xdist 3.8, -n 2: test_a's failure and its
        // teardown error are separated by test_d.
        const model = parsed(sample('pytest-xdist-teardown.xml'));
        expect(model.cases.map(item => [item.name, item.status])).toEqual([['test_c', 'passed'], ['test_a', 'error'], ['test_d', 'passed'], ['test_b', 'passed']]);
        expect(model.cases[1]!.results.map(result => result.kind)).toEqual(['failure', 'error']);
        expect(model.counts).toMatchObject({ tests: 4, failed: 0, errors: 1 });
        // The call recorded 0.000 s and the teardown 0.310 s: the test took both.
        expect(model.cases[1]!.time).toBeCloseTo(0.31, 9);
    });

    it('keeps each worker\'s run separate under pytest-xdist --dist each', () => {
        // Real pytest 9 + xdist 3.8, `-n 2 --dist each`: every test runs on both
        // workers. test_t errors only on teardown; test_f fails and errors.
        const model = parsed(sample('pytest-xdist-each.xml'));
        expect(model.cases.map(item => [item.name, item.status, item.results.map(result => result.kind).join('+')])).toEqual([
            ['test_t', 'error', 'error'], ['test_t', 'error', 'error'], ['test_ok', 'passed', ''], ['test_ok', 'passed', ''],
            ['test_f', 'error', 'failure+error'], ['test_f', 'error', 'failure+error']
        ]);
    });

    it('does not fold a teardown error into another worker\'s passed run', () => {
        // Real pytest 9 + xdist, `--dist each`: gw0 passes, gw1 passes its call
        // and errors on teardown (one record, as pytest writes it).
        const model = parsed(sample('pytest-xdist-each-pass.xml'));
        expect(model.cases.map(item => [item.name, item.status])).toEqual([['test_a', 'passed'], ['test_a', 'error']]);
    });

    it('stays linear when one test name repeats past the cap and in teardown records', () => {
        const started = performance.now();
        const repeated = `<testsuites><testsuite name="s">${'<testcase classname="c" name="t"/>'.repeat(60_000)}</testsuite></testsuites>`;
        expect(parsed(repeated, { limits: { maxEntries: 30_000 } }).droppedCases).toBe(30_000);
        const teardown = `<testsuites><testsuite name="s">${'<testcase classname="c" name="t"/>'.repeat(20_000)}${'<testcase classname="c" name="t"><error message="failed on teardown with x"/></testcase>'.repeat(20_000)}</testsuite></testsuites>`;
        expect(parsed(teardown).cases).toHaveLength(40_000);
        // Quadratic scanning took tens of seconds here.
        expect(performance.now() - started).toBeLessThan(5000);
    });

    it('caps suites, skipping the rest with what they hold, and reports the report incomplete', () => {
        const result = outcome(`<testsuites tests="3">${'<testsuite name="s"><testcase name="t"/></testsuite>'.repeat(3)}</testsuites>`, { maxSuites: 2 });
        if (result.status === 'failed') throw new Error('parse');
        expect(result.status).toBe('partial');
        expect(result.document.suites).toHaveLength(2);
        expect(result.document.cases).toHaveLength(2);
        expect(result.document.incomplete).toBe(true);
        expect(result.document.countMismatch).toBe(false);
        expect(result.diagnostics.find(d => d.code === 'junit-suite-limit')?.args).toEqual({ max: 2 });
    });

    it('keeps a report complete when only text trails the root', () => {
        for (const tail of ['\nEOF', '\u001a']) {
            const result = outcome(`<testsuite name="s" tests="1"><testcase name="a"/></testsuite>${tail}`);
            if (result.status === 'failed') throw new Error('parse');
            expect(result.document.incomplete, JSON.stringify(tail)).toBe(false);
        }
    });

    it('recognizes pytest reports merged by junitparser (unnamed root, several pytest suites)', () => {
        // Real pytest 9 xunit1 output merged with junitparser 5.0.3.
        const model = parsed(sample('pytest-junitparser-merged.xml'));
        expect(model.cases.map(item => `${item.file}:${item.line}`)).toEqual(['test_a.py:1', 'test_b.py:2']);
    });

    it('recognizes merged pytest reports whose suites were renamed with junit_suite_name', () => {
        // Real pytest 9 xunit1 output with junit_suite_name=myproj, merged with junitparser.
        const model = parsed(sample('pytest-merged-suite-name.xml'));
        expect(model.cases.map(item => `${item.file}:${item.line}`)).toEqual(['test_a.py:1', 'test_b.py:2']);
        // Merged non-pytest suites (Gradle has no file/line) are left alone.
        expect(parsed('<testsuites><testsuite name="A" hostname="h" timestamp="t"><testcase name="a" file="a.cc" line="3" status="run"/></testsuite><testsuite name="B" hostname="h" timestamp="t"><testcase name="b"/></testsuite></testsuites>').cases[0]!.line).toBe(3);
    });

    it('recognizes a merged renamed pytest report whose shard holds only a collection error', () => {
        // Real pytest 9 + junitparser: shard b failed to collect (no `line`).
        const model = parsed(sample('pytest-merged-collection-error.xml'));
        expect(model.cases.map(item => [item.name, item.line])).toEqual([['test_one', 1], ['b.test_broken', null]]);
    });

    it('sees lost content even after lexical errors filled the capped diagnostic list', () => {
        const noise = `<system-out>${'&#27;[31m '.repeat(250)}</system-out>`;
        for (const tail of [`&e;`, '<testcase name="b"><!x><failure/></testcase>', '<testcase name="b><failure message="x"/></testcase><testcase name="c"/>']) {
            const result = outcome(`<!DOCTYPE testsuite [<!ENTITY e "<testcase name='z'><failure/></testcase>">]><testsuite tests="2"><testcase name="a"/>${noise}${tail}</testsuite>`);
            if (result.status === 'failed') throw new Error('parse');
            expect(result.document.incomplete, tail).toBe(true);
        }
        // Noise alone stays complete.
        const clean = outcome(`<testsuite tests="1"><testcase name="a"/>${noise}</testsuite>`);
        if (clean.status !== 'failed') expect(clean.document.incomplete).toBe(false);
    });

    it('treats entity markup and external entities as lost content, not a pass', () => {
        for (const entity of [`<!ENTITY e "<testcase name='b'><failure/></testcase>">`, '<!ENTITY e SYSTEM "more.xml">']) {
            const result = outcome(`<!DOCTYPE testsuites [${entity}]><testsuites><testsuite name="s" tests="2" failures="1"><testcase name="a"/>&e;</testsuite></testsuites>`);
            if (result.status === 'failed') throw new Error('parse');
            expect(result.document.incomplete, entity).toBe(true);
            expect(result.status, entity).toBe('partial');
        }
    });

    it('compares no declared totals after a structural XML recovery', () => {
        const result = outcome('<testsuites><testsuite name="s" tests="2"><system-out>log <testcase name="a"/><testcase name="b"/></testsuite></testsuites>');
        if (result.status === 'failed') throw new Error('parse');
        expect(result.document.suites[0]!.countMismatch).toBe(false);
        expect(result.diagnostics.map(d => d.code)).not.toContain('junit-count-mismatch');
    });

    it('states the case total as a lower bound when the suite cap also dropped suites, and reads the root at maxSuites 0', () => {
        const text = `<testsuites>${['<testcase name="a"/><testcase name="b"/>', '<testcase name="c"/><testcase name="d"/>', '<testcase name="e"/><testcase name="f"/><testcase name="g"/>'].map(cases => `<testsuite>${cases}</testsuite>`).join('')}</testsuites>`;
        const result = outcome(text, { maxSuites: 2, limits: { maxEntries: 3 } });
        expect(result.diagnostics.find(d => d.code === 'junit-case-limit')?.messageKey).toBe('diag.junit.caseLimitAtLeast');
        expect(parsed('<testsuite tests="1"><testcase name="a"/></testsuite>', { maxSuites: 0 }).cases).toHaveLength(1);
    });

    it('reads pytest xunit1 file and line attributes', () => {
        const model = parsed(sample('pytest-xunit1.xml'));
        expect(model.counts.tests).toBe(8);
        // pytest writes the 0-based line of the `def` (line="2" for a def on line 3).
        expect(model.cases[0]).toMatchObject({ name: 'test_pass', file: 'test_sample.py', line: 3 });
    });

    it('reads vitest: nested describe names, uncaught throws as failures, todo as skipped, nanosecond times', () => {
        const model = parsed(sample('vitest.xml'));
        expect(model.counts).toEqual({ tests: 6, passed: 2, failed: 2, errors: 0, skipped: 2, flaky: 0 });
        expect(model.cases.map(item => item.name)).toContain('math > nested > throws');
        const thrown = model.cases.find(item => item.name === 'math > nested > throws')!;
        expect(thrown.results[0]).toMatchObject({ kind: 'failure', type: 'TypeError', message: 'boom' });
        // The writer's indentation around the trace is not part of it.
        expect(thrown.results[0]!.text).toBe('TypeError: boom\n ❯ sample.test.ts:7:57');
        expect(model.cases[0]!.systemOut.trim()).toBe('log line <x>');
        expect(model.time).toBeCloseTo(0.006380125, 12);
    });

    it('reads Jenkins nested suites and a suite-level <error> as a synthetic case', () => {
        const model = parsed(sample('jenkins-nested-testsuites.xml'));
        expect(model.suites.map(suite => [suite.depth, suite.name])).toEqual([
            [0, 'test.AutomatedTests'], [1, 'test.fs.FileSystemTest'], [1, 'test.db.DatabaseTest'], [2, 'test.3rdlevel']
        ]);
        expect(model.suites[3]!.path).toEqual(['test.AutomatedTests', 'test.db.DatabaseTest', 'test.3rdlevel']);
        const synthetic = model.cases.find(item => item.synthetic)!;
        expect(synthetic).toMatchObject({ name: 'test.3rdlevel', status: 'error', suite: 3 });
        expect(synthetic.results[0]!.text).toMatch(/^java\.lang\.IllegalStateException: bla bla\n\s+at test\.Test/);
        expect(model.counts).toEqual({ tests: 3, passed: 2, failed: 0, errors: 1, skipped: 0, flaky: 0 });
        // Nested counts roll up to their ancestors.
        expect(model.suites[0]!.counts.tests).toBe(3);
        expect(model.suites[2]!.counts).toMatchObject({ tests: 2, errors: 1 });
        // The root declares tests="186"; that is reported, never trusted.
        expect(model.declared.tests).toBe(186);
        expect(model.countMismatch).toBe(true);
        expect(model.mismatchedSuites).toBe(1);
        expect(model.time).toBe(4.486);
        expect(outcome(sample('jenkins-nested-testsuites.xml')).diagnostics.map(d => d.messageKey)).toEqual(['diag.junit.countMismatch']);
    });

    it('flags a suite whose declared totals disagree with its cases', () => {
        const model = parsed(sample('jenkins-suite-error.xml'));
        expect(model.suites[0]!.declared).toEqual({ tests: 2, failures: 0, errors: 1, skipped: null });
        expect(model.suites[0]!.counts).toMatchObject({ tests: 1, errors: 1 });
        expect(model.suites[0]!.countMismatch).toBe(true);
        expect(model.cases[0]!.results[0]!.message).toBe('this normally has the string like, expected mullet, but got bream');
    });
});

describe('parseJUnit edge cases', () => {
    it('records Maven Surefire flaky and rerun attempts (shape from the Surefire XSD)', () => {
        const model = parsed(`<testsuite name="s" tests="2" failures="1">
  <testcase name="flaky" classname="C" time="0.1">
    <flakyFailure message="first try" type="java.lang.AssertionError"><stackTrace>at C.flaky(C.java:3)</stackTrace><system-out>attempt 1</system-out></flakyFailure>
  </testcase>
  <testcase name="broken" classname="C" time="0.2">
    <failure message="always" type="java.lang.AssertionError">at C.broken</failure>
    <rerunFailure message="again" type="java.lang.AssertionError"><stackTrace>at C.broken</stackTrace></rerunFailure>
  </testcase>
</testsuite>`);
        expect(model.cases[0]).toMatchObject({ status: 'passed', flaky: true });
        expect(model.cases[0]!.results[0]).toMatchObject({ kind: 'flakyFailure', text: 'at C.flaky(C.java:3)', systemOut: 'attempt 1', outputTruncated: false });
        // Failed every rerun: broken, not flaky.
        expect(model.cases[1]).toMatchObject({ status: 'failed', flaky: false });
        expect(model.cases[1]!.results.map(result => result.kind)).toEqual(['failure', 'rerunFailure']);
        expect(model.counts).toMatchObject({ passed: 1, failed: 1, flaky: 1 });
        expect(model.summary.map(item => item.labelKey)).toContain('junit.summary.flaky');
    });

    it('treats GoogleTest notrun/suppressed cases as skipped and adds `disabled` to declared skips (shape from GoogleTest docs)', () => {
        const model = parsed(`<testsuites tests="3" failures="1" disabled="1" errors="0" name="AllTests">
  <testsuite name="FooTest" tests="3" failures="1" disabled="1" skipped="1" errors="0" time="0.01">
    <testcase name="Bar" file="foo_test.cc" line="5" status="run" result="completed" time="0" classname="FooTest">
      <failure message="foo_test.cc:6&#x0A;Expected equality" type=""><![CDATA[foo_test.cc:6
Expected equality]]></failure>
    </testcase>
    <testcase name="DISABLED_Baz" file="foo_test.cc" line="9" status="notrun" result="suppressed" time="0" classname="FooTest"/>
    <testcase name="Skipped" status="run" result="skipped" time="0" classname="FooTest"><skipped message="why"/></testcase>
  </testsuite>
</testsuites>`);
        expect(model.cases.map(item => item.status)).toEqual(['failed', 'skipped', 'skipped']);
        expect(model.cases[1]!.results).toHaveLength(1);
        expect(model.cases[2]!.results).toHaveLength(1);
        expect(model.suites[0]!.declared.skipped).toBe(2);
        expect(model.suites[0]!.countMismatch).toBe(false);
        // The root writes `disabled` but no `skipped`: not a skip total.
        expect(model.declared.skipped).toBeNull();
        expect(model.countMismatch).toBe(false);
        // GoogleTest is already 1-based: kept as written.
        expect(model.cases[0]!.line).toBe(5);
    });

    it('ranks error over failure over skipped, and accepts cases directly under <testsuites>', () => {
        const model = parsed('<testsuites><testcase name="a"><skipped/><failure/><error/></testcase><testcase name="b"><skipped/><failure/></testcase><testsuite name="s"><testcase name="c"/></testsuite></testsuites>');
        expect(model.cases.map(item => [item.name, item.status, item.suite])).toEqual([['a', 'error', -1], ['b', 'failed', -1], ['c', 'passed', 0]]);
        expect(model.counts.tests).toBe(3);
    });

    it('reads property values from attributes or element text, and suite timestamps for the root', () => {
        const model = parsed('<testsuites><properties><property name="ci" value="yes"/></properties><testsuite name="s" timestamp="T1"><properties><property name="multi">line 1\nline 2</property></properties><testcase name="x"><properties><property name="k" value="v"/></properties></testcase></testsuite></testsuites>');
        expect(model.properties).toEqual([{ name: 'ci', value: 'yes' }]);
        expect(model.suites[0]!.properties).toEqual([{ name: 'multi', value: 'line 1\nline 2' }]);
        expect(model.cases[0]!.properties).toEqual([{ name: 'k', value: 'v' }]);
        expect(model.timestamp).toBe('T1');
    });

    it('falls back to the summed top-level suite time when the root has none', () => {
        expect(parsed('<testsuites><testsuite name="a" time="1.5"/><testsuite name="b" time="2"><testsuite name="c" time="9"/></testsuite></testsuites>').time).toBe(3.5);
        expect(parsed('<testsuites><testsuite name="a"/></testsuites>').time).toBeNull();
    });

    it('treats an empty report as ok with zero counts', () => {
        const model = parsed('<?xml version="1.0"?><testsuites/>');
        expect(model.counts.tests).toBe(0);
        expect(model.summary.find(item => item.labelKey === 'junit.summary.passRate')!.value).toBe('—');
    });

    it('rejects documents whose root is not a JUnit element', () => {
        for (const text of ['<test-run><test-suite/></test-run>', '<ns:testsuite xmlns:ns="urn:x"/>', '<TestSuite/>']) {
            const result = outcome(text);
            expect(result.status, text).toBe('failed');
            if (result.status === 'failed') expect(result.failure.messageKey).toBe('diag.junit.notJunit');
        }
        const binary = outcome(new Uint8Array([0, 1, 2, 3]));
        expect(binary.status).toBe('failed');
    });

    it('returns a recovered partial model for a truncated report', () => {
        const text = new TextDecoder().decode(sample('gradle-junit5.xml'));
        const result = outcome(text.slice(0, text.indexOf('<testcase name="disabled()"')));
        expect(result.status).toBe('partial');
        if (result.status !== 'failed') expect(result.document.cases).toHaveLength(5);
    });

    it('caps cases and reports the remainder', () => {
        const text = `<testsuite name="big">${'<testcase name="t"/>'.repeat(30)}</testsuite>`;
        const result = outcome(text, { limits: { maxEntries: 10 } });
        expect(result.status).toBe('partial');
        if (result.status === 'failed') return;
        expect(result.document.cases).toHaveLength(10);
        expect(result.document.droppedCases).toBe(20);
        expect(result.document.suites[0]!.ownCases).toBe(10);
        expect(result.diagnostics.find(d => d.messageKey === 'diag.junit.caseLimit')?.args).toEqual({ shown: 10, total: 30 });
    });

    it('does not report a declared-total mismatch caused by the case cap', () => {
        const result = outcome('<testsuites tests="4"><testsuite name="a" tests="2"><testcase name="1"/><testcase name="2"/></testsuite><testsuite name="b" tests="2"><testsuite name="c" tests="2"><testcase name="3"/><testcase name="4"/></testsuite></testsuite></testsuites>', { limits: { maxEntries: 3 } });
        if (result.status === 'failed') throw new Error('parse');
        expect(result.diagnostics.map(d => d.messageKey)).toEqual(['diag.junit.caseLimit']);
        expect(result.document.suites.map(suite => suite.countMismatch)).toEqual([false, false, false]);
        expect(result.document.countMismatch).toBe(false);
        // A suite the cap did not touch is still checked.
        const other = outcome('<testsuites><testsuite name="a" tests="9"><testcase name="1"/></testsuite><testsuite name="b"><testcase name="2"/><testcase name="3"/></testsuite></testsuites>', { limits: { maxEntries: 2 } });
        if (other.status !== 'failed') expect(other.document.suites[0]!.countMismatch).toBe(true);
    });

    it('clips long traces per item and stops keeping output past the total budget', () => {
        const long = 'x'.repeat(100);
        const model = parsed(`<testsuite><testcase name="a"><failure>${long}</failure><system-out>${long}</system-out></testcase><testcase name="b"><system-out>${long}</system-out></testcase></testsuite>`, { maxTextChars: 40, maxOutputChars: 60 });
        expect(model.cases[0]!.results[0]).toMatchObject({ text: 'x'.repeat(40), truncated: true });
        expect(model.cases[0]!.systemOut).toBe('x'.repeat(40));
        expect(model.cases[1]!.systemOut).toBe('x'.repeat(20));
        expect(model.cases[1]!.outputTruncated).toBe(true);
        expect(outcome(`<testsuite><testcase name="b"><system-out>${long}</system-out></testcase></testsuite>`, { maxOutputChars: 10 }).diagnostics.map(d => d.messageKey)).toContain('diag.junit.outputBudget');
    });

    it('trims a long whitespace run in a result body in linear time', () => {
        expect(parsed('<testsuite><testcase name="a"><failure>\n    at A\n  </failure></testcase></testsuite>').cases[0]!.results[0]!.text).toBe('    at A');
        const started = performance.now();
        const model = parsed(`<testsuite><testcase name="a"><failure>\n  ${' '.repeat(1_000_000)}x${' \n'.repeat(1000)}</failure></testcase></testsuite>`);
        expect(performance.now() - started).toBeLessThan(1000);
        // The opening newline goes; the rest is clipped to the default 64 Ki chars.
        const { text, truncated } = model.cases[0]!.results[0]!;
        expect(truncated).toBe(true);
        expect(text.length).toBe(64 * 1024);
        expect(text.trim()).toBe('');
    });

    it('caps result elements per case while the outcome still counts every one', () => {
        const model = parsed(`<testsuite><testcase name="t">${'<failure/>'.repeat(150)}<error message="late"/></testcase><testsuite name="s">${'<error/>'.repeat(130)}</testsuite></testsuite>`);
        const [many, synthetic] = model.cases;
        expect(many!.results).toHaveLength(100);
        expect(many!.droppedResults).toBe(51);
        // The <error> past the cap still decides the status.
        expect(many!.status).toBe('error');
        expect(synthetic).toMatchObject({ synthetic: true, droppedResults: 30 });
        expect(synthetic!.results).toHaveLength(100);
    });

    it('never splits a surrogate pair when clipping', () => {
        const model = parsed(`<testsuite><testcase name="a"><failure>${'a'.repeat(9)}😀tail</failure></testcase></testsuite>`, { maxTextChars: 10 });
        expect(model.cases[0]!.results[0]!.text).toBe('a'.repeat(9));
        const budget = parsed('<testsuite><testcase name="a"><system-out>abcd😀efg</system-out></testcase></testsuite>', { maxOutputChars: 5 });
        expect(budget.cases[0]!.systemOut).toBe('abcd');
    });

    it('reads the suites after one nested past the depth cap', () => {
        const text = '<testsuites>' + '<testsuite name="d">'.repeat(140) + '<testcase name="deep"/>' + '</testsuite>'.repeat(140)
            + '<testsuite name="after"><testcase name="boom"><failure/></testcase></testsuite></testsuites>';
        const result = outcome(text);
        if (result.status === 'failed') throw new Error('parse');
        expect(result.status).toBe('partial');
        expect(result.document.cases.map(item => [item.name, item.status])).toEqual([['boom', 'failed']]);
        expect(result.document.incomplete).toBe(true);
    });

    it('keeps a report with only lexical XML errors complete and ok (Surefire escapes ANSI as &#27;)', () => {
        const result = outcome('<testsuite name="T" tests="2"><testcase name="a"/><testcase name="b"><skipped message="needs &#27;[1mdocker&#27;[0m"/></testcase></testsuite>');
        if (result.status === 'failed') throw new Error('parse');
        expect(result.status).toBe('ok');
        expect(result.document.cases).toHaveLength(2);
        expect(result.document.incomplete).toBe(false);
        expect(result.diagnostics.map(d => d.code)).toContain('xml-invalid-char-ref');
    });

    it('keeps a report complete when only its XML declaration is misplaced', () => {
        for (const text of ['\n<?xml version="1.0"?><testsuite tests="1"><testcase name="a"/></testsuite>',
            '<?xml version="1.0"?>\n\n<?xml version="1.0"?><testsuite tests="1"><testcase name="a"/></testsuite>']) {
            const result = outcome(text);
            if (result.status === 'failed') throw new Error('parse');
            expect(result.document.incomplete, text).toBe(false);
        }
    });

    it('keeps a suite-level setup error in document order, before the cases after it', () => {
        const model = parsed('<testsuite name="s" tests="3" errors="1"><error message="setup"/><testcase name="a"/><testsuite name="inner"><testcase name="b"><failure/></testcase></testsuite><failure message="later"/></testsuite>');
        expect(model.cases.map(item => [item.name, item.status, item.synthetic])).toEqual([['s', 'error', true], ['a', 'passed', false], ['b', 'failed', false]]);
        expect(model.cases[0]!.results.map(result => result.message)).toEqual(['setup', 'later']);
        expect(model.suites[0]!.ownCases).toBe(2);
    });

    it('does not compare declared totals for a suite whose case was left unclosed', () => {
        for (const text of ['<testsuites tests="2"><testsuite name="s" tests="2"><testcase name="a"><failure/></testcse><testcase name="b"/></testsuite></testsuites>',
            '<testsuites tests="2"><testsuite name="s" tests="2"><testcase name="a"></testcse><testcase name="b"/></testsuite></testsuites>']) {
            const result = outcome(text);
            if (result.status === 'failed') throw new Error('parse');
            expect(result.document.suites[0]!.countMismatch, text).toBe(false);
            expect(result.diagnostics.map(d => d.code), text).not.toContain('junit-count-mismatch');
        }
    });

    it('states the case-limit total as a lower bound when a second root or the depth cap hid cases', () => {
        const second = outcome('<testsuite><testcase name="a"/><testcase name="b"/></testsuite><testsuite><testcase name="c"/><testcase name="d"/></testsuite>', { limits: { maxEntries: 1 } });
        expect(second.diagnostics.find(d => d.code === 'junit-case-limit')?.messageKey).toBe('diag.junit.caseLimitAtLeast');
        const deep = outcome('<testsuite><testcase name="a"/><testcase name="b"/>' + '<testsuite>'.repeat(65) + '<testcase name="c"/>' + '</testsuite>'.repeat(65) + '</testsuite>', { limits: { maxEntries: 1 } });
        expect(deep.diagnostics.find(d => d.code === 'junit-case-limit')?.messageKey).toBe('diag.junit.caseLimitAtLeast');
        const plain = outcome('<testsuite><testcase name="a"/><testcase name="b"/></testsuite>', { limits: { maxEntries: 1 } });
        expect(plain.diagnostics.find(d => d.code === 'junit-case-limit')?.messageKey).toBe('diag.junit.caseLimit');
    });

    it('excludes the root from the comparison when a case directly under it is left unclosed', () => {
        const result = outcome('<testsuites tests="2"><testcase name="a"></testcas><testcase name="b"/></testsuites>');
        if (result.status === 'failed') throw new Error('parse');
        expect(result.document.countMismatch).toBe(false);
        expect(result.diagnostics.map(d => d.code)).not.toContain('junit-count-mismatch');
    });

    it('still folds a pytest teardown record once the case cap is reached', () => {
        const text = '<testsuites name="pytest tests"><testsuite name="pytest" tests="2"><testcase classname="m" name="a"><failure message="x"/></testcase>'
            + '<testcase classname="m" name="a"><error message="failed on teardown with &quot;x&quot;"/></testcase><testcase classname="m" name="b"/></testsuite></testsuites>';
        const result = outcome(text, { limits: { maxEntries: 1 } });
        if (result.status === 'failed') throw new Error('parse');
        expect(result.document.cases.map(item => [item.name, item.status, item.results.length])).toEqual([['a', 'error', 2]]);
        expect(result.diagnostics.find(d => d.code === 'junit-case-limit')?.args).toEqual({ shown: 1, total: 2 });
    });

    it('does not count a case cut off by truncation as passed', () => {
        const result = outcome('<testsuite name="s" tests="2"><testcase name="a"/><testcase name="b">\n  <fail');
        if (result.status === 'failed') throw new Error('parse');
        expect(result.document.cases.map(item => item.name)).toEqual(['a']);
        expect(result.document.incomplete).toBe(true);
        // A result element that did make it in still decides the outcome.
        const kept = outcome('<testsuite name="s"><testcase name="b"><failure message="x"/>');
        if (kept.status !== 'failed') expect(kept.document.cases.map(item => item.status)).toEqual(['failed']);
    });

    it('sees a second root even after the diagnostic list overflowed with lexical errors', () => {
        const text = `<testsuite name="a" tests="1"><testcase name="x"><system-out>${'&#27;[31m'.repeat(201)}</system-out></testcase></testsuite>\n<testsuite name="b" tests="1"><testcase name="y"><failure message="boom"/></testcase></testsuite>`;
        const result = outcome(text);
        if (result.status === 'failed') throw new Error('parse');
        expect(result.document.incomplete).toBe(true);
        expect(result.status).toBe('partial');
    });

    it('marks concatenated reports incomplete instead of silently dropping the second', () => {
        const text = '<?xml version="1.0"?>\n<testsuite name="A" tests="1"><testcase name="ok"/></testsuite>\n<?xml version="1.0"?>\n<testsuite name="B" tests="1" failures="1"><testcase name="bad"><failure message="x"/></testcase></testsuite>';
        const result = outcome(text);
        if (result.status === 'failed') throw new Error('parse');
        expect(result.status).toBe('partial');
        expect(result.document.incomplete).toBe(true);
    });

    it('flags output cut inside a Surefire rerun attempt', () => {
        const model = parsed(`<testsuite name="s"><testcase name="t"><failure message="m">tr</failure><rerunFailure message="r"><system-out>${'x'.repeat(100)}</system-out></rerunFailure></testcase></testsuite>`, { maxTextChars: 10 });
        expect(model.cases[0]!.results[1]).toMatchObject({ kind: 'rerunFailure', systemOut: 'x'.repeat(10), outputTruncated: true });
    });

    it('marks a model incomplete exactly when the file holds cases it does not', () => {
        expect(parsed(sample('gradle-junit5.xml')).incomplete).toBe(false);
        expect(parsed('<testsuite><testcase name="a"/><testcase name="b"/></testsuite>', { limits: { maxEntries: 1 } }).incomplete).toBe(true);
        expect(parsed('<testsuite><testcase name="a"/>').incomplete).toBe(true);
    });

    it('stops at the suite depth cap as partial, without false declared-total mismatches', () => {
        const text = '<testsuite name="s">'.repeat(70) + '<testcase name="deep"/>' + '</testsuite>'.repeat(70);
        const result = outcome(text);
        expect(result.status).toBe('partial');
        if (result.status === 'failed') return;
        expect(result.document.suites).toHaveLength(64);
        expect(result.document.cases).toHaveLength(0);
        expect(result.diagnostics.map(d => d.messageKey)).toContain('diag.junit.depthLimit');
        // Each suite declares its whole subtree: 70 suites, one case each.
        const declared = Array.from({ length: 70 }, (_, i) => `<testsuite name="s${i}" tests="${70 - i}"><testcase name="c${i}"/>`).join('') + '</testsuite>'.repeat(70);
        const deep = outcome(declared);
        if (deep.status === 'failed') throw new Error('parse');
        expect(deep.document.cases).toHaveLength(64);
        expect(deep.document.suites.some(suite => suite.countMismatch)).toBe(false);
        expect(deep.diagnostics.map(d => d.messageKey)).not.toContain('diag.junit.countMismatch');
    });

    it('does not flag suites cut short by a truncated file, and states the case total as a lower bound after a cut', () => {
        const truncated = outcome('<testsuites tests="3"><testsuite name="a" tests="1"><testcase name="1"/></testsuite><testsuite name="b" tests="2"><testcase name="2"/>');
        if (truncated.status === 'failed') throw new Error('parse');
        expect(truncated.status).toBe('partial');
        expect(truncated.document.suites.map(suite => suite.countMismatch)).toEqual([false, false]);
        expect(truncated.document.countMismatch).toBe(false);
        const cut = outcome(`<testsuite name="big">${'<testcase name="t"/>'.repeat(30)}`, { limits: { maxEntries: 10 } });
        expect(cut.diagnostics.find(d => d.code === 'junit-case-limit')?.messageKey).toBe('diag.junit.caseLimitAtLeast');
    });

    it('honours an aborted signal', () => {
        const controller = new AbortController();
        controller.abort();
        const result = outcome(sample('vitest.xml'), { signal: controller.signal });
        expect(result.status).toBe('failed');
        if (result.status === 'failed') expect(result.failure.code).toBe('aborted');
    });

    it('decodes UTF-16 reports', () => {
        const text = '<?xml version="1.0" encoding="UTF-16"?><testsuite name="ü"><testcase name="한글"/></testsuite>';
        const bytes = new Uint8Array(2 + text.length * 2);
        bytes[0] = 0xff; bytes[1] = 0xfe;
        for (let i = 0; i < text.length; i++) { bytes[2 + i * 2] = text.charCodeAt(i) & 0xff; bytes[3 + i * 2] = text.charCodeAt(i) >> 8; }
        expect(parsed(bytes).cases[0]!.name).toBe('한글');
    });

    it('is deterministic', () => {
        expect(outcome(sample('pytest-xunit2.xml'))).toEqual(outcome(sample('pytest-xunit2.xml')));
    });
});

describe('time and rate helpers', () => {
    it('parses plain, exponent and Ant grouped seconds, rejecting the rest', () => {
        expect(parseSeconds('0.043')).toBe(0.043);
        expect(parseSeconds(' 12 ')).toBe(12);
        expect(parseSeconds('.5')).toBe(0.5);
        expect(parseSeconds('1e-3')).toBe(0.001);
        expect(parseSeconds('1,234.5')).toBe(1234.5);
        // A comma decimal is never read as grouping, and bare "1,234" is ambiguous.
        for (const bad of ['', '-1', 'NaN', 'abc', '0,5', '1,23', '0,123', '1,234', '012,345.6']) expect(parseSeconds(bad), bad).toBeNull();
    });
    it('formats durations and pass rates without rounding a failure up to 100%', () => {
        expect(formatSeconds(null)).toBe('—');
        expect(formatSeconds(0.043)).toBe('43 ms');
        expect(formatSeconds(75)).toBe('1m 15s');
        expect(passRate({ tests: 2001, passed: 2000, failed: 1, errors: 0, skipped: 0, flaky: 0 })).toBe('99.9%');
        expect(passRate({ tests: 4, passed: 2, failed: 0, errors: 0, skipped: 2, flaky: 0 })).toBe('100.0%');
        expect(passRate({ tests: 2, passed: 0, failed: 0, errors: 0, skipped: 2, flaky: 0 })).toBe('—');
    });
});

describe('looksLikeJUnit', () => {
    it.each(['gradle-junit5.xml', 'pytest-xunit1.xml', 'pytest-xunit2.xml', 'pytest7-xunit1.xml', 'pytest7-suite-name.xml', 'pytest7-module-skip.xml', 'pytest-teardown-error.xml', 'pytest-xdist-teardown.xml', 'pytest-xdist-each.xml', 'pytest-xdist-each-pass.xml', 'pytest-junitparser-merged.xml', 'pytest-merged-suite-name.xml', 'pytest-merged-collection-error.xml', 'vitest.xml', 'jenkins-nested-testsuites.xml', 'jenkins-suite-error.xml'])('claims %s', name => {
        expect(looksLikeJUnit(new TextDecoder().decode(sample(name)))).toBe(true);
    });
    it('claims a <testsuite> root only with counts or a JUnit child', () => {
        expect(looksLikeJUnit('<testsuite name="a > b"><testcase name="x"/></testsuite>')).toBe(true);
        expect(looksLikeJUnit('<testsuite name="x">\n  <!-- c -->\n  <properties/></testsuite>')).toBe(true);
        expect(looksLikeJUnit('<testsuite tests="0"/>')).toBe(true);
        // TestLink exports a test *specification* with the same root name.
        expect(looksLikeJUnit('<testsuite id="1" name="spec"><node_order>1</node_order><details/></testsuite>')).toBe(false);
        expect(looksLikeJUnit('<testsuite name="x"/>')).toBe(false);
    });
    it('looks past a DOCTYPE with an internal subset, quoted literals and comments', () => {
        expect(looksLikeJUnit('<?xml version="1.0"?>\n<!DOCTYPE testsuites [\n  <!ENTITY host "ci>01">\n  <!-- a > b ] -->\n]>\n<testsuites/>')).toBe(true);
        expect(looksLikeJUnit('<!DOCTYPE testsuites SYSTEM "x>y.dtd"><testsuites/>')).toBe(true);
        expect(looksLikeJUnit('<!DOCTYPE testsuites [ <!ENTITY a "b">')).toBe(false);
    });

    it('declines other test-result dialects and lookalikes', () => {
        expect(looksLikeJUnit('<?xml version="1.0"?><test-run><test-suite/></test-run>')).toBe(false);
        expect(looksLikeJUnit('<assemblies><assembly/></assemblies>')).toBe(false);
        expect(looksLikeJUnit('<TestSuites/>')).toBe(false);
        expect(looksLikeJUnit('<testsuitesX/>')).toBe(false);
        expect(looksLikeJUnit('<root><testsuites/></root>')).toBe(false);
    });
    it('stays linear on hostile prologues', () => {
        const started = performance.now();
        expect(looksLikeJUnit('<!--x-->'.repeat(100_000) + '<testsuites/>')).toBe(false);
        expect(looksLikeJUnit(`<testsuite name="${'"'.repeat(1)}${'a'.repeat(60_000)}`)).toBe(false);
        expect(performance.now() - started).toBeLessThan(1000);
    });
});
