# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.0] - 2026-08-02

### Added

- **`isDirty()` on the LaTeX, Markdown, Mermaid and PlantUML mount handles.**
  They now resolve to `LatexViewerHandle`,
  `MarkdownViewerHandle`, `MermaidViewerHandle` and `PlantUmlViewerHandle` —
  each `ViewerHandle` plus `isDirty(): boolean`, the shape csv, image and pdf
  already used. A host that re-mounts on a file change or refresh can ask whether
  that would discard unsaved edits, instead of reading the editor textarea out of
  the viewer's shadow root and comparing against its own copy of the text. The
  value is the controller's `source !== savedSource`: undoing back to the saved
  text clears it, a successful writeback clears it, and a failed save or a
  Save As/download copy keeps it set.

  Purely additive. The returned objects still satisfy `ViewerHandle`, the mount
  functions are still assignable to their previous `Promise<ViewerHandle>`
  signatures, and `dispose()` is unchanged.

  DESIGN.md §3-② now records the convention (ADR 44): per-viewer capabilities go
  on a handle that extends `ViewerHandle`, never as optional members of the shared
  contract, and `isDirty()` is mandatory for new editable viewers. The Excel and
  Protobuf viewers are editable but still do not expose it — they are recorded
  there as the remaining gap, not covered by this release.

### Fixed

- An edit made while a save was still in flight was reported as saved. The bytes
  are snapshotted before the `await`, but `mark-saved` was dispatched after it and
  took "whatever is in the editor now" as the new baseline — so editing A → B
  during the write left A on disk and B recorded as saved, with `isDirty()`
  answering `false`. A host trusting that answer would discard B on re-mount. The
  action now carries the source that actually reached the file
  (`{ type: 'mark-saved', source }`) and dirty is recomputed against it, so the
  mid-write edit stays dirty and undoing it back to the file's content clears the
  flag as usual. Fixed in the LaTeX, Markdown and diagram (Mermaid/PlantUML)
  controllers. The `source` field is optional, so existing `mark-saved` dispatches
  keep their previous meaning.

- The same defect in the PDF viewer: only the save/merge buttons are disabled
  while an operation runs, so a page reorder or annotation added during a save
  was reported as saved once the write finished. `mark-saved` now carries the
  `pageOrder`/`annotations` pinned when the write began (`savedState`), so the
  mid-save edit stays dirty and undoing it back to the written document clears
  the flag. The field is optional — existing dispatches keep their meaning.

- The same defect in the CSV viewer, where it had been reachable since the first
  release: a cell edited while Save or Save As was in flight was reported as
  saved. CSV tracks dirty by undo depth rather than by text, so the viewer now
  keeps the serialization it wrote and clears dirty only if the document still
  equals it on completion; otherwise the flag stays set until the next save.
  `CsvController` is unchanged — no new or altered members.

## [0.11.1] - 2026-08-01

### Fixed

- The LaTeX viewer no longer loses a `tabular` that sits inside a `table` float.
  Float handling extracted the caption and discarded the rest, which ran before
  the table rendering added in 0.11.0 — so the most common way to write a table
  left nothing on screen, not even its source. A `figure`/`table` float is now a
  container: its body is scanned like any other content and the caption is lifted
  out for display rather than standing in for it. The `\caption` copy left in the
  body is consumed (including `\caption*` and the optional short form), floats
  render as `<figure>`/`<figcaption>`, and the now-untrue "caption only" badge and
  its `diag.latex.float-caption-only` diagnostic are gone from every catalog.

## [0.11.0] - 2026-08-01

### Added

