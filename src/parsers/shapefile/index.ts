export type ShpPosition=[number,number];
export type ShpGeometry=
    {type:'Point';coordinates:ShpPosition}|
    {type:'MultiPoint';coordinates:ShpPosition[]}|
    {type:'LineString';coordinates:ShpPosition[]}|
    /** First ring is the outer boundary; remaining rings are holes. */
    {type:'Polygon';coordinates:ShpPosition[][]}|
    {type:'MultiLineString';coordinates:ShpPosition[][]}|
    /** Each polygon contains an outer ring followed by zero or more holes. */
    {type:'MultiPolygon';coordinates:ShpPosition[][][]};
export interface ShapefileFeature { id:number; geometry:ShpGeometry|null; }
export interface ShapefileModel { shapeType:number; shapeTypeName:string; fileLengthBytes:number; bbox:[number,number,number,number]|null; features:ShapefileFeature[]; vertexCount:number; warnings:string[]; }
export interface ShapefileParseOptions { maxBytes?:number;maxFeatures?:number;maxVertices?:number;signal?:AbortSignal; }
const NAMES:Record<number,string>={0:'Null',1:'Point',3:'PolyLine',5:'Polygon',8:'MultiPoint',11:'PointZ',13:'PolyLineZ',15:'PolygonZ',18:'MultiPointZ',21:'PointM',23:'PolyLineM',25:'PolygonM',28:'MultiPointM',31:'MultiPatch'};
export function parseShapefile(data:Uint8Array,options:ShapefileParseOptions={}):ShapefileModel{
 const maxBytes=options.maxBytes??128*1024*1024,maxFeatures=options.maxFeatures??10_000,maxVertices=options.maxVertices??200_000;if(options.signal?.aborted)throw new Error('aborted');if(data.byteLength>maxBytes)throw new Error(`Shapefile exceeds the ${maxBytes.toLocaleString()} byte limit.`);if(data.byteLength<100)throw new Error('Shapefile header is truncated.');const v=new DataView(data.buffer,data.byteOffset,data.byteLength);if(v.getInt32(0,false)!==9994)throw new Error('Invalid Shapefile file code.');if(v.getInt32(28,true)!==1000)throw new Error('Unsupported Shapefile version.');const type=v.getInt32(32,true);const declared=v.getInt32(24,false)*2;const bbox=readBBox(v,36);const features:ShapefileFeature[]=[];const warnings:string[]=[];let offset=100,vertices=0,truncated=false;
 while(offset+8<=data.length&&features.length<maxFeatures&&vertices<maxVertices){if(options.signal?.aborted)throw new Error('aborted');const id=v.getInt32(offset,false),length=v.getInt32(offset+4,false)*2,start=offset+8,end=start+length;if(length<4||end>data.length){truncated=true;break;}try{const parsed=parseRecord(v,start,end,maxVertices-vertices);features.push({id,geometry:parsed.geometry});vertices+=parsed.vertices;}catch(error){warnings.push(`Record ${id} was skipped: ${error instanceof Error?error.message:String(error)}`);if(warnings.length>=20){warnings.push('Additional record warnings were suppressed.');break;}}offset=end; }
 if(declared!==data.byteLength)warnings.push(`Header declares ${declared.toLocaleString()} bytes; input contains ${data.byteLength.toLocaleString()} bytes.`);if(truncated)warnings.push('Parsing stopped at a truncated record.');if(offset<data.length&&(features.length>=maxFeatures||vertices>=maxVertices))warnings.push(`Preview is limited to ${maxFeatures.toLocaleString()} features and ${maxVertices.toLocaleString()} vertices.`);return{shapeType:type,shapeTypeName:NAMES[type]??`Unknown (${type})`,fileLengthBytes:data.byteLength,bbox,features,vertexCount:vertices,warnings};
}
function parseRecord(v:DataView,start:number,end:number,remaining:number):{geometry:ShpGeometry|null;vertices:number}{const type=v.getInt32(start,true);if(type===0)return{geometry:null,vertices:0};if(type===31)throw new Error('unsupported MultiPatch geometry');const base=type%10;if(base===1){bounds(start+4,16,end);const point=readPoint(v,start+4);return{geometry:{type:'Point',coordinates:point},vertices:1};}if(base!==3&&base!==5&&base!==8)throw new Error(`unsupported shape type ${type}`);bounds(start+4,36,end);let cursor=start+36;if(base===8){const count=v.getInt32(cursor,true);cursor+=4;checkCount(count,remaining);bounds(cursor,count*16,end);const points=readPoints(v,cursor,count);return{geometry:{type:'MultiPoint',coordinates:points},vertices:count};}const partCount=v.getInt32(cursor,true),pointCount=v.getInt32(cursor+4,true);cursor+=8;checkCount(partCount,100_000);checkCount(pointCount,remaining);bounds(cursor,partCount*4+pointCount*16,end);const parts:number[]=[];for(let i=0;i<partCount;i++)parts.push(v.getInt32(cursor+i*4,true));cursor+=partCount*4;const points=readPoints(v,cursor,pointCount);const groups=parts.map((at,i)=>points.slice(at,parts[i+1]??points.length)).filter(x=>x.length>0);if(base===3)return{geometry:groups.length===1?{type:'LineString',coordinates:groups[0]!}:{type:'MultiLineString',coordinates:groups},vertices:pointCount};return{geometry:buildPolygonGeometry(groups),vertices:pointCount};}

