export interface ProtoRange { startLine: number; endLine: number }
export interface ProtoField { name: string; type: string; label: string; number: number; repeated: boolean; optional: boolean; map: boolean; oneof?: string; options: string[]; documentation: string; line: number }
export interface ProtoMessage { kind: 'message'; name: string; fullName: string; documentation: string; fields: ProtoField[]; messages: ProtoMessage[]; enums: ProtoEnum[]; oneofs: string[]; reserved: string[]; range: ProtoRange }
export interface ProtoEnumValue { name: string; number: number; documentation: string; line: number }
export interface ProtoEnum { kind: 'enum'; name: string; fullName: string; documentation: string; values: ProtoEnumValue[]; range: ProtoRange }
export interface ProtoRpc { name: string; requestType: string; responseType: string; requestStream: boolean; responseStream: boolean; documentation: string; line: number }
export interface ProtoService { kind: 'service'; name: string; fullName: string; documentation: string; rpcs: ProtoRpc[]; range: ProtoRange }
export interface ProtoReference { from: string; fromKind: 'field' | 'rpc' | 'import'; name: string; to: string; line: number }
export interface ProtoModel {
    fileName: string; syntax: string; packageName: string; imports: string[]; messages: ProtoMessage[]; enums: ProtoEnum[]; services: ProtoService[];
    references: ProtoReference[]; warnings: string[];
    stats: { messages: number; enums: number; services: number; rpcs: number; fields: number; imports: number };
}

type ProtoContainer = ProtoMessage | ProtoEnum | ProtoService;
interface StackFrame { kind: 'message' | 'enum' | 'service' | 'oneof' | 'block'; name: string; fullName: string; node?: ProtoContainer }
const scalarTypes = new Set(['double','float','int32','int64','uint32','uint64','sint32','sint64','fixed32','fixed64','sfixed32','sfixed64','bool','string','bytes']);
const declarationPattern = /^(.+?)\s+([A-Za-z_][\w]*)\s*=\s*([0-9]+)\s*(?:\[([^\]]*)\])?\s*;/;
const labeledFieldPattern = /^(optional|required|repeated)\s+(.+?)$/;