- **LaTeX viewer** (`omni-viewer-core/viewers/latex`, `.tex` / `.latex` / `.ltx`).
  Structure navigation and math, not typesetting: the preview shows a sectioning
  outline, prose, lists, theorem environments and formulas, and states on screen
  that it is a partial render. Anything it cannot model — `tabular`, TikZ,
  `algorithm` — is shown as its own source with a badge rather than dropped, and
  `\input`/`\includegraphics` are reported as unresolved because the core never
  reads external files. Math is rendered by an injected engine
  (`loadLatexViewerDeps()` wires up KaTeX + DOMPurify) and renders progressively
  as formulas approach the viewport; without the engine, formulas stay readable
  as TeX. A renderer supplied without a DOMPurify factory is refused rather than
  trusted with the DOM. Adds `omni-viewer-core/parsers/latex`,
  `omni-viewer-core/viewers/latex/self-loading`, `dist/styles/latex.css`, and
  `LATEX_VIEWER_DESCRIPTOR` in the registry. See `docs/viewers/latex.md`.
  Tables (`tabular`/`array`/`longtable`/`tabularx`) render with column alignment
  and `\multicolumn` spans; `\newtheorem`-declared theorem environments render
  with their titles; `subequations`, beamer `frame`/`block`/`columns` and other
  pure wrappers are seen through so their content is not buried. Extensionless
  files are routed by a `\documentclass` text sniff. `\input`/`\include` are
  resolved only when the adapter injects `resolveInclude`; the core enforces path
  containment before asking, and included files become sub-documents so the
  editor and writeback keep addressing the main file.
  Preamble macros reach the math engine, including parameterized
  `\newcommand`, `\DeclareMathOperator` and `\let` aliases; `\label`/`\ref` and
  other commands that typeset nothing are dropped before rendering instead of
  becoming the engine's red unknown-command marker, and `\ref` becomes a control
  that scrolls to the labelled block.
- `MathRenderer`, `DomPurify` and the KaTeX sanitize profile now live in
  `viewers/math.ts` so the markdown and LaTeX viewers share one injection type
  and one allow-list. `MarkdownMathRenderer` remains as an alias.

- The Markdown viewer now shows a heading outline beside the preview, with a
  `Contents` toggle. Entries are built from the rendered headings rather than the
  parser's source index, so `#` inside fenced code is excluded and setext
  headings are included; clicking one scrolls the preview (and, in split mode,
  the source), and the current heading is tracked as you scroll. This wires up
  the `select-heading` action and `selectedHeading` state that
  `createMarkdownController` already exposed but nothing used. Adds
  `.omni-markdown__preview-body`, `.omni-markdown__toc`, `.omni-markdown__toc-list`,
  and `.omni-markdown__toc-link` to `markdownViewerCss`; uses the existing
  `markdown.toc` message. The outline is shown in preview mode and hidden in
  split mode, where the width is already divided two ways; using the toggle pins
  it either way for the rest of the session.
- The Markdown viewer's split view now scroll-syncs the preview and the source
  editor in both directions. It is always on and has no button of its own —
  hosts that want it configurable can pass `MarkdownMountOptions.scrollSync`.
  Rendered top-level elements carry `data-source-line`, so hosts can build their
  own outline or reveal-line behaviour on top of the same anchors. New
  `viewers/markdown/source-map.ts` exports `scanSourceBlocks`,
  `assignSourceLines`, `projectScroll`, and `SOURCE_LINE_ATTRIBUTE`.

- The Parquet viewer now shows which column is sorted and in which direction.
  The sorted header carries `aria-sort` and a ▲/▼ indicator, matching the CSV and
  Excel viewers; the state was already tracked by the controller but was never
  rendered. Adds `.omni-parquet__sort-indicator` to `parquetViewerCss`.
- Parquet clipboard actions are guarded by
  `PARQUET_COPY_PAYLOAD_LIMIT_BYTES` (1 MiB, parity with CSV/Excel) and now
  confirm themselves with a toast. Oversized payloads are refused with
  `common.copyTooLarge` and pointed at Export JSON, which stays unguarded. This
  applies to Copy JSON and Copy table, so wide previews that previously wrote
  multi-megabyte payloads to the clipboard are now refused. Adds
  `.omni-parquet__toast` to `parquetViewerCss`.
- `ParquetParseOptions.metadata` / `ParquetDocument.fileMetadata` let a chunked
  read reuse the footer parsed by the previous chunk. The viewer's "load more"
  now threads it through, so each chunk costs only its own page reads — free for
  a buffer input, but one saved round trip per chunk when `slice()` is bridged to
  another process.
