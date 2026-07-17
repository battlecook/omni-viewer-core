export function isText(data: Uint8Array): boolean { return !data.some(x => x === 0 || (x < 9) || (x > 13 && x < 32)); }
export function hexPreview(data: Uint8Array, max = 4096): string { return Array.from(data.subarray(0,max), x=>x.toString(16).padStart(2,'0')).join(' ') + (data.length>max?' …':''); }
