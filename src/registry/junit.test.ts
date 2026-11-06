import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JUNIT_VIEWER_META } from '../viewers/junit/index.js';
import { CORE_VIEWER_DESCRIPTORS, JUNIT_VIEWER_DESCRIPTOR, detectViewer, looksLikeJUnit, sniffTextViewer } from './index.js';

const sample = (name: string): string => readFileSync(new URL(`../../examples/junit/${name}`, import.meta.url), 'utf8');
const detect = (name: string, text?: string, descriptors = CORE_VIEWER_DESCRIPTORS) =>
    detectViewer(name, undefined, descriptors, undefined, text);

describe('JUnit content routing', () => {
    it('registers a content-only viewer with matching metadata', () => {
        expect(JUNIT_VIEWER_META).toMatchObject(JUNIT_VIEWER_DESCRIPTOR);
        expect(JUNIT_VIEWER_DESCRIPTOR.extensions).toEqual([]);
        expect(CORE_VIEWER_DESCRIPTORS.filter(d => d.id === 'junit')).toHaveLength(1);
        expect(looksLikeJUnit('<testsuites/>')).toBe(true);
    });

    it.each(['TEST-demo.CalcTest.xml', 'junit.xml', 'REPORT.XML', 'extensionless'])('routes a report by content: %s', name => {
        expect(detect(name, sample('gradle-junit5.xml'))).toEqual({ viewerId: 'junit', matchedBy: 'content' });
        expect(detect(name, sample('pytest-xunit2.xml')).viewerId).toBe('junit');
    });

    it('keeps the generic XML viewer without content, for other XML, and for other XML extensions', () => {
        expect(detect('TEST-demo.CalcTest.xml').viewerId).toBe('xml');
        expect(detect('pom.xml', '<project><modelVersion>4.0.0</modelVersion></project>').viewerId).toBe('xml');
        // NUnit 3 results (Unity Test Framework writes these) are not JUnit.
        expect(detect('results.xml', '<?xml version="1.0"?><test-run id="2"><test-suite type="TestSuite"/></test-run>').viewerId).toBe('xml');
        // A dialect with its own extension keeps it.
        expect(detect('report.xsd', sample('vitest.xml')).viewerId).toBe('xml');
        expect(detect('ecu.arxml', sample('vitest.xml')).viewerId).toBe('arxml');
    });

    it('routes a report whose DOCTYPE has an internal subset', () => {
        const text = '<?xml version="1.0"?>\n<!DOCTYPE testsuites [\n  <!ENTITY host "ci-01">\n]>\n<testsuites><testsuite name="s" tests="1" hostname="&host;"><testcase name="a"/></testsuite></testsuites>';
        expect(detect('TEST-x.xml', text).viewerId).toBe('junit');
        expect(sniffTextViewer(text)).toBe('junit');
    });

    it('sniffs extensionless reports ahead of the generic XML tree', () => {
        expect(sniffTextViewer(sample('jenkins-suite-error.xml'))).toBe('junit');
        expect(sniffTextViewer('<?xml version="1.0"?><config/>')).toBe('xml');
    });

    it('falls back to generic XML when the JUnit descriptor is disabled', () => {
        const withoutJUnit = CORE_VIEWER_DESCRIPTORS.filter(d => d.id !== 'junit');
        expect(detect('report.xml', sample('vitest.xml'), withoutJUnit).viewerId).toBe('xml');
        expect(detect('report', sample('vitest.xml'), withoutJUnit)).toEqual({ viewerId: 'xml', matchedBy: 'content' });
    });

    it('leaves an OpenVINO IR to its own viewer', () => {
        expect(detect('model.xml', '<?xml version="1.0"?><net name="m" version="11"><layers/></net>').viewerId).toBe('openvino');
    });
});