- The Parquet search input has an `aria-label`, and `Escape` now dismisses its
  context menu from anywhere (parity with CSV/Excel).

### Fixed

- The Markdown viewer's panels now scroll internally instead of growing to fit
  their content. `.omni-markdown__workspace` set only `min-height`, so its grid
  row sized to the document and the preview's `overflow:auto` never engaged —
  the page scrolled instead, leaving `preview.scrollTop` pinned at 0. Everything
  built on the preview being the scrollport was inert as a result: clicking an
  outline entry marked it current but moved nothing, the scroll spy never fired,
  and split-view scroll sync clamped every projection to 0. The workspace now
  takes `flex:1 1 68vh` with a `minmax(0,1fr)` row, so it fills a host that gives
  the viewer a definite height and stays bounded in one that does not.

- The Parquet viewer no longer leaks a mount that was aborted while parsing. A
  signal firing between parse completion and return previously yielded a live
  handle the host never disposed, stranding three `document`-level listeners;
  mount now tears down and throws `MountAbortedError`, as CSV/Excel do.
- `dispose()` now clears the root and removes `VIEWER_ROOT_CLASS` /
  `omni-viewer--parquet` from the container instead of only detaching its own
  frame, and is idempotent.

## [0.10.0] - 2026-07-27

### Added

- The Proto viewer's source pane is now an editor. The left pane became an
  editable `<textarea>` overlaid with the syntax highlighter; edits re-parse the
  schema (debounced) and refresh every navigation panel live, and the toolbar
  gained Save (overwrite the original via `writeback`) and Save as (write a copy
  via `save`) actions with a dirty-state indicator and `Ctrl/Cmd+S`. This adds
  `save`/`writeback` to `ProtoViewerContext` and to the optional services on
  `PROTO_VIEWER_META`/`PROTO_VIEWER_DESCRIPTOR`; hosts that want editing must now
  inject those services (both remain optional — the viewer stays read-only
  without them).

### Fixed

- Charts and embedded workbooks are no longer dropped from DOCX files. The
  placeholder that replaces a `w:drawing`/`w:object` was emitted as a whole `w:r`,
  but both are run *inner* content, so the result nested a run inside a run —
  markup docx-preview's run parser does not recognise, silently discarding the
  placeholder token and with it the rendered chart. The placeholder is now a bare
  `w:t`. Affected every chart in a normally authored document. A drawing or object
  skipped for exceeding the embedded-content limit is likewise dropped outright
  instead of leaving an empty nested `w:r` behind.

- The PDF viewer's thumbnail toggle no longer sits underneath the Annotations
  panel: the toggle is hidden while that left sidebar is open and restored when it
  closes.

- In-document anchors (`<a href="#bookmark">`) now scroll to their target in the
  Word and Markdown viewers instead of being disabled. Word tables of contents,
  cross-references and footnote back-links were dead because fragment hrefs are not
  absolute URLs and so never passed the external-link check. Resolution is scoped to
  the viewer and shadow-root aware, needs no `ctx.navigation`, and scrolls only the
  viewer's own scrollport; external-link and blocked-scheme policy is unchanged.
  Anchors with no matching target stay `aria-disabled="true"` without a diagnostic.
  The Markdown viewer also stops overwriting renderer-supplied heading ids — it now
  only assigns `heading-<n>` to headings that have none.

## [0.9.0] - 2026-07-26

### Added

- The PPT viewer's self-loading entry now bundles a default EMF/WMF rasterizer:
  `emf-converter` is a runtime dependency wired into `renderMetafile` via
  `selfLoadingPptPdfDeps`/`mountSelfLoadingPptViewer`, so embedded metafile logos
  and diagrams render without any host configuration. The reusable
  `renderPptMetafile` adapter is exported from `viewers/ppt/self-loading` for hosts
  that mount the core PPT viewer directly.

### Changed

- Metafile image resolution now prefers an exact-basename raster sibling, then the
  `renderMetafile` converter, and no longer substitutes an arbitrary same-directory
  raster (which usually surfaced an unrelated image such as a logo). Metafiles that
  cannot be converted fall back to a clean, diagnosed placeholder.

## [0.8.0] - 2026-07-25

