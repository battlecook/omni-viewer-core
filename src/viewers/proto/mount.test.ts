// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountProtoViewer } from './index.js';
const ctx = { assets:{resolveAssetUrl:async(path:string)=>path}, i18n:createCatalogI18n(), logger:{log:()=>undefined} };
describe('mountProtoViewer',()=>{
    it('renders schema navigation and disposes cleanly',async()=>{const container=document.createElement('div');const handle=await mountProtoViewer({fileName:'a.proto',data:new TextEncoder().encode('syntax = "proto3";\nmessage User {\n string id = 1;\n}')},container,ctx);const root=container.shadowRoot!;expect(root.querySelector('.omni-proto__source')?.textContent).toContain('message User');expect(root.querySelector('.omni-proto__panel')?.textContent).toContain('User');expect([...root.querySelectorAll('button')].map(b=>b.textContent)).toContain('gRPC');handle.dispose();expect(root.childNodes).toHaveLength(0);});
    it('applies syntax highlighting to the source pane', async () => {
        const container = document.createElement('div');
        await mountProtoViewer({ fileName: 'a.proto', data: new TextEncoder().encode('// header\nsyntax = "proto3";\nmessage User {\n string id = 1;\n}') }, container, ctx);
        const root = container.shadowRoot!;
        const source = root.querySelector('.omni-proto__source')!;
        expect(source.querySelector('.omni-proto__tok--comment')?.textContent).toBe('// header');
        expect([...source.querySelectorAll('.omni-proto__tok--kw')].map(n => n.textContent)).toEqual(expect.arrayContaining(['syntax', 'message']));
        expect(source.querySelector('.omni-proto__tok--str')?.textContent).toBe('"proto3"');
        expect(source.querySelector('.omni-proto__tok--type')?.textContent).toBe('string');
        expect(source.querySelector('.omni-proto__tok--num')?.textContent).toBe('1');
        expect(source.textContent).toContain('message User');
    });
    it.each([
        ['account_id', 'field'],
        ['ACTIVE', 'value'],
        ['FindAccount', 'rpc']
    ])('keeps the parent declaration visible when searching for child %s', async (query, badge) => {
        const source = `syntax = "proto3";
message Account {
  string account_id = 1;
  enum State {
    ACTIVE = 0;
  }
}
service Accounts {
  rpc FindAccount(Account) returns (Account);
}`;
        const container = document.createElement('div');
        await mountProtoViewer({ fileName: 'accounts.proto', data: new TextEncoder().encode(source) }, container, ctx);
        const root = container.shadowRoot!;
        const search = root.querySelector<HTMLInputElement>('.omni-proto__search')!;
        search.value = query;
        search.dispatchEvent(new Event('input'));
        const result = [...root.querySelectorAll<HTMLElement>('.omni-proto__row')]
            .find(node => node.querySelector('.omni-proto__badge')?.textContent === badge && node.textContent?.includes(query));
        expect(result?.style.display).toBe('');
        expect(result?.closest<HTMLElement>('.omni-proto__card')?.style.display).toBe('');
    });
    it('filters search results without rebuilding the panel DOM', async () => {
        const container = document.createElement('div');
        await mountProtoViewer({ fileName: 'a.proto', data: new TextEncoder().encode('syntax = "proto3";\nmessage User {\n string account_id = 1;\n}') }, container, ctx);
        const root = container.shadowRoot!;
        const panel = root.querySelector('.omni-proto__panel')!;
        const originalCard = panel.firstElementChild;
        const search = root.querySelector<HTMLInputElement>('.omni-proto__search')!;
        for (const query of ['a', 'account', 'account_id', '']) {
            search.value = query;
            search.dispatchEvent(new Event('input'));
            expect(panel.firstElementChild).toBe(originalCard);
        }
    });
    it('provides reverse references, JSON examples, breaking checks, and panel copy', async () => {
        const source = `syntax = "proto3";
message Account {
  string account_id = 1;
}
message Lookup {
  Account account = 1;
}`;
        const writeText = vi.fn(async () => undefined);
        const container = document.createElement('div');
        await mountProtoViewer({ fileName: 'accounts.proto', data: new TextEncoder().encode(source) }, container, { ...ctx, clipboard: { writeText } });
        const root = container.shadowRoot!;
        const click = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!.click();

        click('Who Uses This?');
        const typeSelect = root.querySelector<HTMLSelectElement>('.omni-proto__panel select')!;
        typeSelect.value = 'Account'; typeSelect.dispatchEvent(new Event('change'));
        expect(root.querySelector('.omni-proto__panel')?.textContent).toContain('Lookup uses Account via account');

        click('JSON Example');
        expect(root.querySelector('.omni-proto__panel')?.textContent).toContain('"account_id": "string"');

        click('Breaking Changes');
        const baseline = root.querySelector<HTMLTextAreaElement>('.omni-proto__baseline')!;
        baseline.value = 'syntax = "proto3";\nmessage Account {\n string old_id = 1;\n}';
        click('Compare');
        expect(root.querySelector('.omni-proto__panel')?.textContent).toContain('Field number 1 changed');

        click('Copy panel');
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Field number 1 changed'));
    });
    it('renders field- and RPC-level documentation in the Docs panel', async () => {
        const source = `syntax = "proto3";
message Account {
  // the unique account identifier
  string account_id = 1;
}
service Accounts {
  // look up an account by id
  rpc FindAccount(Account) returns (Account);
}`;
        const container = document.createElement('div');
        await mountProtoViewer({ fileName: 'accounts.proto', data: new TextEncoder().encode(source) }, container, ctx);
        const root = container.shadowRoot!;
        [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Docs')!.click();
        const text = root.querySelector('.omni-proto__panel')?.textContent ?? '';
        expect(text).toContain('account_id: the unique account identifier');
        expect(text).toContain('FindAccount: look up an account by id');
    });
    it('resolves Proto chrome through i18n keys', async () => {
        const requested: string[] = [];
        const container = document.createElement('div');
        await mountProtoViewer({ fileName: 'a.proto', data: new TextEncoder().encode('syntax = "proto3";') }, container, {
            ...ctx, i18n: { t: (key: string) => { requested.push(key); return `[${key}]`; } }
        });
        expect(requested).toEqual(expect.arrayContaining(['proto.summary', 'proto.search', 'proto.panel.reverse', 'proto.panel.json', 'proto.panel.breaking', 'proto.copyPanel']));
        expect(container.shadowRoot?.textContent).toContain('[proto.panel.reverse]');
    });
    it('re-parses the schema and writes back edits from the source editor', async () => {
        const write = vi.fn(async (_data: Uint8Array) => undefined);
        const container = document.createElement('div');
        await mountProtoViewer({ fileName: 'a.proto', data: new TextEncoder().encode('syntax = "proto3";\nmessage User {\n string id = 1;\n}') }, container, { ...ctx, writeback: { write } });
        const root = container.shadowRoot!;
        const editor = root.querySelector<HTMLTextAreaElement>('.omni-proto__editor')!;
        const save = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save')!;
        expect(save.disabled).toBe(true);
        editor.value = 'syntax = "proto3";\nmessage Account {\n string account_id = 1;\n}';
        editor.dispatchEvent(new Event('input'));
        // Highlight and the dirty/Save state refresh eagerly on each keystroke.
        expect(root.querySelector('.omni-proto__source')?.textContent).toContain('message Account');
        expect(save.disabled).toBe(false);
        // The parse + panel rebuild is debounced, so let it settle.
        await new Promise(resolve => setTimeout(resolve, 220));
        const panel = root.querySelector('.omni-proto__panel')?.textContent ?? '';
        expect(panel).toContain('Account');
        expect(panel).not.toContain('User');
        expect(root.querySelector('.omni-proto__summary')?.textContent).toContain('1 messages');
        save.click();
        await Promise.resolve(); await Promise.resolve();
        expect(write).toHaveBeenCalledTimes(1);
        expect(new TextDecoder().decode(write.mock.calls[0]![0])).toContain('account_id');
        expect(save.disabled).toBe(true);
    });
    it('does not mark edits typed during an in-flight save as saved', async () => {
        let resolveWrite: () => void = () => undefined;
        const write = vi.fn((_data: Uint8Array) => new Promise<void>(resolve => { resolveWrite = resolve; }));
        const container = document.createElement('div');
        const handle = await mountProtoViewer({ fileName: 'a.proto', data: new TextEncoder().encode('syntax = "proto3";\nmessage User { string id = 1; }') }, container, { ...ctx, writeback: { write } });
        const root = container.shadowRoot!;
        const editor = root.querySelector<HTMLTextAreaElement>('.omni-proto__editor')!;
        const save = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save')!;
        editor.value = 'syntax = "proto3";\nmessage User { string id = 2; }';
        editor.dispatchEvent(new Event('input'));
        save.click();
        // Keep typing while the write is still pending.
        editor.value = 'syntax = "proto3";\nmessage User { string id = 3; }';
        editor.dispatchEvent(new Event('input'));
        resolveWrite();
        await Promise.resolve(); await Promise.resolve();
        // id = 3 was never written, so the buffer must still be dirty.
        expect(save.disabled).toBe(false);
        handle.dispose();
    });
    it('saves a copy through the file save service and disables actions without services', async () => {
        const saveFile = vi.fn(async (_name: string, _data: Uint8Array, _mime: string) => undefined);
        const bare = document.createElement('div');
        await mountProtoViewer({ fileName: 'a.proto', data: new TextEncoder().encode('syntax = "proto3";') }, bare, ctx);
        const bareRoot = bare.shadowRoot!;
        const bareButton = (label: string) => [...bareRoot.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!;
        expect(bareButton('Save').disabled).toBe(true);
        expect(bareButton('Save as').disabled).toBe(true);

        const container = document.createElement('div');
        await mountProtoViewer({ fileName: 'a.proto', data: new TextEncoder().encode('syntax = "proto3";\nmessage User {\n string id = 1;\n}') }, container, { ...ctx, save: { saveFile } });
        const root = container.shadowRoot!;
        const saveAs = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save as')!;
        expect(saveAs.disabled).toBe(false);
        saveAs.click();
        await Promise.resolve();
        expect(saveFile).toHaveBeenCalledTimes(1);
        const [name, data, mime] = saveFile.mock.calls[0]!;
        expect(name).toBe('a.proto');
        expect(mime).toBe('text/plain');
        expect(new TextDecoder().decode(data)).toContain('message User');
    });
    it('matches the reference JSON samples for maps, enums, and unresolved types', async () => {
        const source = `syntax = "proto3";
enum State {
  ACTIVE = 0;
  INACTIVE = 1;
}
message Example {
  map<string, string> labels = 1;
  State state = 2;
  Missing external = 3;
  bool enabled = 4;
}`;
        const container = document.createElement('div');
        await mountProtoViewer({ fileName: 'example.proto', data: new TextEncoder().encode(source) }, container, ctx);
        const root = container.shadowRoot!;
        [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'JSON Example')!.click();
        const value = JSON.parse(root.querySelector('.omni-proto__panel pre')!.textContent!);
        expect(value).toEqual({ labels: { key: 'value' }, state: 'ACTIVE', external: null, enabled: false });
    });
});
