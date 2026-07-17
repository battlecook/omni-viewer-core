import { describe, expect, it } from 'vitest';
import { createParquetController } from './controller.js';
import type { ParquetDocument } from '../../parsers/parquet/index.js';

const doc: ParquetDocument = {headers:['name','score'],rows:[['beta',2],['alpha',10],['gamma',null]],schema:{},totalRows:3,loadedRows:3,fileSizeBytes:123,isLimited:false};
describe('ParquetController',()=>{
 it('filters, pages, and uses stable numeric sorting',()=>{const c=createParquetController(doc);c.dispatch({type:'sort',column:1});expect(c.visibleRows().map(r=>r[0])).toEqual(['beta','alpha','gamma']);c.dispatch({type:'search',value:'alp'});expect(c.state.matchedRows).toBe(1);expect(c.visibleRows()[0]?.[0]).toBe('alpha')});
 it('cycles ascending, descending, and unsorted',()=>{const c=createParquetController(doc);c.dispatch({type:'sort',column:0});expect(c.visibleRows().map(r=>r[0])).toEqual(['alpha','beta','gamma']);c.dispatch({type:'sort',column:0});expect(c.visibleRows().map(r=>r[0])).toEqual(['gamma','beta','alpha']);c.dispatch({type:'sort',column:0});expect(c.visibleRows()).toEqual(doc.rows)});
 it('exports the schema and complete metadata envelope',()=>{const value=JSON.parse(createParquetController(doc).toJson());expect(value).toMatchObject({headers:['name','score'],metadata:{totalRows:3,loadedRows:3,columns:2}})});
 it('reapplies search and sort when rows are appended',()=>{const partial:ParquetDocument={...doc,rows:[['beta',2]],loadedRows:1,isLimited:true};const c=createParquetController(partial);c.dispatch({type:'search',value:'alpha'});c.appendRows([['alpha',10]]);expect(c.state.matchedRows).toBe(1);expect(c.visibleRows()[0]?.[0]).toBe('alpha');expect(partial.loadedRows).toBe(2)});
});
