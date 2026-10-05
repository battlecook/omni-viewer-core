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
  legacy PPT), Markdown, Jupyter Notebook (.ipynb),
  LaTeX (structure and math preview, not typesetting)
- **Data & spreadsheets** — Excel, CSV/TSV, JSON, JSONL/NDJSON, YAML, TOML,
  Parquet, Avro, HDF5, MATLAB MAT, NumPy (NPY/NPZ), Safetensors, GGUF, ONNX, TFLite/LiteRT,
  Keras (.keras and legacy .h5), Core ML (.mlmodel and .mlpackage),
  OpenVINO IR (.xml + .bin), PyTorch Export (.pt2), ExecuTorch (.pte), Protocol
  Buffers, ReqIF, SQLite
- **Web & network** — HAR (HTTP Archive) request logs
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

### OpenVINO IR models

An OpenVINO IR is two files that share a base name. The `.xml` is ordinary XML
whose root is `<net name version>` holding `<layers>` and `<edges>`; the `.bin`
has no header, magic, or index of its own — it is a raw concatenation of
constant payloads that `Const` layers address by `offset` and `size`. The core
receives the `.xml` as its input and the `.bin` as a sidecar the adapter reads
from the same directory:

```ts
import { mountOpenVinoViewer } from 'omni-viewer-core/viewers/openvino';

await mountOpenVinoViewer({ fileName: file.name, data: xmlBytes }, container, ctx, {
  sidecars: { bin: binBytes } // optional
});
```

The topology renders in full without the `.bin`. When it is supplied, every
constant's byte range is checked against it and its leading values are decoded
for a preview (all fixed-width IR element types, including f16, bf16, and the
f8 variants); the rest of the weights are never read, so a multi-gigabyte model
costs nothing beyond its XML. A `.bin` that is too short for the constants, or
that has bytes no constant references, is surfaced as a warning — the usual
signs of a mismatched pair (the unreferenced-bytes signal is only trusted when
every constant was read).

The viewer provides a computation graph with layer inspection (ports with
their producers and consumers, `<data>` attributes, `rt_info`, weight ranges,
and the sub-graphs a `Loop`, `TensorIterator`, or `If` layer carries in its
body), plus searchable layer, constant, input/output, and model-information
panels. IR v10 and v11 are the target; the legacy v7-and-earlier layout
(`<layer precision>` with `<blobs>`) is read on a best-effort basis and
flagged.

Routing is by content only: `.xml` is shared with every other XML dialect, so
the descriptor claims no extension and `detectViewer` reaches the viewer
through its text sample (`looksLikeOpenVinoIr`, also exported from
`omni-viewer-core/parsers/openvino`). A `.bin` opened on its own has nothing to
identify it; an adapter that wants to open one should look for the same-named
`.xml` beside it.

### PyTorch Export packages (.pt2)

A `.pt2` is what `torch.export.save` writes: a ZIP whose members sit under a
folder named after the file, with the serialized Export IR program in
`models/<name>.json`, parameters and buffers as raw storage bytes under
`data/weights/` (indexed by `<name>_weights_config.json`), tensor constants and
script objects under `data/constants/`, pickled sample inputs, optional
AOTInductor artifacts under `data/aotinductor/`, and user files under `extra/`.

```ts
import { mountPt2Viewer } from 'omni-viewer-core/viewers/pt2';

await mountPt2Viewer({ fileName: file.name, data: bytes }, container, ctx);
```

`parsePt2` reads the archive's central directory and only the JSON members it
needs; stored weight payloads are viewed in place and sampled for a short value
preview (every fixed-width torch dtype, including bf16 and the float8
variants), so a multi-gigabyte package costs nothing beyond its program JSON.
The viewer shows the ATen graph — placeholders coloured by signature kind
(user input, parameter, buffer, constant), operator nodes, higher-order
control-flow nodes with their `cond` / `while_loop` sub-graphs, and outputs —
with a node inspector (arguments, producers and consumers, module stack,
metadata, stack trace), plus searchable tables of nodes (sub-graph nodes
included), weights and constants with their archive status, the graph
signature (inputs and outputs by kind, buffer mutations, constant inputs), the
nn.Module hierarchy with preserved call signatures, model information (schema
and torch versions, opsets, range constraints, guards, operator counts), and
the archive listing. Symbolic shapes are printed as expressions (`2*s0`)
rather than the sympy `srepr` the file stores.