/** Parse a proto2/proto3 schema without loading protoc or executing schema code. */
export function parseProto(source: string, fileName = ''): ProtoModel {
    const lines = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const model: ProtoModel = { fileName, syntax: '', packageName: '', imports: [], messages: [], enums: [], services: [], references: [], warnings: [], stats: { messages: 0, enums: 0, services: 0, rpcs: 0, fields: 0, imports: 0 } };
    const stack: StackFrame[] = []; const docs: string[] = [];
    let inBlockComment = false; let blockComment: string[] = [];
    const consumeDocs = (): string => { const value = docs.join('\n').trim(); docs.length = 0; return value; };
    const currentMessage = (): ProtoMessage | undefined => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.kind === 'message') return stack[i]!.node as ProtoMessage; return undefined; };
    const currentEnum = (): ProtoEnum | undefined => stack.at(-1)?.kind === 'enum' ? stack.at(-1)!.node as ProtoEnum : undefined;
    const currentService = (): ProtoService | undefined => stack.at(-1)?.kind === 'service' ? stack.at(-1)!.node as ProtoService : undefined;
    const currentOneof = (): string | undefined => stack.at(-1)?.kind === 'oneof' ? stack.at(-1)!.name : undefined;

    lines.forEach((rawLine, index) => {
        const lineNumber = index + 1; let line = rawLine.trim();
        if (inBlockComment) { const end = line.indexOf('*/'); if (end < 0) { blockComment.push(cleanDocLine(line)); return; } blockComment.push(cleanDocLine(line.slice(0, end))); docs.push(blockComment.join('\n').trim()); blockComment = []; inBlockComment = false; line = line.slice(end + 2).trim(); }
        if (!line) return;
        if (line.startsWith('//')) { docs.push(line.replace(/^\/\/\s?/, '')); return; }
        if (line.startsWith('/*')) { const end = line.indexOf('*/', 2); if (end < 0) { inBlockComment = true; blockComment = [cleanDocLine(line.slice(2))]; return; } docs.push(cleanDocLine(line.slice(2, end))); line = line.slice(end + 2).trim(); }
        line = stripInlineComment(line).trim(); if (!line) return;
        let match = line.match(/^syntax\s*=\s*"([^"]+)"\s*;/); if (match) { model.syntax = match[1]!; consumeDocs(); return; }
        match = line.match(/^package\s+([\w.]+)\s*;/); if (match) { model.packageName = match[1]!; consumeDocs(); return; }
        match = line.match(/^import\s+(?:public\s+|weak\s+)?["']([^"']+)["']\s*;/); if (match) { const imported = match[1]!; model.imports.push(imported); model.references.push({ from: fileName || 'current file', fromKind: 'import', name: imported, to: imported, line: lineNumber }); consumeDocs(); return; }
        match = line.match(/^message\s+([A-Za-z_]\w*)\s*\{/); if (match) { const parent = currentMessage(); const fullName = qualify(match[1]!, parent?.fullName || model.packageName); const node: ProtoMessage = { kind: 'message', name: match[1]!, fullName, documentation: consumeDocs(), fields: [], messages: [], enums: [], oneofs: [], reserved: [], range: { startLine: lineNumber, endLine: lineNumber } }; parent ? parent.messages.push(node) : model.messages.push(node); stack.push({ kind: 'message', name: node.name, fullName, node }); return; }
        match = line.match(/^enum\s+([A-Za-z_]\w*)\s*\{/); if (match) { const parent = currentMessage(); const fullName = qualify(match[1]!, parent?.fullName || model.packageName); const node: ProtoEnum = { kind: 'enum', name: match[1]!, fullName, documentation: consumeDocs(), values: [], range: { startLine: lineNumber, endLine: lineNumber } }; parent ? parent.enums.push(node) : model.enums.push(node); stack.push({ kind: 'enum', name: node.name, fullName, node }); return; }
        match = line.match(/^service\s+([A-Za-z_]\w*)\s*\{/); if (match) { const fullName = qualify(match[1]!, model.packageName); const node: ProtoService = { kind: 'service', name: match[1]!, fullName, documentation: consumeDocs(), rpcs: [], range: { startLine: lineNumber, endLine: lineNumber } }; model.services.push(node); stack.push({ kind: 'service', name: node.name, fullName, node }); return; }
        match = line.match(/^oneof\s+([A-Za-z_]\w*)\s*\{/); if (match) { currentMessage()?.oneofs.push(match[1]!); stack.push({ kind: 'oneof', name: match[1]!, fullName: match[1]! }); consumeDocs(); return; }
        const enumNode = currentEnum(); match = line.match(/^([A-Za-z_]\w*)\s*=\s*(-?\d+)\s*(?:\[[^\]]*\])?\s*;/); if (enumNode && match) { enumNode.values.push({ name: match[1]!, number: Number(match[2]), documentation: consumeDocs(), line: lineNumber }); return; }
        const service = currentService(); match = line.match(/^rpc\s+([A-Za-z_]\w*)\s*\(\s*(stream\s+)?([.\w]+)\s*\)\s+returns\s*\(\s*(stream\s+)?([.\w]+)\s*\)/); if (service && match) { const rpc: ProtoRpc = { name: match[1]!, requestType: cleanType(match[3]!), responseType: cleanType(match[5]!), requestStream: !!match[2], responseStream: !!match[4], documentation: consumeDocs(), line: lineNumber }; service.rpcs.push(rpc); model.references.push({ from: `${service.fullName}.${rpc.name}`, fromKind: 'rpc', name: 'request', to: rpc.requestType, line: lineNumber }, { from: `${service.fullName}.${rpc.name}`, fromKind: 'rpc', name: 'response', to: rpc.responseType, line: lineNumber }); if (line.includes('{')) stack.push({ kind: 'block', name: '', fullName: '' }); return; }
        const message = currentMessage(); if (message) { match = line.match(/^reserved\s+(.+);/); if (match) { message.reserved.push(match[1]!); consumeDocs(); return; } const field = parseField(line, lineNumber, consumeDocs(), currentOneof()); if (field) { message.fields.push(field); if (!scalarTypes.has(cleanType(field.type)) && !field.map) model.references.push({ from: message.fullName, fromKind: 'field', name: field.name, to: cleanType(field.type), line: lineNumber }); return; } }
        if (line.includes('}')) { for (let n = count(line, '}'); n > 0; n--) { const frame = stack.pop(); if (frame?.node) frame.node.range.endLine = lineNumber; } consumeDocs(); return; }
        if (line.endsWith('{') && !/^rpc\b/.test(line)) stack.push({ kind: 'block', name: '', fullName: '' });
        consumeDocs();
    });
    model.stats = buildStats(model); model.warnings = buildWarnings(model); return model;
}

function parseField(line: string, lineNumber: number, documentation: string, oneof?: string): ProtoField | null {
    if (line.startsWith('option ') || line.startsWith('extensions ')) return null;
    let candidate = line; let label = ''; const labeled = candidate.match(labeledFieldPattern); if (labeled) { label = labeled[1]!; candidate = labeled[2]!; }
    const match = candidate.match(declarationPattern); if (!match) return null; const type = match[1]!;
    return { name: match[2]!, type, label, number: Number(match[3]), repeated: label === 'repeated', optional: label === 'optional', map: type.startsWith('map<'), ...(oneof ? { oneof } : {}), options: match[4]?.split(',').map(v => v.trim()).filter(Boolean) ?? [], documentation, line: lineNumber };
}
export function flattenProtoMessages(messages: readonly ProtoMessage[]): ProtoMessage[] { return messages.flatMap(message => [message, ...flattenProtoMessages(message.messages)]); }
export function allProtoTypes(model: ProtoModel): Array<ProtoMessage | ProtoEnum | ProtoService> { const messages = flattenProtoMessages(model.messages); return [...messages, ...model.enums, ...messages.flatMap(message => message.enums), ...model.services]; }
function buildStats(model: ProtoModel): ProtoModel['stats'] { const messages = flattenProtoMessages(model.messages); return { messages: messages.length, enums: model.enums.length + messages.reduce((n, m) => n + m.enums.length, 0), services: model.services.length, rpcs: model.services.reduce((n, s) => n + s.rpcs.length, 0), fields: messages.reduce((n, m) => n + m.fields.length, 0), imports: model.imports.length }; }
function buildWarnings(model: ProtoModel): string[] { const warnings: string[] = []; const messages = flattenProtoMessages(model.messages); const names = new Set([...messages.map(m => m.fullName), ...model.enums.map(e => e.fullName), ...messages.flatMap(m => m.enums.map(e => e.fullName))]); const shorts = new Set([...names].map(n => n.split('.').at(-1)!)); for (const message of messages) { const numbers = new Map<number,string>(); for (const field of message.fields) { const previous = numbers.get(field.number); if (previous) warnings.push(`${message.fullName} reuses field number ${field.number} for ${previous} and ${field.name}.`); numbers.set(field.number, field.name); } } for (const ref of model.references.filter(r => r.fromKind !== 'import')) { const target = cleanType(ref.to); if (!scalarTypes.has(target) && !names.has(target) && !shorts.has(target.split('.').at(-1)!)) warnings.push(`${ref.from} references ${ref.to} on line ${ref.line}, but it is not declared in this file.`); } if (!model.syntax) warnings.push('No syntax declaration found.'); return warnings; }
function qualify(name: string, prefix: string): string { return prefix ? `${prefix}.${name}` : name; }
function cleanType(type: string): string { return type.replace(/^\./, '').trim(); }
function cleanDocLine(value: string): string { return value.replace(/^\s*\*\s?/, '').trim(); }
function count(value: string, char: string): number { return [...value].filter(v => v === char).length; }
function stripInlineComment(line: string): string { let quoted = false; for (let i = 0; i < line.length - 1; i++) { if (line[i] === '"' && line[i - 1] !== '\\') quoted = !quoted; if (!quoted && line[i] === '/' && line[i + 1] === '/') return line.slice(0, i); } return line; }
