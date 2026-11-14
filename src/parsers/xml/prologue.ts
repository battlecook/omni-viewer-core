/** Drops a BOM, whitespace, and any declaration / PIs / comments / DOCTYPE,
 *  scanning forward once so hostile repetition stays linear. */
export function skipXmlPrologue(text: string): string {
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
