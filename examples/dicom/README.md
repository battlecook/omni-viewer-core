# DICOM example

Run `npm run build` in the repository root, serve the repository with a local
HTTP server (for example `python3 -m http.server 8080`), then open
`http://localhost:8080/examples/dicom/`.

`synthetic-phantom.dcm` contains three 128 × 128 signed, 16-bit frames with a
CT-style window. Every pixel and identifier is synthetic; it contains no real
patient information. Regenerate it with `node tools/generate_dicom_samples.mjs`.
This is a minimal demonstration dataset, not a clinical acquisition or a complete
CT IOD conformance fixture.

The example can also open local `.dcm`/`.dicom` files without uploading them.

See [supported encodings, API and limits](SUPPORT.md).
