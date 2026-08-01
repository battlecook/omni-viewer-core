import type { ClipboardService, FileSaveService, HostContext } from '../../host/index.js';
import { serializeRowsToTsv } from '../../parsers/csv/index.js';
import { PARQUET_PREVIEW_ROWS, parseParquet, parseParquetSource, type ParquetCell, type ParquetDocument, type ParquetParseOptions, type ParquetSource } from '../../parsers/parquet/index.js';
import { utf8ByteLength } from '../../parsers/types.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { createParquetController } from './controller.js';
import { parquetViewerCss } from './styles.js';
export { createParquetController } from './controller.js';
export type { ParquetController, ParquetAction, ParquetViewState } from './controller.js';
export { parquetViewerCss } from './styles.js';
export const PARQUET_VIEWER_META={id:'parquet',displayNameKey:'parquet.title',extensions:['parquet'],priority:20,requiredServices:[] as const,optionalServices:['clipboard','save'] as const,inputOwnership:'borrows' as const};
export type ParquetViewerContext=HostContext&{clipboard?:ClipboardService;save?:FileSaveService};
export interface ParquetMountOptions extends MountOptions{parse?:ParquetParseOptions}
/** Clipboard copy guard (parity with csv/excel): larger payloads are refused and routed to file export. */
export const PARQUET_COPY_PAYLOAD_LIMIT_BYTES=1024*1024;

/** Lazy input used by large-file hosts to avoid materializing the whole file. */
export interface ParquetViewerSource extends ParquetSource{fileName:string;lastModified?:number}

/** Creates a lazy parquet input backed by browser `Blob.slice()` range reads. */
export function createParquetBlobSource(blob:Blob,fileName='data.parquet'):ParquetViewerSource{
 return{fileName,byteLength:blob.size,async slice(start,end){return blob.slice(start,end).arrayBuffer()}};
}

