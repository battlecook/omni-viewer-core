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
  legacy PPT), Markdown, LaTeX (structure and math preview, not typesetting)
- **Data & spreadsheets** — Excel, CSV/TSV, JSON, JSONL/NDJSON, YAML, TOML,
  Parquet, Avro, HDF5, MATLAB MAT, NumPy (NPY/NPZ), Safetensors, GGUF, ONNX, TFLite/LiteRT,
  Keras (.keras and legacy .h5), Core ML (.mlmodel and .mlpackage),
  Protocol Buffers, ReqIF, SQLite
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

### Safetensors large-file input

Pass browser `File`/`Blob` objects through the lazy source helper so only the
8-byte length prefix and JSON header are read:

```ts
import {
    createSafetensorsBlobSource,
    mountSafetensorsViewer
} from 'omni-viewer-core/viewers/safetensors';

const source = createSafetensorsBlobSource(file, file.name);
await mountSafetensorsViewer(source, container, ctx);
```

Node hosts can use `parseSafetensorsFile` from
`omni-viewer-core/parsers/safetensors/node` and mount the returned document
with `mountSafetensorsDocument`. The legacy `Uint8Array` input remains
available, but it requires the host to load the complete file first.

### GGUF metadata and tensor index

GGUF parsing reads the header, metadata block, and tensor index directly from
ranged reads, and normalizes their bigint and large-array values into an Omni
Viewer JSON-safe document. Tensor payload bytes are never read, metadata array
bodies are skipped rather than decoded, and only a bounded number of metadata
and tensor entries is retained, so a model's vocabulary size does not affect
peak memory or what the document contains. `normalizeGguf` remains available for
hosts that already hold a `@huggingface/gguf` parse result. Node hosts can parse
a local model without loading tensor payloads and mount the result separately:

```ts
import { parseGgufFile } from 'omni-viewer-core/parsers/gguf/node';
import { mountGgufDocument } from 'omni-viewer-core/viewers/gguf';

const document = await parseGgufFile('/models/model.gguf');
mountGgufDocument(document, 'model.gguf', container, ctx);
```

Remote hosts can use `parseGgufUri` from `omni-viewer-core/parsers/gguf`.
Browser and file-picker hosts can pass the common `{ fileName, data }`
`ViewerInput` directly to `mountGgufViewer`; the byte input is exposed to the
same upstream parser through an in-memory range source.
Tokenizer arrays are represented by bounded previews in the normalized model;
the viewer provides searchable tensor/metadata tables, structure preview, and
JSON copy. Node.js 20 or later is required.

### ONNX computation graphs

The ONNX parser reads the protobuf `ModelProto` directly without a runtime
dependency. Tensor payload bytes are skipped while graph topology, operators,
attributes, shapes, opsets, metadata, and external-data locations are retained:

```ts
import { mountOnnxViewer } from 'omni-viewer-core/viewers/onnx';

await mountOnnxViewer({ fileName: file.name, data: bytes }, container, ctx);
```

The viewer provides a connected computation graph with node inspection plus
searchable node, initializer, input/output, and model-information panels.

### TFLite / LiteRT models

The TFLite parser reads the `TFL3` FlatBuffer directly — no schema compiler and
no runtime dependency. Buffer payloads stay unread while subgraph topology,
operator codes, decoded builtin options, tensor types, shapes, quantization,
sparsity, signature definitions, and metadata are retained:

```ts
import { mountTfliteViewer } from 'omni-viewer-core/viewers/tflite';

await mountTfliteViewer({ fileName: file.name, data: bytes }, container, ctx);
```

The viewer provides a per-subgraph computation graph with operator and tensor
inspection, navigation into the subgraphs a control-flow operator references,
and searchable operator, tensor, input/output, buffer, and model-information
panels. Custom operators, Select TensorFlow fallbacks, and buffers stored
outside the FlatBuffer are surfaced as warnings.

### Keras models

Both Keras save formats open through one viewer. A `.keras` file is a ZIP whose
members Keras stores uncompressed, so `config.json`, `metadata.json`, and the
`model.weights.h5` store are read in place — JSZip is only consulted for an
archive that was re-zipped with compression. A legacy `.h5` model is read as
HDF5, taking `model_config` and `training_config` from the root attributes and
the parameters from `/model_weights`:

```ts
import { mountKerasViewer } from 'omni-viewer-core/viewers/keras';

await mountKerasViewer({ fileName: file.name, data: bytes }, container, ctx);
```

Weight payloads are never read: only dataset shapes and datatypes are walked, so
parameter counts stay cheap on multi-gigabyte models. The viewer lists layers
(nested sub-models flattened by depth) with per-layer configuration, inbound
connections, and weights, plus searchable weight, configuration, training,
archive, and model-information panels.

`.keras` routes by extension, and an extensionless archive is resolved by
`probeContainer`. A `.h5` file routes to the HDF5 viewer, since only its
contents distinguish a Keras model from any other HDF5 file; hosts that read the
whole file can refine that with `looksLikeKerasHdf5` from
`omni-viewer-core/parsers/keras` and mount the Keras viewer instead.

### Core ML models

A `.mlmodel` is a serialized `CoreML.Specification.Model` protobuf, and an
`.mlpackage` is a bundle whose `Manifest.json` points at one such spec plus the
weight blobs its ML Program references. One entry point reads both — bytes that
open with a ZIP header are treated as a packaged bundle:

```ts
import { mountCoremlViewer } from 'omni-viewer-core/viewers/coreml';

await mountCoremlViewer({ fileName: file.name, data: bytes }, container, ctx);
```

Weight payloads are never decoded: blob references resolve to a file, an offset,
and a byte count, and inline weight tensors to their size and quantization, so a
multi-gigabyte model costs nothing to open. Package members are read in place,
and JSZip is only consulted for a bundle that was re-zipped with compression.

Two model families carry a graph, and the viewer reads them to different depths:

- An **ML Program** (Core ML 5 and newer) is self-describing — every operation
  names its own inputs, so attributes are shown exactly as the producer wrote
  them, with no schema knowledge involved.
- A **neural network** (the older encoding) stores each layer's parameters in a
  distinct message per layer type. Layer types resolve for all of them, and
  attributes are decoded for the common types; weights need no such table, since
  `WeightParams` has one shape everywhere it appears and is found structurally.

The viewer provides a per-graph computation graph with operation, value, and
weight inspection, navigation into the blocks a control-flow operation
references, and searchable operation, input/output, weight, package, and
model-information panels. Custom layers, pipeline stages, unmapped layer types,
and weight files that are not present are surfaced as warnings.

Both extensions route by extension, and an extensionless zipped bundle is
resolved by `probeContainer` from its `Manifest.json` + `Data/com.apple.CoreML`
layout. A `.mlmodel` carries no leading magic, so hosts that can read a whole
extensionless file can refine routing with `looksLikeCoremlSpec` from
`omni-viewer-core/parsers/coreml`.

### Archive host integration

Archive decompression remains adapter-owned: pass an `ArchiveDecoder` to
`mountArchiveViewer`, retaining JSZip or libarchive according to the formats
the platform supports. All parity extensions are optional. `previewEntry`
delegates extracted PDF, Office, HWP, Parquet, or nested-archive entries to a
host viewer router; `requestPassword` retries decoder open/extract/save calls;
and `includeImplicitDirectories` synthesizes view-only folders for decoders
that omit directory records. Hosts that omit these options keep the existing
media/text/hex preview and encrypted-entry blocking behavior.

### Word host integration

`mountWordViewer` exposes a typed `status`, `subscribeStatus`, `contentElement`,
and `viewportElement`. Hosts can use `onStatusChange` to observe the initial
`loading` state, inspect structured diagnostics, and distinguish `ready`,
`partial`, `failed`, and `aborted` outcomes. A host-owned
`fallbackRenderer` can render Mammoth HTML into the stable content root after a
core failure; successful fallback is reported as `ready` with
`renderer: 'fallback'`.

`toolbarActions` adds host operations such as “Save as PDF” without adding PDF
or download dependencies to core. The handle's `refreshToolbarActions()`
re-evaluates dynamic disabled states, while core manages in-progress disabling
and reports rejected actions through `onToolbarActionError`.

Hosts may tighten `limits` and tune the safe `docxRenderOptions` subset.
`inWrapper` is always kept enabled for the DOM contract. The self-loading entry
imports `xlsx` only when an embedded workbook is discovered; pass
`loadWordViewerDeps({ embeddedSheets: false })` to disable that path entirely.
All element accessors become invalid when the handle is disposed.

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
