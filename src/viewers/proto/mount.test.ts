// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountProtoViewer } from './index.js';
const ctx = { assets:{resolveAssetUrl:async(path:string)=>path}, i18n:createCatalogI18n(), logger:{log:()=>undefined} };
describe('mountProtoViewer',()=>{
    it('renders schema navigation and disposes cleanly',async()=>{const container=document.createElement('div');const handle=await mountProtoViewer({fileName:'a.proto',data:new TextEncoder().encode('syntax = "proto3";\nmessage User {\n string id = 1;\n}')},container,ctx);const root=container.shadowRoot!;expect(root.querySelector('.omni-proto__source')?.textContent).toContain('message User');expect(root.querySelector('.omni-proto__panel')?.textContent).toContain('User');expect([...root.querySelectorAll('button')].map(b=>b.textContent)).toContain('gRPC');handle.dispose();expect(root.childNodes).toHaveLength(0);});
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
    it('resolves Proto chrome through i18n keys', async () => {
        const requested: string[] = [];
        const container = document.createElement('div');
        await mountProtoViewer({ fileName: 'a.proto', data: new TextEncoder().encode('syntax = "proto3";') }, container, {
            ...ctx, i18n: { t: (key: string) => { requested.push(key); return `[${key}]`; } }
        });
        expect(requested).toEqual(expect.arrayContaining(['proto.summary', 'proto.search', 'proto.panel.reverse', 'proto.panel.json', 'proto.panel.breaking', 'proto.copyPanel']));
        expect(container.shadowRoot?.textContent).toContain('[proto.panel.reverse]');
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