### Added

- The Word viewer now exposes typed render status and diagnostics, stable
  content/viewport accessors, host fallback rendering, custom toolbar actions,
  configurable docx-preview options, and host-tightenable resource limits.
- DOCX charts preserve bar, line, and pie types; unsupported charts use a
  diagnosed placeholder, while packaged chart fallback images are preferred.
- The Parquet toolbar now exposes the existing filtered-table TSV copy action.
- Parquet parsing gains a random-access path: `parseParquetSource` reads a host
  `ParquetSource` (Blob range reads, Node `fs`) and materializes only the footer
  and requested preview pages. `createParquetBlobSource` and `mountParquetViewer`
  accept such a source; the existing `Uint8Array` API remains for compatibility.
- Mermaid and PlantUML now share an editable diagram viewer with Diagram/Split/
  Source view modes, a Render action with undo/redo history, per-renderer theme
  selection, zoom controls, SVG/source copy, and a live render status; when no
  renderer is installed the source is shown instead.
- The PPT/PPTX slide renderer draws clustered-column, clustered/stacked/percent-
  stacked bar, stacked/percent-stacked column, and pie charts, with configurable
  legend positions.
- PPTX parsing can render embedded WMF/EMF metafiles through an optional host
  `renderMetafile` hook, distinguishes corrupted from invalid packages, and
  enforces cooperative input/entry/time limits with typed diagnostics, including
  an unsupported-object notice.
- The PPT viewer accepts host `renderElement`/`renderChart` overrides, custom
  `toolbarActions`, and `onSlideChange`/`onDiagnostics` callbacks, and reports
  typed failures through `PptViewerError`.
- The Proto viewer syntax-highlights its source panel (keywords, builtin types,
  literals, strings, numbers, and comments).
- Legacy DOC parsing distinguishes password-protected and corrupted OLE files
  and recovers partial text from a damaged piece table, reported through a
  `recovered-corruption` diagnostic.
- Archive decoders can report archive-wide encryption through
  `OpenArchiveHandle.encrypted`, alongside entry-level `ArchiveEntry.encrypted`;
  the archive viewer displays both states and blocks unavailable extraction.
- Archive hosts can optionally delegate extracted entries to their own viewer
  router, preserving PDF, Office, HWP, Parquet, and nested-archive previews
  without importing those viewers from the archive bundle.
- Archive adapters can expose compression metadata and decoder capabilities,
  retry open/extract/save operations through a host-owned password prompt, and
  opt into view-only implicit directory synthesis when a decoder omits folders.

### Changed

- Word self-loading now imports `xlsx` only after an embedded workbook is
  discovered and supports `embeddedSheets: false`; legacy DOC rendering now
  reports a typed parse outcome without discarding its richer layout path.
- The minimum supported `dompurify` peer version is now 3.4.12.

### Fixed

- Aborted or superseded Word renders can no longer overwrite a newer mount,
  and Word disposal now removes injected styles, listeners, and blob URLs.
- JSONL details and editing once again use the cursor-positioned hover popup
  instead of expanding rows inline, and inline edits now reject records that
  contain newlines, keeping each entry on one physical line.
- PDF text annotations preserve multiline content and non-hex CSS colors when
  edited, and multiline flattening renders every line.
- Late archive save results no longer overwrite the UI for a subsequently
  selected entry.

## [0.7.0] - 2026-07-22

### Added

- Safetensors random-access parsing via `parseSafetensorsSource`, reading only
  the 8-byte length prefix and JSON header while validating tensor offsets
  against the complete file size. Browser hosts can use
  `createSafetensorsBlobSource`; Node hosts can use `parseSafetensorsFile` from
  `omni-viewer-core/parsers/safetensors/node`. The existing `Uint8Array` API
  remains available for compatibility.

## [0.6.0] - 2026-07-21

### Added

