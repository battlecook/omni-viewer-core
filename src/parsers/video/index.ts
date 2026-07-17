export interface VideoInfo { format: string; mimeType: string; warnings: string[]; }
const MIME: Record<string,string> = { mp4:'video/mp4',mts:'video/mp2t',m2ts:'video/mp2t',avi:'video/x-msvideo',mov:'video/quicktime',wmv:'video/x-ms-wmv',flv:'video/x-flv',webm:'video/webm',mkv:'video/x-matroska' };
export function parseVideoInfo(fileName:string,data:Uint8Array):VideoInfo { const ext=fileName.toLowerCase().split('.').pop()??''; return {format:ext.toUpperCase()||'VIDEO',mimeType:MIME[ext]??'application/octet-stream',warnings:data.byteLength?[]:['The video file is empty.']}; }
