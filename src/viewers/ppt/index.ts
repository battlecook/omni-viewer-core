import type {HostContext} from '../../host/index.js';
import {parsePptBinaryVscode} from '../../parsers/ppt-binary/index.js';
import {openPptxZip,parsePptxLegacy,parsePptxVscode,type PptxParserDeps} from '../../parsers/pptx/index.js';
import type {SlideDeck} from '../../parsers/slide-model.js';
import type {ParseOptions,ParseOutcome,ResourceLimits} from '../../parsers/types.js';
import {mountPdfViewer,type PdfJsModule,type PdfViewerHandle} from '../pdf/index.js';
import {MountAbortedError,VIEWER_ROOT_CLASS,type MountOptions,type ViewerInput} from '../types.js';
import {createPptController,type PptController} from './controller.js';
import {renderSlide} from './render.js';
import {pptViewerCss} from './styles.js';

export * from './controller.js';export {pptViewerCss} from './styles.js';export * from '../../parsers/slide-model.js';
export const PPT_VIEWER_META={id:'ppt',displayNameKey:'ppt.title',extensions:['pptx','ppt'],priority:15,requiredServices:[] as const,optionalServices:[] as const,inputOwnership:'borrows' as const};
export interface PptViewerDeps extends Partial<PptxParserDeps>{
    convertToPdf?(input:Uint8Array,signal?:AbortSignal):Promise<Uint8Array>;
    loadPdfjs?():Promise<PdfJsModule>;
    parseLegacyPptx?(input:Uint8Array,options:ParseOptions):Promise<ParseOutcome<SlideDeck>>;
}
export interface PptViewerHandle {readonly controller:PptController;readonly mode:'slides'|'pdf';dispose():void;}
export interface PptMountOptions extends MountOptions{limits?:ResourceLimits;}
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,cls?:string,text?:string)=>{const value=document.createElement(tag);if(cls)value.className=cls;if(text!==undefined)value.textContent=text;return value;};
const pdfName=(name:string)=>name.replace(/\.pptx?$/i,'.pdf');

async function mountPdfFallback(input:ViewerInput,container:HTMLElement,ctx:HostContext,deps:PptViewerDeps,options:PptMountOptions,originalMessageKey:string):Promise<PptViewerHandle>{
    if(!deps.convertToPdf)throw new Error(ctx.i18n.t(originalMessageKey));
    if(!deps.loadPdfjs)throw new Error(ctx.i18n.t('diag.ppt.pdf-missing-dependency'));
    const bytes=await deps.convertToPdf(input.data,options.signal);
    if(options.signal?.aborted)throw new MountAbortedError();
    const pdf:PdfViewerHandle=await mountPdfViewer({fileName:pdfName(input.fileName),data:bytes,...(input.lastModified===undefined?{}:{lastModified:input.lastModified})},container,ctx,{loadPdfjs:deps.loadPdfjs},options);
    return{controller:createPptController(0),mode:'pdf',dispose:()=>pdf.dispose()};
}

