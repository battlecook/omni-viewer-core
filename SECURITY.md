# Security Policy

## Reporting a vulnerability

Please report vulnerabilities through
[GitHub private vulnerability reporting](../../security/advisories/new)
(Security tab → "Report a vulnerability" on this repository). Do not open a
public issue for security reports.

You can expect an acknowledgement within a week. Please include a minimal
reproducing file when the issue is input-triggered.

## Supported versions

Only the latest published 0.x release receives security fixes.

## Threat model

omni-viewer-core parses and renders **untrusted files**. The design
assumptions:

- Parsers never execute content: no `eval`, no script injection from file
  contents. Rendered output is sanitized before it reaches the DOM, and
  `script`/`iframe`/`object`/`embed` nodes are stripped everywhere. The exact
  mechanism varies by viewer: the Markdown viewer runs its HTML through
  **DOMPurify** with tag/attribute allowlists; the Mermaid, PlantUML, and HWP
  viewers pass rendered SVG through a dedicated sanitizer that also removes
  event-handler attributes and `javascript:`/external-resource references; the
  Word viewer strips active and embedded content, neutralizes document
  hyperlinks, and blocks remote media. Sanitization coverage differs between
  these paths — it is not a single shared DOMPurify pass.
- Parsers return typed failures instead of throwing on malformed input, and
  enforce resource limits: input size caps, cell/row/entry count caps, and a
  declared-size pre-scan of ZIP central directories before anything is
  inflated.

### Known limits of the guarantees

- The ZIP pre-scan checks the sizes the archive *declares*. Libraries with
  their own inflaters (SheetJS, JSZip, docx-preview) are not bounded
  mid-inflate, so an archive that lies in its headers can still expand
  beyond the cap. Embedders opening fully untrusted input should run
  parsers in a Worker they can terminate.
- Excel paths require `xlsx` >= 0.20.2 (SheetJS CDN build); the npm
  registry's 0.18.5 has known vulnerabilities and is outside the supported
  peer range.
