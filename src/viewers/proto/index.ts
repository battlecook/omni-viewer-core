import type { ClipboardService, FileSaveService, FileWritebackService, HostContext } from '../../host/index.js';
import { allProtoTypes, flattenProtoMessages, parseProto, type ProtoEnum, type ProtoMessage, type ProtoModel, type ProtoService } from '../../parsers/proto/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { protoViewerCss } from './styles.js';
export { protoViewerCss } from './styles.js';
export { parseProto } from '../../parsers/proto/index.js';
export const PROTO_VIEWER_META = { id: 'proto', displayNameKey: 'proto.title', extensions: ['proto'], priority: 10, requiredServices: [] as const, optionalServices: ['clipboard', 'save', 'writeback'] as const, inputOwnership: 'borrows' as const };
export type ProtoViewerContext = HostContext & { clipboard?: ClipboardService; save?: FileSaveService; writeback?: FileWritebackService };
type Panel = 'tree' | 'types' | 'relationships' | 'reverse' | 'json' | 'breaking' | 'imports' | 'grpc' | 'docs';
type Declaration = ProtoMessage | ProtoEnum | ProtoService;
type ProtoToken = { cls?: string | undefined; text: string };

const PROTO_KEYWORDS = new Set(['syntax', 'package', 'import', 'public', 'weak', 'option', 'message', 'enum', 'service', 'rpc', 'returns', 'stream', 'repeated', 'optional', 'required', 'oneof', 'map', 'reserved', 'extend', 'extensions', 'to', 'max', 'group', 'default']);
const PROTO_TYPES = new Set(['double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes']);
const PROTO_LITERALS = new Set(['true', 'false']);

/** Tokenize a single proto source line, threading block-comment state across lines. */
function tokenizeProtoLine(line: string, inBlock: boolean): { tokens: ProtoToken[]; inBlock: boolean } {
    const tokens: ProtoToken[] = []; let i = 0;
    if (inBlock) { const end = line.indexOf('*/'); if (end === -1) { if (line) tokens.push({ cls: 'comment', text: line }); return { tokens, inBlock: true }; } tokens.push({ cls: 'comment', text: line.slice(0, end + 2) }); i = end + 2; inBlock = false; }
    while (i < line.length) {
        const rest = line.slice(i); const ch = line[i]!;
        if (rest.startsWith('//')) { tokens.push({ cls: 'comment', text: rest }); break; }
        if (rest.startsWith('/*')) { const end = line.indexOf('*/', i + 2); if (end === -1) { tokens.push({ cls: 'comment', text: rest }); return { tokens, inBlock: true }; } tokens.push({ cls: 'comment', text: line.slice(i, end + 2) }); i = end + 2; continue; }
        if (ch === '"' || ch === "'") { let j = i + 1; while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1; j = Math.min(j + 1, line.length); tokens.push({ cls: 'str', text: line.slice(i, j) }); i = j; continue; }
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[i + 1] ?? ''))) { const match = /^[-+]?(?:0x[0-9a-fA-F]+|\d[\d.eE+-]*)/.exec(rest)!; tokens.push({ cls: 'num', text: match[0] }); i += match[0].length; continue; }
        if (/[A-Za-z_]/.test(ch)) { const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)!; const word = match[0]; const cls = PROTO_KEYWORDS.has(word) ? 'kw' : PROTO_TYPES.has(word) ? 'type' : PROTO_LITERALS.has(word) ? 'num' : undefined; tokens.push({ cls, text: word }); i += word.length; continue; }
        if (/[{}()[\]<>=;,]/.test(ch)) { tokens.push({ cls: 'punct', text: ch }); i += 1; continue; }
        tokens.push({ text: ch }); i += 1;
    }
    return { tokens, inBlock };
}