- New Safetensors viewer (`.safetensors`). It decodes only the 8-byte header
  length and the JSON header — never the tensor payloads — so multi-gigabyte
  checkpoints stay cheap to inspect. Shows a tensor table (name, dtype, shape,
  parameter count, byte size), the `__metadata__` string map, a structure
  preview, search, and JSON copy, and validates current Safetensors 0.8 dtypes,
  tensor declarations, and packed byte ranges without decoding tensor data.
  Exposed via
  `omni-viewer-core/parsers/safetensors` (`parseSafetensors`) and
  `omni-viewer-core/viewers/safetensors` (`mountSafetensorsViewer`,
  `mountSafetensorsDocument`).
- The PDF viewer now zooms with a trackpad pinch (two-finger spread/close),
  handled as a `ctrl`+wheel gesture and coalesced to one re-layout per frame so
  a burst of events stays smooth.
- The PDF page-thumbnail rail (shown by default) can now be collapsed and
  restored with a toolbar toggle to give the page area more room.
- Clicking a PDF text-markup annotation (highlight/underline/strikethrough) now
  shows a floating toolbar to open the annotation list, recolor it from a
  palette, copy its text, or delete it. Markups now store their selected text
  (persisted through the sidecar) and the toolbar's leftmost button opens a
  left sidebar listing every markup, each linking to its place in the document.
- The PDF markup toolbar button is no longer disabled until a selection exists.
  It always reflects the active markup kind (highlight/underline/strikethrough),
  and finishing a text selection now applies that kind immediately — no extra
  click required.
- TOML nodes now carry a `range` (character offsets into the document text) and
  a `comment` (the `#` run directly above the declaration plus any trailing
  comment on its line). Ranges stay accurate across CRLF sources, a leading BOM,
  multiline arrays, and inline-table members.
- `TomlController` gained `nodeRange`, `nodeAtOffset`, and `nodeMatches`, plus
  the `set-search-scope`, `select-node`, and `select-offset` actions, with
  `searchScope` (`all`/`key`/`path`/`value`), `searchScopes`, `matchCount`, and
  `selected` on the view state.
- The shared structured viewer (TOML/YAML) now syncs the tree with the source
  caret in both directions when a controller exposes ranges, highlights the
  selected node, shows a status badge with the selected path and match count,
  renders node comments, previews empty containers as `{ n keys }` /
  `[ n items ]`, and gives flat rows a type badge and click-to-navigate. Every
  new `StructuredController` member is optional, so controllers that omit them
  render exactly as before.

### Fixed

- PDF underline annotations were stamped near the top of the text box instead of
  the bottom, so a saved/flattened file showed the underline in the wrong place
  when opened in another viewer. The line now sits just above the box bottom,
  matching the on-screen rendering.

## [0.5.0] - 2026-07-19

### Added

- Added PDF host-integration mount options (`PdfMountOptions`): `saveMode`
  (`hybrid` default, or `flattened` for smaller output without the editable
  sidecar, with a toolbar badge showing the active mode), host-owned
  `toolbarActions`, `workerSrc` (defaulting to the exported
  `PDF_WORKER_ASSET_KEY` asset), `isEvalSupported` (defaults to `false` for
  CSP-safe hosts such as VS Code), `maxMergeBytes` for the merge file picker,
  and `onSaveAsComplete`.
- Added an optional `PdfViewerDeps.processing` service so hosts (VS Code
  extension host, Web Workers) can run byte-heavy PDF save and merge work via
  `buildPdf`/`mergePdfs`, with an `AbortSignal` and progress reporting per
  operation. `processingMode` selects `auto` (delegate when available),
  `host`, or `browser` (always use the `pdf-lib` fallback).
  `PdfViewerHandle` now exposes the running/succeeded/failed/cancelled
  `operation` state, `cancelOperation()`, and `refreshToolbarActions()`.
- Added configurable PDF zoom (`PdfControllerOptions`: `zoomLevels`,
  `minZoom`, `maxZoom`), expanded the default button steps with the VS
  Code-compatible intermediate levels (175/225/250/275), and exported
  `PDF_MIN_ZOOM`/`PDF_MAX_ZOOM`. Zoom buttons now disable at the real
  minimum and maximum instead of the first and last button step.
- Added annotation overlays to PDF thumbnails so highlights, underlines,
  strikeouts, text, and signatures stay in sync with markup edits.
