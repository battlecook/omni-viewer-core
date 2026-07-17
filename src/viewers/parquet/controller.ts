import type { ParquetCell, ParquetDocument } from '../../parsers/parquet/index.js';

export interface ParquetViewState { search: string; sortColumn: number | null; sortDirection: 'asc' | 'desc' | null; page: number; pageSize: number; pageCount: number; matchedRows: number; viewMode: 'table' | 'raw' }
export type ParquetAction = {type:'search';value:string}|{type:'sort';column:number}|{type:'page';page:number}|{type:'page-size';size:number}|{type:'view';mode:'table'|'raw'};
export interface ParquetController { readonly state: ParquetViewState; dispatch(action: ParquetAction): void; appendRows(rows: ParquetCell[][]): void; subscribe(fn:(s:ParquetViewState)=>void):()=>void; visibleRows(): ParquetCell[][]; filteredRows(): readonly ParquetCell[][]; toJson(): string }

export function createParquetController(document: ParquetDocument): ParquetController {
    const listeners = new Set<(s:ParquetViewState)=>void>();
    let state: ParquetViewState = {search:'',sortColumn:null,sortDirection:null,page:0,pageSize:100,pageCount:1,matchedRows:document.rows.length,viewMode:'table'};
    let filtered = document.rows.slice();
    const text = (v: ParquetCell) => typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
    function rebuild() {
        const q=state.search.toLowerCase(); filtered=document.rows.filter(r=>!q||r.some(v=>text(v).toLowerCase().includes(q)));
        if(state.sortColumn!==null&&state.sortDirection){const c=state.sortColumn,d=state.sortDirection==='asc'?1:-1;filtered=filtered.map((row,i)=>({row,i})).sort((a,b)=>{const x=text(a.row[c]??null),y=text(b.row[c]??null);if(x===''||y==='')return x===y?a.i-b.i:x===''?1:-1;const xn=Number(x),yn=Number(y);const cmp=Number.isFinite(xn)&&Number.isFinite(yn)?xn-yn:x.localeCompare(y,undefined,{numeric:true});return cmp?cmp*d:a.i-b.i}).map(x=>x.row)}
        const pageCount=Math.max(1,Math.ceil(filtered.length/state.pageSize)); state={...state,matchedRows:filtered.length,pageCount,page:Math.min(state.page,pageCount-1)};
    }
    return {get state(){return state},dispatch(a){if(a.type==='search')state={...state,search:a.value,page:0};if(a.type==='sort'){const same=state.sortColumn===a.column;const next=!same?'asc':state.sortDirection==='asc'?'desc':state.sortDirection==='desc'?null:'asc';state={...state,sortColumn:next?a.column:null,sortDirection:next,page:0}}if(a.type==='page')state={...state,page:Math.max(0,Math.min(a.page,state.pageCount-1))};if(a.type==='page-size')state={...state,pageSize:a.size,page:0};if(a.type==='view')state={...state,viewMode:a.mode};rebuild();listeners.forEach(f=>f(state))},appendRows(rows){document.rows.push(...rows);document.loadedRows=document.rows.length;document.isLimited=document.loadedRows<document.totalRows;rebuild();listeners.forEach(f=>f(state))},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},visibleRows(){const start=state.page*state.pageSize;return filtered.slice(start,start+state.pageSize)},filteredRows(){return filtered},toJson(){return JSON.stringify({schema:document.schema,headers:document.headers,rows:filtered,metadata:{totalRows:document.totalRows,loadedRows:document.loadedRows,columns:document.headers.length,fileSizeBytes:document.fileSizeBytes}},null,2)}};
}
