/** Conservative IPC sniffing without importing the optional Arrow runtime. */
export function looksLikeArrowIpc(data: Uint8Array): boolean {
    if ([0x41, 0x52, 0x52, 0x4f, 0x57, 0x31].every((byte, index) => data[index] === byte)) return true;
    if (data.byteLength < 16) return false;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const continuation = view.getInt32(0, true) === -1;
    const prefix = continuation ? 8 : 4;
    const length = view.getInt32(continuation ? 4 : 0, true);
    if (length < 16 || length > 16 * 1024 * 1024) return false;
    const available = Math.min(data.byteLength, prefix + length);
    const table = prefix + view.getUint32(prefix, true);
    if (table < prefix + 4 || table + 4 > available) return false;
    const vtable = table - view.getInt32(table, true);
    if (vtable < prefix + 4 || vtable + 8 > available) return false;
    const field = view.getUint16(vtable + 6, true);
    if (field < 4 || table + field >= available) return false;
    // Message.header_type = Schema (1). A continuation marker alone is ambiguous.
    return view.getUint8(table + field) === 1;
}