- Added a `FileSaveResult` return type to `FileSaveService.saveFile` so new
  host adapters can report `saved` (with optional file name/URI) or
  `cancelled`; existing `void`-returning implementations keep working. A
  cancelled Save As picker no longer reports a successful save.
- Added a Markdown save fallback: when no writeback service exists, Ctrl+S
  saves a copy through the optional `save` (file-save) service, now declared
  in the Markdown viewer descriptor.
- Added a "Replace editor" action to the JSON converter result panel so a
  conversion can be applied back to the editor without a clipboard service.
- Added YAML duplicate-key detection: duplicate mapping keys now parse as a
  `yaml.duplicate-key` warning (keeping every entry with disambiguated
  paths) instead of failing the document, and structured-viewer diagnostics
  now interpolate message arguments.
- Added YAML alias and merge-key resolution to JSON output: scalar aliases
  resolve to their anchor values, `<<:` merge keys are expanded, redefined
  anchors resolve in document order, and self-referencing cycles are broken
  instead of overflowing the stack.
- Added a `verify:pdf-package` script that checks the published package
  ships the PDF entry points, styles, worker asset, and matching `exports`.
- Added GitHub sponsor metadata (`.github/FUNDING.yml`) and README
  documentation for PDF host integration.

### Changed

- Changed the JSON raw-text tools (escape, unescape, Base64 encode/decode)
  to replace the editor content directly — chaining through the editor —
  instead of opening a review panel; failures surface as status messages.
- Changed PDF page navigation to use display positions after reordering or
  deleting pages: the page input, placeholders, and thumbnail labels now
  show the visible position rather than the original page number.
- Changed drawn PDF signatures to keep their drawn aspect ratio (contained
  within the stamp box) instead of being stretched to a fixed 120×60 size.
- Changed the PDF merge button to only require a file-pick service plus any
  merge-capable processing path, instead of the full editing dependency.
- Updated GitHub Actions to `actions/checkout@v6`, `actions/setup-node@v6`,
  `actions/upload-artifact@v7`, and `softprops/action-gh-release@v3`.

### Fixed

- Fixed opening a saved PDF whose embedded sidecar base is corrupt: the
  viewer now logs a warning and falls back to the flattened document
  instead of failing to open the file.
- Fixed PDF worker-asset load failures crashing the mount; the viewer now
  reports a localized error status and returns a stable handle.
- Fixed pdf.js resource cleanup: failed loading tasks are destroyed,
  in-flight thumbnail renders are cancelled on layout rebuilds, the
  password prompt is dismissed on abort, and the previous document is
  destroyed only after a merge succeeds.
- Fixed YAML merge-key (`<<`) entries being parsed as a literal `Symbol()`
  key by the self-loading normalizer.

## [0.4.0] - 2026-07-19

### Added

- Exported `parsePptxLegacy` from the PPTX parser entry point so hosts can run
  the lightweight extractor directly instead of going through `parsePptx`.

### Fixed

- Fixed the built-in legacy PPTX extractor never running for hosts that do not
  inject their own `parseLegacyPptx`. The recovery path called `parsePptx`,
  which retries the full-fidelity parser first — that parser had already
  succeeded with an element-less deck, so the legacy extractor was unreachable
  and such presentations always fell through to PDF conversion. The path now
  calls `parsePptxLegacy` directly, and passes the host's own ZIP reader when
  one is provided.
- Fixed the PowerPoint toolbar ordering the zoom controls as `−` `+` `100%`,
  which separated the two zoom buttons from each other; the reset button now
  sits between them as `−` `100%` `+`.
- Fixed the archive viewer jumping back to the top of the entry list while
  scrolling. The virtualized list emptied the table body before measuring the
  viewport, so the layout flush collapsed the scroll height and the browser
  clamped the scroll offset to zero. The rows are now measured before any DOM
  write and swapped in a single update.
- Fixed the archive viewer scrolling back to the top when an entry further down
  the list was selected. Selecting an entry rebuilt every visible row, including
  the one being clicked; selection now patches the existing rows in place, and
  the scroll offset is restored whenever the rows genuinely have to be redrawn.
