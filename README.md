# omni-viewer-core

Shared parsing and rendering core for Omni Viewer — a family of file viewers
that run inside VS Code, Chrome extensions, Obsidian, and plain web pages from
a single codebase.

The core is platform-agnostic: parsers take bytes and return typed document
models, viewers mount into a DOM element, and everything host-specific
(file access, printing, asset URLs) is injected through small interfaces.

> **Status: 0.x pre-release.** APIs may change between minor versions.

## Supported formats

- **Documents** — PDF, Word (DOCX and legacy DOC), HWP, PowerPoint (PPTX and
  legacy PPT), Markdown
- **Data & spreadsheets** — Excel, CSV/TSV, JSON, JSONL/NDJSON, YAML, TOML,
  Parquet, Avro, HDF5, MATLAB MAT, Safetensors, Protocol Buffers, ReqIF, SQLite
- **Media & graphics** — audio (waveform/spectrogram), video, images,
  Photoshop PSD
- **Engineering & automotive** — CAN DBC, AUTOSAR ARXML, ASAM A2L, Vector
  ASC/BLF logs, ASAM MDF 4 (MF4), PCAP/PCAPNG, ROS bag, STEP (STP)
- **Diagrams & GIS** — Mermaid, PlantUML, ESRI Shapefile
- **Archives** — ZIP-family listing and safe entry preview

## Install

```sh
npm install omni-viewer-core
```

Heavy format libraries are **optional peer dependencies**: install only what
the formats you use need (`pdfjs-dist` for PDF, `jszip` + `docx-preview` for
Word, `mermaid` for Mermaid, and so on). Bundlers never have to resolve the
ones you skip.

### Note on `xlsx` (Excel / embedded workbooks)

The Excel paths require **`xlsx` >= 0.20.2**. The npm registry's `xlsx`
package stops at 0.18.5, which has known vulnerabilities (prototype
pollution, ReDoS); SheetJS distributes patched builds from its own CDN:

```sh
npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
```

## Usage

Each format is a subpath export. Parsers are pure functions over bytes;
libraries they need are injected, never imported at the top level:

```ts
import { parseExcel } from 'omni-viewer-core/parsers/excel';
import * as XLSX from 'xlsx'; // your app's copy, from the SheetJS CDN

const { result } = parseExcel(bytes, { xlsx: XLSX });
if (result.status !== 'failed') {
    console.log(result.document.sheetNames);
}
```

Viewers follow the same pattern — a `mount*Viewer(input, container, ctx,
deps)` entry per format, plus `self-loading` variants that dynamically import
their own dependencies for hosts that don't want to wire them manually.

### PDF host integration

The PDF viewer asks `ctx.assets.resolveAssetUrl` for the exact key
`assets/pdfjs/pdf.worker.min.mjs`. The published package also exposes that
worker at `omni-viewer-core/assets/pdfjs/pdf.worker.min.mjs`; a host may return
its own compatible `pdfjs-dist` worker URL instead, or pass `workerSrc` in the
PDF mount options. `isEvalSupported` defaults to `false` for CSP-safe hosts.

PDF mount options are additive and optional. `saveMode` is `hybrid` by default
(editable text/markup sidecar; signatures and deleted pages are permanent) and
may be set to `flattened` for smaller output. `toolbarActions` adds host-owned
buttons without exposing platform APIs to core. `zoomLevels`, `maxMergeBytes`,
and `onSaveAsComplete` configure navigation and host save behavior.

Large save and merge work can be delegated through the optional
`PdfViewerDeps.processing` service. VS Code extension-host and Web Worker
adapters can implement `buildPdf` and/or `mergePdfs`; each receives an
`AbortSignal` and progress callback. When the service is absent, the default
`auto` mode preserves the browser `pdf-lib` fallback. `host` requires the
service and `browser` forces the fallback. `PdfViewerHandle.operation` reports
running, succeeded, failed, and cancelled states, and `cancelOperation()`
requests cancellation.

`FileSaveService.saveFile` may continue resolving `void` for compatibility.
New adapters should return `{ status: 'cancelled' }` when a Save As picker is
dismissed, or `{ status: 'saved', fileName?, uri? }` after any host post-save
work (for example opening the new file or showing a notification) completes.

Parsers never throw on malformed input; they return a
`ParseOutcome` with a typed failure and diagnostics, and they enforce
resource limits (input size, cell/row/entry counts, declared decompressed
size for ZIP containers) that callers can tighten via `ParseOptions.limits`.

## Security

This library is built to open **untrusted files**. See [SECURITY.md](SECURITY.md)
for the threat model, the guarantees and their limits, and how to report a
vulnerability.

## License

[MIT](LICENSE). Bundled third-party components are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