A package holding several programs (`package_pt2`) gets a model selector; an
AOTInductor-only package (`aoti_compile_and_package`) opens on the archive
tab with its compile metadata. The pre-PT2 `torch.export.save` layout
(`serialized_exported_program.json` beside torch.save pickles) is read on a
best-effort basis: the graph is complete, but weights are listed from the
signature without a preview. Schema 8.x is the target; enums
written as member names by older versions are accepted.

Routing is by the `.pt2` extension; an extensionless package reaches the viewer
through `probeContainer`, which recognizes the `archive_format` marker
(`looksLikePt2Archive` is also exported from `omni-viewer-core/parsers/pt2`).
A plain `torch.save` checkpoint (`.pt` / `.pth`) is not an Export package and
is not claimed.

### ExecuTorch programs (.pte)

A `.pte` is what `to_executorch().save()` writes: a FlatBuffer following
ExecuTorch's `program.fbs` (file identifier `ET12`), optionally followed by data
segments — constant tensors, delegate blobs, mutable initial state, and named
blobs — that an extended header (`eh00`, inserted right after the identifier)
locates. The parser reads the FlatBuffer directly with no schema compiler and no
runtime dependency, and never decodes a segment or buffer payload:

```ts
import { mountPteViewer } from 'omni-viewer-core/viewers/pte';

await mountPteViewer({ fileName: file.name, data: bytes }, container, ctx);
```

`parsePte` keeps every method (`ExecutionPlan`) with its values, instructions,
operators, and delegates, and resolves where each tensor's bytes live: the
deprecated inline `constant_buffer`, the constant segment (`constant_segment`
offsets, with the alignment-padded slot size and absolute file offset), a
mutable data segment for buffers with initial state, an external `.ptd` file
(`ExtraTensorInfo.location = EXTERNAL`), a memory-planned arena slot
(`AllocationDetails`), or nothing at all for runtime inputs. A kernel call's
outputs come from the return value the emitter appends after the schema
arguments (the out tensor, a TensorList of the out tensors, or a fresh scalar
for a symbolic op), and only the out-argument positions in front of it are
dropped from the inputs; a delegate call carries inputs then outputs with no marker,
so those are split by data flow — the trailing arguments nothing defined yet.
A view or alias the emitter gave its own EValue — a tensor nothing writes that
shares a memory-planned slot with an earlier one — is resolved to the value it
aliases when the file leaves no other reading, so a delegate fed through
aliases keeps its inputs and the graph keeps its edges. Every EValue kind
gets a preview, delegate compile specs are decoded when they are short text,
and the leading instructions keep their emitter stack traces.

The viewer draws each method's kernel, delegate, and move calls as a graph with
inputs, consumed constants, and outputs, plus an inspector (arguments with their
values, backend and compile specs for a delegate call, jump destination, stack
trace), and searchable instruction, value, input/output, delegate, segment, and
model-information panels; a multi-method program gets a method selector.
Warnings cover backends the runtime must register, tensors stored in a separate
`.ptd`, segments the file cannot locate or that run past its end, constant data
the program never provides, references to segments the program never declares,
and unrecognized scalar types, value kinds, or instruction kinds.

Routing is by the `.pte` extension, validated against the `ET12` identifier at
offset 4; an extensionless program is detected from the same bytes. A `.ptd`
data file (`FT01`) is not a program and is not claimed.

### Jupyter notebooks (.ipynb)

View nbformat 4 notebooks with their code and saved results in file order.
Markdown cells reuse the Markdown renderer, syntax highlighter, math renderer,
and prose styles. Code cells show `In`/`Out` execution counts, stdout/stderr,
HTML tables, PNG/JPEG/GIF/WebP/SVG images, Markdown, LaTeX, JSON, plain text,
and error tracebacks. Raw cells display as text. Code is never executed.

