import { parseJsonDocument } from '../json/index.js';
import type { Diagnostic } from '../types.js';
import type { JsonlDocument } from './model.js';

export function parseJsonlText(text: string, maxEntries: number): { document: JsonlDocument; diagnostics: Diagnostic[]; limited: boolean } {
    const entries: JsonlDocument['entries'] = []; const diagnostics: Diagnostic[] = [];
    const lines = text.match(/.*(?:\r\n|\n|$)/g) ?? []; let line = 1; let limited = false;
    for (const item of lines) { if (!item && line > 1) continue; if (entries.length >= maxEntries) { limited = true; break; }
        const ending = item.endsWith('\r\n') ? '\r\n' : item.endsWith('\n') ? '\n' : '';
        const raw = ending ? item.slice(0, -ending.length) : item;
        if (!raw.trim()) { entries.push({ id: `line:${line}`, line, raw, lineEnding: ending, value: null, diagnostics: [] }); line++; continue; }
        const parsed = parseJsonDocument(raw); const entryDiagnostics = parsed.diagnostics;
        if (!parsed.root || parsed.errored || parsed.trailing) {
            const diagnostic: Diagnostic = { severity: 'warning', code: 'invalid-jsonl-line', messageKey: 'diag.jsonl.invalid-line', args: { line }, location: `line:${line}` };
            entries.push({ id: `line:${line}`, line, raw, lineEnding: ending, value: parsed.root, diagnostics: [...entryDiagnostics, diagnostic] }); diagnostics.push(diagnostic);
        } else entries.push({ id: `line:${line}`, line, raw, lineEnding: ending, value: parsed.root, diagnostics: entryDiagnostics });
        line++;
    }
    return { document: { text, entries }, diagnostics, limited };
}
