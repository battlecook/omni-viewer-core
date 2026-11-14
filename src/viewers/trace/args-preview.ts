const TEXT_LIMIT = 16_384;
const DEPTH_LIMIT = 16;

export function formatTraceArgs(args: Record<string, unknown>): { text: string; truncated: boolean } {
    const parts: string[] = [];
    let remaining = TEXT_LIMIT;
    let truncated = false;
    const append = (text: string) => {
        parts.push(text.slice(0, remaining));
        if (text.length > remaining) truncated = true;
        remaining -= Math.min(remaining, text.length);
    };
    const quoted = (value: string) => {
        if (value.length > remaining) truncated = true;
        append(JSON.stringify(value.slice(0, remaining)));
    };
    const format = (value: unknown, depth: number) => {
        if (typeof value === 'string') {
            quoted(value);
            return;
        }
        if (value === null || typeof value !== 'object') {
            append(JSON.stringify(value) ?? 'null');
            return;
        }
        if (depth >= DEPTH_LIMIT) {
            truncated = true;
            append('…');
            return;
        }
        const array = Array.isArray(value);
        const entries = value as Record<string, unknown>;
        append(array ? '[' : '{');
        let first = true;
        for (const key in entries) {
            if (!Object.hasOwn(entries, key)) continue;
            if (!remaining) {
                truncated = true;
                break;
            }
            if (!first) append(',');
            first = false;
            append('\n' + '  '.repeat(depth + 1));
            if (!array) {
                quoted(key);
                append(': ');
            }
            if (remaining) format(entries[key], depth + 1);
        }
        if (!first) append('\n' + '  '.repeat(depth));
        append(array ? ']' : '}');
    };
    format(args, 0);
    return { text: parts.join(''), truncated };
}