export function mountParquetViewer(input:ViewerInput,container:HTMLElement,ctx:ParquetViewerContext,options?:ParquetMountOptions):Promise<ViewerHandle>;
export function mountParquetViewer(input:ParquetViewerSource,container:HTMLElement,ctx:ParquetViewerContext,options?:ParquetMountOptions):Promise<ViewerHandle>;
export async function mountParquetViewer(input:ViewerInput|ParquetViewerSource,container:HTMLElement,ctx:ParquetViewerContext,options:ParquetMountOptions={}):Promise<ViewerHandle>{
 if(options.signal?.aborted)throw new MountAbortedError();
 const parseOptions:ParquetParseOptions={...options.parse};if(options.signal)parseOptions.signal=options.signal;
 const runParse=(opts:ParquetParseOptions):Promise<ParquetDocument>=>'data' in input?parseParquet(input.data,opts):parseParquetSource(input,opts);
 let doc:ParquetDocument;try{doc=await runParse(parseOptions)}catch(error){if(options.signal?.aborted)throw new MountAbortedError();throw error}
 const ctl=createParquetController(doc),off:Array<()=>void>=[];let disposed=false,loadingMore=false;let root:HTMLElement|ShadowRoot=container;let toastTimer:ReturnType<typeof setTimeout>|null=null;
 const columnWidths=doc.headers.map((header,index)=>estimateColumnWidth(header,index));let resize:{column:number;startX:number;startWidth:number}|null=null;
 if((options.styleIsolation??'shadow')==='shadow'&&container.attachShadow){root=container.shadowRoot??container.attachShadow({mode:'open'});const style=el('style');style.textContent=parquetViewerCss;root.append(style)}else container.classList.add(VIEWER_ROOT_CLASS,'omni-viewer--parquet');
 const frame=el('div','omni-parquet'),bar=el('div','omni-parquet__toolbar'),search=el('input') as HTMLInputElement,view=el('button') as HTMLButtonElement,copyTableButton=el('button',undefined,ctx.i18n.t('parquet.copyTable')) as HTMLButtonElement,copyJsonButton=el('button',undefined,ctx.i18n.t('parquet.copyJson')) as HTMLButtonElement,save=el('button',undefined,ctx.i18n.t('parquet.exportJson')) as HTMLButtonElement,info=el('span','omni-parquet__info');frame.tabIndex=0;
 search.type='search';search.placeholder=ctx.i18n.t('parquet.search');search.setAttribute('aria-label',ctx.i18n.t('parquet.search'));bar.append(search,view,copyTableButton,copyJsonButton,save,info);
 const warning=el('div','omni-parquet__warning'),warningText=el('span'),loadMore=el('button') as HTMLButtonElement;warning.append(warningText,loadMore);
 const loadError=el('div','omni-parquet__error'),wrap=el('div','omni-parquet__wrap'),foot=el('div','omni-parquet__footer'),prev=el('button',undefined,ctx.i18n.t('common.prevPage')) as HTMLButtonElement,next=el('button',undefined,ctx.i18n.t('common.nextPage')) as HTMLButtonElement,page=el('span'),menu=el('div','omni-parquet__menu');
 foot.append(prev,page,next);frame.append(bar,warning,loadError,wrap,foot,menu);root.append(frame);
 const on=(target:EventTarget,type:string,fn:EventListener)=>{target.addEventListener(type,fn);off.push(()=>target.removeEventListener(type,fn))};
 on(search,'input',()=>ctl.dispatch({type:'search',value:search.value}));on(view,'click',()=>ctl.dispatch({type:'view',mode:ctl.state.viewMode==='table'?'raw':'table'}));on(prev,'click',()=>ctl.dispatch({type:'page',page:ctl.state.page-1}));on(next,'click',()=>ctl.dispatch({type:'page',page:ctl.state.page+1}));on(loadMore,'click',()=>void loadNext());
 on(frame,'keydown',(event)=>{const e=event as KeyboardEvent;if(!(e.ctrlKey||e.metaKey))return;if(e.key.toLowerCase()==='f'){e.preventDefault();search.focus()}else if(e.key.toLowerCase()==='c'&&ctx.clipboard){e.preventDefault();void copyTable()}else if(e.key.toLowerCase()==='j'&&ctx.save){e.preventDefault();void exportJson()}});
 on(document,'mousemove',(event)=>{if(!resize)return;applyColumnWidth(resize.column,resize.startWidth+(event as MouseEvent).clientX-resize.startX)});on(document,'mouseup',()=>{resize=null});on(document,'click',()=>hideMenu());on(wrap,'scroll',()=>hideMenu());
 // Escape dismisses the context menu wherever focus sits — keyboard events cross the shadow boundary, so window is the only target that always sees it (parity with csv/excel).
 on(window,'keydown',(event)=>{if((event as KeyboardEvent).key==='Escape')hideMenu()});
 if(ctx.clipboard){on(copyTableButton,'click',()=>void copyTable());on(copyJsonButton,'click',()=>void copyText(ctl.toJson()))}else{for(const button of [copyTableButton,copyJsonButton]){button.disabled=true;button.title=ctx.i18n.t('common.noClipboard')}}
 if(ctx.save)on(save,'click',()=>void exportJson());else{save.disabled=true;save.title=ctx.i18n.t('common.noFileSave')}
 async function exportJson(){if(ctx.save)await ctx.save.saveFile(input.fileName.replace(/\.parquet$/i,'')+'-export.json',new TextEncoder().encode(ctl.toJson()),'application/json')}
 function showToast(message:string){frame.querySelector('.omni-parquet__toast')?.remove();const toast=el('div','omni-parquet__toast',message);frame.append(toast);if(toastTimer)clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.remove(),1500)}
 /** Single funnel for every copy action, so the payload guard cannot be bypassed. Export stays unguarded — that is the escape hatch the message points at. */
 async function copyText(text:string){if(!ctx.clipboard)return;const bytes=utf8ByteLength(text);if(bytes>PARQUET_COPY_PAYLOAD_LIMIT_BYTES){showToast(ctx.i18n.t('common.copyTooLarge',{size:bytes}));return}try{await ctx.clipboard.writeText(text);showToast(ctx.i18n.t('common.copied'))}catch(error){ctx.logger.log('error',`parquet copy failed: ${String(error)}`)}}
 async function copyTable(){await copyText(serializeRowsToTsv(ctl.filteredRows().map(row=>row.map(formatCell)),doc.headers))}
 function copyColumn(index:number){return copyText(ctl.filteredRows().map(row=>formatCell(row[index]??null)).join('\n'))}
 function rowJson(row:readonly ParquetCell[]){return JSON.stringify(Object.fromEntries(doc.headers.map((header,index)=>[header||`col${index}`,row[index]??null])),null,2)}
 function showMenu(event:MouseEvent,items:Array<{label:string;action:()=>void}>){event.preventDefault();event.stopPropagation();menu.replaceChildren();items.forEach(item=>{const button=el('button',undefined,item.label);button.disabled=!ctx.clipboard&&item.label!==ctx.i18n.t('parquet.autoFit');button.onclick=()=>{item.action();hideMenu()};menu.append(button)});menu.style.left=`${event.clientX}px`;menu.style.top=`${event.clientY}px`;menu.style.display='flex'}
 function hideMenu(){menu.style.display='none'}
 function estimateColumnWidth(header:string,index:number){const sample=Math.max(0,...doc.rows.slice(0,50).map(row=>formatCell(row[index]??null).length*7+24));return Math.min(360,Math.max(120,header.length*8+68,sample))}
 function applyColumnWidth(index:number,width:number){columnWidths[index]=Math.max(48,Math.min(800,width));const col=wrap.querySelectorAll('col')[index] as HTMLTableColElement|undefined;if(col)col.style.width=`${columnWidths[index]}px`;const table=wrap.querySelector('table');if(table)table.style.width=`${columnWidths.reduce((sum,value)=>sum+value,0)}px`}
 function autoFit(index:number){applyColumnWidth(index,estimateColumnWidth(doc.headers[index]??'',index))}
 async function loadNext(){if(loadingMore||disposed||!doc.isLimited)return;loadingMore=true;loadError.textContent='';renderStatus();try{const chunkOptions:ParquetParseOptions={...parseOptions,rowStart:doc.loadedRows};if(doc.fileMetadata)chunkOptions.metadata=doc.fileMetadata;const chunk=await runParse(chunkOptions);if(!disposed)ctl.appendRows(chunk.rows)}catch(error){if(!disposed&&!options.signal?.aborted)loadError.textContent=ctx.i18n.t('parquet.loadFailed',{message:error instanceof Error?error.message:String(error)})}finally{loadingMore=false;if(!disposed)renderStatus()}}
 function renderStatus(){warning.style.display=doc.isLimited?'flex':'none';warningText.textContent=ctx.i18n.t('parquet.limited',{loaded:doc.loadedRows,total:doc.totalRows});loadMore.disabled=loadingMore;loadMore.textContent=ctx.i18n.t(loadingMore?'parquet.loading':'parquet.loadMore',{count:PARQUET_PREVIEW_ROWS})}
 function render(){wrap.replaceChildren();renderStatus();info.textContent=`${ctl.state.matchedRows.toLocaleString()} / ${doc.loadedRows.toLocaleString()} ${ctx.i18n.t('parquet.rows')} · ${doc.headers.length} ${ctx.i18n.t('parquet.columns')}`;view.textContent=ctx.i18n.t(ctl.state.viewMode==='table'?'parquet.raw':'parquet.table');page.textContent=ctx.i18n.t('common.page',{page:ctl.state.page+1,pages:ctl.state.pageCount});prev.disabled=ctl.state.page===0;next.disabled=ctl.state.page+1>=ctl.state.pageCount;if(ctl.state.viewMode==='raw'){wrap.append(el('pre',undefined,ctl.toJson()));return}const table=el('table'),cols=el('colgroup'),head=el('thead'),hr=el('tr');columnWidths.forEach(width=>{const col=el('col');col.style.width=`${width}px`;cols.append(col)});table.style.width=`${columnWidths.reduce((sum,value)=>sum+value,0)}px`;doc.headers.forEach((h,i)=>{const th=el('th'),label=el('span',undefined,h),handle=el('span','omni-parquet__resizer');th.title=h;handle.title=ctx.i18n.t('parquet.resize');handle.setAttribute('role','separator');handle.tabIndex=0;handle.onclick=(event)=>event.stopPropagation();handle.onmousedown=(event)=>{event.preventDefault();event.stopPropagation();resize={column:i,startX:event.clientX,startWidth:columnWidths[i]??120}};handle.ondblclick=(event)=>{event.preventDefault();event.stopPropagation();autoFit(i)};handle.onkeydown=(event)=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();autoFit(i)}else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();event.stopPropagation();applyColumnWidth(i,(columnWidths[i]??120)+(event.key==='ArrowRight'?10:-10))}};th.onclick=()=>ctl.dispatch({type:'sort',column:i});th.oncontextmenu=(event)=>showMenu(event,[{label:ctx.i18n.t('parquet.copyColumn'),action:()=>void copyColumn(i)},{label:ctx.i18n.t('parquet.autoFit'),action:()=>autoFit(i)}]);th.append(label);if(ctl.state.sortColumn===i&&ctl.state.sortDirection){th.setAttribute('aria-sort',ctl.state.sortDirection==='asc'?'ascending':'descending');th.append(el('span','omni-parquet__sort-indicator',ctl.state.sortDirection==='asc'?'▲':'▼'))}th.append(handle);hr.append(th)});head.append(hr);const body=el('tbody');ctl.visibleRows().forEach(row=>{const tr=el('tr');row.forEach((cell,index)=>{const value=formatCell(cell),td=el('td',undefined,value);td.title=value;if(cell==null)td.style.fontStyle='italic';td.ondblclick=()=>void copyText(value);td.oncontextmenu=(event)=>showMenu(event,[{label:ctx.i18n.t('parquet.copyCell'),action:()=>void copyText(value)},{label:ctx.i18n.t('parquet.copyRow'),action:()=>void copyText(rowJson(row))},{label:ctx.i18n.t('parquet.copyColumn'),action:()=>void copyColumn(index)}]);tr.append(td)});body.append(tr)});table.append(cols,head,body);wrap.append(table)}
 const unsubscribe=ctl.subscribe(render);render();
 // A signal that fires while we were parsing leaves the host waiting on a throw, not a handle — so tear down here rather than leaking the document-level listeners (parity with csv/excel).
 if(options.signal?.aborted){cleanup();throw new MountAbortedError()}
 return{dispose:cleanup};
 function cleanup(){if(disposed)return;disposed=true;unsubscribe();if(toastTimer)clearTimeout(toastTimer);off.splice(0).forEach(fn=>fn());root.replaceChildren();if(root===container)container.classList.remove(VIEWER_ROOT_CLASS,'omni-viewer--parquet')}
}
function el<K extends keyof HTMLElementTagNameMap>(tag:K,className?:string,text?:string):HTMLElementTagNameMap[K]{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
function formatCell(cell:ParquetCell){return typeof cell==='object'&&cell!==null?JSON.stringify(cell):String(cell??'')}
