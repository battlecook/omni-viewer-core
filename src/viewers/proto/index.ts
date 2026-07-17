import type { ClipboardService, HostContext } from '../../host/index.js';
import { allProtoTypes, flattenProtoMessages, parseProto, type ProtoEnum, type ProtoMessage, type ProtoModel, type ProtoService } from '../../parsers/proto/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { protoViewerCss } from './styles.js';
export { protoViewerCss } from './styles.js';
export { parseProto } from '../../parsers/proto/index.js';
export const PROTO_VIEWER_META = { id: 'proto', displayNameKey: 'proto.title', extensions: ['proto'], priority: 10, requiredServices: [] as const, optionalServices: ['clipboard'] as const, inputOwnership: 'borrows' as const };
export type ProtoViewerContext = HostContext & { clipboard?: ClipboardService };
type Panel = 'tree' | 'types' | 'relationships' | 'reverse' | 'json' | 'breaking' | 'imports' | 'grpc' | 'docs';
type Declaration = ProtoMessage | ProtoEnum | ProtoService;

export async function mountProtoViewer(input: ViewerInput, container: HTMLElement, ctx: ProtoViewerContext, options: MountOptions = {}): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const source = new TextDecoder().decode(input.data); const model = parseProto(source, input.fileName); const t = ctx.i18n.t.bind(ctx.i18n);
    let root: HTMLElement | ShadowRoot;
    if ((options.styleIsolation ?? 'shadow') === 'shadow' && typeof container.attachShadow === 'function') { root = container.shadowRoot ?? container.attachShadow({ mode: 'open' }); const style = document.createElement('style'); style.textContent = protoViewerCss; root.append(style); }
    else { container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--proto'); root = container; }
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
    const disposers: Array<() => void> = []; const panelDisposers: Array<() => void> = [];
    const listen = (bucket: Array<() => void>, node: HTMLElement, type: string, listener: EventListener): void => { node.addEventListener(type, listener); bucket.push(() => node.removeEventListener(type, listener)); };
    const on = (node: HTMLElement, type: string, listener: EventListener): void => listen(disposers, node, type, listener);
    const onPanel = (node: HTMLElement, type: string, listener: EventListener): void => listen(panelDisposers, node, type, listener);
    const frame = el('div', 'omni-proto'); const header = el('header', 'omni-proto__header');
    header.append(el('strong', 'omni-proto__title', input.fileName), el('span', 'omni-proto__summary', t('proto.summary', { syntax: model.syntax || 'proto', package: model.packageName || t('proto.noPackage'), messages: model.stats.messages, services: model.stats.services })));
    const toolbar = el('div', 'omni-proto__toolbar'); const search = el('input', 'omni-proto__search') as HTMLInputElement; search.type = 'search'; search.placeholder = t('proto.search'); search.setAttribute('aria-label', t('proto.search')); toolbar.append(search);
    const panelDefs: Array<[Panel, string]> = [['tree','proto.panel.tree'],['types','proto.panel.types'],['relationships','proto.panel.relationships'],['reverse','proto.panel.reverse'],['json','proto.panel.json'],['breaking','proto.panel.breaking'],['imports','proto.panel.imports'],['grpc','proto.panel.grpc'],['docs','proto.panel.docs']]; let active: Panel = 'tree'; let selectedType = flattenProtoMessages(model.messages)[0]?.fullName ?? '';
    const copy = el('button', undefined, t('proto.copyPanel')); copy.type = 'button'; copy.disabled = !ctx.clipboard; copy.title = ctx.clipboard ? '' : t('common.noClipboard'); toolbar.append(copy);
    const sourceView = el('pre', 'omni-proto__source'); source.replace(/\r\n?|\n/g, '\n').split('\n').forEach((text, i) => { const line = el('span', 'omni-proto__line', text || ' '); line.dataset.line = String(i + 1); sourceView.append(line); });
    const panel = el('section', 'omni-proto__panel'); const workspace = el('main', 'omni-proto__workspace'); workspace.append(sourceView, panel);
    const reveal = (line?: number): void => { if (!line) return; sourceView.querySelectorAll('.is-selected').forEach(node => node.classList.remove('is-selected')); const target = sourceView.querySelector<HTMLElement>(`[data-line="${line}"]`); target?.classList.add('is-selected'); target?.scrollIntoView({ block: 'center' }); };
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
        else allProtoTypes(model).forEach(item => { const card = el('article', 'omni-proto__card'); card.dataset.search = `${item.fullName} ${item.documentation}`.toLowerCase(); card.append(el('strong', undefined, item.fullName), el('pre', 'omni-proto__muted', item.documentation || t('proto.noDocumentation'))); panel.append(card); });
        applySearch(search.value.trim().toLowerCase()); if (!panel.children.length) panel.append(el('div', 'omni-proto__empty', t('proto.noDeclarations')));
    };
    panelDefs.forEach(([key, labelKey]) => { const button = el('button', undefined, t(labelKey)); button.type = 'button'; button.dataset.panel = key; button.setAttribute('aria-pressed', String(key === active)); on(button, 'click', () => { active = key; toolbar.querySelectorAll<HTMLElement>('[data-panel]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.panel === active))); render(); }); toolbar.insertBefore(button, copy); });
    on(search, 'input', () => applySearch(search.value.trim().toLowerCase())); on(copy, 'click', () => { if (ctx.clipboard) void ctx.clipboard.writeText(panel.textContent ?? '').catch(error => ctx.logger.log('error', `proto copy failed: ${String(error)}`)); });
    frame.append(header, toolbar, workspace); if (model.warnings.length) frame.append(el('div', 'omni-proto__warning', model.warnings.join(' · '))); root.append(frame); render();
    return { dispose() { panelDisposers.splice(0).forEach(dispose => dispose()); disposers.splice(0).forEach(dispose => dispose()); frame.remove(); if (root instanceof ShadowRoot) root.replaceChildren(); else container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--proto'); } };
}
