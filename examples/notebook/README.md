# Jupyter Notebook viewer

The viewer reads the [nbformat 4 specification](https://nbformat.readthedocs.io/en/latest/format_description.html).
It displays saved content; it does not start a kernel, execute code, edit cells,
or run embedded JavaScript/widgets. Notebook versions 4.0 through 4.x are
accepted. Earlier major versions return a localized unsupported-version error.

## Public API

- `parsers/notebook`: `parseNotebook`, typed models, limits, MIME priority, and
  `NOTEBOOK_INPUT_OWNERSHIP` (`borrows`). Input may be UTF-8 bytes or text.
- `viewers/notebook`: `mountNotebookViewer`, `NotebookViewerDeps`,
  `NotebookViewerContext`, `NotebookMountOptions`, `NOTEBOOK_VIEWER_META`,
  and `notebookViewerCss`.
- `viewers/notebook/self-loading`: `loadNotebookViewerDeps()`.
- `styles/notebook.css`: static stylesheet for scoped mounts.
- `registry`: `NOTEBOOK_VIEWER_DESCRIPTOR` and `looksLikeNotebook`.

`mountNotebookViewer(input, container, context, dependencies, options)` returns
the standard disposable `ViewerHandle`. Shadow DOM is the default; scoped mode
requires the adapter to load the static stylesheet. The viewer reuses
`--omni-*` theme tokens and Markdown prose, table, math, and syntax colors.

Required renderer dependencies are the same `render` and `createDOMPurify`
interfaces as Markdown. `highlighter` and `math` are optional. The loader
imports `marked` and `dompurify`, then attempts `highlight.js` and `katex`.
It does not load diagram engines. KaTeX CSS/fonts remain an adapter asset.

## Cells and outputs

Cells retain file order and their original index. Sources and multiline MIME
values accept strings or arrays of strings joined with no extra separator.
Traceback frames join with newlines. ANSI CSI/OSC sequences are removed from
displayed terminal output; the parser retains the original text.

| Content | Display |
| --- | --- |
| Markdown | Sanitized prose, tables, fenced code, `$…$`/`$$…$$` math, attachments |
| Code | Highlighted source, `In [count]`, independently expandable outputs |
| Raw / future cell types | Inert source text; unknown types produce a warning |
| `stream` | Preserved whitespace; stderr has a warning color |
| `error` | Error name/value and traceback, visibly marked as an error |
| `display_data`, `execute_result` | One static MIME representation; results show `Out [count]` |

MIME priority is HTML, SVG, PNG, JPEG, GIF, WebP, Markdown, LaTeX, JSON, then
plain text. Unsupported custom representations use saved plain text when
available. Truncated rich representations are never interpreted as markup or
images; a smaller usable representation is selected, or a notice and truncated
plain text appear. JSON outputs retain their source numeric tokens and duplicate
keys. PNG/JPEG/GIF/WebP payloads are base64; SVG uses the existing diagram
sanitizer and an isolated SVG image. Image width/height metadata is honored.

The toolbar searches rendered text, code, and text outputs case-insensitively.
It can hide code or outputs globally. Individual `<details>` sections honor
`metadata.jupyter.source_hidden`, `metadata.jupyter.outputs_hidden`, and
`metadata.collapsed` initially, and remain keyboard accessible.

## Host services and resource handling

Only the usual assets/i18n/logger context is required. `navigation` and
`documentAssets` are optional:

- Allowed external links go through `NavigationService`; without it links are
  disabled. Fragment links navigate within the notebook, including across cells.
- Relative images go through `DocumentAssetsService`; traversal and absolute
  paths are blocked. Resolved assets are released when the viewer is disposed,
  including resolutions that finish after disposal.
- Markdown cell `attachment:` images and embedded raster data URLs work without
  asset services. The parser uses a prototype-free attachment dictionary.
  Repeated attachment references use short sanitizer tokens and a shared image
  URL. Generated blob URLs are released on disposal; older hosts use data URLs.
- Saved HTML and Markdown use the same DOMPurify policy as Markdown. Active
  content is stripped and remote media is removed before insertion into the
  live DOM. SVG uses the existing diagram sanitizer. Notebook CSS and SVG ids
  do not enter the host's scope under default shadow isolation.

## Limits and failures

The parser returns input-caused failures instead of throwing. Invalid JSON,
invalid top-level structure, unsupported major versions, and cancellation are
typed failures. Malformed individual cells are skipped with a diagnostic;
unknown cell types remain readable as source. Limit or field recovery returns
`partial` and the viewer displays the diagnostics.

| Option | Default |
| --- | --- |
| `limits.maxInputBytes` | 64 MiB |
| `limits.maxEntries` (cells) | 2,000 |
| `maxOutputs` (all cells) | 10,000 |
| `limits.maxPreviewBytes` (one field/representation) | 4 MiB |
| `maxTotalPreviewBytes` | 16 MiB |
| `limits.maxParseMillis` | 30 seconds, cooperative |

The core JSON parser retains its independent 1,000,000-node and default depth
limits. Cell/output limits do not lower its node budget. Preview budgets count
UTF-8 bytes, including attachments and alternate MIME representations. Strings
are capped without splitting surrogate pairs. Attachment bundles are capped at
100 per cell. Image dimensions above 16,384 are ignored. Parsing and rendering
are synchronous; large-input hard deadlines require a host-managed Worker.

The sample [analysis.ipynb](analysis.ipynb) covers Markdown/math,
attachments, code, streams, a saved table/chart, JSON, raw text, and an error.
