import { describe, expect, it } from 'vitest';
import { parseProto } from './index.js';
describe('parseProto', () => {
    it('parses messages, enums, imports, oneofs, services and references', () => {
        const model = parseProto(`syntax = "proto3";
package acme.orders;
import "google/protobuf/timestamp.proto";
// An order
message Order {
  string id = 1;
  repeated Item items = 2;
  oneof result { string error = 3; }
  enum State { UNKNOWN = 0; }
}
message Item {
  string sku = 1;
}
service Orders {
  rpc Get(Order) returns (stream Item);
}
`, 'orders.proto');
        expect(model.syntax).toBe('proto3'); expect(model.packageName).toBe('acme.orders'); expect(model.imports).toEqual(['google/protobuf/timestamp.proto']);
        expect(model.messages[0]).toMatchObject({ fullName: 'acme.orders.Order', documentation: 'An order' });
        expect(model.messages[0]!.fields[1]).toMatchObject({ name: 'items', repeated: true, type: 'Item' });
        expect(model.services[0]!.rpcs[0]).toMatchObject({ name: 'Get', responseStream: true });
        expect(model.references).toEqual(expect.arrayContaining([expect.objectContaining({ fromKind: 'field', to: 'Item' }), expect.objectContaining({ fromKind: 'rpc', to: 'Order' })]));
    });
    it('reports duplicate field numbers and a missing syntax declaration', () => {
        const model = parseProto('message Broken {\n string first = 1;\n string second = 1;\n}');
        expect(model.warnings).toContain('Broken reuses field number 1 for first and second.'); expect(model.warnings).toContain('No syntax declaration found.');
    });
});
