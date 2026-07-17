# Third-Party Notices

This distribution includes the following third-party software.

## PDF.js

- Project: PDF.js (`pdfjs-dist`)
- Copyright: Mozilla Foundation and PDF.js contributors
- License: Apache License 2.0
- Included artifact: `dist/assets/pdfjs/pdf.worker.min.mjs`
- Source: https://github.com/mozilla/pdf.js

The complete Apache License 2.0 text is distributed at
`dist/licenses/pdfjs-dist.txt`. The upstream license notice embedded in the
worker file is retained without modification.

## Audio engine

The WebAssembly audio engine under `assets/audio-engine/` is built from the
sources under `native/audio-engine/` and includes the following software:

- KISS FFT, copyright (c) 2003-2010 Mark Borgerding, BSD 3-Clause. The license
  text is distributed at `native/audio-engine/lib/COPYING.kissfft` and copied
  to `dist/licenses/kissfft.txt` by the package build.
- dr_wav, dr_mp3, and dr_flac by David Reid, used under the MIT No Attribution
  (MIT-0) option. The complete upstream license statements remain embedded in
  the corresponding source headers.
- stb_vorbis, copyright (c) 2017 Sean Barrett, used under the MIT license
  option. The complete upstream license statement remains embedded in
  `native/audio-engine/lib/stb_vorbis.c`.
- Emscripten runtime, copyright the Emscripten authors, MIT license. The
  generated `audio_engine.mjs` embeds Emscripten's JavaScript runtime
  support code, produced by emsdk 6.0.3 (the version `build.sh` pins).
  The complete license text from that release is distributed at
  `native/audio-engine/COPYING.emscripten` and copied to
  `dist/licenses/emscripten.txt` by the package build.
  Source: https://github.com/emscripten-core/emscripten/blob/6.0.3/LICENSE

## HWP test fixtures

The HWP/HWPX regression fixtures under `src/viewers/hwp/fixtures/`
(`text-align.hwp.b64`, `nested-table.hwpx.b64`) are sample documents from the
rhwp project, used only for tests and never published to the npm package.

- Project: rhwp
- Copyright: (c) 2025-2026 Edward Kim
- License: MIT
- Source: https://github.com/edwardkim/rhwp (`rhwp-studio/public/samples/`,
  `samples/valign_fixtures/`)
