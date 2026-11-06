import { describe, expect, it } from 'vitest';
import { EML_VIEWER_META } from '../viewers/eml/index.js';
import { CORE_VIEWER_DESCRIPTORS, EML_VIEWER_DESCRIPTOR, detectViewer, looksLikeEml } from './index.js';

const mail = 'From: sender@example.com\r\nTo: reader@example.com\r\nSubject: Test\r\n\r\nHello';
describe('EML detection', () => {
    it.each(['message.eml', 'MESSAGE.EML'])('detects %s without optional services', name => {
        expect(detectViewer(name)).toEqual({ viewerId: 'eml', matchedBy: 'extension' });
    });
    it('recognizes extensionless messages and avoids claiming arbitrary header-like text', () => {
        expect(detectViewer('message', undefined, undefined, undefined, mail)).toEqual({ viewerId: 'eml', matchedBy: 'content' });
        expect(looksLikeEml('\ufeff' + mail)).toBe(true);
        expect(looksLikeEml('From sender@example.com Thu Oct 29\n' + mail.replace(/\r/g, ''))).toBe(true);
        for (const sample of ['Subject: task\n\nhello', 'From: source\nTo: target', 'HTTP/1.1 200 OK\nDate: now', 'From: a\nTo: b\nSubject: c\nnot a header']) expect(looksLikeEml(sample)).toBe(false);
        expect(detectViewer('message', undefined, CORE_VIEWER_DESCRIPTORS.filter(item => item.id !== 'eml'), undefined, mail).viewerId).toBe('fallback');
        expect(detectViewer('message.txt', undefined, undefined, undefined, mail).viewerId).toBe('text');
        expect(detectViewer('message.html', undefined, undefined, undefined, mail).viewerId).toBe('html');
    });
    it('keeps public viewer metadata aligned with registry descriptors', () => {
        const { inputOwnership: _, ...meta } = EML_VIEWER_META;
        expect(EML_VIEWER_DESCRIPTOR).toEqual(meta);
        expect(CORE_VIEWER_DESCRIPTORS.filter(item => item.id === 'eml')).toHaveLength(1);
    });
});
