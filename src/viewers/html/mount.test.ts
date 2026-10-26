// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { detectViewer, looksLikeHtml } from '../../registry/index.js';
import { MountAbortedError } from '../types.js';
import { HTML_PREVIEW_MAX_BYTES, HTML_PREVIEW_MAX_DELIMITERS, HTML_VIEWER_META, decodeHtmlText, htmlPreviewDocument, mountHtmlViewer } from './index.js';

const context = {
    assets: { resolveAssetUrl: async (path: string) => path },
    logger: { log: () => undefined },
    i18n: createCatalogI18n('en')
};
const bytes = (source: string) => new TextEncoder().encode(source);

describe('HTML viewer', () => {
    it('registers HTML and HTM files and conservative extensionless documents', () => {
        for (const extension of HTML_VIEWER_META.extensions) {
            expect(detectViewer(`page.${extension}`).viewerId).toBe('html');
            expect(detectViewer(`PAGE.${extension.toUpperCase()}`).viewerId).toBe('html');
        }
        expect(detectViewer('page', undefined, undefined, undefined, '<!DOCTYPE HTML><html><body>Hi</body></html>').viewerId).toBe('html');
        expect(looksLikeHtml('<!-- a -->\n<HTML lang="en">')).toBe(true);
        expect(looksLikeHtml('<div>fragment</div>')).toBe(false);
        expect(looksLikeHtml('<htmlish/>')).toBe(false);
    });

    it('shows a sandboxed preview and an inert source pane', async () => {
        const container = document.createElement('div');
        const source = '<style>p{color:red}</style><script>parent.alert(1)</script><p>Hi</p>';
        const handle = await mountHtmlViewer({ fileName: 'page.html', data: bytes(source) }, container, context);
        const root = container.shadowRoot!;
        const preview = root.querySelector('iframe')!;
        const sourcePane = root.querySelector('pre')!;
        expect(preview.getAttribute('sandbox')).toBe('');
        expect(preview.referrerPolicy).toBe('no-referrer');
        expect(preview.srcdoc).toContain('default-src \'none\'');
        expect(preview.srcdoc).toContain('frame-src \'none\'');
        expect(preview.srcdoc).toContain('<style>p{color:red}</style>');
        expect(preview.srcdoc).toContain('<p>Hi</p>');
        expect(preview.srcdoc).not.toContain('<script>');
        expect(sourcePane.textContent).toBe(source);
        expect(root.querySelector('script')).toBeNull();
        expect(sourcePane.hidden).toBe(true);

        const buttons = root.querySelectorAll('button');
        buttons[1]!.click();
        expect(preview.hidden).toBe(true);
        expect(sourcePane.hidden).toBe(false);
        buttons[0]!.click();
        expect(preview.hidden).toBe(false);
        handle.dispose();
        expect(root.children).toHaveLength(0);
    });

    it('limits large documents to a bounded source preview', async () => {
        const container = document.createElement('div');
        const handle = await mountHtmlViewer({ fileName: 'huge.htm', data: new Uint8Array(HTML_PREVIEW_MAX_BYTES + 1) }, container, context, { styleIsolation: 'scoped' });
        expect(container.querySelector('iframe')?.hasAttribute('srcdoc')).toBe(false);
        expect(container.querySelector('iframe')?.hidden).toBe(true);
        expect(container.querySelector('button')?.hasAttribute('disabled')).toBe(true);
        expect(container.querySelector('pre')?.textContent?.length).toBeLessThan(HTML_PREVIEW_MAX_BYTES);
        handle.dispose();
        expect(container.children).toHaveLength(0);
        expect(container.classList.contains('omni-viewer--html')).toBe(false);
    });

    it('does not parse dense markup even below the byte limit', async () => {
        const container = document.createElement('div');
        const dense = '<b>x</b>'.repeat(HTML_PREVIEW_MAX_DELIMITERS + 1);
        const handle = await mountHtmlViewer({ fileName: 'dense.html', data: bytes(dense) }, container, context);
        const root = container.shadowRoot!;
        expect(root.querySelector('iframe')?.hasAttribute('srcdoc')).toBe(false);
        expect(root.querySelector('iframe')?.hidden).toBe(true);
        expect(root.querySelector('pre')?.textContent).toBe(dense);
        expect(root.querySelector('.omni-html__note')?.textContent).toContain('too complex');
        handle.dispose();
    });

    it('rejects an already aborted mount without touching the container', async () => {
        const container = document.createElement('div');
        const controller = new AbortController();
        controller.abort();
        await expect(mountHtmlViewer({ fileName: 'a.html', data: bytes('hello') }, container, context, { signal: controller.signal })).rejects.toBeInstanceOf(MountAbortedError);
        expect(container.shadowRoot).toBeNull();
    });

    it('puts the restriction before untrusted markup', () => {
        const document = htmlPreviewDocument('</head><meta http-equiv="refresh" content="0;url=https://example.com">');
        expect(document).toContain('Content-Security-Policy');
        expect(document).not.toContain('refresh');
    });

    it('decodes an HTML charset declaration and UTF-16 BOM', () => {
        const latin1 = new Uint8Array([...bytes('<meta charset="windows-1252"><p>caf'), 0xe9, ...bytes('</p>')]);
        expect(decodeHtmlText(latin1)).toContain('café');
        expect(decodeHtmlText(new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]))).toBe('Hi');
        expect(decodeHtmlText(bytes('<!-- <meta charset=windows-1252> --><meta charset=utf-8><p>café</p>'))).toContain('café');
        expect(decodeHtmlText(bytes('<script>"<meta charset=windows-1252>"</script><meta charset=utf-8><p>café</p>'))).toContain('café');
        const withEndAttributes = new Uint8Array([...bytes('<script>0</script data-x><meta charset=windows-1252><p>caf'), 0xe9, ...bytes('</p>')]);
        expect(decodeHtmlText(withEndAttributes)).toContain('café');
        const quotedContentType = new Uint8Array([...bytes('<meta http-equiv="Content-Type" content=\'text/html; charset="windows-1252"\'><p>caf'), 0xe9, ...bytes('</p>')]);
        expect(decodeHtmlText(quotedContentType)).toContain('café');
    });

    it('removes active elements, remote resources and navigable links', () => {
        const preview = htmlPreviewDocument('<a href="https://example.com" ping="https://x">away</a><a href="#local">here</a><img src="https://x/a.png" srcset="https://x/b.png"><img src="data:image/png;base64,AAAA"><img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E"><iframe src="https://x"></iframe><p onclick="alert(1)">ok</p>');
        expect(preview).not.toContain('https://');
        expect(preview).not.toContain('<iframe');
        expect(preview).not.toContain('onclick');
        expect(preview).toContain('href="#local"');
        expect(preview).toContain('src="data:image/png;base64,AAAA"');
        expect(preview).toContain('src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E"');
    });

    it('removes noscript markup before the script-disabled iframe reparses it', () => {
        const preview = htmlPreviewDocument('<noscript><meta http-equiv="refresh" content="0;url=https://example.com"><iframe src="https://example.com"></iframe></noscript><p>safe</p>');
        expect(preview).not.toContain('<noscript');
        expect(preview).not.toContain('refresh');
        expect(preview).not.toContain('<iframe');
        expect(preview).toContain('<p>safe</p>');
    });

    it('removes nested templates before declarative shadow DOM can expose their contents', () => {
        const preview = htmlPreviewDocument('<div><template shadowrootmode="open"><iframe src="https://example.com"></iframe><a href="https://example.com">away</a></template><p>safe</p></div>');
        expect(preview).not.toContain('<template');
        expect(preview).not.toContain('https://');
        expect(preview).toContain('<p>safe</p>');
    });

    it('keeps safe html and body attributes needed by document styles', () => {
        const preview = htmlPreviewDocument('<html class="dark" lang="ko"><head><style>body.page{color:white}</style></head><body class="page" style="background:black" onload="alert(1)"><p>Hi</p></body></html>');
        expect(preview).toContain('<html class="dark" lang="ko">');
        expect(preview).toContain('<body class="page" style="background:black">');
        expect(preview).not.toContain('onload');
        const commented = htmlPreviewDocument('<!-- <html class="wrong"> --><html class="right"><body class="page">OK</body></html>');
        expect(commented).toContain('<html class="right">');
        const templated = htmlPreviewDocument('<html class="right"><template><body class="wrong"></body><template><body class="also-wrong"></body></template></template><body class="page">OK</body></html>');
        expect(templated).toContain('<body class="page">');
        expect(templated).not.toContain('class="also-wrong"');
        const afterScript = htmlPreviewDocument('<script>0</script data-x><body class="after">OK</body>');
        expect(afterScript).toContain('<body class="after">');
    });
});
