/**
 * Epoch millis from an ISO-8601 timestamp, without `new Date(string)` (whose
 * result is implementation- and timezone-dependent — DESIGN.md §3-①). A
 * timestamp with no offset is read as UTC.
 * Returns null for anything it cannot read, so the caller can report it.
 */
export function parseIso8601Millis(value: string): number | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/
        .exec(value.trim());
    if (!match) return null;
    const [, year, month, day, hour, minute, second = '0', fraction = '', , sign, offsetHour, offsetMinute] = match;
    const y = Number(year), mo = Number(month), d = Number(day);
    const h = Number(hour), mi = Number(minute), s = Number(second);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
    if (d > daysInMonth(y, mo)) return null;
    const millis = Number((fraction + '000').slice(0, 3));
    // Built field by field rather than with Date.UTC, whose legacy two-digit
    // window would remap year 0001 (what a .NET writer emits for an unset
    // DateTime) to 1901. `new Date(0)` is an epoch, not a parsed string, so the
    // determinism rule still holds.
    const date = new Date(0);
    date.setUTCFullYear(y, mo - 1, d);
    date.setUTCHours(h, mi, Math.min(s, 59), millis);
    let epoch = date.getTime();
    if (!Number.isFinite(epoch)) return null;
    if (sign) {
        const offset = Number(offsetHour) * 60 + Number(offsetMinute);
        if (Number(offsetHour) > 23 || Number(offsetMinute) > 59) return null;
        epoch += (sign === '-' ? 1 : -1) * offset * 60_000;
    }
    return epoch;
}

function daysInMonth(year: number, month: number): number {
    if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
    return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}
