import { skipXmlPrologue } from '../xml/prologue.js';

// JUnit report signature check, kept apart from the parser so the registry can
// sniff a `.xml` without loading the XML scanner (docs/viewers/junit.md §1).

/** Elements a JUnit suite holds — the sniff uses them to tell a JUnit
 *  `<testsuite>` root from an unrelated one (TestLink exports, for instance,
 *  open with `<node_order>` or `<details>`). */
const SUITE_CHILDREN = ['properties', 'testcase', 'testsuite', 'system-out', 'system-err'];

/**
 * True when `text` opens with a JUnit report root: `<testsuites>`, or a
 * `<testsuite>` that carries a count attribute or opens with a JUnit child
 * element. Names are case-sensitive and unprefixed, as every writer emits
 * them; NUnit's `<test-run>` and xUnit.net's `<assemblies>` are not claimed.
 */
export function looksLikeJUnit(text: string): boolean {
    const sample = skipXmlPrologue(text.slice(0, 64 * 1024));
    // Quoted attribute values may hold a literal '>' (name="a > b").
    const root = /^<(testsuites?)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(sample);
    if (!root) return false;
    if (root[1] === 'testsuites') return true;
    if (/\s(?:tests|failures|errors)\s*=\s*["']/.test(root[2]!)) return true;
    if (root[2]!.endsWith('/')) return false;
    const first = /^<([A-Za-z_][\w.-]*)/.exec(skipXmlPrologue(sample.slice(root[0].length)));
    return first !== null && SUITE_CHILDREN.includes(first[1]!);
}
