// CSV delimiter auto-detection. Ported unchanged (already pure and
// deterministic) from omni-viewer-chrome `templates/csv/js/csvDelimiter.ts`,
// except the file-extension shortcut uses ASCII-only lowercasing (ADR 41).

export type CsvDelimiter = ',' | ';' | '\t' | '|';

export interface DelimiterDetectionResult {
    delimiter: CsvDelimiter;
    confidence: number;
}

/** Order matters — earlier candidates win priority ties. */
export const DELIMITER_PRIORITY: readonly CsvDelimiter[] = [',', '\t', ';', '|'];

const DEFAULT_SAMPLE_LINES = 10;
const DEFAULT_DELIMITER: CsvDelimiter = ',';

export interface DetectOptions {
    /** Maximum number of leading lines to inspect (default 10). */
    sampleLines?: number;
}

/**
 * Detect the most likely delimiter in `text`.
 *
 * Always returns a result. When `text` has no candidates at all (e.g. a
 * single-column CSV) we fall back to `,` with confidence 0 so callers can
 * still parse deterministically.
 */
export function detectDelimiter(
    text: string,
    options: DetectOptions = {}
): DelimiterDetectionResult {
    const sampleLines = options.sampleLines ?? DEFAULT_SAMPLE_LINES;
    const lines = takeSampleLines(text, sampleLines);

    if (lines.length === 0) {
        return { delimiter: DEFAULT_DELIMITER, confidence: 0 };
    }

    interface Score {
        delimiter: CsvDelimiter;
        mean: number;
        variance: number;
        score: number;
        priorityIndex: number;
    }

    const scores: Score[] = DELIMITER_PRIORITY.map((delimiter, priorityIndex) => {
        const counts = lines.map((line) => countOutsideQuotes(line, delimiter));
        const positive = counts.filter((c) => c > 0);
        const mean = positive.length === 0 ? 0 : sum(positive) / positive.length;
        const variance =
            positive.length === 0
                ? Number.POSITIVE_INFINITY
                : varianceOf(positive, mean);
        // Consistency factor squared: a delimiter firing on every line beats
        // one firing on a single high-count outlier.
        const consistency = positive.length / lines.length;
        const score = mean * consistency * consistency;
        return { delimiter, mean, variance, score, priorityIndex };
    });

    scores.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.variance !== b.variance) return a.variance - b.variance;
        return a.priorityIndex - b.priorityIndex;
    });

    const winner = scores[0];
    if (!winner || winner.score === 0) {
        return { delimiter: DEFAULT_DELIMITER, confidence: 0 };
    }

    const runnerUp = scores[1];
    const runnerScore = runnerUp ? runnerUp.score : 0;
    const total = winner.score + runnerScore;
    const confidence = total === 0 ? 0 : (winner.score - runnerScore) / total;

    return {
        delimiter: winner.delimiter,
        confidence: Math.max(0, Math.min(1, confidence))
    };
}

/**
 * Slice `text` into up to `max` logical lines: a `\n` only breaks a line when
 * it falls outside an open double-quoted span.
 */
function takeSampleLines(text: string, max: number): string[] {
    if (!text || max <= 0) return [];

    const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const normalized = stripped.replace(/\r\n?/g, '\n');

    const out: string[] = [];
    let buf = '';
    let inQuotes = false;

    for (let i = 0; i < normalized.length; i++) {
        const ch = normalized[i];
        if (ch === '"') {
            if (inQuotes && normalized[i + 1] === '"') {
                buf += '""';
                i++;
                continue;
            }
            inQuotes = !inQuotes;
            buf += ch;
            continue;
        }
        if (ch === '\n' && !inQuotes) {
            if (buf.length > 0) out.push(buf);
            buf = '';
            if (out.length >= max) return out;
            continue;
        }
        buf += ch;
    }

    if (out.length < max && buf.length > 0) out.push(buf);
    return out;
}

/**
 * Count occurrences of `delimiter` in `line`, ignoring any inside a
 * double-quoted span (`""` is the escaped quote and stays inside).
 */
export function countOutsideQuotes(line: string, delimiter: string): number {
    if (!delimiter) return 0;
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                i++;
                continue;
            }
            inQuotes = !inQuotes;
            continue;
        }
        if (!inQuotes && ch === delimiter) {
            count++;
        }
    }
    return count;
}

function sum(values: readonly number[]): number {
    let s = 0;
    for (const v of values) s += v;
    return s;
}

function varianceOf(values: readonly number[], mean: number): number {
    if (values.length <= 1) return 0;
    let acc = 0;
    for (const v of values) {
        const d = v - mean;
        acc += d * d;
    }
    return acc / values.length;
}

/** ASCII-only lowercase (determinism rule — no locale-dependent toLowerCase). */
export function asciiLower(s: string): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : s[i];
    }
    return out;
}

/**
 * Extension shortcut: `.tsv` is unambiguously tab-delimited; anything else
 * falls through to content-based detection.
 */
export function detectDelimiterForFile(
    fileName: string,
    text: string,
    options: DetectOptions = {}
): DelimiterDetectionResult {
    if (asciiLower(fileName).endsWith('.tsv')) {
        return { delimiter: '\t', confidence: 1 };
    }
    return detectDelimiter(text, options);
}
