import { finite, invalidPreview, object, previewParser, string, type JsonObject } from '../file-preview.js';
import { decodeUtf8, type ParseOptions, type ParseOutcome } from '../types.js';

export interface TraceEvent {
    name: string;
    category: string;
    start: number;
    duration: number;
    args: JsonObject | undefined;
}
export interface TraceTrack {
    /** Numeric ids per the spec; string ids (e.g. PyTorch Kineto spans) are kept as written. */
    pid: number | string;
    tid: number | string;
    label: string;
    events: TraceEvent[];
}
export interface TraceDocument {
    tracks: TraceTrack[];
    start: number;
    end: number;
    eventCount: number;
}

/** Perfetto and chrome://tracing also accept string pid/tid values. */
function traceId(value: unknown): number | string | undefined {
    return typeof value === 'string' ? value : finite(value);
}
const idKey = (value: number | string | undefined) => typeof value === 'string' ? JSON.stringify(value) : String(value);

/** The JSON Array Format may omit its closing `]` (traces of crashed processes); close it like catapult does. */
function traceJson(input: Uint8Array): unknown {
    const text = decodeUtf8(input);
    try {
        return JSON.parse(text) as unknown;
    } catch {
        const body = text.trimEnd();
        if (!body.trimStart().startsWith('[')) return invalidPreview();
        try {
            return JSON.parse(`${body.endsWith(',') ? body.slice(0, -1) : body}]`) as unknown;
        } catch {
            return invalidPreview();
        }
    }
}

export function parseTrace(input: Uint8Array, options: ParseOptions = {}): ParseOutcome<TraceDocument> {
    const parser = previewParser(input, options, 64 * 1024 * 1024);
    try {
        parser.check();
        const value = traceJson(input);
        parser.requireTime();
        const records = Array.isArray(value) ? value : object(value)?.traceEvents;
        if (!Array.isArray(records)) return invalidPreview();
        const limit = options.limits?.maxEntries ?? 100_000;
        const tracks = new Map<string, TraceTrack>();
        const stacks = new Map<string, TraceEvent[]>();
        const processNames = new Map<number | string, string>();
        const threadNames = new Map<string, string>();
        let start = Infinity;
        let end = -Infinity;
        let eventCount = 0;
        let recognized = false;
        if (records.length > limit) parser.warn('truncated');
        for (const candidate of records.slice(0, limit)) {
            if (!parser.checkpoint()) break;
            const raw = object(candidate);
            const pid = traceId(raw?.pid), tid = traceId(raw?.tid), ts = finite(raw?.ts);
            const phase = string(raw?.ph);
            if (!raw || pid === undefined || !phase) {
                parser.warn('skipped');
                continue;
            }
            const name = string(raw.name);
            const args = object(raw.args);
            const key = `${idKey(pid)}:${idKey(tid)}`;
            if (phase === 'M') {
                recognized = true;
                if (name === 'process_name' && string(args?.name)) processNames.set(pid, string(args?.name).slice(0, 512));
                if (tid !== undefined && name === 'thread_name' && string(args?.name)) threadNames.set(key, string(args?.name).slice(0, 512));
                continue;
            }
            if (ts === undefined || tid === undefined) {
                parser.warn('skipped');
                continue;
            }
            recognized = true;
            const event: TraceEvent = { name, category: string(raw.cat), start: ts, duration: 0, args };
            const stack = stacks.get(key) ?? [];
            if (phase === 'B') {
                stack.push(event);
                stacks.set(key, stack);
                continue;
            }
            let complete = event;
            if (phase === 'E') {
                const begin = stack.pop();
                if (!begin || ts < begin.start || !Number.isFinite(ts - begin.start)) {
                    parser.warn('skipped');
                    continue;
                }
                complete = { ...begin, duration: ts - begin.start, args: args ? { ...begin.args, ...args } : begin.args };
            } else if (phase === 'X') {
                const duration = finite(raw.dur);
                if (duration === undefined || duration < 0 || !Number.isFinite(ts + duration)) {
                    parser.warn('skipped');
                    continue;
                }
                complete.duration = duration;
            } else if (!['I', 'i', 'R'].includes(phase)) {
                parser.warn('unsupported');
                continue;
            }
            let track = tracks.get(key);
            if (!track) {
                track = { pid, tid, label: `${String(pid).slice(0, 512)}:${String(tid).slice(0, 512)}`, events: [] };
                tracks.set(key, track);
            }
            track.events.push(complete);
            start = Math.min(start, complete.start);
            end = Math.max(end, complete.start + complete.duration);
            eventCount++;
        }
        if ([...stacks.values()].some(stack => stack.length)) parser.warn('skipped');
        if (records.length && limit > 0 && !recognized && parser.checkpoint()) return invalidPreview();
        for (const [key, track] of tracks) {
            // As in Perfetto, a string id doubles as the process or thread name.
            const process = processNames.get(track.pid) ?? (typeof track.pid === 'string' && track.pid ? track.pid.slice(0, 512) : undefined);
            const thread = threadNames.get(key) ?? (typeof track.tid === 'string' && track.tid ? track.tid.slice(0, 512) : undefined);
            const fallback = track.label;
            track.label = process ? `${process} / ${thread ?? fallback}` : thread ?? fallback;
            track.events.sort((a, b) => a.start - b.start || b.duration - a.duration);
        }
        if (eventCount && !Number.isFinite(end - start)) return invalidPreview();
        return parser.success({ tracks: [...tracks.values()], start: eventCount ? start : 0, end: eventCount ? end : 0, eventCount });
    } catch (error) {
        return parser.failure(error);
    }
}