function buildPolygonGeometry(rings: ShpPosition[][]): Extract<ShpGeometry, { type: 'Polygon' | 'MultiPolygon' }> {
    const outers = rings.filter(ring => signedRingArea(ring) < 0);
    const holes = rings.filter(ring => signedRingArea(ring) >= 0);
    const polygons = outers.map(outer => [outer]);
    for (const hole of holes) {
        const point = hole[0];
        const owner = point === undefined ? undefined : outers
            .map((outer, index) => ({ index, area: Math.abs(signedRingArea(outer)), contains: pointInRing(point, outer) }))
            .filter(candidate => candidate.contains)
            .sort((left, right) => left.area - right.area)[0]?.index;
        if (owner !== undefined) polygons[owner]!.push(hole);
        else polygons.push([signedRingArea(hole) > 0 ? [...hole].reverse() : hole]);
    }
    if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0]! };
    return { type: 'MultiPolygon', coordinates: polygons };
}

function signedRingArea(ring: ShpPosition[]): number {
    let area = 0;
    for (let index = 0; index < ring.length; index++) {
        const current = ring[index];
        const next = ring[(index + 1) % ring.length];
        if (current && next) area += current[0] * next[1] - next[0] * current[1];
    }
    return area / 2;
}

function pointInRing(point: ShpPosition, ring: ShpPosition[]): boolean {
    let inside = false;
    for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
        const a = ring[current];
        const b = ring[previous];
        if (!a || !b) continue;
        const crosses = (a[1] > point[1]) !== (b[1] > point[1]) &&
            point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
        if (crosses) inside = !inside;
    }
    return inside;
}
function readBBox(v:DataView,o:number):[number,number,number,number]|null{const b:[number,number,number,number]=[v.getFloat64(o,true),v.getFloat64(o+8,true),v.getFloat64(o+16,true),v.getFloat64(o+24,true)];return b.every(Number.isFinite)?b:null;}
function readPoint(v:DataView,o:number):ShpPosition{const p:ShpPosition=[v.getFloat64(o,true),v.getFloat64(o+8,true)];if(!p.every(Number.isFinite))throw new Error('non-finite coordinate');return p;}
function readPoints(v:DataView,o:number,n:number):ShpPosition[]{const r:ShpPosition[]=[];for(let i=0;i<n;i++)r.push(readPoint(v,o+i*16));return r;}
function bounds(o:number,n:number,end:number):void{if(o<0||n<0||o+n>end)throw new Error('truncated geometry');}function checkCount(n:number,max:number):void{if(!Number.isInteger(n)||n<0||n>max)throw new Error('geometry count exceeds the resource limit');}
