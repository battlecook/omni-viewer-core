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
    const sample = skipPrologue(text.slice(0, 64 * 1024));
    // Quoted attribute values may hold a literal '>' (name="a > b").
    const root = /^<(testsuites?)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(sample);
    if (!root) return false;
    if (root[1] === 'testsuites') return true;
    if (/\s(?:tests|failures|errors)\s*=\s*["']/.test(root[2]!)) return true;
    if (root[2]!.endsWith('/')) return false;
    const first = /^<([A-Za-z_][\w.-]*)/.exec(skipPrologue(sample.slice(root[0].length)));
    return first !== null && SUITE_CHILDREN.includes(first[1]!);
}

/** Drops a BOM, whitespace, and any declaration / PIs / comments / DOCTYPE,
 *  scanning forward once so hostile repetition stays linear. */
function skipPrologue(text: string): string {
    let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    for (;;) {
        while (index < text.length && /\s/.test(text[index]!)) index++;
        let closer: string;
        let skip: number;
        if (text.startsWith('<?', index)) { closer = '?>'; skip = 2; }
        else if (text.startsWith('<!--', index)) { closer = '-->'; skip = 4; }
        else if (text.startsWith('<!DOCTYPE', index)) {
            index = doctypeEnd(text, index + 9);
            if (index === -1) return '';
            continue;
        }
        else return text.slice(index);
        const end = text.indexOf(closer, index + skip);
        if (end === -1) return '';
        index = end + closer.length;
    }
}

/** Index just past a DOCTYPE's closing '>', skipping quoted literals and an
 *  internal subset `[...]` (whose declarations, comments and literals hold '>'s
 *  of their own); -1 when it does not close within the sample. Linear. */
function doctypeEnd(text: string, from: number): number {
    let inSubset = false;
    for (let i = from; i < text.length; i++) {
        const char = text[i]!;
        if (char === '"' || char === "'") {
            const close = text.indexOf(char, i + 1);
            if (close === -1) return -1;
            i = close;
        } else if (inSubset && text.startsWith('<!--', i)) {
            const close = text.indexOf('-->', i + 4);
            if (close === -1) return -1;
            i = close + 2;
        } else if (char === '[') inSubset = true;
        else if (char === ']') inSubset = false;
        else if (char === '>' && !inSubset) return i + 1;
    }
    return -1;
}