```ts
import { mountNotebookViewer } from 'omni-viewer-core/viewers/notebook';
import { loadNotebookViewerDeps } from 'omni-viewer-core/viewers/notebook/self-loading';

const deps = await loadNotebookViewerDeps();
const handle = await mountNotebookViewer(
  { fileName: 'analysis.ipynb', data: notebookBytes }, container, hostContext, deps
);
// Release the viewer, listeners, and any host-resolved assets on close.
handle.dispose();
```

The loader requires the existing optional peers `marked` and `dompurify`;
`highlight.js` and `katex` enhance code and formulas when installed. Adapters
can inject the same dependencies they use for Markdown. Load KaTeX CSS and
fonts inside the viewer's shadow root when using KaTeX, as with Markdown.
Scoped mounting uses `styles/notebook.css`.

Search cells and results, hide all code or outputs, or expand individual cells.
Persisted `source_hidden`, `outputs_hidden`, and `collapsed` hints set the
initial expansion state. One static representation is selected per MIME bundle;
interactive widget/JavaScript outputs fall back to saved plain text, or a
clear unsupported-output notice. Markdown `attachment:` images work offline.
Relative images use the optional `documentAssets` service, external links use
`navigation`, and remote resources and active HTML are blocked.

`parseNotebook` is also available from `parsers/notebook`. It returns a typed
`ParseOutcome<NotebookDocument>` and uses the core JSON parser, retaining raw
JSON output tokens. Defaults: 64 MiB input, 2,000 cells, 10,000 outputs, 4 MiB
per preview, and 16 MiB cumulative previews. `limits.maxEntries` counts cells;
`maxOutputs` and `maxTotalPreviewBytes` are independent limits. Truncation
returns `partial` with diagnostics. Invalid JSON and unsupported major versions
return typed failures. See [viewer details](examples/notebook/README.md) and the
[sample notebook](examples/notebook/analysis.ipynb).

### HAR network logs (.har)

A `.har` file is the HTTP Archive a browser's network panel (or curl, Charles,
Fiddler, Playwright) exports: one JSON `log` holding every request of a session
with its headers, bodies, sizes, and phase timings. It is the artifact a web or
API failure usually arrives as, so the viewer is built for triage rather than
for reading JSON:

```ts
import { mountHarViewer } from 'omni-viewer-core/viewers/har';

await mountHarViewer({ fileName: file.name, data: bytes }, container, ctx);
```

`parseHar` is a contract parser (`ParseOutcome<HarDocument>`) and reads the
archive through the core JSON layer, so a truncated export still yields the
requests it did hold. Each entry keeps its request and response headers, query
string, cookies, request payload, and response body, and gains what the table
needs: host, path, status class, resource type (from `_resourceType` when the
writer supplied one, from the MIME type otherwise), transferred bytes
(`_transferSize` when present), decoded resource size, and a phase breakdown
with the TLS handshake taken out of `connect` so a waterfall cannot
double-count it. Timestamps go through a core ISO-8601 parser rather than
`new Date(string)`, and the timeline's origin is the earliest entry, so offsets
and bar positions are the same on every platform. A base64 body is decoded when
its MIME type is textual (the URL-safe alphabet included) and reported by size
only when it is not; bodies are kept up to a preview limit, and entries up to
`HAR_DEFAULT_MAX_ENTRIES` (a larger archive comes back `partial` with a
diagnostic). A body cut by the preview limit and one the archive stored
incompletely — several padded base64 chunks, or a tail outside the alphabet —
are reported as two different things, and a size or start time the archive never
gave is kept unknown rather than shown as a confident zero.

The viewer shows summary figures (requests, elapsed, transferred, resources,
domains, errors), a request table sortable by every column with a per-entry
waterfall bar, and filters for method, status class, resource type, domain, and
free text over URLs, status text, and headers — with an opt-in toggle that
extends the search to bodies. Selecting a request opens headers (general,
request, response), payload (query string and request body, form fields
expanded), response (body pretty-printed through the JSON serializer when it
really is JSON), cookies, and timings (drawn phases plus the values the archive
reported, with `-1` shown as not applicable). Page load timings and archive
metadata get their own tabs. Routing is by the `.har` extension; an
extensionless archive is recognized by content — a `log` object holding an
`entries` array — and claimed before the generic JSON viewer.

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
