# EML email samples

Run `npm run build` and serve the repository root with any static HTTP server.
Open `examples/eml/` to choose either bundled sample or a local `.eml` file.
Parsing and rendering happen locally; the demo does not upload mail.

- `plain.eml`: UTF-8 plain text with encoded Korean sender and subject.
- `multipart.eml`: mixed/alternative/related MIME nesting, HTML and text,
  inline PNG, and an attachment with an extended UTF-8 filename.

The demo provides save and clipboard host services where the browser supports
them. The library itself needs no MIME or HTML rendering peer dependency.
