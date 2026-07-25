// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type { HostContext } from '../../host/index.js';
import type { SlideDeck } from '../../parsers/slide-model.js';
import {
    mountPptDocument,
    mountPptViewer,
    PptViewerError
} from './index.js';

const ctx: HostContext = {
    assets: { resolveAssetUrl: async (value) => value },
    i18n: { t: (key) => key },
    logger: { log() {} }
};

const deck: SlideDeck = {
    totalSlides: 2,
    slides: [
        {
            slideNumber: 1,
            widthPx: 400,
            heightPx: 300,
            backgroundColor: '#fff',
            elements: [{
                type: 'chart',
                x: 10,
                y: 10,
                width: 200,
                height: 100,
                zIndex: 0,
                chartTitle: 'Host chart'
            }]
        },
        {
            slideNumber: 2,
            widthPx: 400,
            heightPx: 300,
            backgroundColor: '#fff',
            elements: [{
                type: 'text',
                x: 10,
                y: 10,
                width: 200,
                height: 100,
                zIndex: 0,
                paragraphs: [{ text: 'Second', level: 0 }]
            }]
        }
    ]
};

describe('PPT host extension API', () => {
    it('mounts an already parsed deck with chart, toolbar, slide and diagnostic hooks', () => {
        const container = document.createElement('div');
        const onSlideChange = vi.fn();
        const onDiagnostics = vi.fn();
        const onAction = vi.fn();
        const renderChart = vi.fn(() => {
            const value = document.createElement('div');
            value.className = 'host-chart';
            value.textContent = 'custom';
            return value;
        });
        const diagnostic = {
            severity: 'warning' as const,
            code: 'pptx.chart.placeholder',
            messageKey: 'diag.ppt.unsupported-object'
        };
        const handle = mountPptDocument(deck, container, ctx, {
            styleIsolation: 'scoped',
            renderChart,
            toolbarActions: [{
                id: 'inspect',
                label: 'Inspect',
                onActivate: onAction
            }],
            diagnostics: [diagnostic],
            onDiagnostics,
            onSlideChange
        });

        expect(container.querySelector('.host-chart')?.textContent).toBe('custom');
        expect(renderChart).toHaveBeenCalled();
        expect(onDiagnostics).toHaveBeenCalledOnce();
        expect(onDiagnostics).toHaveBeenCalledWith([diagnostic]);
        expect(onSlideChange).toHaveBeenCalledWith(1);
        (container.querySelector('[data-action-id="inspect"]') as HTMLButtonElement).click();
        expect(onAction).toHaveBeenCalledOnce();
        handle.controller.dispatch({ type: 'jump', slide: 2 });
        expect(onSlideChange).toHaveBeenLastCalledWith(2);
        expect(container.textContent).toContain('Second');
        handle.dispose();
    });

    it('exposes a structured PDF conversion requirement with its parser cause', async () => {
        try {
            await mountPptViewer(
                { fileName: 'broken.ppt', data: new Uint8Array([1]) },
                document.createElement('div'),
                ctx
            );
            throw new Error('expected mount to fail');
        } catch (error) {
            expect(error).toBeInstanceOf(PptViewerError);
            expect(error).toMatchObject({
                code: 'pdf-conversion-required',
                causeCode: 'invalid-format',
                message: 'diag.ppt.invalid-format'
            });
        }
    });

    it('distinguishes an empty presentation when no PDF converter is installed', async () => {
        const zip = new JSZip();
        zip.file(
            'ppt/presentation.xml',
            '<p:presentation xmlns:p="p"><p:sldIdLst/><p:sldSz cx="9144000" cy="6858000"/></p:presentation>'
        );
        const input = await zip.generateAsync({ type: 'uint8array' });
        await expect(mountPptViewer(
            { fileName: 'empty.pptx', data: input },
            document.createElement('div'),
            ctx
        )).rejects.toMatchObject({
            code: 'pdf-conversion-required',
            causeCode: 'empty-presentation'
        });
    });

    it('distinguishes PDF conversion failure from the original parse failure', async () => {
        await expect(mountPptViewer(
            { fileName: 'broken.ppt', data: new Uint8Array([1]) },
            document.createElement('div'),
            ctx,
            {
                convertToPdf: async () => {
                    throw new Error('converter failed');
                },
                loadPdfjs: async () => {
                    throw new Error('must not load');
                }
            }
        )).rejects.toMatchObject({
            code: 'pdf-conversion-failed',
            causeCode: 'invalid-format'
        });
    });
});
