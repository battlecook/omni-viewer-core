import type { HostContext } from '../host/index.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from './types.js';

export const mediaViewerCss = `.omni-media{box-sizing:border-box;min-height:100%;padding:20px;background:var(--omni-bg,#181818);color:var(--omni-fg,#eee);font:14px/1.45 system-ui,sans-serif}.omni-media *{box-sizing:border-box}.omni-media__header{display:flex;justify-content:space-between;gap:16px;margin-bottom:18px}.omni-media__title{font-size:18px;font-weight:650;overflow-wrap:anywhere}.omni-media__meta{color:var(--omni-muted,#aaa)}.omni-media__stage{display:grid;place-items:center;min-height:280px;border:1px solid var(--omni-border,#444);border-radius:10px;background:#000;padding:18px}.omni-media audio,.omni-media video{display:block;width:min(100%,1100px);max-height:75vh}.omni-media__warning{margin-top:12px;padding:10px 12px;border:1px solid #b98b2f;border-radius:7px;background:#3b2d10;color:#ffd98a;white-space:pre-wrap}`;
export interface MediaMountOptions extends MountOptions { maxBytes?: number; createObjectUrl?(blob: Blob): string; revokeObjectUrl?(url: string): void; }
export async function mountMediaViewer(kind:'audio'|'video',input:ViewerInput,container:HTMLElement,_ctx:HostContext,mimeType:string,warnings:string[],options:MediaMountOptions={}):Promise<ViewerHandle>{
    if(options.signal?.aborted) throw new MountAbortedError(); const max=options.maxBytes??128*1024*1024;
    const root:HTMLElement|ShadowRoot=options.styleIsolation!=='scoped'&&container.attachShadow?(container.shadowRoot??container.attachShadow({mode:'open'})):container;
    if(root===container) container.classList.add(VIEWER_ROOT_CLASS,`omni-viewer--${kind}`); else {const style=document.createElement('style');style.textContent=mediaViewerCss;root.append(style);}
    const shell=document.createElement('section');shell.className=`${VIEWER_ROOT_CLASS} omni-media omni-media--${kind}`;
    const header=document.createElement('header');header.className='omni-media__header'; const title=document.createElement('div');title.className='omni-media__title';title.textContent=input.fileName; const meta=document.createElement('div');meta.className='omni-media__meta';meta.textContent=`${mimeType} · ${formatBytes(input.data.byteLength)}`;header.append(title,meta);
    const stage=document.createElement('main');stage.className='omni-media__stage'; const media=document.createElement(kind);media.controls=true;media.preload=input.data.byteLength>50*1024*1024?'metadata':'auto'; const messages=document.createElement('div');messages.className='omni-media__warning';messages.hidden=true;
    shell.append(header,stage,messages);root.append(shell); let url:string|undefined; let disposed=false;
    const show=(message:string):void=>{messages.hidden=false;messages.textContent=[...warnings,message].filter(Boolean).join('\n');};
    if(input.data.byteLength>max) show(`The file exceeds the ${formatBytes(max)} browser preview limit.`); else if(input.data.byteLength===0) show('The media file is empty.'); else {
        try { const create=options.createObjectUrl??URL.createObjectURL.bind(URL); url=create(new Blob([blobPart(input.data)],{type:mimeType}));media.src=url;stage.append(media); if(warnings.length) show(''); }
        catch { show('This environment cannot create a browser media source.'); }
    }
    const onError=():void=>show(`The browser could not decode this ${kind} codec. Try a host with the required codec or transcode the file.`);media.addEventListener('error',onError);
    if(options.signal?.aborted){media.removeEventListener('error',onError);shell.remove();if(url)(options.revokeObjectUrl??URL.revokeObjectURL.bind(URL))(url);throw new MountAbortedError();}
    return {dispose(){if(disposed)return;disposed=true;media.pause();media.removeAttribute('src');media.load();media.removeEventListener('error',onError);if(url)(options.revokeObjectUrl??URL.revokeObjectURL.bind(URL))(url);shell.remove();if(root===container)container.classList.remove(VIEWER_ROOT_CLASS,`omni-viewer--${kind}`);else root.replaceChildren();}};
}
function blobPart(data:Uint8Array):Uint8Array<ArrayBuffer>{return data.buffer instanceof ArrayBuffer?data as Uint8Array<ArrayBuffer>:new Uint8Array(data);}
function formatBytes(bytes:number):string{if(bytes<1024)return `${bytes} B`;const units=['KiB','MiB','GiB'];let v=bytes/1024,i=0;while(v>=1024&&i<2){v/=1024;i++;}return `${v.toFixed(v>=10?1:2)} ${units[i]}`;}
