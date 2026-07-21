# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
