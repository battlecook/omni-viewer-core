# Third-Party Notices

This distribution includes the following third-party software.

## Three.js (optional peer)

- Project: Three.js (`three`)
- Copyright: 2010-2025 three.js authors
- License: MIT
- Use: 3D mesh rendering, GLB/glTF/STL/OBJ loaders and orbit controls
- Source: https://github.com/mrdoob/three.js

Three.js is supplied by the consuming host; the core does not redistribute its
runtime. Retain the upstream MIT license when bundling it in an application.

## Hugging Face GGUF parser

- Project: `@huggingface/gguf` and `@huggingface/tasks`
- Copyright: Hugging Face and contributors
- License: MIT
- Use: GGUF metadata and tensor-index parsing
- Source: https://github.com/huggingface/huggingface.js

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

## JUnit example reports

`examples/junit/jenkins-nested-testsuites.xml` and
`examples/junit/jenkins-suite-error.xml` are unmodified test fixtures from the
Jenkins JUnit plugin, used for examples and tests and never published to the
npm package.

- Project: jenkinsci/junit-plugin (commit `04461ad56caf19b05bc16015f23675883df83d43`)
- Copyright: (c) 2004-2009, Sun Microsystems, Inc., Kohsuke Kawaguchi
- License: MIT
- Source: https://github.com/jenkinsci/junit-plugin/tree/04461ad56caf19b05bc16015f23675883df83d43/src/test/resources/hudson/tasks/junit