- Fixed the archive viewer losing keyboard focus while scrolling. Recycled rows
  now hand focus to their replacement, and scroll ticks that stay inside the
  overscan margin no longer rebuild the rows at all.

## [0.3.0] - 2026-07-19

### Changed

- **PDF saved-file format (sidecar v2, breaking).** Saved PDFs now embed only
  the kept pages as the re-editable base — deleted pages are no longer
  recoverable from the attachment — and drawn signatures are permanently
  flattened into that base instead of staying editable on reopen. Text and
  markup overlays remain removable via the layer JSON, with page references
  remapped onto the kept-page base. Files saved by the previous v1 format are
  no longer rehydrated for re-editing (they still open as flattened PDFs).
- Changed the main PPTX parser to prefer the full-fidelity parser for real
  presentation archives, while retaining the legacy parser as an invalid-file
  fallback for custom host adapters.
- Improved PowerPoint rendering fidelity for line-chart bounds and axes, plot
  borders, point and connector markers, table frames, chart placeholders, and
  slide and text styling.
- Changed tag-triggered GitHub Releases to use the matching version section
  from this changelog as the release body.

### Fixed

- Fixed npm trusted publishing with npm 12 by allowing the package's pinned,
  root-level SheetJS remote dependency during clean installation.

## [0.2.0] - 2026-07-19

### Added

- Added core message catalogs for Japanese, French, German, Italian, Thai,
  Simplified Chinese, and Traditional Chinese, and completed Korean catalog
  coverage.
- Added locale normalization for hyphen and underscore separators, including
  script- and region-aware Simplified/Traditional Chinese selection.
- Added lazy, path-based archive opening so host adapters can inspect large
  archives without loading the entire file into memory.
- Added bounded image, audio, and video previews for archive entries.
- Added adapter-driven streaming saves for archive entries, with buffered save
  support retained as a fallback.
- Added tag-triggered GitHub Release packaging with generated release notes and
  npm tarball artifacts.
- Added npm trusted publishing through GitHub Actions and OIDC, without a
  long-lived npm token.

### Changed

- Improved PowerPoint rendering for chart labels, overflowing text, bullets,
  vector-image fallbacks, and connector arrowheads.
- Relaxed the optional `puml-canvas-js` peer dependency from `0.5.0` to
  `>=0.2.0` for broader host compatibility.

### Security

- Kept archive streaming and previews within entry-count, decompressed-size,
  preview-size, and cumulative extraction limits.

## [0.1.0] - 2026-07-18

### Added

- Published the initial framework-agnostic parsing and rendering core for VS
  Code, browser extensions, Obsidian, and web applications.
- Added typed parsers and mountable viewers for documents, spreadsheets and
  structured data, media, engineering and automotive formats, diagrams, GIS,
  and archives.
- Added subpath exports for parsers, viewers, host adapters, the viewer
  registry, localization catalogs, shared styles, and bundled assets.
- Added host-injected services for file access, saving, printing, asset URLs,
  localization, and optional heavyweight format dependencies.
- Added format detection and probing through the central viewer registry.
- Added editable CSV/TSV viewing with sorting, statistics, cell and header
  editing, row and column insertion/deletion, raw-document replacement, and
  undo/redo support.
- Added Shapefile DBF attribute inspection, feature selection, pan and zoom,
  and optional PRJ reprojection through `proj4`.
- Added spreadsheet parsing and serialization, including UTC-based Excel date
  round-tripping with `xlsx` 0.20.2 or later.
- Added English and Korean core message catalogs.
- Added an embedded WebAssembly audio engine for waveform and spectrogram
  analysis.
- Added package documentation, security policy, MIT license, and third-party
  notices.
- Added npm package metadata and a pre-publish hook that rebuilds the package
  and runs the test suite before publication.

### Security

- Added typed parse outcomes, diagnostics, abort handling, and configurable
  limits for untrusted input.
- Added ZIP preflight scanning and declared decompressed-size checks for archive,
  Excel, DOCX, and embedded-object paths to reduce zip-bomb risk.
- Added input, row, cell, entry, vertex, and preview limits across supported
  parsers and viewers.
