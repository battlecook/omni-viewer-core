# DICOM

`parsers/dicom` exports `parseDicom`, `hasDicomPreamble`, `decodeDicomFrame`,
`renderDicomFrame`, and typed document/frame/element models. `viewers/dicom`
exports `mountDicomViewer`, `DICOM_VIEWER_META`, and `dicomViewerCss`.
Scoped mounts require `omni-viewer-core/styles/dicom.css`; shadow mounts inject
styles automatically. No additional dependencies or host services are required.

```ts
import { mountDicomViewer } from 'omni-viewer-core/viewers/dicom';
const handle = await mountDicomViewer({ fileName: 'scan.dcm', data }, container, ctx);
// On tab close / file change:
handle.dispose();
```

Detection accepts `.dcm` and `.dicom` case-insensitively, including raw datasets
without a Part 10 preamble. Extensionless Part 10 files are recognized by `DICM`
at offset 128. Adapters should use `REQUIRED_SNIFF_BYTES` and explicitly register
the `dicom` mount, following the registry's existing import-map contract.

Supported native transfer syntaxes are Implicit VR Little Endian
(`1.2.840.10008.1.2`), Explicit VR Little Endian (`.1`), and retired Explicit VR
Big Endian (`.2`). Raw datasets default to little endian, inferring explicit VR
from the first header; pass `transferSyntaxUid` for raw big-endian datasets.
Defined/undefined-length sequences and items are traversed, including implicit
private sequences when item headers identify them. Undefined-length UN values
use implicit little endian regardless of the surrounding syntax. Character
sets are inherited and restored at each sequence item boundary. Nested attributes appear in
the tag table but cannot override top-level image metadata.

The preview supports 8/16-bit signed and unsigned MONOCHROME1/2 pixels,
Bits Stored / High Bit extraction, rescale slope/intercept, pixel padding-aware
auto-windowing, double-precision rescaled samples, LINEAR / LINEAR_EXACT /
SIGMOID VOI functions, 8-bit RGB and
YBR_FULL with interleaved or planar samples, non-square pixel spacing, and
multi-frame navigation. Only the current frame is decoded and retained. The
controls offer window center/width, inversion, zoom and reset. The searchable
metadata table renders 100 attributes per page and never interprets file text
as markup. Common attribute names follow the standard's English names; UI
messages are localized in English, Korean, Japanese, Simplified Chinese and
Traditional Chinese, with the normal English fallback for other catalogs.

Compressed pixel syntaxes (JPEG, JPEG-LS, JPEG 2000, RLE, etc.) preserve metadata
but do not render images. Deflated/unknown dataset syntaxes show file metadata
only. No codec hook is currently exposed. Float pixels, packed 1-bit images,
PALETTE COLOR / subsampled YBR, modality LUTs and enhanced functional-group
transformations do not render. VOI LUTs use windowing with an explicit notice.
Unsupported character sets display a notice; UTF-8, Latin-1, Korean EUC-KR,
GBK and GB18030 are decoded. ISO 2022 switching is not implemented. This is an
image preview, with no series assembly, volume rendering or measurement tools.

Default limits are 256 MiB input, 50,000 elements/items/fragments, sequence
nesting depth 32, 16,777,216 pixels per frame and 100,000 frames. All limits can
be lowered with mount/parser options. Display values are capped at 1,024 bytes;
large binary values are not expanded. Invalid lengths, duplicate top-level
attributes, malformed delimiters, nonfinite numeric attributes and native
pixel-length mismatches are rejected. Parsing borrows input bytes; callers must
keep them valid until the viewer is disposed. Disposal removes listeners,
releases canvas storage and removes only the viewer's own nodes/styles.

See [the synthetic example](README.md). Encoding and
windowing follow [DICOM PS3.5](https://dicom.nema.org/medical/dicom/current/output/chtml/part05/chapter_A.html),
[PS3.10](https://dicom.nema.org/medical/dicom/current/output/chtml/part10/chapter_7.html)
and [PS3.3 C.11.2](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.11.2.html).
