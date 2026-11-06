"""Independent decode of examples/junit/*.xml with Python's ElementTree.

junit.test.ts compares every parsed case against golden.json, so the parser is
checked against a reader that shares none of its code. Regenerate after adding
a sample:  python3 -I src/parsers/junit/__tests__/golden.py
"""
import json, os, xml.etree.ElementTree as ET

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..')
SAMPLES = os.path.join(ROOT, 'examples', 'junit')
RESULTS = ('failure', 'error', 'skipped', 'flakyFailure', 'flakyError', 'rerunFailure', 'rerunError')

def trim_block(text):
    # Leading whitespace through its last newline, and all trailing whitespace.
    i, start = 0, 0
    while i < len(text) and text[i].isspace():
        if text[i] == '\n': start = i + 1
        i += 1
    return text[start:].rstrip()

def output(elements, tag):
    return '\n'.join(b for b in (''.join(e.itertext()) for e in elements if e.tag == tag) if b.strip())

def status(kinds):
    if 'error' in kinds: return 'error'
    if 'failure' in kinds: return 'failed'
    if 'skipped' in kinds: return 'skipped'
    return 'passed'

def result(r):
    return {'kind': r.tag, 'message': r.get('message', ''), 'type': r.get('type', ''), 'text': trim_block(''.join(r.itertext()))}

latest = {}
ZERO_BASED = False  # pytest writes 0-based `line`; the model is 1-based
PYTEST = False

def is_teardown(r):
    return r['kind'] == 'error' and r['message'].startswith('failed on teardown with ')

def walk(suite, cases):
    synthetic = None  # placed where the first suite-level result stands
    for child in suite:
        if child.tag == 'testcase':
            results = [result(r) for r in child if r.tag in RESULTS]
            # Under pytest-xdist other records land in between, and `--dist each`
            # runs every test on every worker: the target is the test's latest
            # record in this suite that has no teardown error yet.
            key = (id(suite), child.get('classname', ''), child.get('name', ''))
            # pytest splits only a failed call from its teardown error.
            prev = next((c for c in reversed(latest.get(key, []))
                         if any(r['kind'] == 'failure' for r in c['results']) and not any(is_teardown(r) for r in c['results'])), None)
            # pytest writes a call failure plus teardown error as two records of
            # one test; the second (errors only, pytest's own wording) folds in.
            if (prev is not None
                    and results and all(r['kind'] == 'error' for r in results)
                    and any(is_teardown(r) for r in results)):
                prev['results'].extend(results)
                prev['systemOut'] = '\n'.join(x for x in (prev['systemOut'], output(child, 'system-out')) if x)
                prev['systemErr'] = '\n'.join(x for x in (prev['systemErr'], output(child, 'system-err')) if x)
                t = child.get('time')
                if t:
                    prev['time'] = (prev['time'] or 0) + float(t)
                prev['status'] = status([r['kind'] for r in prev['results']])
                continue
            line = child.get('line', '')
            t = child.get('time')
            cases.append({
                'name': child.get('name', ''), 'classname': child.get('classname', ''),
                'file': child.get('file', ''), 'line': int(line) + (1 if ZERO_BASED else 0) if line.isdigit() else None,
                'time': float(t) if t else None, 'status': status([r['kind'] for r in results]),
                'synthetic': False, 'results': results,
                'systemOut': output(child, 'system-out'), 'systemErr': output(child, 'system-err'),
                '_suite': suite,
            })
            latest.setdefault(key, []).append(cases[-1])
        elif child.tag == 'testsuite':
            walk(child, cases)
        elif child.tag in ('failure', 'error'):
            if synthetic is None:
                synthetic = {
                    'name': suite.get('name', ''), 'classname': suite.get('package') or suite.get('name', ''),
                    'file': suite.get('file', ''), 'line': None, 'time': None,
                    'status': None, 'synthetic': True, 'results': [],
                    'systemOut': '', 'systemErr': '',
                }
                cases.append(synthetic)
            synthetic['results'].append(result(child))
    if synthetic is not None:
        synthetic['status'] = status([r['kind'] for r in synthetic['results']])

golden = {}
for name in sorted(os.listdir(SAMPLES)):
    if not name.endswith('.xml'): continue
    cases = []
    root = ET.parse(os.path.join(SAMPLES, name)).getroot()
    # pytest 8+ names the root; 5.1-7 is recognized by shape (see looksLikePytest7).
    kids = list(root)
    def first_lined(k):
        return next((c for c in k.iter('testcase') if c.get('line') is not None), None)
    def pytest_suite(k):
        # A shard without any lined case is neutral; one with must look like pytest.
        case = first_lined(k)
        return (k.get('hostname') is not None and k.get('timestamp') is not None
                and (case is None or (case.get('file') is not None and case.get('assertions') is None and case.get('status') is None)))
    suites_only = (root.tag == 'testsuites' and root.get('name') is None and len(kids) > 0
                   and all(k.tag == 'testsuite' for k in kids))
    shape = suites_only and (all(k.get('name') == 'pytest' for k in kids)
                             or (all(pytest_suite(k) for k in kids) and any(first_lined(k) is not None for k in kids)))
    ZERO_BASED = PYTEST = root.get('name') in ('pytest tests', 'pytest') or shape
    walk(root, cases)
    for case in cases:
        case.pop('_suite', None)
    golden[name] = cases
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'golden.json'), 'w', encoding='utf-8') as f:
    json.dump(golden, f, ensure_ascii=False, indent=1)
    f.write('\n')
