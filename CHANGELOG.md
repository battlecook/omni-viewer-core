# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
