import { describe, expect, it } from 'vitest';
import { XML_VIEWER_META } from '../viewers/xml/index.js';
import { CORE_VIEWER_DESCRIPTORS, detectViewer, looksLikeXml, sniffTextViewer } from './index.js';

const sniff = (name: string, text: string) => detectViewer(name, undefined, undefined, undefined, text);

describe('detectViewer (generic XML)', () => {
    it('keeps the registry descriptor aligned with the viewer metadata', () => {
        const descriptor = CORE_VIEWER_DESCRIPTORS.find((d) => d.id === 'xml');
        expect(descriptor).toBeDefined();
        expect(descriptor?.displayNameKey).toBe(XML_VIEWER_META.displayNameKey);
        expect(descriptor?.extensions).toEqual(XML_VIEWER_META.extensions);
        expect(descriptor?.priority).toBe(XML_VIEWER_META.priority);
        expect(descriptor?.requiredServices).toEqual(XML_VIEWER_META.requiredServices);
        expect(descriptor?.optionalServices).toEqual(XML_VIEWER_META.optionalServices);
    });

    it('routes every XML extension, in any case', () => {
        for (const ext of XML_VIEWER_META.extensions) {
            expect(detectViewer(`file.${ext}`).viewerId, ext).toBe('xml');
            expect(detectViewer(`FILE.${ext.toUpperCase()}`).viewerId, ext).toBe('xml');
        }
    });

    it('leaves dialects with their own extension, SVG, and HTML to their viewers', () => {
        expect(detectViewer('ecu.arxml').viewerId).toBe('arxml');
        expect(detectViewer('spec.reqif').viewerId).toBe('reqif');
        expect(detectViewer('icon.svg').viewerId).toBe('image');
        expect(detectViewer('page.html').viewerId).toBe('fallback');
    });

    it('claims extensionless XML by content, after OpenVINO and the JSON family', () => {
        expect(sniff('data', '﻿<?xml version="1.0"?>\n<config><a/></config>')).toEqual({ viewerId: 'xml', matchedBy: 'content' });
        expect(sniff('data', '<!-- generated -->\n<?pi x?>\n<!DOCTYPE r [\n<!ENTITY e "x>y">\n]>\n<r/>').viewerId).toBe('xml');
        expect(sniff('data', '<project xmlns="urn:x"><a/></project>').viewerId).toBe('xml');
        expect(sniffTextViewer('{"a":1}')).toBe('json');
    });

    it('claims a declared document whose sample ends before the root, and non-ASCII roots', () => {
        const licence = `<?xml version="1.0" encoding="UTF-8"?>\n<!--\n${'  Licensed to the Apache Software Foundation (ASF).\n'.repeat(30)}-->\n<project/>`;
        expect(looksLikeXml(licence)).toBe(true);
        expect(sniff('pom', licence.slice(0, 1024)).viewerId).toBe('xml');
        expect(looksLikeXml('<?xml version="1.0"?>\n<proj')).toBe(true);
        expect(looksLikeXml('<?xml version="1.0"?><設定/>')).toBe(true);
        expect(looksLikeXml('<設定><値>1</値></設定>')).toBe(true);
        // Without a declaration an unfinished prolog proves nothing.
        expect(looksLikeXml('<!-- just a comment that never')).toBe(false);
        // A declaration followed by plain text is not a cut-off root.
        expect(looksLikeXml('<?xml version="1.0"?>\nhello')).toBe(false);
    });

    it('does not claim HTML or text that only contains angle brackets', () => {
        expect(looksLikeXml('<!DOCTYPE html>\n<html><body/></html>')).toBe(false);
        expect(looksLikeXml('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"/>')).toBe(false);
        expect(looksLikeXml('<HTML><BODY></BODY></HTML>')).toBe(false);
        expect(looksLikeXml('a < b and <c>')).toBe(false);
        expect(looksLikeXml('<!-- unterminated')).toBe(false);
        expect(looksLikeXml('<3 hearts')).toBe(false);
        expect(sniff('notes', 'plain text').viewerId).toBe('fallback');
    });
});