export async function mountPptViewer(input:ViewerInput,container:HTMLElement,ctx:HostContext,deps:PptViewerDeps={},options:PptMountOptions={}):Promise<PptViewerHandle>{
    if(options.signal?.aborted)throw new MountAbortedError();
    const isPptx=input.fileName.toLowerCase().endsWith('.pptx');
    const outcome=isPptx?await parsePptxVscode(input.data,options):await parsePptBinaryVscode(input.data,options);
    if(options.signal?.aborted)throw new MountAbortedError();
    if(outcome.result.status==='failed'){
        if(outcome.result.failure.code!=='invalid-format')throw new Error(ctx.i18n.t(outcome.result.failure.messageKey,outcome.result.failure.args));
        return mountPdfFallback(input,container,ctx,deps,options,outcome.result.failure.messageKey);
    }
    let deck:SlideDeck=outcome.result.document;
    if(deck.totalSlides===0||deck.slides.length===0)return mountPdfFallback(input,container,ctx,deps,options,'diag.ppt.empty');
    if(!deck.slides.some(slide=>slide.elements.length>0)){
        if(isPptx){const legacy=await (deps.parseLegacyPptx?.(input.data,options)??parsePptxLegacy(input.data,{openZip:deps.openZip??openPptxZip},options));if(legacy.result.status!=='failed'&&legacy.result.document.slides.some(slide=>slide.elements.length>0))deck=legacy.result.document;else return mountPdfFallback(input,container,ctx,deps,options,'diag.ppt.empty');}
        else return mountPdfFallback(input,container,ctx,deps,options,'diag.ppt.empty');
    }

    const root:HTMLElement|ShadowRoot=options.styleIsolation!=='scoped'&&typeof container.attachShadow==='function'?(container.shadowRoot??container.attachShadow({mode:'open'})):container;
    if(root===container)container.classList.add(VIEWER_ROOT_CLASS,'omni-viewer--ppt');else{root.replaceChildren();const style=el('style');style.textContent=pptViewerCss;root.append(style);}
    const frame=el('section','omni-ppt'),toolbar=el('div','omni-ppt__toolbar'),prev=el('button',undefined,'‹'),next=el('button',undefined,'›'),jump=el('select') as HTMLSelectElement,count=el('span'),minus=el('button',undefined,'−'),plus=el('button',undefined,'+'),reset=el('button',undefined,'100%'),mode=el('button');
    prev.setAttribute('aria-label',ctx.i18n.t('ppt.previous'));next.setAttribute('aria-label',ctx.i18n.t('ppt.next'));jump.setAttribute('aria-label',ctx.i18n.t('ppt.jump'));
    deck.slides.forEach(slide=>{const option=el('option') as HTMLOptionElement;option.value=String(slide.slideNumber);const title=slide.elements.find(element=>element.isTitle)?.paragraphs?.map(paragraph=>paragraph.text).join(' ');option.textContent=`Slide ${slide.slideNumber}${title?`: ${title}`:''}`;jump.append(option);});
    toolbar.append(prev,next,jump,count,minus,reset,plus,mode);const viewport=el('div','omni-ppt__viewport'),slides=el('div','omni-ppt__slides');viewport.append(slides);frame.append(toolbar,viewport);root.append(frame);
    const controller=createPptController(deck.totalSlides);const render=(state=controller.state)=>{count.textContent=`${state.currentSlide} / ${state.slideCount}`;reset.textContent=`${Math.round(state.zoom*100)}%`;mode.textContent=ctx.i18n.t(state.mode==='continuous'?'ppt.mode.single':'ppt.mode.continuous');jump.value=String(state.currentSlide);slides.replaceChildren();const shown=state.mode==='single'?deck.slides.filter(slide=>slide.slideNumber===state.currentSlide):deck.slides;shown.forEach(slide=>slides.append(renderSlide(slide,state.zoom)));};
    const scrollCurrent=()=>{if(controller.state.mode!=='continuous')return;slides.querySelector<HTMLElement>(`[aria-label="Slide ${controller.state.currentSlide}"]`)?.scrollIntoView({block:'start'});};
    const navigate=(action:{type:'previous'}|{type:'next'}|{type:'jump';slide:number})=>{controller.dispatch(action);scrollCurrent();};
    const onKeydown=(event:KeyboardEvent)=>{if(!(event.ctrlKey||event.metaKey))return;if(event.key==='='||event.key==='+'){event.preventDefault();controller.dispatch({type:'zoom-in'});}else if(event.key==='-'){event.preventDefault();controller.dispatch({type:'zoom-out'});}else if(event.key==='0'){event.preventDefault();controller.dispatch({type:'reset-zoom'});}};
    const off=controller.subscribe(render);prev.onclick=()=>navigate({type:'previous'});next.onclick=()=>navigate({type:'next'});jump.onchange=()=>navigate({type:'jump',slide:Number(jump.value)});minus.onclick=()=>controller.dispatch({type:'zoom-out'});plus.onclick=()=>controller.dispatch({type:'zoom-in'});reset.onclick=()=>controller.dispatch({type:'reset-zoom'});mode.onclick=()=>controller.dispatch({type:'set-mode',mode:controller.state.mode==='continuous'?'single':'continuous'});document.addEventListener('keydown',onKeydown);render();
    return{controller,mode:'slides',dispose(){off();document.removeEventListener('keydown',onKeydown);frame.remove();}};
}