export async function mountProtoViewer(input: ViewerInput, container: HTMLElement, ctx: ProtoViewerContext, options: MountOptions = {}): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const source = new TextDecoder().decode(input.data); let model = parseProto(source, input.fileName); const t = ctx.i18n.t.bind(ctx.i18n);
    let root: HTMLElement | ShadowRoot;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && typeof container.attachShadow === 'function') { root = container.shadowRoot ?? container.attachShadow({ mode: 'open' }); const style = document.createElement('style'); style.textContent = protoViewerCss; root.append(style); }
    else { container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--proto'); root = container; }
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
    const disposers: Array<() => void> = []; const panelDisposers: Array<() => void> = [];
    const listen = (bucket: Array<() => void>, node: HTMLElement, type: string, listener: EventListener): void => { node.addEventListener(type, listener); bucket.push(() => node.removeEventListener(type, listener)); };
    const on = (node: HTMLElement, type: string, listener: EventListener): void => listen(disposers, node, type, listener);
    const onPanel = (node: HTMLElement, type: string, listener: EventListener): void => listen(panelDisposers, node, type, listener);
    const frame = el('div', 'omni-proto'); const header = el('header', 'omni-proto__header');
    const summaryText = (): string => t('proto.summary', { syntax: model.syntax || 'proto', package: model.packageName || t('proto.noPackage'), messages: model.stats.messages, services: model.stats.services });
    const summary = el('span', 'omni-proto__summary', summaryText());
    header.append(el('strong', 'omni-proto__title', input.fileName), summary);
    const toolbar = el('div', 'omni-proto__toolbar'); const search = el('input', 'omni-proto__search') as HTMLInputElement; search.type = 'search'; search.placeholder = t('proto.search'); search.setAttribute('aria-label', t('proto.search')); toolbar.append(search);
    const panelDefs: Array<[Panel, string]> = [['tree','proto.panel.tree'],['types','proto.panel.types'],['relationships','proto.panel.relationships'],['reverse','proto.panel.reverse'],['json','proto.panel.json'],['breaking','proto.panel.breaking'],['imports','proto.panel.imports'],['grpc','proto.panel.grpc'],['docs','proto.panel.docs']]; let active: Panel = 'tree'; let selectedType = flattenProtoMessages(model.messages)[0]?.fullName ?? '';
    const copy = el('button', undefined, t('proto.copyPanel')); copy.type = 'button'; copy.disabled = !ctx.clipboard; copy.title = ctx.clipboard ? '' : t('common.noClipboard');
    const save = el('button', undefined, t('json.save')); save.type = 'button'; const saveAs = el('button', undefined, t('json.saveAs')); saveAs.type = 'button';
    const status = el('span', 'omni-proto__status'); status.setAttribute('aria-live', 'polite');
    toolbar.append(copy, save, saveAs, status);
    const highlight = el('pre', 'omni-proto__highlight');
    const highlightSource = (text: string): void => { highlight.replaceChildren(); let inBlock = false; text.replace(/\r\n?|\n/g, '\n').split('\n').forEach((lineText, i) => { const line = el('span', 'omni-proto__line'); line.dataset.line = String(i + 1); const result = tokenizeProtoLine(lineText, inBlock); inBlock = result.inBlock; if (!result.tokens.length) line.textContent = ' '; else result.tokens.forEach(token => line.append(token.cls ? el('span', `omni-proto__tok--${token.cls}`, token.text) : document.createTextNode(token.text))); highlight.append(line); }); };
    const editor = el('textarea', 'omni-proto__editor') as HTMLTextAreaElement; editor.spellcheck = false; editor.value = source; editor.setAttribute('aria-label', t('json.editor.title'));
    let savedText = source; let dirty = false;
    const sourceView = el('div', 'omni-proto__source'); sourceView.append(highlight, editor);
    const syncScroll = (): void => { highlight.scrollTop = editor.scrollTop; highlight.scrollLeft = editor.scrollLeft; };
    on(editor, 'scroll', syncScroll); highlightSource(source);
    const panel = el('section', 'omni-proto__panel'); const workspace = el('main', 'omni-proto__workspace'); workspace.append(sourceView, panel);
    const reveal = (line?: number): void => { if (!line) return; highlight.querySelectorAll('.is-selected').forEach(node => node.classList.remove('is-selected')); const target = highlight.querySelector<HTMLElement>(`[data-line="${line}"]`); target?.classList.add('is-selected'); const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 18; editor.scrollTop = Math.max(0, (line - 1) * lineHeight - editor.clientHeight / 2); syncScroll(); };
    const row = (badge: string, text: string, line?: number): HTMLElement => { const node = el('div', 'omni-proto__row'); node.append(el('span', 'omni-proto__badge', badge), el('span', 'omni-proto__code', text)); node.dataset.search = `${badge} ${text}`.toLowerCase(); if (line) { node.dataset.line = String(line); onPanel(node, 'click', () => reveal(line)); } return node; };
    const kind = (value: string): string => t(`proto.kind.${value}`);
    const declaration = (item: Declaration): HTMLElement => { const wrap = el('div', 'omni-proto__card'); wrap.dataset.search = `${item.kind} ${item.fullName} ${item.documentation}`.toLowerCase(); wrap.append(row(kind(item.kind), item.fullName, item.range.startLine)); const children = el('div', 'omni-proto__children'); if (item.kind === 'message') { item.fields.forEach(field => children.append(row(field.oneof ? `${kind('oneof')} ${field.oneof}` : field.repeated ? kind('repeated') : kind('field'), `${field.name}: ${field.type} = ${field.number}`, field.line))); item.enums.forEach(value => children.append(declaration(value))); item.messages.forEach(value => children.append(declaration(value))); } else if (item.kind === 'enum') item.values.forEach(value => children.append(row(kind('value'), `${value.name} = ${value.number}`, value.line))); else item.rpcs.forEach(rpc => children.append(row(kind('rpc'), `${rpc.name}(${rpc.requestStream ? `${kind('stream')} ` : ''}${rpc.requestType}) → ${rpc.responseStream ? `${kind('stream')} ` : ''}${rpc.responseType}`, rpc.line))); wrap.append(children); return wrap; };
    const selectType = (messagesOnly = false): HTMLSelectElement => { const select = el('select') as HTMLSelectElement; const values = messagesOnly ? flattenProtoMessages(model.messages) : allProtoTypes(model); values.forEach(value => { const option = el('option', undefined, value.fullName); option.value = value.fullName; select.append(option); }); if (!values.some(value => value.fullName === selectedType)) selectedType = values[0]?.fullName ?? ''; select.value = selectedType; onPanel(select, 'change', () => { selectedType = select.value; render(); }); return select; };
    const example = (message: ProtoMessage, seen = new Set<string>()): unknown => {
        if (seen.has(message.fullName)) return {};
        const next = new Set(seen).add(message.fullName);
        const messages = flattenProtoMessages(model.messages);
        const enums = allProtoTypes(model).filter((item): item is ProtoEnum => item.kind === 'enum');
        const scalars: Record<string, unknown> = { string: 'string', bytes: 'base64', bool: false, double: 0, float: 0, int32: 0, int64: '0', uint32: 0, uint64: '0', sint32: 0, sint64: '0', fixed32: 0, fixed64: '0', sfixed32: 0, sfixed64: '0' };
        const matchesType = (candidate: { name: string; fullName: string }, type: string): boolean => candidate.fullName === type || candidate.name === type || candidate.fullName.endsWith(`.${type}`);
        return Object.fromEntries(message.fields.map(field => {
            const type = field.type.replace(/^\./, '');
            let value: unknown;
            if (field.map) value = { key: 'value' };
            else if (Object.prototype.hasOwnProperty.call(scalars, type)) value = scalars[type];
            else {
                const enumType = enums.find(candidate => matchesType(candidate, type));
                const nested = messages.find(candidate => matchesType(candidate, type));
                value = enumType ? (enumType.values[0]?.name ?? 'ENUM_VALUE') : nested ? example(nested, next) : null;
            }
            return [field.name, field.repeated ? [value] : value];
        }));
    };
    const breakingFindings = (previous: ProtoModel): string[] => { const findings: string[] = []; const currentMessages = new Map(flattenProtoMessages(model.messages).map(message => [message.fullName, message])); for (const oldMessage of flattenProtoMessages(previous.messages)) { const current = currentMessages.get(oldMessage.fullName); if (!current) { findings.push(t('proto.breaking.messageRemoved', { name: oldMessage.fullName })); continue; } const fields = new Map(current.fields.map(field => [field.number, field])); for (const oldField of oldMessage.fields) { const field = fields.get(oldField.number); if (!field) findings.push(t('proto.breaking.fieldRemoved', { message: oldMessage.fullName, field: oldField.name, number: oldField.number })); else if (field.name !== oldField.name || field.type !== oldField.type) findings.push(t('proto.breaking.fieldChanged', { message: oldMessage.fullName, number: oldField.number })); } } return findings; };
    const applySearch = (query: string): void => { const filter = (node: HTMLElement): boolean => { const own = !query || (node.dataset.search?.includes(query) ?? false); let childMatch = false; for (const child of node.children) if (child instanceof HTMLElement) childMatch = filter(child) || childMatch; const visible = own || childMatch; if (node.dataset.search !== undefined || node.classList.contains('omni-proto__card')) node.style.display = visible ? '' : 'none'; return visible; }; for (const child of panel.children) if (child instanceof HTMLElement) filter(child); };
    const render = (): void => {
        panelDisposers.splice(0).forEach(dispose => dispose());
        panel.replaceChildren();
        if (active === 'tree') [...model.messages, ...model.enums, ...model.services].forEach(item => panel.append(declaration(item)));
        else if (active === 'types') allProtoTypes(model).forEach(item => panel.append(declaration(item)));
        else if (active === 'relationships') model.references.forEach(ref => panel.append(row(kind(ref.fromKind), `${ref.from} → ${ref.to} (${ref.name})`, ref.line)));
        else if (active === 'reverse') { panel.append(selectType()); const refs = model.references.filter(ref => ref.to === selectedType || ref.to.split('.').at(-1) === selectedType.split('.').at(-1)); refs.forEach(ref => panel.append(row(kind(ref.fromKind), t('proto.reverseRow', { from: ref.from, to: ref.to, name: ref.name }), ref.line))); if (!refs.length) panel.append(el('div', 'omni-proto__empty', t('proto.noReferences', { name: selectedType })) ); }
        else if (active === 'json') { const select = selectType(true); const message = flattenProtoMessages(model.messages).find(value => value.fullName === selectedType); const pre = el('pre', 'omni-proto__card omni-proto__code', message ? JSON.stringify(example(message), null, 2) : t('proto.noMessages')); panel.append(select, pre); }
        else if (active === 'breaking') { const textarea = el('textarea', 'omni-proto__baseline') as HTMLTextAreaElement; textarea.placeholder = t('proto.breaking.placeholder'); const compare = el('button', undefined, t('proto.breaking.compare')); compare.type = 'button'; const result = el('div'); onPanel(compare, 'click', () => { const findings = breakingFindings(parseProto(textarea.value, input.fileName)); result.replaceChildren(...(findings.length ? findings.map(value => row(t('proto.breaking.breaking'), value)) : [el('div', 'omni-proto__empty', t('proto.breaking.none'))])); }); panel.append(textarea, compare, result); }
        else if (active === 'imports') model.imports.forEach(value => panel.append(row(kind('import'), `${input.fileName} → ${value}`)));
        else if (active === 'grpc') model.services.forEach(service => panel.append(declaration(service)));
        else allProtoTypes(model).forEach(item => { const card = el('article', 'omni-proto__card'); const body = [item.documentation || t('proto.noDocumentation')]; if (item.kind === 'message') item.fields.forEach(field => body.push(`${field.name}: ${field.documentation || field.type}`)); else if (item.kind === 'service') item.rpcs.forEach(rpc => body.push(`${rpc.name}: ${rpc.documentation || `${rpc.requestType} → ${rpc.responseType}`}`)); card.dataset.search = `${item.fullName} ${body.join(' ')}`.toLowerCase(); card.append(el('strong', undefined, item.fullName), el('pre', 'omni-proto__muted', body.join('\n'))); panel.append(card); });
        applySearch(search.value.trim().toLowerCase()); if (!panel.children.length) panel.append(el('div', 'omni-proto__empty', t('proto.noDeclarations')));
    };
    const warning = el('div', 'omni-proto__warning');
    const updateWarning = (): void => { warning.textContent = model.warnings.join(' · '); warning.style.display = model.warnings.length ? '' : 'none'; };
    const updateSaveState = (): void => { save.disabled = !ctx.writeback || !dirty; save.title = ctx.writeback ? '' : t('common.noWriteback'); saveAs.disabled = !ctx.save; saveAs.title = ctx.save ? '' : t('common.noFileSave'); };
    const bytes = (): Uint8Array => new TextEncoder().encode(editor.value);
    // Heavy pass: full re-parse + panel rebuild. Debounced (below) so typing in
    // a large schema stays responsive.
    const reparse = (): void => { model = parseProto(editor.value, input.fileName); summary.textContent = summaryText(); updateWarning(); render(); };
    let reparseTimer: ReturnType<typeof setTimeout> | undefined;
    // Eager pass on every keystroke: cheap highlight + dirty/save state so the
    // caret feedback and Save button react immediately; the parse/render is
    // deferred to the debounced reparse.
    const onEdit = (): void => { highlightSource(editor.value); dirty = editor.value !== savedText; status.textContent = ''; updateSaveState(); if (reparseTimer) clearTimeout(reparseTimer); reparseTimer = setTimeout(() => { reparseTimer = undefined; reparse(); }, 200); };
    // Snapshot the text before the async write: reading editor.value again in
    // the resolve handler would mark whatever the user typed meanwhile as saved.
    const doSave = (): void => { if (!ctx.writeback) return; const text = editor.value; void ctx.writeback.write(new TextEncoder().encode(text)).then(() => { savedText = text; dirty = editor.value !== text; status.textContent = t('common.savedToOriginal'); updateSaveState(); }).catch(error => { ctx.logger.log('error', `proto save failed: ${String(error)}`); status.textContent = t('common.saveFailed'); }); };
    const doSaveAs = (): void => { if (!ctx.save) return; void Promise.resolve(ctx.save.saveFile(input.fileName, bytes(), 'text/plain')).then(() => { status.textContent = t('common.saved', { name: input.fileName }); }).catch(error => { ctx.logger.log('error', `proto saveAs failed: ${String(error)}`); status.textContent = t('common.saveFailed'); }); };
    panelDefs.forEach(([key, labelKey]) => { const button = el('button', undefined, t(labelKey)); button.type = 'button'; button.dataset.panel = key; button.setAttribute('aria-pressed', String(key === active)); on(button, 'click', () => { active = key; toolbar.querySelectorAll<HTMLElement>('[data-panel]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.panel === active))); render(); }); toolbar.insertBefore(button, copy); });
    on(search, 'input', () => applySearch(search.value.trim().toLowerCase())); on(copy, 'click', () => { if (ctx.clipboard) void ctx.clipboard.writeText(panel.textContent ?? '').catch(error => ctx.logger.log('error', `proto copy failed: ${String(error)}`)); });
    on(editor, 'input', onEdit); on(save, 'click', doSave); on(saveAs, 'click', doSaveAs);
    on(editor, 'keydown', event => { const keyboard = event as KeyboardEvent; if ((keyboard.metaKey || keyboard.ctrlKey) && keyboard.key === 's') { keyboard.preventDefault(); if (ctx.writeback) doSave(); else doSaveAs(); } });
    updateWarning(); updateSaveState();
    frame.append(header, toolbar, workspace, warning); root.append(frame); render();
    return { dispose() { if (reparseTimer) clearTimeout(reparseTimer); panelDisposers.splice(0).forEach(dispose => dispose()); disposers.splice(0).forEach(dispose => dispose()); frame.remove(); if (root instanceof ShadowRoot) root.replaceChildren(); else container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--proto'); } };
}
