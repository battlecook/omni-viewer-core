import { describe, expect, it } from 'vitest';
import { parseEml, safeEmlFileName, type EmlParseOptions } from './index.js';

const message = (headers: string, body: string) => `From: Sender <sender@example.com>\r\nTo: Reader <reader@example.com>\r\nSubject: Test${headers ? '\r\n' + headers : ''}\r\n\r\n${body}`;
const documentOf = (source: string | Uint8Array, options?: EmlParseOptions) => {
    const { result } = parseEml(source, options);
    if (result.status === 'failed') throw new Error(result.failure.code);
    return result.document;
};

describe('EML MIME parser', () => {
    it('decodes folded UTF-8 encoded words, repeated headers and mail metadata', () => {
        const doc = documentOf('From: =?UTF-8?B?7ZmN6ri464+Z?= <hong@example.com>\r\nTo: one@example.com\r\nTo: two@example.com\r\nSubject: =?UTF-8?B?7JWI64WV?=\r\n =?UTF-8?Q?_=EC=84=B8=EA=B3=84?=\r\nDate: Thu, 29 Oct 2026 10:00:00 +0900\r\nReply-To: reply@example.com\r\nMessage-ID: <test@example.com>\r\n\r\nHello');
        expect(doc.subject).toBe('안녕 세계');
        expect(doc.from).toBe('홍길동 <hong@example.com>');
        expect(doc.to).toBe('one@example.com, two@example.com');
        expect(doc.replyTo).toBe('reply@example.com');
        expect(doc.messageId).toBe('<test@example.com>');
        expect(doc.headers.filter(header => header.name === 'To')).toHaveLength(2);
        expect(doc.headers.find(header => header.name === 'Subject')?.rawValue).toContain('=?UTF-8?');
        expect(doc.text).toBe('Hello');
    });

    it('decodes quoted printable soft breaks and legacy body/header charsets', () => {
        expect(documentOf(message('Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable', '=EC=95=88=EB=85=95=\r\n=20world')).text).toBe('안녕 world');
        const doc = documentOf('From: sender@example.com\nSubject: =?iso-8859-1?Q?caf=E9?=\nContent-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: base64\n\nY2Fm6Q==');
        expect(doc.subject).toBe('café'); expect(doc.text).toBe('café');
        expect(documentOf(message('Content-Type: text/plain; charset=euc-kr\r\nContent-Transfer-Encoding: base64', 'vsiz5w==')).text).toBe('안녕');
    });

    it('retains raw eight-bit UTF-8 and binary attachment bytes without mutating input', () => {
        expect(documentOf(new TextEncoder().encode(message('Content-Type: text/plain; charset=utf-8', '안녕 👋'))).text).toBe('안녕 👋');
        const head = new TextEncoder().encode(message('Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="binary.bin"\r\nContent-Transfer-Encoding: binary', ''));
        const input = new Uint8Array([...head, 0, 128, 129, 255]); const copy = input.slice();
        expect(documentOf(input).attachments[0]?.data).toEqual(Uint8Array.of(0, 128, 129, 255));
        expect(input).toEqual(copy);
    });

    it('parses nested alternative/related parts, inline images, and named text attachments', () => {
        const body = [
            'preamble', '--outer', 'Content-Type: multipart/alternative; boundary="alt"', '',
            '--alt', 'Content-Type: text/plain', '', 'Plain version',
            '--alt', 'Content-Type: multipart/related; boundary="related"', '',
            '--related', 'Content-Type: text/html', '', '<p>Hello<img src="cid:logo"></p>',
            '--related', 'Content-Type: image/png', 'Content-ID: <logo>', 'Content-Transfer-Encoding: base64', '', 'AAEC/w==',
            '--related--', '--alt--', '--outer', 'Content-Type: text/plain; name="notes.txt"', 'Content-Disposition: attachment; filename="notes.txt"', '', 'Attachment contents',
            '--outer--', 'epilogue'
        ].join('\r\n');
        const doc = documentOf(message('Content-Type: multipart/mixed; boundary="outer"', body));
        expect(doc.text).toBe('Plain version');
        expect(doc.html).toBe('<p>Hello<img src="cid:logo"></p>');
        expect(doc.attachments).toHaveLength(2);
        expect(doc.attachments[0]).toMatchObject({ contentId: 'logo', inline: true, contentType: 'image/png', data: Uint8Array.of(0, 1, 2, 255) });
        expect(new TextDecoder().decode(doc.attachments[1]!.data)).toBe('Attachment contents');
    });

    it('decodes extended and continued attachment filenames and strips unsafe paths', () => {
        const doc = documentOf(message("Content-Type: application/pdf\r\nContent-Disposition: attachment; filename=old.pdf; filename*0*=utf-8''%EB%B3%B4;\r\n filename*1*=%EA%B3%A0%EC%84%9C.pdf\r\nContent-Transfer-Encoding: base64", 'JVBERg=='));
        expect(doc.attachments[0]?.fileName).toBe('보고서.pdf');
        expect(documentOf(message("Content-Type: application/pdf\r\nContent-Disposition: attachment; filename*=UTF-8''hello%20world.pdf", 'pdf')).attachments[0]?.fileName).toBe('hello world.pdf');
        expect(documentOf(message('Content-Type: text/plain; name="=?UTF-8?B?7JWI64WV?=.txt"', 'hello')).attachments[0]?.fileName).toBe('안녕.txt');
        expect(safeEmlFileName('../../secret.txt')).toBe('secret.txt');
        expect(safeEmlFileName('C:\\temp\\evil\u202efile.exe')).toBe('evil_file.exe');
        expect(safeEmlFileName('..')).toBe('attachment');
    });

    it('keeps attached messages and multipart attachments out of the parent body', () => {
        for (const type of ['message/rfc822', 'multipart/mixed; boundary=inner']) {
            const doc = documentOf(message(`Content-Type: ${type}\r\nContent-Disposition: attachment; filename="forward.eml"`, 'From: hidden@example.com\r\nSubject: Forward\r\n\r\nForward body'));
            expect(doc.text).toBe(''); expect(doc.html).toBe('');
            expect(doc.attachments[0]?.fileName).toBe('forward.eml');
            expect(new TextDecoder().decode(doc.attachments[0]!.data)).toContain('Forward body');
        }
    });

    it('selects the related root by start and keeps other HTML parts as resources', () => {
        const body = [
            '--x', 'Content-Type: text/html', 'Content-ID: <resource>', '', '<p>Resource</p>',
            '--x', 'Content-Type: text/html', 'Content-ID: <root>', 'Content-Disposition: inline; filename="body.html"', '', '<p>Root</p>', '--x--'
        ].join('\r\n');
        const doc = documentOf(message('Content-Type: multipart/related; boundary=x; start="<root>"', body));
        expect(doc.html).toBe('<p>Root</p>');
        expect(doc.attachments).toHaveLength(1);
        expect(doc.attachments[0]?.contentId).toBe('resource');
        expect(new TextDecoder().decode(doc.attachments[0]!.data)).toBe('<p>Resource</p>');
    });

    it('renders the first related child as an inline text root when start is absent', () => {
        const body = [
            '--x', 'Content-Type: text/plain', 'Content-ID: <root>', 'Content-Disposition: inline', '', 'Root body',
            '--x', 'Content-Type: text/html', '', '<p>Resource</p>', '--x--'
        ].join('\n');
        const doc = documentOf(message('Content-Type: multipart/related; boundary=x', body));
        expect(doc.text).toBe('Root body'); expect(doc.html).toBe('');
        expect(doc.attachments).toHaveLength(1);
    });

    it('decodes each starred filename segment while preserving unstarred percent signs', () => {
        const attachment = (parameters: string) => documentOf(message(`Content-Type: application/octet-stream\r\nContent-Disposition: attachment; ${parameters}`, 'bytes')).attachments[0]!.fileName;
        expect(attachment('filename*0="hello"; filename*1*="%20world.txt"')).toBe('hello world.txt');
        expect(attachment('filename*0="100%20"; filename*1*="%20done.txt"')).toBe('100%20 done.txt');
        expect(attachment("filename*0*=iso-8859-1''caf; filename*1*=%E9; filename*2=.txt")).toBe('café.txt');
        expect(attachment("filename*0*=utf-8''%EC; filename*1*=%95%88.txt")).toBe('안.txt');
    });

    it('keeps CID resources associated with the selected HTML alternative', () => {
        const related = (boundary: string, text: string, image: string) => [
            `--${boundary}`, 'Content-Type: text/html', '', `<p>${text}<img src="cid:logo"></p>`,
            `--${boundary}`, 'Content-Type: image/png', 'Content-ID: <logo>', '', image, `--${boundary}--`
        ].join('\n');
        const source = message('Content-Type: multipart/alternative; boundary=alt', [
            '--alt', 'Content-Type: multipart/related; boundary=old', '', related('old', 'Old', 'OLD'),
            '--alt', 'Content-Type: multipart/related; boundary=new', '', related('new', 'New', 'NEW'), '--alt--'
        ].join('\n'));
        const doc = documentOf(source);
        expect(doc.html).toBe('<p>New<img src="cid:logo"></p>');
        expect(doc.attachments.map(item => new TextDecoder().decode(item.data))).toEqual(['OLD', 'NEW']);
        expect(doc.htmlResources.map(item => new TextDecoder().decode(item.data))).toEqual(['NEW']);
    });

    it('accepts LF, CR, BOM, mbox envelope, header-only messages, and empty bodies', () => {
        for (const newline of ['\n', '\r\n', '\r']) expect(documentOf(`Subject: Test${newline}${newline}hello`).text).toBe('hello');
        expect(documentOf('\ufeffFrom sender@example.com Thu Oct 29 00:00:00 2026\nSubject: Test\n\nhello').text).toBe('hello');
        expect(documentOf('Subject: Header only').subject).toBe('Header only');
        expect(documentOf('Subject: Empty\n\n').text).toBe('');
    });

    it('recovers incomplete multipart bodies and reports malformed/unsupported content', () => {
        const { result } = parseEml(message('Content-Type: multipart/mixed; boundary=x', '--x\nContent-Type: text/plain\n\nRecovered'));
        expect(result.status).toBe('partial');
        if (result.status === 'failed') return;
        expect(result.document.text).toBe('Recovered');
        expect(result.diagnostics.map(item => item.code)).toContain('eml.multipart');
        for (const headers of ['Content-Transfer-Encoding: base64', 'Content-Type: text/plain; charset=not-a-charset', 'Bad header']) {
            expect(parseEml(message(headers, '%%%')).result.status).toBe('partial');
        }
        expect(parseEml('not a mail').result.status).toBe('failed');
        expect(parseEml(message('Content-Type: multipart/mixed', 'body')).result.status).toBe('partial');
    });

    it('matches MIME boundaries only on delimiter lines and preserves attachment trailing bytes', () => {
        const body = '--x\r\nContent-Type: text/plain\r\n\r\ntext --x\r\n--x-not-a-boundary\r\n--x--\r\n';
        expect(documentOf(message('Content-Type: multipart/mixed; boundary=x', body)).text).toBe('text --x\r\n--x-not-a-boundary');
        const binary = '--x\nContent-Type: application/octet-stream\n\nabc\n\n--x--';
        expect(new TextDecoder().decode(documentOf(message('Content-Type: multipart/mixed; boundary=x', binary)).attachments[0]!.data)).toBe('abc\n');
    });

    it('enforces input, decoded bytes, part count, depth, header size, and cancellation limits', () => {
        const fail = (source: string, options: EmlParseOptions) => expect(parseEml(source, options).result).toMatchObject({ status: 'failed', failure: { code: 'limit-exceeded' } });
        fail('Subject: 한글\n\nbody', { limits: { maxInputBytes: 15 } });
        fail(message('', 'hello'), { limits: { maxDecompressedBytes: 2 } });
        fail(message('', 'hello'), { limits: { maxEntries: 0 } });
        const multipart = message('Content-Type: multipart/mixed; boundary=x', '--x\n\nhello\n--x--');
        fail(multipart, { maxDepth: 0 });
        fail(multipart, { limits: { maxEntries: 1 } });
        fail('Subject: ' + 'x'.repeat(65536), {});
        const controller = new AbortController(); controller.abort();
        expect(parseEml(message('', 'hello'), { signal: controller.signal }).result).toMatchObject({ status: 'failed', failure: { code: 'aborted' } });
    });

    it('bounds body previews and returns deterministic results', () => {
        const source = message('', '0123456789');
        const outcome = parseEml(source, { limits: { maxPreviewBytes: 4 } });
        expect(outcome.result).toMatchObject({ status: 'partial', document: { text: '0123' }, diagnostics: [{ code: 'eml.preview' }] });
        expect(parseEml(source).result).toEqual(parseEml(source).result);
    });
});
