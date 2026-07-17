import type {SlideDeck} from '../slide-model.js';
import type {Diagnostic,ParseOptions,ParseOutcome} from '../types.js';
import {PptxXmlParser} from './vscode-parser.js';

/** VS Code's full-fidelity PPTX parser, adapted from a file path to bytes. */
export async function parsePptxVscode(input:Uint8Array,options:ParseOptions={}):Promise<ParseOutcome<SlideDeck>> {
    const started=Date.now(); const diagnostics:Diagnostic[]=[];
    if(options.signal?.aborted)return{result:{status:'failed',failure:{code:'aborted',retryable:true,messageKey:'diag.aborted'},diagnostics},execution:{workerUsed:false,hardLimitEnforced:false,elapsedMillis:0}};
    if(input.byteLength>(options.limits?.maxInputBytes??50*1024*1024))return{result:{status:'failed',failure:{code:'limit-exceeded',retryable:false,messageKey:'diag.limit-exceeded.input'},diagnostics},execution:{workerUsed:false,hardLimitEnforced:false,elapsedMillis:Date.now()-started}};
    try {
        const parsed=await PptxXmlParser.parse(input);
        const slides=parsed.slides as SlideDeck['slides'];
        return{result:{status:'ok',document:{slides,totalSlides:parsed.totalSlides,...(slides[0]?{slideSize:{widthPx:slides[0].widthPx,heightPx:slides[0].heightPx}}:{})},diagnostics},execution:{workerUsed:false,hardLimitEnforced:false,elapsedMillis:Date.now()-started}};
    } catch {
        return{result:{status:'failed',failure:{code:'invalid-format',retryable:false,messageKey:'diag.ppt.invalid-format'},diagnostics},execution:{workerUsed:false,hardLimitEnforced:false,elapsedMillis:Date.now()-started}};
    }
}
