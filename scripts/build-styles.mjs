// Emit dist/styles/*.css from the per-viewer style constants (DESIGN.md §6:
// the static CSS asset is the standard deliverable; the TS constant is the
// single source and is what shadow-mode mounting injects).
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, '..', 'dist');

const entries = [
    ['viewers/csv/styles.js', 'csvViewerCss', 'csv.css'],
    ['viewers/json/styles.js', 'jsonViewerCss', 'json.css'],
    ['viewers/toml/index.js', 'tomlViewerCss', 'toml.css'],
    ['viewers/jsonl/styles.js', 'jsonlViewerCss', 'jsonl.css'],
    ['viewers/yaml/index.js', 'yamlViewerCss', 'yaml.css'],
    ['viewers/fallback/styles.js', 'fallbackViewerCss', 'fallback.css'],
    ['viewers/pdf/styles.js', 'pdfViewerCss', 'pdf.css'],
    ['viewers/excel/styles.js', 'excelViewerCss', 'excel.css'],
    ['viewers/image/styles.js', 'imageViewerCss', 'image.css']
    ,['viewers/markdown/styles.js', 'markdownViewerCss', 'markdown.css']
    ,['viewers/archive/styles.js', 'archiveViewerCss', 'archive.css']
    ,['viewers/parquet/styles.js', 'parquetViewerCss', 'parquet.css']
    ,['viewers/hwp/styles.js', 'hwpViewerCss', 'hwp.css']
    ,['viewers/word/styles.js', 'wordViewerCss', 'word.css']
    ,['viewers/ppt/styles.js', 'pptViewerCss', 'ppt.css']
    ,['viewers/proto/styles.js', 'protoViewerCss', 'proto.css']
    ,['viewers/hdf5/styles.js', 'hdf5ViewerCss', 'hdf5.css']
    ,['viewers/mat/styles.js', 'matViewerCss', 'mat.css']
    ,['viewers/automotive/styles.js', 'automotiveViewerCss', 'automotive.css']
    ,['viewers/audio/index.js', 'audioViewerCss', 'audio.css']
    ,['viewers/video/index.js', 'videoViewerCss', 'video.css']
    ,['viewers/mermaid/index.js', 'mermaidViewerCss', 'mermaid.css']
    ,['viewers/plantuml/index.js', 'plantumlViewerCss', 'plantuml.css']
    ,['viewers/shapefile/styles.js', 'shapefileViewerCss', 'shapefile.css']
    ,['viewers/psd/styles.js', 'psdViewerCss', 'psd.css']
];

await mkdir(path.join(dist, 'styles'), { recursive: true });
for (const [module_, exportName, outName] of entries) {
    const mod = await import(path.join(dist, module_));
    await writeFile(path.join(dist, 'styles', outName), mod[exportName], 'utf8');
    console.log(`styles/${outName} written`);
}

const assets = path.join(dist, 'assets', 'pdfjs');
await mkdir(assets, { recursive: true });
await copyFile(
    path.join(root, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
    path.join(assets, 'pdf.worker.min.mjs')
);

// WASM audio engine (built from native/audio-engine, committed artifacts).
const audioEngine = path.join(dist, 'assets', 'audio-engine');
await mkdir(audioEngine, { recursive: true });
for (const artifact of ['audio_engine.mjs', 'audio_engine.wasm']) {
    await copyFile(
        path.join(root, '..', 'assets', 'audio-engine', artifact),
        path.join(audioEngine, artifact)
    );
}

const licenses = path.join(dist, 'licenses');
await mkdir(licenses, { recursive: true });
await copyFile(
    path.join(root, '..', 'node_modules', 'pdfjs-dist', 'LICENSE'),
    path.join(licenses, 'pdfjs-dist.txt')
);
await copyFile(
    path.join(root, '..', 'native', 'audio-engine', 'lib', 'COPYING.kissfft'),
    path.join(licenses, 'kissfft.txt')
);
await copyFile(
    path.join(root, '..', 'native', 'audio-engine', 'COPYING.emscripten'),
    path.join(licenses, 'emscripten.txt')
);
