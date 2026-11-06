# JUnit XML examples

Every sample is real writer output, not a hand-written fixture:

| File | Writer | Shows |
|---|---|---|
| `gradle-junit5.xml` | Gradle 8 `test` task, JUnit Jupiter 5.10 | assumption aborts and `@Disabled` as skipped, parameterized names, an unexpected exception filed as a failure, suite-level CDATA output |
| `pytest-xunit2.xml` | pytest 9 `--junitxml`, `junit_logging=all` | `<testsuites>` root, setup error, xfail as skipped, captured output per case (twice on a skipped case) |
| `pytest-xunit1.xml` | pytest 9, `junit_family=xunit1` | `file`/`line` attributes on each case |
| `pytest-teardown-error.xml` | pytest 9 `--junitxml` | a call failure plus teardown error written as two records of one test; a teardown-only error |
| `pytest-xdist-teardown.xml` | pytest 9 + pytest-xdist 3.8, `-n 2` | a teardown-error record written after another worker's record |
| `pytest-xdist-each.xml` | pytest 9 + pytest-xdist 3.8, `-n 2 --dist each` | every test recorded once per worker, teardown errors per run |
| `pytest-xdist-each-pass.xml` | pytest 9 + pytest-xdist, `-n 2 --dist each` | one worker passes, the other passes its call and errors on teardown (one record) |
| `pytest-junitparser-merged.xml` | two pytest 9 xunit1 reports merged with `junitparser merge` 5.0.3 | unnamed root, several `<testsuite name="pytest">`, 0-based `line` |
| `pytest-merged-suite-name.xml` | two pytest 9 xunit1 reports with `junit_suite_name=myproj`, merged with `junitparser merge` | renamed suites under an unnamed root; recognized by shape |
| `pytest-merged-collection-error.xml` | two renamed pytest 9 shards merged with `junitparser merge`, one only a collection error | a shard with no `line` at all; paths anonymized |
| `pytest7-xunit1.xml` | pytest 7.4 `--junitxml`, `junit_family=xunit1` | unnamed `<testsuites>` around `<testsuite name="pytest">`, 0-based `line` |
| `pytest7-suite-name.xml` | pytest 7.4, `junit_family=xunit1`, `junit_suite_name=myproj` | no pytest name anywhere; 0-based `line` recognized by shape |
| `pytest7-module-skip.xml` | pytest 7.4, `junit_suite_name=myproj`, an `importorskip` module | a line-less collection-skip case written first |
| `vitest.xml` | vitest 4 `--reporter=junit` | `describe` chains in names, uncaught throws as failures, `it.todo` as skipped |
| `jenkins-nested-testsuites.xml` | Jenkins JUnit plugin fixture | nested suites, a suite-level `<error>`, a root that declares `tests="186"` for 3 cases |
| `jenkins-suite-error.xml` | Jenkins JUnit plugin fixture | declared totals that disagree with the file |

The Gradle, pytest and vitest files were generated on 2026-10-30 (pytest 7 in a scratch venv); the machine
hostname was replaced with `build-host.local` and pytest's absolute test path
with a relative one. The Jenkins files are byte-identical to the upstream
fixtures (MIT, see `THIRD_PARTY_NOTICES.md`).

Build the core and serve the repository root:

```sh
npm run build
python3 -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/examples/junit/` and pick a sample or a local
`.xml` file. The page routes by content with `detectViewer`: JUnit reports open
in the JUnit viewer and any other XML in the generic XML viewer. Everything is
loaded from this repository; no CDN is used.

See the [viewer contract](../../docs/viewers/junit.md) for the model, limits and
detection rules.
