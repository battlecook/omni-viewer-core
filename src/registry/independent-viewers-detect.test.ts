import {describe,expect,it}from'vitest';import{CORE_VIEWER_DESCRIPTORS,detectViewer}from'./index.js';
describe('independent viewer detection',()=>{it.each([
 ['audio',['mp3','wav','pcm','aiff','aif','aifc','amr','awb','ogg','flac','ac3','aac','m4a']],
 ['video',['mp4','mts','m2ts','avi','mov','wmv','flv','webm','mkv']],['dbc',['dbc']],['arxml',['arxml']],['a2l',['a2l']],['asc',['asc']],['blf',['blf']],['mf4',['mf4']],['pcap',['pcap']],['pcapng',['pcapng']],['mermaid',['mmd','mermaid']],['plantuml',['puml','plantuml','iuml']],['shapefile',['shp']],['psd',['psd']]
] as const)('routes every %s extension before fallback',(viewer,extensions)=>{for(const ext of extensions){expect(detectViewer(`sample.${ext}`).viewerId,ext).toBe(viewer);expect(detectViewer(`SAMPLE.${ext.toUpperCase()}`).viewerId,ext).toBe(viewer);}});
it('registers one independent descriptor per requested viewer',()=>{for(const id of ['audio','video','dbc','arxml','a2l','asc','blf','mf4','pcap','pcapng','mermaid','plantuml','shapefile','psd'])expect(CORE_VIEWER_DESCRIPTORS.filter(x=>x.id===id)).toHaveLength(1);});
it('does not let generic image, markdown, or fallback descriptors win',()=>{expect(detectViewer('diagram.mmd').viewerId).toBe('mermaid');expect(detectViewer('map.shp').viewerId).toBe('shapefile');expect(detectViewer('layers.psd').viewerId).toBe('psd');});});
