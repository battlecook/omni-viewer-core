// RFC-4180-ish CSV text parser. Ported from omni-viewer-chrome
// `templates/csv/js/csvParser.ts` with two changes for the core contract:
//   - ragged rows (padded / truncated to columnCount) are counted so the
//     caller can emit a `diag.csv.ragged-rows` diagnostic,
//   - the record loop reports through a cooperative checkpoint callback so
//     limits / cancellation can stop parsing mid-file (DESIGN.md §3-①).

export interface RawCsv {
    headers: string[];
    rows: string[][];
    columnCount: number;
    /** Rows whose cell count differed from columnCount (padded/truncated). */
    raggedRowCount: number;
    /** True when the record loop was stopped early by the checkpoint. */
    stoppedEarly: boolean;
}

export interface ParseTextOptions {
    delimiter?: string;
    /** First row is headers (default true); otherwise headers are generated. */
    hasHeader?: boolean;
    /**
     * Called after each completed record with the running record count.
     * Return false to stop parsing (limit hit / aborted).
     */
    checkpoint?: (recordCount: number) => boolean;
}

export function parseCsvText(text: string, options: ParseTextOptions = {}): RawCsv {
    const delimiter = options.delimiter ?? ',';
    const hasHeader = options.hasHeader ?? true;
    const checkpoint = options.checkpoint;

    // Strip BOM so the first header doesn't carry a leading U+FEFF.
    const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const normalized = stripped.replace(/\r\n?/g, '\n');

    const records: string[][] = [];
    let field = '';
    let row: string[] = [];
    let inQuotes = false;
    let stoppedEarly = false;

    for (let i = 0; i < normalized.length; i++) {
        const ch = normalized[i];

        if (inQuotes) {
            if (ch === '"') {
                if (normalized[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
            continue;
        }

        if (ch === '"' && field.length === 0) {
            inQuotes = true;
            continue;
        }

        if (ch === delimiter) {
            row.push(field);
            field = '';
            continue;
        }

        if (ch === '\n') {
            row.push(field);
            field = '';
            records.push(row);
            row = [];
            if (checkpoint && !checkpoint(records.length)) {
                stoppedEarly = true;
                break;
            }
            continue;
        }

        field += ch;
    }

    // Flush the last field/row unless we stopped early mid-record. Drop a
    // trailing empty row produced by a final newline. The flushed record goes
    // through the same checkpoint as the loop, so a file without a trailing
    // newline cannot slip one record past the entry limit unreported.
    if (!stoppedEarly && (field.length > 0 || row.length > 0)) {
        row.push(field);
        records.push(row);
        if (checkpoint && !checkpoint(records.length)) {
            stoppedEarly = true;
        }
    }

    if (records.length === 0) {
        return { headers: [], rows: [], columnCount: 0, raggedRowCount: 0, stoppedEarly };
    }

    let headers: string[];
    let dataRows: string[][];
    if (hasHeader) {
        headers = records[0] ?? [];
        dataRows = records.slice(1);
    } else {
        headers = [];
        dataRows = records;
    }

    let columnCount = headers.length;
    for (const r of dataRows) {
        if (r.length > columnCount) columnCount = r.length;
    }

    if (!hasHeader) {
        headers = Array.from({ length: columnCount }, (_, i) => `Column ${i + 1}`);
    } else {
        while (headers.length < columnCount) {
            headers.push(`Column ${headers.length + 1}`);
        }
    }

    let raggedRowCount = 0;
    const padded = dataRows.map((r) => {
        if (r.length === columnCount) return r;
        raggedRowCount++;
        if (r.length > columnCount) return r.slice(0, columnCount);
        const out = r.slice();
        while (out.length < columnCount) out.push('');
        return out;
    });

    return { headers, rows: padded, columnCount, raggedRowCount, stoppedEarly };
}
