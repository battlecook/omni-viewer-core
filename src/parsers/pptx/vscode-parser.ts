// @ts-nocheck -- upstream VS Code parser predates exactOptionalPropertyTypes.
import JSZip from 'jszip';
import type { SlideObjectDiagnostic } from '../slide-model.js';
import type { Diagnostic, ParseOptions } from '../types.js';
import {
    installBoundedZipReaders,
    pptxLimits,
    PptxLimitError,
    PptxParseGuard,
    preflightPptxZip
} from './limits.js';

// Browser-safe subset of node:path used by the original VS Code parser.
const normalizePath = (value: string): string => {
    const output: string[] = [];
    for (const part of value.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') output.pop(); else output.push(part);
    }
    return output.join('/');
};
const dirname = (value: string): string => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '.';
const extname = (value: string): string => /(^|\/)([^/]*?)(\.[^/.]+)$/.exec(value)?.[3] ?? '';
const basename = (value: string, suffix = ''): string => {
    const name = value.slice(value.lastIndexOf('/') + 1);
    return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
};
const joinPath = (...parts: string[]): string => normalizePath(parts.join('/'));
const path = { extname, posix: { dirname, basename, join: joinPath, normalize: normalizePath } };

interface Relationship {
    id: string;
    target: string;
    type: string;
}

interface Transform {
    offX: number;
    offY: number;
    scaleX: number;
    scaleY: number;
    rotDeg: number;
}

interface ThemeInfo {
    colors: Record<string, string>;
    fonts: Record<string, string>;
}

interface ColorContext {
    themeColors: Record<string, string>;
    themeFonts: Record<string, string>;
    clrMap: Record<string, string>;
}

export interface PptxXmlParserDeps {
    renderMetafile?(
        input: Uint8Array,
        type: 'wmf' | 'emf',
        signal?: AbortSignal
    ): Promise<string | Uint8Array | undefined>;
}

interface ParserContext {
    guard: PptxParseGuard;
    diagnostics: Diagnostic[];
    deps: PptxXmlParserDeps;
    slideNumber: number;
    sourcePath: string;
}

interface ParsedElement {
    type: 'text' | 'image' | 'table' | 'chart' | 'shape';
    x: number;
    y: number;
    width: number;
    height: number;
    rotateDeg?: number;
    zIndex: number;
    sourcePriority: number;
    placeholderKey?: string;
    isTitle?: boolean;
    paragraphs?: Array<{
        text: string;
        level: number;
        bullet?: boolean;
        bulletChar?: string;
        numbered?: boolean;
        numberingFormat?: string;
        numberingStartAt?: number;
        align?: string;
        fontSizePx?: number;
        fontFamily?: string;
        bold?: boolean;
        italic?: boolean;
        underline?: boolean;
        strike?: boolean;
        characterSpacingPx?: number;
        color?: string;
        lineSpacingPx?: number;
        lineSpacingPercent?: number;
        spaceBeforePx?: number;
        spaceAfterPx?: number;
        rtl?: boolean;
        runs?: Array<{
            text: string;
            fontSizePx?: number;
            fontFamily?: string;
            bold?: boolean;
            italic?: boolean;
            underline?: boolean;
            strike?: boolean;
            characterSpacingPx?: number;
            color?: string;
            rtl?: boolean;
            hyperlink?: string;
            action?: string;
        }>;
    }>;
    textMargins?: { left?: number; right?: number; top?: number; bottom?: number };
    verticalAlign?: string;
    autofit?: 'none' | 'normal' | 'shape';
    src?: string;
    srcRect?: { l: number; t: number; r: number; b: number };
    vectorFallback?: boolean;
    tableRows?: string[][];
    table?: import('../slide-model.js').SlideTable;
    chartKind?: string;
    chartTitle?: string;
    chartData?: {
        kind: import('../slide-model.js').SlideChartKind;
        grouping?: string;
        barDir?: string;
        categories: string[];
        series: Array<{
            name: string;
            color: string;
            values: number[];
            valueFormat?: string;
            dataLabel?: {
                showValue?: boolean;
                numFmt?: string;
                fontSizePx?: number;
                color?: string;
            };
        }>;
        gapWidth?: number;
        overlap?: number;
        legend?: {
            position?: string;
            fontSizePx?: number;
            color?: string;
            align?: string;
        };
        categoryAxis?: {
            numFmt?: string;
            fontSizePx?: number;
            color?: string;
            lineColor?: string;
        };
        valueAxis?: {
            numFmt?: string;
            fontSizePx?: number;
            color?: string;
            lineColor?: string;
            gridColor?: string;
            majorUnit?: number;
            min?: number;
            max?: number;
            crossesAt?: number;
        };
    };
    fillColor?: string;
    borderColor?: string;
    customSvgPath?: string;
    presetGeom?: string;
    headEnd?: string;
    tailEnd?: string;
    flipH?: boolean;
    flipV?: boolean;
    hasGeometry?: boolean;
    hiddenPromptText?: boolean;
}

const ZERO_TX: Transform = {
    offX: 0,
    offY: 0,
    scaleX: 1,
    scaleY: 1,
    rotDeg: 0
};

export class PptxXmlParser {
    public static async parse(
        input: Uint8Array,
        options: ParseOptions = {},
        deps: PptxXmlParserDeps = {}
    ): Promise<{
        slides: Array<{
            slideNumber: number;
            widthPx: number;
            heightPx: number;
            backgroundColor: string;
            elements: ParsedElement[];
        }>;
        totalSlides: number;
        diagnostics: Diagnostic[];
    }> {
        const buffer = input;
        const limits = pptxLimits(options);
        preflightPptxZip(buffer, limits);
        const guard = new PptxParseGuard(options, limits);
        guard.checkpoint('input');
        const zip = await JSZip.loadAsync(buffer);
        const actualEntryCount = Object.keys(zip.files).length;
        if (
            limits.maxEntries !== undefined &&
            actualEntryCount > limits.maxEntries
        ) {
            throw new PptxLimitError({
                kind: 'entries',
                count: actualEntryCount
            }, 'central-directory');
        }
        installBoundedZipReaders(zip, guard);
        guard.checkpoint('central-directory');

        const size = await this.getSlideSize(zip);
        const slidePaths = await this.getOrderedSlidePaths(zip);
        const diagnostics: Diagnostic[] = [];

        const slides: Array<{
            slideNumber: number;
            widthPx: number;
            heightPx: number;
            backgroundColor: string;
            elements: ParsedElement[];
        }> = [];

        for (let i = 0; i < slidePaths.length; i++) {
            guard.checkpoint(slidePaths[i]);
            const parsed = await this.parseSingleSlide(
                zip,
                slidePaths[i],
                i + 1,
                size,
                { guard, diagnostics, deps, slideNumber: i + 1, sourcePath: slidePaths[i] }
            );
            slides.push(parsed);
        }

        return {
            slides,
            totalSlides: slides.length,
            diagnostics
        };
    }

    private static async parseSingleSlide(
        zip: JSZip,
        slidePath: string,
        slideNumber: number,
        size: { widthPx: number; heightPx: number },
        context: ParserContext
    ): Promise<{
        slideNumber: number;
        widthPx: number;
        heightPx: number;
        backgroundColor: string;
        elements: ParsedElement[];
    }> {
        const slideXml = await this.readZipText(zip, slidePath);
        const slideRels = await this.getRelationships(zip, slidePath);

        const layoutPath = slideRels.find((r) => r.type.includes('/slideLayout'))?.target;
        const layoutXml = layoutPath ? await this.readZipText(zip, layoutPath) : '';
        const layoutRels = layoutPath ? await this.getRelationships(zip, layoutPath) : [];

        const masterPath = layoutRels.find((r) => r.type.includes('/slideMaster'))?.target;
        const masterXml = masterPath ? await this.readZipText(zip, masterPath) : '';
        const masterRels = masterPath ? await this.getRelationships(zip, masterPath) : [];

        const themePath = masterRels.find((r) => r.type.includes('/theme'))?.target;
        const themeXml = themePath ? await this.readZipText(zip, themePath) : '';
        const theme = this.parseTheme(themeXml);
        const colorCtx = this.buildColorContext(theme, masterXml, layoutXml, slideXml);

        const backgroundColor =
            this.extractBackgroundColor(slideXml, colorCtx)
            || this.extractBackgroundColor(layoutXml, colorCtx)
            || this.extractBackgroundColor(masterXml, colorCtx)
            || '#ffffff';

        const masterElements = await this.extractElementsFromPart(
            zip,
            masterXml,
            masterRels,
            colorCtx,
            1,
            { ...context, sourcePath: masterPath || slidePath }
        );
        const layoutElements = await this.extractElementsFromPart(
            zip,
            layoutXml,
            layoutRels,
            colorCtx,
            2,
            { ...context, sourcePath: layoutPath || slidePath }
        );
        const slideElements = await this.extractElementsFromPart(zip, slideXml, slideRels, colorCtx, 3, context);
        this.collectPartDiagnostics(slideXml, slideRels, context);

        const merged = this.mergeWithPlaceholderInheritance([
            ...masterElements,
            ...layoutElements,
            ...slideElements
        ]);

        return {
            slideNumber,
            widthPx: size.widthPx,
            heightPx: size.heightPx,
            backgroundColor,
            elements: merged
        };
    }

    private static mergeWithPlaceholderInheritance(elements: ParsedElement[]): ParsedElement[] {
        const placeholders = new Map<string, ParsedElement>();
        const others: ParsedElement[] = [];

        const sorted = [...elements].sort((a, b) => {
            if (a.sourcePriority !== b.sourcePriority) {
                return a.sourcePriority - b.sourcePriority;
            }
            return a.zIndex - b.zIndex;
        });

        for (const element of sorted) {
            if (!element.placeholderKey) {
                others.push(element);
                continue;
            }

            const prev = placeholders.get(element.placeholderKey);
            if (!prev) {
                placeholders.set(element.placeholderKey, element);
                continue;
            }

            placeholders.set(element.placeholderKey, this.mergePlaceholderElement(prev, element));
        }

        const merged = [...others, ...Array.from(placeholders.values())]
            .filter((element) => !element.hiddenPromptText);
        merged.sort((a, b) => {
            if (a.sourcePriority !== b.sourcePriority) {
                return a.sourcePriority - b.sourcePriority;
            }
            return a.zIndex - b.zIndex;
        });

        return merged.map((el, idx) => ({ ...el, zIndex: idx }));
    }

    private static mergePlaceholderElement(base: ParsedElement, incoming: ParsedElement): ParsedElement {
        const incomingHasGeometry = this.hasValidGeometry(incoming);
        const baseHasGeometry = this.hasValidGeometry(base);
        const mergedParagraphs = incoming.paragraphs && incoming.paragraphs.length > 0
            ? this.mergeParagraphStyles(base.paragraphs, incoming.paragraphs)
            : base.paragraphs;
        const incomingHasVisibleParagraphs = !!(incoming.paragraphs && incoming.paragraphs.length > 0 && !incoming.hiddenPromptText);

        return {
            ...base,
            ...incoming,
            x: incomingHasGeometry ? incoming.x : base.x,
            y: incomingHasGeometry ? incoming.y : base.y,
            width: incomingHasGeometry ? incoming.width : base.width,
            height: incomingHasGeometry ? incoming.height : base.height,
            rotateDeg: incomingHasGeometry ? incoming.rotateDeg : base.rotateDeg,
            hasGeometry: incomingHasGeometry || baseHasGeometry || !!incoming.hasGeometry || !!base.hasGeometry,
            paragraphs: mergedParagraphs,
            src: incoming.src || base.src,
            tableRows: incoming.tableRows && incoming.tableRows.length > 0 ? incoming.tableRows : base.tableRows,
            table: incoming.table || base.table,
            chartKind: incoming.chartKind || base.chartKind,
            chartTitle: incoming.chartTitle || base.chartTitle,
            chartData: incoming.chartData || base.chartData,
            fillColor: incoming.fillColor || base.fillColor,
            borderColor: incoming.borderColor || base.borderColor,
            customSvgPath: incoming.customSvgPath || base.customSvgPath,
            isTitle: incoming.isTitle || base.isTitle,
            textMargins: incoming.textMargins || base.textMargins,
            verticalAlign: incoming.verticalAlign || base.verticalAlign,
            autofit: incoming.autofit || base.autofit,
            hiddenPromptText: incomingHasVisibleParagraphs ? false : !!(incoming.hiddenPromptText ?? base.hiddenPromptText)
        };
    }

    private static hasValidGeometry(el: ParsedElement): boolean {
        return Number.isFinite(el.width) && Number.isFinite(el.height) && el.width > 0 && el.height > 0;
    }

    private static mergeParagraphStyles(
        baseParagraphs: ParsedElement['paragraphs'],
        incomingParagraphs: ParsedElement['paragraphs']
    ): ParsedElement['paragraphs'] {
        if (!incomingParagraphs || incomingParagraphs.length === 0) {
            return baseParagraphs;
        }
        if (!baseParagraphs || baseParagraphs.length === 0) {
            return incomingParagraphs;
        }

        return incomingParagraphs.map((paragraph, index) => {
            const fallback = baseParagraphs[index]
                || baseParagraphs.find((candidate) => candidate.level === paragraph.level)
                || baseParagraphs[0];
            if (!fallback) {
                return paragraph;
            }

            const incomingRuns = Array.isArray(paragraph.runs) ? paragraph.runs : [];
            const fallbackRuns = Array.isArray(fallback.runs) ? fallback.runs : [];
            const mergedRuns = incomingRuns.length > 0
                ? incomingRuns.map((run, runIndex) => {
                    const fallbackRun = fallbackRuns[runIndex] || fallbackRuns[0];
                    return {
                        ...fallbackRun,
                        ...run,
                        fontSizePx: run.fontSizePx || fallbackRun?.fontSizePx,
                        fontFamily: run.fontFamily || fallbackRun?.fontFamily,
                        bold: run.bold ?? fallbackRun?.bold,
                        italic: run.italic ?? fallbackRun?.italic,
                        underline: run.underline ?? fallbackRun?.underline,
                        strike: run.strike ?? fallbackRun?.strike,
                        characterSpacingPx: run.characterSpacingPx ?? fallbackRun?.characterSpacingPx,
                        rtl: run.rtl ?? fallbackRun?.rtl,
                        hyperlink: run.hyperlink || fallbackRun?.hyperlink,
                        action: run.action || fallbackRun?.action,
                        color: run.color || fallbackRun?.color
                    };
                })
                : fallbackRuns;

            return {
                ...fallback,
                ...paragraph,
                text: paragraph.text,
                level: Number.isFinite(paragraph.level) ? paragraph.level : fallback.level,
                bullet: paragraph.bullet ?? fallback.bullet,
                bulletChar: paragraph.bulletChar || fallback.bulletChar,
                numbered: paragraph.numbered ?? fallback.numbered,
                numberingFormat: paragraph.numberingFormat || fallback.numberingFormat,
                numberingStartAt: paragraph.numberingStartAt ?? fallback.numberingStartAt,
                align: paragraph.align || fallback.align,
                fontSizePx: paragraph.fontSizePx || fallback.fontSizePx,
                fontFamily: paragraph.fontFamily || fallback.fontFamily,
                bold: paragraph.bold ?? fallback.bold,
                italic: paragraph.italic ?? fallback.italic,
                underline: paragraph.underline ?? fallback.underline,
                strike: paragraph.strike ?? fallback.strike,
                characterSpacingPx: paragraph.characterSpacingPx ?? fallback.characterSpacingPx,
                color: paragraph.color || fallback.color,
                lineSpacingPx: paragraph.lineSpacingPx ?? fallback.lineSpacingPx,
                lineSpacingPercent: paragraph.lineSpacingPercent ?? fallback.lineSpacingPercent,
                spaceBeforePx: paragraph.spaceBeforePx ?? fallback.spaceBeforePx,
                spaceAfterPx: paragraph.spaceAfterPx ?? fallback.spaceAfterPx,
                rtl: paragraph.rtl ?? fallback.rtl,
                runs: mergedRuns.length > 0 ? mergedRuns : undefined
            };
        });
    }

    private static async extractElementsFromPart(
        zip: JSZip,
        partXml: string,
        rels: Relationship[],
        colors: ColorContext,
        sourcePriority: number,
        context: ParserContext
    ): Promise<ParsedElement[]> {
        if (!partXml) {
            return [];
        }

        const tree = this.extractTagBlock(partXml, 'p:spTree');
        if (!tree) {
            return [];
        }

        const result: ParsedElement[] = [];
        await this.collectBlocks(zip, tree, rels, colors, sourcePriority, ZERO_TX, result, { value: 0 }, context);
        return result;
    }

    private static async collectBlocks(
        zip: JSZip,
        xml: string,
        rels: Relationship[],
        colors: ColorContext,
        sourcePriority: number,
        parentTx: Transform,
        out: ParsedElement[],
        zCounter: { value: number },
        context: ParserContext
    ): Promise<void> {
        const tagNames = ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp', 'p:cxnSp'];
        let cursor = 0;

        while (cursor < xml.length) {
            context.guard.checkpoint(context.sourcePath);
            let nextIdx = -1;
            let foundTag = '';

            for (const tag of tagNames) {
                const idx = this.findNextTagIndex(xml, tag, cursor);
                if (idx !== -1 && (nextIdx === -1 || idx < nextIdx)) {
                    nextIdx = idx;
                    foundTag = tag;
                }
            }

            if (nextIdx === -1) {
                break;
            }

            const block = this.extractBalancedTag(xml, foundTag, nextIdx);
            if (!block) {
                cursor = nextIdx + foundTag.length;
                continue;
            }

            if (foundTag === 'p:grpSp') {
                const grpTx = this.combineTransforms(parentTx, this.parseGroupTransform(block.content));
                await this.collectBlocks(zip, block.innerContent, rels, colors, sourcePriority, grpTx, out, zCounter, context);
            } else if (foundTag === 'p:sp' || foundTag === 'p:cxnSp') {
                const element = await this.parseShapeBlock(zip, block.content, rels, colors, sourcePriority, parentTx, zCounter.value, context);
                if (element) {
                    out.push(element);
                    zCounter.value += 1;
                }
            } else if (foundTag === 'p:pic') {
                const element = await this.parsePictureBlock(zip, block.content, rels, sourcePriority, parentTx, zCounter.value, context);
                if (element) {
                    out.push(element);
                    zCounter.value += 1;
                }
            } else if (foundTag === 'p:graphicFrame') {
                const element = await this.parseGraphicFrameBlock(zip, block.content, rels, colors, sourcePriority, parentTx, zCounter.value, context);
                if (element) {
                    out.push(element);
                    zCounter.value += 1;
                }
            }

            cursor = block.end;
        }
    }

    private static findNextTagIndex(xml: string, tag: string, from: number): number {
        const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`<${escaped}(?=[\\s>/])`, 'g');
        re.lastIndex = from;
        const m = re.exec(xml);
        return m ? m.index : -1;
    }

    private static async parseShapeBlock(
        zip: JSZip,
        shapeXml: string,
        rels: Relationship[],
        colors: ColorContext,
        sourcePriority: number,
        parentTx: Transform,
        zIndex: number,
        context: ParserContext
    ): Promise<ParsedElement | null> {
        const placeholderType = this.getPlaceholderType(shapeXml);
        // Footer/date/slide-number placeholders in master/layout should not render unless slide overrides them.
        if (sourcePriority < 3 && (placeholderType === 'dt' || placeholderType === 'ftr' || placeholderType === 'sldnum')) {
            return null;
        }

        const localGeom = this.parseGeometry(shapeXml);
        const geom = localGeom ? this.applyTransform(localGeom, parentTx) : null;

        const placeholderKey = this.getPlaceholderKey(shapeXml);
        const isTitle = this.isTitleShape(shapeXml);
        const paragraphs = this.extractTextParagraphs(shapeXml, colors);
        const textBox = this.extractTextBoxProperties(shapeXml);
        if (paragraphs.length > 0 && sourcePriority < 3) {
            const hasOnlyPromptText = paragraphs.every((p) => this.isPlaceholderPromptText(p.text));
            if (hasOnlyPromptText) {
                if (placeholderKey && geom) {
                    return {
                        type: 'text',
                        x: geom.x,
                        y: geom.y,
                        width: geom.width,
                        height: geom.height,
                        rotateDeg: geom.rotateDeg,
                        zIndex,
                        sourcePriority,
                        placeholderKey,
                        hasGeometry: true,
                        paragraphs,
                        hiddenPromptText: true
                    };
                }
                return null;
            }
        }

        const fillColor = this.extractFillColor(shapeXml, colors);
        const borderColor = this.extractLineColor(shapeXml, colors);
        const presetGeom = shapeXml.match(/<a:prstGeom\b[^>]*prst="([^"]+)"/)?.[1];
        const customSvgPath = geom ? this.parseCustomGeometryPath(shapeXml, geom.width, geom.height) : undefined;
        if (
            presetGeom &&
            !customSvgPath &&
            !this.isSupportedPresetGeometry(presetGeom)
        ) {
            this.addObjectDiagnostic(context, 'shape', 'simplified', geom ?? undefined, {
                preset: presetGeom
            });
        }

        // Connector line arrow endpoints.
        const headEndType = shapeXml.match(/<a:headEnd\b[^>]*type="([^"]+)"/)?.[1];
        const tailEndType = shapeXml.match(/<a:tailEnd\b[^>]*type="([^"]+)"/)?.[1];

        if (paragraphs.length > 0) {
            return {
                type: 'text',
                x: geom ? geom.x : 0,
                y: geom ? geom.y : 0,
                width: geom ? geom.width : 0,
                height: geom ? geom.height : 0,
                rotateDeg: geom?.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey,
                isTitle,
                paragraphs,
                ...textBox,
                fillColor,
                borderColor,
                customSvgPath,
                presetGeom,
                hasGeometry: !!geom
            };
        }

        const blipEmbedId = shapeXml.match(/<a:blip[^>]*r:embed="([^"]+)"/)?.[1];
        if (blipEmbedId && geom) {
            const target = rels.find((r) => r.id === blipEmbedId)?.target;
            if (target) {
                const image = await this.resolveImageSource(zip, target, context, geom);
                if (image) {
                    return {
                        type: 'image',
                        x: geom.x,
                        y: geom.y,
                        width: geom.width,
                        height: geom.height,
                        rotateDeg: geom.rotateDeg,
                        zIndex,
                        sourcePriority,
                        placeholderKey,
                        src: image.src,
                        vectorFallback: image.vectorFallback,
                        hasGeometry: true
                    };
                }
            }
        }

        // Keep non-text shape so layout boxes/background elements are still visible.
        if (fillColor || borderColor || customSvgPath) {
            return {
                type: 'shape',
                x: geom ? geom.x : 0,
                y: geom ? geom.y : 0,
                width: geom ? geom.width : 0,
                height: geom ? geom.height : 0,
                rotateDeg: geom?.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey,
                fillColor,
                borderColor,
                customSvgPath,
                presetGeom,
                headEnd: headEndType,
                tailEnd: tailEndType,
                flipH: geom?.flipH,
                flipV: geom?.flipV,
                hasGeometry: !!geom
            };
        }

        return null;
    }

    private static async parsePictureBlock(
        zip: JSZip,
        picXml: string,
        rels: Relationship[],
        sourcePriority: number,
        parentTx: Transform,
        zIndex: number,
        context: ParserContext
    ): Promise<ParsedElement | null> {
        const localGeom = this.parseGeometry(picXml);
        const geom = localGeom ? this.applyTransform(localGeom, parentTx) : null;
        const placeholderKey = this.getPlaceholderKey(picXml);
        const picName = picXml.match(/<p:cNvPr[^>]*name="([^"]+)"/)?.[1] || '';
        const picDescr = picXml.match(/<p:cNvPr[^>]*descr="([^"]+)"/)?.[1] || '';

        if (sourcePriority < 3 && !placeholderKey && /placeholder/i.test(picName)) {
            return null;
        }

        const embedId = picXml.match(/<a:blip[^>]*r:embed="([^"]+)"/)?.[1];
        if (!embedId) {
            this.addObjectDiagnostic(context, 'image', 'placeholder', geom ?? undefined, {
                reason: 'missing-relationship-id'
            });
            if (!geom && !placeholderKey) {
                return null;
            }
            return {
                type: 'shape',
                x: geom ? geom.x : 0,
                y: geom ? geom.y : 0,
                width: geom ? geom.width : 0,
                height: geom ? geom.height : 0,
                rotateDeg: geom?.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey,
                hasGeometry: !!geom
            };
        }

        const target = rels.find((r) => r.id === embedId)?.target;
        if (!target) {
            this.addObjectDiagnostic(context, 'image', 'placeholder', geom ?? undefined, {
                reason: 'missing-relationship-target'
            });
            return geom || placeholderKey ? {
                type: 'shape',
                x: geom ? geom.x : 0,
                y: geom ? geom.y : 0,
                width: geom ? geom.width : 0,
                height: geom ? geom.height : 0,
                rotateDeg: geom?.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey,
                hasGeometry: !!geom
            } : null;
        }

        const image = await this.resolveImageSource(zip, target, context, geom ?? undefined);
        if (!image) {
            return geom || placeholderKey ? {
                type: 'shape',
                x: geom ? geom.x : 0,
                y: geom ? geom.y : 0,
                width: geom ? geom.width : 0,
                height: geom ? geom.height : 0,
                rotateDeg: geom?.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey,
                fillColor: '#f7f7f7',
                borderColor: '#c9c9c9',
                hasGeometry: !!geom
            } : null;
        }

        // Parse <a:srcRect l="" t="" r="" b=""/> — values are in 1/1000th percent.
        const srcRectTag = picXml.match(/<a:srcRect\b[^>]*\/?>/)?.[0] || '';
        let srcRect: { l: number; t: number; r: number; b: number } | undefined;
        if (srcRectTag) {
            const toPct = (name: string): number => {
                const v = Number(this.getAttr(srcRectTag, name) || 0);
                return Number.isFinite(v) ? v / 1000 : 0;
            };
            const l = toPct('l');
            const t = toPct('t');
            const r = toPct('r');
            const b = toPct('b');
            if (l || t || r || b) {
                srcRect = { l, t, r, b };
            }
        }

        return {
            type: 'image',
            x: geom ? geom.x : 0,
            y: geom ? geom.y : 0,
            width: geom ? geom.width : 0,
            height: geom ? geom.height : 0,
            rotateDeg: geom?.rotateDeg,
            zIndex,
            sourcePriority,
            placeholderKey,
            src: image.src,
            srcRect,
            vectorFallback: image.vectorFallback,
            hasGeometry: !!geom
        };
    }

    private static async parseGraphicFrameBlock(
        zip: JSZip,
        frameXml: string,
        rels: Relationship[],
        colors: ColorContext,
        sourcePriority: number,
        parentTx: Transform,
        zIndex: number,
        context: ParserContext
    ): Promise<ParsedElement | null> {
        const localGeom = this.parseGeometry(frameXml);
        if (!localGeom) {
            return null;
        }
        const geom = this.applyTransform(localGeom, parentTx);

        const uri = frameXml.match(/<a:graphicData[^>]*uri="([^"]+)"/)?.[1] || '';

        if (uri.includes('/table')) {
            const table = this.extractTable(frameXml, colors);
            const tableRows = table.rows.map((row) =>
                row.cells.filter((cell) => !cell.merged).map((cell) =>
                    cell.paragraphs.map((paragraph) => paragraph.text).join('\n')
                )
            );
            if (tableRows.length === 0) {
                return null;
            }
            return {
                type: 'table',
                x: geom.x,
                y: geom.y,
                width: geom.width,
                height: geom.height,
                rotateDeg: geom.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey: this.getPlaceholderKey(frameXml),
                table,
                tableRows
            };
        }

        if (uri.includes('/chart')) {
            const chartRelId = frameXml.match(/<c:chart[^>]*r:id="([^"]+)"/)?.[1] || '';
            let chartTitle = 'Chart';
            let chartData: ParsedElement['chartData'] | undefined;
            if (chartRelId) {
                const chartTarget = rels.find((r) => r.id === chartRelId)?.target;
                if (chartTarget) {
                    const chartXml = await this.readZipText(zip, chartTarget);
                    const chartText = chartXml.match(/<c:title[\s\S]*?<a:t(?=[\s>])[^>]*>([\s\S]*?)<\/a:t>/)?.[1];
                    if (chartText) {
                        chartTitle = this.decodeXmlEntities(chartText);
                    }
                    chartData = this.parseChartData(chartXml, colors);
                }
            }
            if (!chartData) {
                this.addObjectDiagnostic(context, 'chart', 'placeholder', geom, {
                    chartTitle
                });
            }
            return {
                type: 'chart',
                x: geom.x,
                y: geom.y,
                width: geom.width,
                height: geom.height,
                rotateDeg: geom.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey: this.getPlaceholderKey(frameXml),
                chartKind: 'chart',
                chartTitle,
                chartData
            };
        }

        if (uri.includes('/diagram')) {
            const referencedRelIds = Array.from(
                frameXml.matchAll(/\br:[A-Za-z0-9_]+="([^"]+)"/g),
                (match) => match[1]
            );
            const imageRelationship = rels.find((relationship) =>
                referencedRelIds.includes(relationship.id) &&
                /\/image$/.test(relationship.type)
            );
            const imageTarget = imageRelationship?.target;
            if (imageTarget) {
                const image = await this.resolveImageSource(zip, imageTarget, context, geom);
                if (image) {
                    this.addObjectDiagnostic(context, 'smartart', 'simplified', geom, {
                        fallback: 'image'
                    });
                    return {
                        type: 'image',
                        x: geom.x,
                        y: geom.y,
                        width: geom.width,
                        height: geom.height,
                        rotateDeg: geom.rotateDeg,
                        zIndex,
                        sourcePriority,
                        placeholderKey: this.getPlaceholderKey(frameXml),
                        src: image.src,
                        vectorFallback: image.vectorFallback
                    };
                }
            }

            const smartArtText: string[] = [];
            const diagramRelIds = Array.from(frameXml.matchAll(/\br:(?:dm|lo|qs|cs)="([^"]+)"/g), (match) => match[1]);
            for (const relId of diagramRelIds) {
                context.guard.checkpoint(context.sourcePath);
                const target = rels.find((relationship) => relationship.id === relId)?.target;
                if (!target) continue;
                const dataXml = await this.readZipText(zip, target);
                for (const match of dataXml.matchAll(/<a:t(?=[\s>])[^>]*>([\s\S]*?)<\/a:t>/g)) {
                    const text = this.decodeXmlEntities(match[1] ?? '').trim();
                    if (text && !smartArtText.includes(text)) smartArtText.push(text);
                }
            }
            this.addObjectDiagnostic(
                context,
                'smartart',
                smartArtText.length ? 'simplified' : 'placeholder',
                geom,
                { fallback: smartArtText.length ? 'text' : 'none' }
            );
            return {
                type: 'chart',
                x: geom.x,
                y: geom.y,
                width: geom.width,
                height: geom.height,
                rotateDeg: geom.rotateDeg,
                zIndex,
                sourcePriority,
                placeholderKey: this.getPlaceholderKey(frameXml),
                chartKind: 'smartart',
                chartTitle: 'SmartArt',
                ...(smartArtText.length
                    ? {
                        paragraphs: smartArtText.map((text) => ({
                            text,
                            level: 0
                        }))
                    }
                    : {})
            };
        }

        // Other embedded objects fallback as shape frame
        const objectKind = /ole|package/i.test(uri) ? 'ole' : 'shape';
        this.addObjectDiagnostic(context, objectKind, 'placeholder', geom, { uri });
        return {
            type: 'shape',
            x: geom.x,
            y: geom.y,
            width: geom.width,
            height: geom.height,
            rotateDeg: geom.rotateDeg,
            zIndex,
            sourcePriority,
            placeholderKey: this.getPlaceholderKey(frameXml),
            fillColor: '#f7f7f7',
            borderColor: '#c9c9c9'
        };
    }

    private static extractTable(xml: string, colors: ColorContext): import('../slide-model.js').SlideTable {
        const rows: import('../slide-model.js').SlideTableRow[] = [];
        const columnWidths = (xml.match(/<a:gridCol\b[^>]*\/?>/g) || []).map((tag) =>
            this.emuToPx(Number(this.getAttr(tag, 'w') || 0))
        );
        const trMatches = xml.match(/<a:tr\b[\s\S]*?<\/a:tr>/g) || [];
        for (const tr of trMatches) {
            const cells: import('../slide-model.js').SlideTableCell[] = [];
            const tcMatches = tr.match(/<a:tc\b[\s\S]*?<\/a:tc>/g) || [];
            for (const tc of tcMatches) {
                const open = tc.match(/^<a:tc\b[^>]*>/)?.[0] || '';
                const tcPr = this.extractTagBlock(tc, 'a:tcPr') || '';
                const cell: import('../slide-model.js').SlideTableCell = {
                    paragraphs: this.extractTextParagraphs(tc, colors),
                    rowSpan: this.parseNumber(this.getAttr(open, 'rowSpan')),
                    colSpan: this.parseNumber(this.getAttr(open, 'gridSpan')),
                    merged: this.getAttr(open, 'hMerge') === '1' || this.getAttr(open, 'vMerge') === '1',
                    fillColor: this.extractFillColor(tcPr, colors),
                    borders: this.extractTableBorders(tcPr, colors),
                    verticalAlign: this.getAttr(tcPr.match(/<a:tcPr\b[^>]*>/)?.[0] || '', 'anchor'),
                    margins: this.extractTableMargins(tcPr)
                };
                cells.push(cell);
            }
            if (cells.length > 0) {
                rows.push({
                    height: this.emuToPx(Number(this.getAttr(tr.match(/^<a:tr\b[^>]*>/)?.[0] || '', 'h') || 0)),
                    cells
                });
            }
        }
        const tblPr = xml.match(/<a:tblPr\b[^>]*\/?>/)?.[0] || '';
        return {
            rows,
            columnWidths: columnWidths.length ? columnWidths : undefined,
            firstRow: this.getAttr(tblPr, 'firstRow') === '1',
            firstColumn: this.getAttr(tblPr, 'firstCol') === '1',
            bandedRows: this.getAttr(tblPr, 'bandRow') === '1',
            bandedColumns: this.getAttr(tblPr, 'bandCol') === '1'
        };
    }

    private static extractTextParagraphs(shapeXml: string, colors: ColorContext): Array<{
        text: string;
        level: number;
        bullet?: boolean;
        align?: string;
        fontSizePx?: number;
        bold?: boolean;
        italic?: boolean;
        color?: string;
        runs?: Array<{
            text: string;
            fontSizePx?: number;
            bold?: boolean;
            italic?: boolean;
            color?: string;
        }>;
    }> {
        const paragraphs: Array<{
            text: string;
            level: number;
            bullet?: boolean;
            align?: string;
            fontSizePx?: number;
            bold?: boolean;
            italic?: boolean;
            color?: string;
            runs?: Array<{
                text: string;
                fontSizePx?: number;
                bold?: boolean;
                italic?: boolean;
                color?: string;
            }>;
        }> = [];

        const txBody = this.extractTagBlock(shapeXml, 'p:txBody') || shapeXml;
        const lstStyle = this.extractTagBlock(txBody, 'a:lstStyle') || '';
        const bodyPr = this.extractTagBlock(txBody, 'a:bodyPr') || '';
        const pMatches = txBody.match(/<a:p\b[\s\S]*?<\/a:p>/g) || [];
        for (const pXml of pMatches) {
            const textParts: string[] = [];
            const runs: Array<{
                text: string;
                fontSizePx?: number;
                bold?: boolean;
                italic?: boolean;
                color?: string;
            }> = [];
            const runMatches = pXml.match(/<a:r\b[\s\S]*?<\/a:r>|<a:fld\b[\s\S]*?<\/a:fld>|<a:t(?=[\s>])[^>]*>[\s\S]*?<\/a:t>/g) || [];
            let lastRun = '';

            for (const run of runMatches) {
                if (run.startsWith('<a:r') || run.startsWith('<a:fld')) {
                    lastRun = run;
                    const t = run.match(/<a:t(?=[\s>])[^>]*>([\s\S]*?)<\/a:t>/)?.[1];
                    if (t) {
                        const text = this.decodeXmlEntities(t);
                        textParts.push(text);
                        const runRPr = run.match(/<a:rPr[^>]*\/?>/)?.[0] || '';
                        const runRPrXml = this.extractTagBlock(run, 'a:rPr') || runRPr;
                        const runSz = Number(this.getAttr(runRPr, 'sz') || 0);
                        const underline = this.getAttr(runRPr, 'u');
                        const strike = this.getAttr(runRPr, 'strike');
                        const spacing = Number(this.getAttr(runRPr, 'spc') || 0);
                        const hyperlink = runRPrXml.match(/<a:hlinkClick\b[^>]*r:id="([^"]+)"/)?.[1];
                        const action = runRPrXml.match(/<a:hlinkClick\b[^>]*action="([^"]+)"/)?.[1];
                        runs.push({
                            text,
                            fontSizePx: runSz > 0 ? Math.round((runSz / 100) * 1.333) : undefined,
                            fontFamily: this.extractFontFamily(runRPrXml, colors),
                            bold: this.parseOptionalBoolAttr(runRPr, 'b'),
                            italic: this.parseOptionalBoolAttr(runRPr, 'i'),
                            underline: underline ? underline !== 'none' : undefined,
                            strike: strike ? strike !== 'noStrike' : undefined,
                            characterSpacingPx: spacing ? (spacing / 100) * 1.333 : undefined,
                            rtl: this.parseOptionalBoolAttr(runRPr, 'rtl'),
                            hyperlink,
                            action,
                            color: this.extractColorFromXml(runRPr + run, colors)
                        });
                    }
                } else {
                    const t = run.match(/<a:t(?=[\s>])[^>]*>([\s\S]*?)<\/a:t>/)?.[1];
                    if (t) {
                        const text = this.decodeXmlEntities(t);
                        textParts.push(text);
                        runs.push({ text });
                    }
                }
            }

            const text = textParts.join('').trim();
            if (!text) continue;

            const inlinePPrTag = pXml.match(/<a:pPr[^>]*\/?>/)?.[0] || '';
            const inlinePPr = this.extractTagBlock(pXml, 'a:pPr') || inlinePPrTag;
            const inlineLevel = Number(this.getAttr(inlinePPrTag, 'lvl') || 0);
            const level = Number.isFinite(inlineLevel) ? inlineLevel : 0;
            const levelStyle = this.extractParagraphLevelStyle(lstStyle, level);
            const levelPPr = levelStyle.match(/<a:lvl\d+pPr[^>]*>/)?.[0] || '';
            const pPr = inlinePPr || levelStyle;
            const levelRPr = levelStyle.match(/<a:defRPr[^>]*\/?>/)?.[0] || '';
            const bodyDefaultRPr = txBody.match(/<a:defRPr[^>]*\/?>/)?.[0]
                || bodyPr.match(/<a:defRPr[^>]*\/?>/)?.[0]
                || '';
            const rPr = lastRun.match(/<a:rPr[^>]*\/?>/)?.[0]
                || pXml.match(/<a:defRPr[^>]*\/?>/)?.[0]
                || levelRPr
                || bodyDefaultRPr
                || '';

            const align = this.getAttr(pPr, 'algn') || undefined;
            const size = Number(this.getAttr(rPr, 'sz') || 0);
            const color = this.extractColorFromXml(rPr, colors);
            const hasBullet = /<a:buChar\b|<a:buAutoNum\b|<a:buBlip\b/.test(pXml) || /<a:buChar\b|<a:buAutoNum\b|<a:buBlip\b/.test(levelStyle);
            const hasBuNone = /<a:buNone\b/.test(pXml) || /<a:buNone\b/.test(levelStyle);
            const bulletXml = inlinePPr || levelStyle;
            const bulletCharRaw = bulletXml.match(/<a:buChar\b[^>]*char="([^"]+)"/)?.[1];
            const autoNum = bulletXml.match(/<a:buAutoNum\b[^>]*\/?>/)?.[0] || '';
            const underline = this.getAttr(rPr, 'u');
            const strike = this.getAttr(rPr, 'strike');
            const characterSpacing = Number(this.getAttr(rPr, 'spc') || 0);
            const lineSpacing = this.extractParagraphSpacing(pPr, 'lnSpc');
            const beforeSpacing = this.extractParagraphSpacing(pPr, 'spcBef');
            const afterSpacing = this.extractParagraphSpacing(pPr, 'spcAft');

            paragraphs.push({
                text,
                level: Number.isFinite(level) ? level : 0,
                bullet: hasBullet && !hasBuNone,
                bulletChar: bulletCharRaw ? this.decodeXmlEntities(bulletCharRaw) : undefined,
                numbered: !!autoNum && !hasBuNone,
                numberingFormat: this.getAttr(autoNum, 'type'),
                numberingStartAt: this.parseNumber(this.getAttr(autoNum, 'startAt')),
                align,
                fontSizePx: size > 0 ? Math.round((size / 100) * 1.333) : undefined,
                fontFamily: this.extractFontFamily(rPr, colors),
                bold: this.parseOptionalBoolAttr(rPr, 'b'),
                italic: this.parseOptionalBoolAttr(rPr, 'i'),
                underline: underline ? underline !== 'none' : undefined,
                strike: strike ? strike !== 'noStrike' : undefined,
                characterSpacingPx: characterSpacing ? (characterSpacing / 100) * 1.333 : undefined,
                color,
                lineSpacingPx: lineSpacing.px,
                lineSpacingPercent: lineSpacing.percent,
                spaceBeforePx: beforeSpacing.px,
                spaceAfterPx: afterSpacing.px,
                rtl: this.parseOptionalBoolAttr(inlinePPrTag, 'rtl'),
                runs: runs.length > 0 ? runs : undefined
            });
        }

        return paragraphs;
    }

    private static extractTextBoxProperties(shapeXml: string): Pick<
        ParsedElement,
        'textMargins' | 'verticalAlign' | 'autofit'
    > {
        const bodyPr = shapeXml.match(/<a:bodyPr\b[^>]*\/?>/)?.[0] || '';
        if (!bodyPr) return {};
        const inset = (name: string): number | undefined => {
            const raw = this.getAttr(bodyPr, name);
            return raw === undefined ? undefined : this.emuToPx(Number(raw));
        };
        let autofit: ParsedElement['autofit'];
        const body = this.extractTagBlock(shapeXml, 'a:bodyPr') || bodyPr;
        if (/<a:normAutofit\b/.test(body)) autofit = 'normal';
        else if (/<a:spAutoFit\b/.test(body)) autofit = 'shape';
        else if (/<a:noAutofit\b/.test(body)) autofit = 'none';
        const margins = {
            left: inset('lIns'),
            right: inset('rIns'),
            top: inset('tIns'),
            bottom: inset('bIns')
        };
        // Only emit textMargins when the shape actually declares an inset, so an
        // empty <a:bodyPr/> does not mask insets inherited from layout/master
        // through mergeElements' `incoming.textMargins || base.textMargins`.
        const hasMargin = Object.values(margins).some((item) => item !== undefined);
        return {
            ...(hasMargin ? { textMargins: margins } : {}),
            verticalAlign: this.getAttr(bodyPr, 'anchor'),
            autofit
        };
    }

    private static extractFontFamily(xml: string, colors: ColorContext): string | undefined {
        const tag = xml.match(/<a:(?:latin|ea|cs)\b[^>]*typeface="([^"]+)"/)?.[1];
        if (!tag) return undefined;
        const decoded = this.decodeXmlEntities(tag);
        return colors.themeFonts[decoded] || decoded;
    }

    private static extractParagraphSpacing(
        xml: string,
        tag: 'lnSpc' | 'spcBef' | 'spcAft'
    ): { px?: number; percent?: number } {
        const block = this.extractTagBlock(xml, `a:${tag}`) || '';
        const points = this.parseNumber(block.match(/<a:spcPts\b[^>]*val="([^"]+)"/)?.[1]);
        const percent = this.parseNumber(block.match(/<a:spcPct\b[^>]*val="([^"]+)"/)?.[1]);
        return {
            px: points === undefined ? undefined : (points / 100) * 1.333,
            percent: percent === undefined ? undefined : percent / 1000
        };
    }

    private static extractTableMargins(xml: string): import('../slide-model.js').TableCellMargins | undefined {
        const tcPr = xml.match(/<a:tcPr\b[^>]*>/)?.[0] || '';
        const value = (name: string): number | undefined => {
            const raw = this.getAttr(tcPr, name);
            return raw === undefined ? undefined : this.emuToPx(Number(raw));
        };
        const margins = {
            left: value('marL'),
            right: value('marR'),
            top: value('marT'),
            bottom: value('marB')
        };
        return Object.values(margins).some((item) => item !== undefined) ? margins : undefined;
    }

    private static extractTableBorders(
        xml: string,
        colors: ColorContext
    ): import('../slide-model.js').TableCellBorders | undefined {
        const side = (tag: string): string | undefined =>
            this.extractColorFromXml(this.extractTagBlock(xml, tag) || '', colors);
        const borders = {
            left: side('a:lnL'),
            right: side('a:lnR'),
            top: side('a:lnT'),
            bottom: side('a:lnB')
        };
        return Object.values(borders).some(Boolean) ? borders : undefined;
    }

    private static parseGeometry(xml: string): { x: number; y: number; width: number; height: number; rotateDeg?: number; flipH?: boolean; flipV?: boolean } | null {
        const xfrm = this.extractTagBlock(xml, 'a:xfrm') || this.extractTagBlock(xml, 'p:xfrm');
        if (!xfrm) return null;

        const off = xfrm.match(/<a:off[^>]*\/>/)?.[0] || '';
        const ext = xfrm.match(/<a:ext[^>]*\/>/)?.[0] || '';

        const x = Number(this.getAttr(off, 'x') || 0);
        const y = Number(this.getAttr(off, 'y') || 0);
        const cx = Number(this.getAttr(ext, 'cx') || 0);
        const cy = Number(this.getAttr(ext, 'cy') || 0);
        // Allow cx=0 or cy=0 so horizontal/vertical line connectors keep their position.
        if (!cx && !cy) return null;

        const rotRaw = Number(this.getAttr(xfrm, 'rot') || 0);
        const flipH = this.getAttr(xfrm, 'flipH') === '1';
        const flipV = this.getAttr(xfrm, 'flipV') === '1';

        return {
            x: this.emuToPx(x),
            y: this.emuToPx(y),
            width: this.emuToPx(cx),
            height: this.emuToPx(cy),
            rotateDeg: rotRaw ? rotRaw / 60000 : undefined,
            flipH: flipH || undefined,
            flipV: flipV || undefined
        };
    }

    private static parseGroupTransform(xml: string): Transform {
        const grpPr = this.extractTagBlock(xml, 'p:grpSpPr');
        const xfrm = grpPr ? this.extractTagBlock(grpPr, 'a:xfrm') : '';
        if (!xfrm) {
            return ZERO_TX;
        }

        const off = xfrm.match(/<a:off[^>]*\/>/)?.[0] || '';
        const ext = xfrm.match(/<a:ext[^>]*\/>/)?.[0] || '';
        const chOff = xfrm.match(/<a:chOff[^>]*\/>/)?.[0] || '';
        const chExt = xfrm.match(/<a:chExt[^>]*\/>/)?.[0] || '';

        const offX = Number(this.getAttr(off, 'x') || 0);
        const offY = Number(this.getAttr(off, 'y') || 0);
        const extX = Number(this.getAttr(ext, 'cx') || 1);
        const extY = Number(this.getAttr(ext, 'cy') || 1);
        const chOffX = Number(this.getAttr(chOff, 'x') || 0);
        const chOffY = Number(this.getAttr(chOff, 'y') || 0);
        const chExtX = Number(this.getAttr(chExt, 'cx') || extX || 1);
        const chExtY = Number(this.getAttr(chExt, 'cy') || extY || 1);

        const sx = extX / (chExtX || 1);
        const sy = extY / (chExtY || 1);
        const rotRaw = Number(this.getAttr(xfrm, 'rot') || 0);

        return {
            offX: this.emuToPx(offX - chOffX * sx),
            offY: this.emuToPx(offY - chOffY * sy),
            scaleX: sx,
            scaleY: sy,
            rotDeg: rotRaw ? rotRaw / 60000 : 0
        };
    }

    private static combineTransforms(parent: Transform, child: Transform): Transform {
        return {
            offX: parent.offX + child.offX * parent.scaleX,
            offY: parent.offY + child.offY * parent.scaleY,
            scaleX: parent.scaleX * child.scaleX,
            scaleY: parent.scaleY * child.scaleY,
            rotDeg: (parent.rotDeg || 0) + (child.rotDeg || 0)
        };
    }

    private static applyTransform(
        geom: { x: number; y: number; width: number; height: number; rotateDeg?: number; flipH?: boolean; flipV?: boolean },
        tx: Transform
    ): { x: number; y: number; width: number; height: number; rotateDeg?: number; flipH?: boolean; flipV?: boolean } {
        return {
            x: Math.round(tx.offX + geom.x * tx.scaleX),
            y: Math.round(tx.offY + geom.y * tx.scaleY),
            width: Math.round(geom.width * tx.scaleX),
            height: Math.round(geom.height * tx.scaleY),
            rotateDeg: (geom.rotateDeg || 0) + (tx.rotDeg || 0),
            flipH: geom.flipH,
            flipV: geom.flipV
        };
    }

    private static parseTheme(themeXml: string): ThemeInfo {
        const colors: Record<string, string> = {
            lt1: '#ffffff',
            dk1: '#000000',
            lt2: '#eeeeee',
            dk2: '#222222',
            accent1: '#4472c4',
            accent2: '#ed7d31',
            accent3: '#a5a5a5',
            accent4: '#ffc000',
            accent5: '#5b9bd5',
            accent6: '#70ad47'
        };
        const fonts: Record<string, string> = {};

        if (!themeXml) return { colors, fonts };

        const clrScheme = this.extractTagBlock(themeXml, 'a:clrScheme') || '';
        const keys = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
        for (const key of keys) {
            const block = this.extractTagBlock(clrScheme, `a:${key}`) || '';
            const srgb = block.match(/<a:srgbClr[^>]*val="([^"]+)"/)?.[1];
            const sys = block.match(/<a:sysClr[^>]*lastClr="([^"]+)"/)?.[1];
            if (srgb) colors[key] = `#${srgb}`;
            else if (sys) colors[key] = `#${sys}`;
        }

        const majorFont = this.extractTagBlock(themeXml, 'a:majorFont') || '';
        const minorFont = this.extractTagBlock(themeXml, 'a:minorFont') || '';
        const family = (xml: string, tag: 'latin' | 'ea'): string | undefined =>
            xml.match(new RegExp(`<a:${tag}\\b[^>]*typeface="([^"]*)"`))?.[1] || undefined;
        const majorLatin = family(majorFont, 'latin');
        const majorEa = family(majorFont, 'ea');
        const minorLatin = family(minorFont, 'latin');
        const minorEa = family(minorFont, 'ea');
        if (majorLatin) fonts['+mj-lt'] = this.decodeXmlEntities(majorLatin);
        if (majorEa) fonts['+mj-ea'] = this.decodeXmlEntities(majorEa);
        if (minorLatin) fonts['+mn-lt'] = this.decodeXmlEntities(minorLatin);
        if (minorEa) fonts['+mn-ea'] = this.decodeXmlEntities(minorEa);

        return { colors, fonts };
    }

    private static extractBackgroundColor(xml: string, colors: ColorContext): string | undefined {
        if (!xml) return undefined;
        const bgPr = this.extractTagBlock(xml, 'p:bgPr') || '';
        if (!bgPr) return undefined;
        const solid = this.extractColorFromXml(bgPr, colors);
        if (solid) return solid;

        const gradFill = this.extractTagBlock(bgPr, 'a:gradFill') || '';
        if (gradFill) {
            const stops = gradFill.match(/<a:gs\b[\s\S]*?<\/a:gs>/g) || [];
            const lastStop = stops[stops.length - 1] || gradFill;
            return this.extractColorFromXml(lastStop, colors);
        }

        return undefined;
    }

    private static extractFillColor(xml: string, colors: ColorContext): string | undefined {
        const spPr = this.extractTagBlock(xml, 'p:spPr') || xml;
        // Strip nested blocks (line, effects, 3d) that contain their own solidFill
        // so we don't mistake line color for fill color.
        const fillScope = this.stripNestedBlocks(spPr, ['a:ln', 'a:effectLst', 'a:scene3d', 'a:sp3d']);

        // Explicit <a:noFill/> means no fill regardless of style refs.
        if (/<a:noFill\b[^>]*\/?>/.test(fillScope)) {
            return undefined;
        }

        const solid = this.extractTagBlock(fillScope, 'a:solidFill') || '';
        const solidColor = this.extractColorFromXml(solid, colors);
        if (solidColor) return solidColor;

        const gradFill = this.extractTagBlock(fillScope, 'a:gradFill') || '';
        if (gradFill) {
            const stops = gradFill.match(/<a:gs\b[\s\S]*?<\/a:gs>/g) || [];
            const firstStop = stops[0] || gradFill;
            const lastStop = stops[stops.length - 1] || gradFill;
            return this.extractColorFromXml(firstStop, colors) || this.extractColorFromXml(lastStop, colors);
        }

        const style = this.extractTagBlock(xml, 'p:style') || '';
        const fillRef = this.extractTagBlock(style, 'a:fillRef') || '';
        return this.extractColorFromXml(fillRef, colors);
    }

    private static stripNestedBlocks(xml: string, tags: string[]): string {
        let result = xml;
        for (const tag of tags) {
            const re = new RegExp(`<${tag}\\b[^>]*/>|<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'g');
            result = result.replace(re, '');
        }
        return result;
    }

    private static extractLineColor(xml: string, colors: ColorContext): string | undefined {
        const spPr = this.extractTagBlock(xml, 'p:spPr') || xml;
        const ln = this.extractTagBlock(spPr, 'a:ln') || '';
        return this.extractColorFromXml(ln, colors);
    }

    private static extractColorFromXml(xml: string, colors: ColorContext): string | undefined {
        if (!xml) return undefined;
        const srgbNode = xml.match(/<a:srgbClr[^>]*val="([^"]+)"[^>]*\/>|<a:srgbClr[^>]*val="([^"]+)"[^>]*>[\s\S]*?<\/a:srgbClr>/);
        if (srgbNode) {
            const raw = srgbNode[1] || srgbNode[2];
            const base = raw ? `#${raw}` : undefined;
            if (base) return this.applyColorTransforms(base, srgbNode[0]);
        }

        const sysNode = xml.match(/<a:sysClr[^>]*lastClr="([^"]+)"[^>]*\/>|<a:sysClr[^>]*lastClr="([^"]+)"[^>]*>[\s\S]*?<\/a:sysClr>/);
        if (sysNode) {
            const raw = sysNode[1] || sysNode[2];
            const base = raw ? `#${raw}` : undefined;
            if (base) return this.applyColorTransforms(base, sysNode[0]);
        }

        const presetNode = xml.match(/<a:prstClr[^>]*val="([^"]+)"[^>]*\/>|<a:prstClr[^>]*val="([^"]+)"[^>]*>[\s\S]*?<\/a:prstClr>/);
        if (presetNode) {
            const preset = presetNode[1] || presetNode[2];
            const presetColor = preset ? this.mapPresetColorName(preset) : undefined;
            if (presetColor) return this.applyColorTransforms(presetColor, presetNode[0]);
        }

        const schemeNode = xml.match(/<a:schemeClr[^>]*val="([^"]+)"[^>]*\/>|<a:schemeClr[^>]*val="([^"]+)"[^>]*>[\s\S]*?<\/a:schemeClr>/);
        if (schemeNode) {
            const scheme = ((schemeNode[1] || schemeNode[2]) || '').trim();
            if (scheme) {
                let base = colors.themeColors[scheme];
                if (!base) {
                    const mapped = colors.clrMap[scheme];
                    if (mapped) base = colors.themeColors[mapped];
                }
                if (base) return this.applyColorTransforms(base, schemeNode[0]);
            }
        }
        return undefined;
    }

    private static isTitleShape(xml: string): boolean {
        const phType = xml.match(/<p:ph[^>]*type="([^"]+)"/)?.[1] || '';
        if (phType === 'title' || phType === 'ctrTitle') return true;
        const name = xml.match(/<p:cNvPr[^>]*name="([^"]+)"/)?.[1] || '';
        // Avoid treating subtitle placeholders as title.
        if (/subtitle/i.test(name)) return false;
        return /^title\b/i.test(name) || /title placeholder/i.test(name);
    }

    private static getPlaceholderKey(xml: string): string | undefined {
        const ph = xml.match(/<p:ph[^>]*\/>/)?.[0] || xml.match(/<p:ph[^>]*>/)?.[0] || '';
        if (!ph) return undefined;
        const rawIdx = this.getAttr(ph, 'idx') || '0';
        const idx = (rawIdx && rawIdx !== '0' && rawIdx !== '4294967295') ? rawIdx : undefined;
        const type = (this.getAttr(ph, 'type') || 'body').toLowerCase();
        const normalizedType = this.normalizePlaceholderType(type);
        if (normalizedType === 'title' || normalizedType === 'body' || normalizedType === 'sldnum' || normalizedType === 'ftr' || normalizedType === 'dt') {
            return `type:${normalizedType}`;
        }
        if (idx) {
            return `idx:${idx}`;
        }
        return `type:${normalizedType}`;
    }

    private static normalizePlaceholderType(type: string): string {
        if (type === 'title' || type === 'ctrtitle') return 'title';
        if (type === 'subtitle' || type === 'subTitle'.toLowerCase()) return 'body';
        if (type === 'sldnum') return 'sldnum';
        if (type === 'body' || type === 'obj' || type === 'content') return 'body';
        return type;
    }

    private static getPlaceholderType(xml: string): string | undefined {
        const ph = xml.match(/<p:ph[^>]*\/>/)?.[0] || xml.match(/<p:ph[^>]*>/)?.[0] || '';
        if (!ph) return undefined;
        const type = (this.getAttr(ph, 'type') || '').toLowerCase();
        return type || undefined;
    }

    private static async getSlideSize(zip: JSZip): Promise<{ widthPx: number; heightPx: number }> {
        const presentation = await this.readZipText(zip, 'ppt/presentation.xml');
        const szTag = presentation.match(/<p:sldSz[^>]*\/>/)?.[0] || '';
        const cx = Number(this.getAttr(szTag, 'cx') || 0);
        const cy = Number(this.getAttr(szTag, 'cy') || 0);

        if (!cx || !cy) return { widthPx: 1280, heightPx: 720 };

        const widthPx = this.emuToPx(cx);
        const heightPx = this.emuToPx(cy);
        if (widthPx < 300 || heightPx < 200) return { widthPx: 1280, heightPx: 720 };
        return { widthPx, heightPx };
    }

    private static async getOrderedSlidePaths(zip: JSZip): Promise<string[]> {
        const presentationXml = await this.readZipText(zip, 'ppt/presentation.xml');
        const rels = await this.getRelationships(zip, 'ppt/presentation.xml');

        const relMap = new Map<string, string>();
        rels.forEach((r) => relMap.set(r.id, r.target));

        const ordered: string[] = [];
        const idMatches = presentationXml.match(/<p:sldId[^>]*r:id="([^"]+)"[^>]*\/?/g) || [];
        for (const match of idMatches) {
            const id = match.match(/r:id="([^"]+)"/)?.[1];
            if (!id) continue;
            const target = relMap.get(id);
            if (target && zip.file(target)) ordered.push(target);
        }

        if (ordered.length > 0) return ordered;

        return Object.keys(zip.files)
            .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
            .sort((a, b) => {
                const na = Number(a.match(/slide(\d+)\.xml/i)?.[1] || 0);
                const nb = Number(b.match(/slide(\d+)\.xml/i)?.[1] || 0);
                return na - nb;
            });
    }

    private static async getRelationships(zip: JSZip, partPath: string): Promise<Relationship[]> {
        const relPath = this.toRelsPath(partPath);
        const relXml = await this.readZipText(zip, relPath);
        if (!relXml) return [];

        const list: Relationship[] = [];
        const re = /<Relationship[^>]*Id="([^"]+)"[^>]*Type="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(relXml)) !== null) {
            list.push({
                id: m[1],
                type: m[2],
                target: this.resolvePath(partPath, m[3])
            });
        }
        return list;
    }

    private static toRelsPath(partPath: string): string {
        const dir = path.posix.dirname(partPath);
        const base = path.posix.basename(partPath);
        return path.posix.join(dir, '_rels', `${base}.rels`);
    }

    private static resolvePath(basePath: string, target: string): string {
        if (target.startsWith('/')) {
            return target.replace(/^\/+/, '');
        }
        return path.posix.normalize(path.posix.join(path.posix.dirname(basePath), target));
    }

    private static async readZipText(zip: JSZip, zipPath: string): Promise<string> {
        const file = zip.file(zipPath);
        if (!file) return '';
        return await file.async('text');
    }

    private static extractBalancedTag(
        xml: string,
        tag: string,
        startAt: number
    ): { content: string; innerContent: string; end: number } | null {
        const closeToken = `</${tag}>`;
        let pos = startAt;

        const firstOpen = this.findNextTagIndex(xml, tag, pos);
        if (firstOpen !== startAt) return null;

        const firstClose = xml.indexOf('>', firstOpen);
        if (firstClose === -1) return null;

        // Self-closing tag
        const beforeClose = xml.slice(firstOpen, firstClose + 1);
        if (/\/\s*>$/.test(beforeClose)) {
            return {
                content: xml.slice(firstOpen, firstClose + 1),
                innerContent: '',
                end: firstClose + 1
            };
        }

        let depth = 1;
        pos = firstClose + 1;

        while (depth > 0) {
            const nextOpen = this.findNextTagIndex(xml, tag, pos);
            const nextClose = xml.indexOf(closeToken, pos);
            if (nextClose === -1) return null;

            if (nextOpen !== -1 && nextOpen < nextClose) {
                const openEnd = xml.indexOf('>', nextOpen);
                if (openEnd === -1) return null;
                if (xml[openEnd - 1] !== '/') {
                    depth += 1;
                }
                pos = openEnd + 1;
            } else {
                depth -= 1;
                pos = nextClose + closeToken.length;
            }
        }

        return {
            content: xml.slice(firstOpen, pos),
            innerContent: xml.slice(firstClose + 1, pos - closeToken.length),
            end: pos
        };
    }

    private static extractTagBlock(xml: string, tag: string): string {
        const idx = xml.indexOf(`<${tag}`);
        if (idx === -1) return '';
        return this.extractBalancedTag(xml, tag, idx)?.content || '';
    }

    private static getAttr(tag: string, attr: string): string | undefined {
        if (!tag) return undefined;
        const escaped = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return tag.match(new RegExp(`${escaped}=(?:"([^"]+)"|'([^']+)')`))?.[1]
            || tag.match(new RegExp(`${escaped}=(?:"([^"]+)"|'([^']+)')`))?.[2];
    }

    private static parseOptionalBoolAttr(tag: string, attr: string): boolean | undefined {
        const raw = this.getAttr(tag, attr);
        if (raw === undefined) return undefined;
        return raw === '1' || raw.toLowerCase() === 'true';
    }

    private static emuToPx(emu: number): number {
        return Math.round(emu / 9525);
    }

    private static decodeXmlEntities(input: string): string {
        return input
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#xD;/gi, '')
            .replace(/&#xA;/gi, ' ')
            .replace(/&#10;/g, ' ');
    }

    private static extractParagraphLevelStyle(lstStyle: string, level: number): string {
        if (!lstStyle) return '';
        const normalizedLevel = Math.max(0, Math.min(8, Number.isFinite(level) ? level : 0)) + 1;
        return this.extractTagBlock(lstStyle, `a:lvl${normalizedLevel}pPr`) || '';
    }

    private static buildColorContext(
        theme: ThemeInfo,
        masterXml: string,
        layoutXml: string,
        slideXml: string
    ): ColorContext {
        const masterMap = this.parseMasterClrMap(masterXml);
        const layoutOverride = this.parseClrMapOverride(layoutXml);
        const slideOverride = this.parseClrMapOverride(slideXml);

        let clrMap = { ...masterMap };
        if (layoutOverride) {
            clrMap = { ...clrMap, ...layoutOverride };
        }
        if (slideOverride) {
            clrMap = { ...clrMap, ...slideOverride };
        }

        return {
            themeColors: theme.colors,
            themeFonts: theme.fonts,
            clrMap
        };
    }

    private static parseMasterClrMap(masterXml: string): Record<string, string> {
        const defaults: Record<string, string> = {
            bg1: 'lt1',
            tx1: 'dk1',
            bg2: 'lt2',
            tx2: 'dk2',
            accent1: 'accent1',
            accent2: 'accent2',
            accent3: 'accent3',
            accent4: 'accent4',
            accent5: 'accent5',
            accent6: 'accent6',
            hlink: 'hlink',
            folHlink: 'folHlink'
        };

        const clrMapTag = masterXml.match(/<p:clrMap\b[^>]*\/>/)?.[0] || '';
        if (!clrMapTag) {
            return defaults;
        }

        const keys = Object.keys(defaults);
        const parsed: Record<string, string> = { ...defaults };
        keys.forEach((key) => {
            const value = this.getAttr(clrMapTag, key);
            if (value) parsed[key] = value;
        });
        return parsed;
    }

    private static parseClrMapOverride(xml: string): Record<string, string> | null {
        if (!xml) return null;
        const clrMapOvr = this.extractTagBlock(xml, 'p:clrMapOvr') || '';
        if (!clrMapOvr) return null;
        if (clrMapOvr.includes('<a:masterClrMapping')) {
            return null;
        }

        const overrideTag = clrMapOvr.match(/<a:overrideClrMapping\b[^>]*\/>/)?.[0] || '';
        if (!overrideTag) return null;

        const keys = ['bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
        const parsed: Record<string, string> = {};
        keys.forEach((key) => {
            const value = this.getAttr(overrideTag, key);
            if (value) parsed[key] = value;
        });
        return Object.keys(parsed).length > 0 ? parsed : null;
    }

    private static parseChartData(xml: string, colors: ColorContext): ParsedElement['chartData'] | undefined {
        if (!xml) return undefined;

        const lineChart = this.extractTagBlock(xml, 'c:lineChart');
        if (lineChart) {
            const parsedLineChart = this.parseLineChartData(xml, lineChart, colors);
            if (parsedLineChart) return parsedLineChart;
        }

        const pieChart = this.extractTagBlock(xml, 'c:pieChart')
            || this.extractTagBlock(xml, 'c:pie3DChart');
        if (pieChart) {
            const parsedPieChart = this.parsePieChartData(xml, pieChart, colors);
            if (parsedPieChart) return parsedPieChart;
        }

        const barChart = this.extractTagBlock(xml, 'c:barChart');
        if (!barChart) return undefined;

        const grouping = barChart.match(/<c:grouping[^>]*val="([^"]+)"/)?.[1] || '';
        const barDir = barChart.match(/<c:barDir[^>]*val="([^"]+)"/)?.[1] || '';
        const normalizedGrouping = grouping || 'clustered';
        const kindBySemantics: Record<string, import('../slide-model.js').SlideChartKind> = {
            'col:clustered': 'clusteredColumn',
            'col:stacked': 'stackedColumn',
            'col:percentStacked': 'percentStackedColumn',
            'bar:clustered': 'clusteredBar',
            'bar:stacked': 'stackedBar',
            'bar:percentStacked': 'percentStackedBar'
        };
        const kind = kindBySemantics[`${barDir || 'col'}:${normalizedGrouping}`];
        if (!kind) return undefined;

        const serBlocks = barChart.match(/<c:ser\b[\s\S]*?<\/c:ser>/g) || [];
        if (serBlocks.length === 0) return undefined;

        let categories: string[] = [];
        const series = serBlocks.map((serXml, idx) => {
            const name = this.decodeXmlEntities(
                serXml.match(/<c:tx[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/)?.[1]
                || `Series ${idx + 1}`
            );

            const spPr = this.extractTagBlock(serXml, 'c:spPr') || '';
            const palette = ['#8a8a8a', '#d10000', '#4f81bd', '#9bbb59', '#8064a2', '#f79646'];
            const seriesColor = this.extractColorFromXml(spPr, colors) || palette[idx % palette.length];

            if (categories.length === 0) {
                const categoryPts = serXml.match(/<c:cat[\s\S]*?<\/c:cat>/)?.[0] || '';
                categories = this.extractChartPoints(categoryPts);
            }

            const valuePts = serXml.match(/<c:val[\s\S]*?<\/c:val>/)?.[0] || '';
            const values = this.extractChartNumericPoints(valuePts, categories.length || undefined);
            const valueFormatRaw = valuePts.match(/<c:formatCode>([\s\S]*?)<\/c:formatCode>/)?.[1];
            const dataLabel = this.parseSeriesDataLabel(serXml, colors);
            return {
                name,
                color: seriesColor,
                values,
                valueFormat: valueFormatRaw ? this.decodeXmlEntities(valueFormatRaw) : undefined,
                dataLabel
            };
        });

        if (categories.length === 0) {
            const maxLen = Math.max(...series.map((s) => s.values.length));
            categories = Array.from({ length: maxLen }, (_, i) => `${i + 1}`);
        }

        const normalizedSeries = series.map((s) => ({
            ...s,
            values: this.padValues(s.values, categories.length)
        }));

        const gapWidth = this.parseNumber(barChart.match(/<c:gapWidth[^>]*val="([^"]+)"/)?.[1]);
        const overlap = this.parseNumber(barChart.match(/<c:overlap[^>]*val="([^"]+)"/)?.[1]);
        const categoryAxis = this.parseCategoryAxis(xml, colors);
        const valueAxis = this.parseValueAxis(xml, colors);
        const legend = this.parseLegend(xml, colors);

        return {
            kind,
            grouping: normalizedGrouping,
            barDir: barDir || 'col',
            categories,
            series: normalizedSeries,
            gapWidth,
            overlap,
            categoryAxis,
            valueAxis,
            legend
        };
    }

    private static parsePieChartData(
        chartXml: string,
        pieChart: string,
        colors: ColorContext
    ): ParsedElement['chartData'] | undefined {
        const serXml = pieChart.match(/<c:ser\b[\s\S]*?<\/c:ser>/)?.[0] || '';
        if (!serXml) return undefined;
        const categories = this.extractChartPoints(
            serXml.match(/<c:cat[\s\S]*?<\/c:cat>/)?.[0] || ''
        );
        const values = this.extractChartNumericPoints(
            serXml.match(/<c:val[\s\S]*?<\/c:val>/)?.[0] || '',
            categories.length || undefined
        );
        const pointColors = new Map<number, string>();
        for (const point of serXml.match(/<c:dPt\b[\s\S]*?<\/c:dPt>/g) || []) {
            const index = Number(point.match(/<c:idx\b[^>]*val="(\d+)"/)?.[1] || -1);
            const color = this.extractColorFromXml(point, colors);
            if (index >= 0 && color) pointColors.set(index, color);
        }
        const palette = ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'];
        const dataLabel = this.parseSeriesDataLabel(serXml, colors)
            || this.parseSeriesDataLabel(pieChart, colors);
        const series = categories.map((category, index) => ({
            name: category || `Point ${index + 1}`,
            color: pointColors.get(index) || palette[index % palette.length],
            values: [values[index] ?? 0],
            dataLabel
        }));
        if (!series.length && values.length) {
            values.forEach((value, index) => {
                categories.push(`${index + 1}`);
                series.push({
                    name: `${index + 1}`,
                    color: palette[index % palette.length],
                    values: [value],
                    dataLabel
                });
            });
        }
        return {
            kind: 'pie',
            categories,
            series,
            legend: this.parseLegend(chartXml, colors)
        };
    }

    private static parseLineChartData(
        chartXml: string,
        lineChart: string,
        colors: ColorContext
    ): ParsedElement['chartData'] | undefined {
        const serBlocks = lineChart.match(/<c:ser\b[\s\S]*?<\/c:ser>/g) || [];
        if (serBlocks.length === 0) return undefined;

        let categories: string[] = [];
        const series = serBlocks.map((serXml, idx) => {
            const name = this.decodeXmlEntities(
                serXml.match(/<c:tx[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/)?.[1]
                || `Series ${idx + 1}`
            );

            const spPr = this.extractTagBlock(serXml, 'c:spPr') || '';
            const palette = ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'];
            const seriesColor = this.extractColorFromXml(spPr, colors) || palette[idx % palette.length];

            if (categories.length === 0) {
                const categoryPts = serXml.match(/<c:cat[\s\S]*?<\/c:cat>/)?.[0] || '';
                categories = this.extractChartPoints(categoryPts);
            }

            const valuePts = serXml.match(/<c:val[\s\S]*?<\/c:val>/)?.[0] || '';
            const values = this.extractChartNumericPoints(valuePts, categories.length || undefined);
            const valueFormatRaw = valuePts.match(/<c:formatCode>([\s\S]*?)<\/c:formatCode>/)?.[1];
            const dataLabel = this.parseSeriesDataLabel(serXml, colors);

            return {
                name,
                color: seriesColor,
                values,
                valueFormat: valueFormatRaw ? this.decodeXmlEntities(valueFormatRaw) : undefined,
                dataLabel
            };
        });

        if (categories.length === 0) {
            const maxLen = Math.max(...series.map((s) => s.values.length));
            categories = Array.from({ length: maxLen }, (_, i) => `${i + 1}`);
        }

        const normalizedSeries = series.map((s) => ({
            ...s,
            values: this.padValues(s.values, categories.length)
        }));
        const categoryAxis = this.parseCategoryAxis(chartXml, colors);
        const valueAxis = this.parseValueAxis(chartXml, colors);
        const legend = this.parseLegend(chartXml, colors);

        return {
            kind: 'line',
            categories,
            series: normalizedSeries,
            categoryAxis,
            valueAxis,
            legend
        };
    }

    private static parseSeriesDataLabel(
        serXml: string,
        colors: ColorContext
    ): { showValue?: boolean; numFmt?: string; fontSizePx?: number; color?: string } | undefined {
        const dLbls = this.extractTagBlock(serXml, 'c:dLbls') || '';
        if (!dLbls) return undefined;

        const txPr = this.extractTagBlock(dLbls, 'c:txPr') || '';
        const style = this.parseTxPrStyle(txPr, colors);
        const numFmtRaw = dLbls.match(/<c:numFmt[^>]*formatCode="([^"]+)"/)?.[1];
        const showValRaw = dLbls.match(/<c:showVal[^>]*val="([^"]+)"/)?.[1];
        const numFmt = numFmtRaw ? this.decodeXmlEntities(numFmtRaw) : undefined;
        const showValue = showValRaw === '1' ? true : (showValRaw === '0' ? false : undefined);

        if (showValue === undefined && !numFmt && !style.fontSizePx && !style.color) {
            return undefined;
        }

        return {
            showValue,
            numFmt,
            fontSizePx: style.fontSizePx,
            color: style.color
        };
    }

    private static parseCategoryAxis(
        chartXml: string,
        colors: ColorContext
    ): { numFmt?: string; fontSizePx?: number; color?: string; lineColor?: string } | undefined {
        const catAx = this.extractTagBlock(chartXml, 'c:catAx') || '';
        if (!catAx) return undefined;

        const txPr = this.extractTagBlock(catAx, 'c:txPr') || '';
        const style = this.parseTxPrStyle(txPr, colors);
        const lineColor = this.extractColorFromXml(this.extractTagBlock(catAx, 'c:spPr') || '', colors);
        const numFmtRaw = catAx.match(/<c:numFmt[^>]*formatCode="([^"]+)"/)?.[1];
        const numFmt = numFmtRaw ? this.decodeXmlEntities(numFmtRaw) : undefined;

        return {
            numFmt,
            fontSizePx: style.fontSizePx,
            color: style.color,
            lineColor
        };
    }

    private static parseValueAxis(
        chartXml: string,
        colors: ColorContext
    ): {
        numFmt?: string;
        fontSizePx?: number;
        color?: string;
        lineColor?: string;
        gridColor?: string;
        majorUnit?: number;
        min?: number;
        max?: number;
        crossesAt?: number;
    } | undefined {
        const valAx = this.extractTagBlock(chartXml, 'c:valAx') || '';
        if (!valAx) return undefined;

        const txPr = this.extractTagBlock(valAx, 'c:txPr') || '';
        const style = this.parseTxPrStyle(txPr, colors);
        const lineColor = this.extractColorFromXml(this.extractTagBlock(valAx, 'c:spPr') || '', colors);
        const majorGridColor = this.extractColorFromXml(this.extractTagBlock(valAx, 'c:majorGridlines') || '', colors);
        const numFmtRaw = valAx.match(/<c:numFmt[^>]*formatCode="([^"]+)"/)?.[1];
        const numFmt = numFmtRaw ? this.decodeXmlEntities(numFmtRaw) : undefined;

        const scaling = this.extractTagBlock(valAx, 'c:scaling') || '';
        const min = this.parseNumber(scaling.match(/<c:min[^>]*val="([^"]+)"/)?.[1]);
        const max = this.parseNumber(scaling.match(/<c:max[^>]*val="([^"]+)"/)?.[1]);
        const majorUnit = this.parseNumber(valAx.match(/<c:majorUnit[^>]*val="([^"]+)"/)?.[1]);
        const crossesAt = this.parseNumber(valAx.match(/<c:crossesAt[^>]*val="([^"]+)"/)?.[1]);

        return {
            numFmt,
            fontSizePx: style.fontSizePx,
            color: style.color,
            lineColor,
            gridColor: majorGridColor,
            majorUnit,
            min,
            max,
            crossesAt
        };
    }

    private static parseLegend(
        chartXml: string,
        colors: ColorContext
    ): { position?: string; fontSizePx?: number; color?: string; align?: string } | undefined {
        const legend = this.extractTagBlock(chartXml, 'c:legend') || '';
        if (!legend) return undefined;

        const position = legend.match(/<c:legendPos[^>]*val="([^"]+)"/)?.[1];
        const txPr = this.extractTagBlock(legend, 'c:txPr') || '';
        const style = this.parseTxPrStyle(txPr, colors);

        return {
            position: position || undefined,
            fontSizePx: style.fontSizePx,
            color: style.color,
            align: style.align
        };
    }

    private static parseTxPrStyle(
        txPr: string,
        colors: ColorContext
    ): { fontSizePx?: number; color?: string; align?: string } {
        if (!txPr) return {};
        const pPr = txPr.match(/<a:pPr[^>]*\/?>/)?.[0] || '';
        const defRPr = txPr.match(/<a:defRPr[^>]*\/?>/)?.[0] || '';
        const endRPr = txPr.match(/<a:endParaRPr[^>]*\/?>/)?.[0] || '';
        const fontRaw = Number(this.getAttr(defRPr, 'sz') || this.getAttr(endRPr, 'sz') || 0);
        const color = this.extractColorFromXml(defRPr || txPr, colors);
        return {
            fontSizePx: fontRaw > 0 ? Math.round((fontRaw / 100) * 1.333) : undefined,
            color,
            align: this.getAttr(pPr, 'algn') || undefined
        };
    }

    private static extractChartPoints(xml: string): string[] {
        if (!xml) return [];
        const out: Array<{ idx: number; value: string }> = [];
        const pts = xml.match(/<c:pt\b[\s\S]*?<\/c:pt>/g) || [];
        pts.forEach((pt) => {
            const idx = Number(pt.match(/idx="(\d+)"/)?.[1] || 0);
            const raw = pt.match(/<c:v>([\s\S]*?)<\/c:v>/)?.[1] || '';
            out.push({ idx, value: this.decodeXmlEntities(raw) });
        });
        out.sort((a, b) => a.idx - b.idx);
        return out.map((p) => p.value);
    }

    private static extractChartNumericPoints(xml: string, fallbackLength?: number): number[] {
        const values: number[] = [];
        if (!xml) return fallbackLength ? Array.from({ length: fallbackLength }, () => 0) : values;

        const pts = xml.match(/<c:pt\b[\s\S]*?<\/c:pt>/g) || [];
        pts.forEach((pt) => {
            const idx = Number(pt.match(/idx="(\d+)"/)?.[1] || 0);
            const raw = pt.match(/<c:v>([\s\S]*?)<\/c:v>/)?.[1] || '';
            const n = Number(raw);
            if (!Number.isNaN(n)) {
                values[idx] = n;
            }
        });

        if (fallbackLength && values.length < fallbackLength) {
            for (let i = 0; i < fallbackLength; i++) {
                if (!Number.isFinite(values[i])) values[i] = 0;
            }
        }

        return values.map((v) => (Number.isFinite(v) ? v : 0));
    }

    private static padValues(values: number[], length: number): number[] {
        const out = Array.from({ length }, (_, i) => values[i] || 0);
        return out;
    }

    private static parseCustomGeometryPath(shapeXml: string, width: number, height: number): string | undefined {
        const custGeom = this.extractTagBlock(shapeXml, 'a:custGeom');
        if (!custGeom || width <= 0 || height <= 0) return undefined;

        const pathBlocks = custGeom.match(/<a:path\b[\s\S]*?<\/a:path>/g) || [];
        if (pathBlocks.length === 0) return undefined;

        const pathData: string[] = [];
        for (const pathBlock of pathBlocks) {
            const rawW = Number(this.getAttr(pathBlock, 'w') || 0);
            const rawH = Number(this.getAttr(pathBlock, 'h') || 0);
            const scaleX = rawW > 0 ? width / rawW : 1;
            const scaleY = rawH > 0 ? height / rawH : 1;
            const commandBlocks = pathBlock.match(/<a:(?:moveTo|lnTo|cubicBezTo)\b[\s\S]*?<\/a:(?:moveTo|lnTo|cubicBezTo)>|<a:close\s*\/>/g) || [];

            for (const commandBlock of commandBlocks) {
                if (commandBlock.startsWith('<a:moveTo')) {
                    const pt = this.extractPathPoint(commandBlock, 0, scaleX, scaleY);
                    if (pt) pathData.push(`M ${pt.x} ${pt.y}`);
                } else if (commandBlock.startsWith('<a:lnTo')) {
                    const pt = this.extractPathPoint(commandBlock, 0, scaleX, scaleY);
                    if (pt) pathData.push(`L ${pt.x} ${pt.y}`);
                } else if (commandBlock.startsWith('<a:cubicBezTo')) {
                    const p1 = this.extractPathPoint(commandBlock, 0, scaleX, scaleY);
                    const p2 = this.extractPathPoint(commandBlock, 1, scaleX, scaleY);
                    const p3 = this.extractPathPoint(commandBlock, 2, scaleX, scaleY);
                    if (p1 && p2 && p3) {
                        pathData.push(`C ${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`);
                    }
                } else if (commandBlock.startsWith('<a:close')) {
                    pathData.push('Z');
                }
            }
        }

        return pathData.length > 0 ? pathData.join(' ') : undefined;
    }

    private static extractPathPoint(
        xml: string,
        index: number,
        scaleX: number,
        scaleY: number
    ): { x: number; y: number } | null {
        const pointTags = xml.match(/<a:pt\b[^>]*x="[^"]+"[^>]*y="[^"]+"[^>]*\/>/g) || [];
        const pointTag = pointTags[index];
        if (!pointTag) return null;

        const x = Number(this.getAttr(pointTag, 'x') || 0);
        const y = Number(this.getAttr(pointTag, 'y') || 0);
        return {
            x: Math.round(x * scaleX * 1000) / 1000,
            y: Math.round(y * scaleY * 1000) / 1000
        };
    }

    private static mapPresetColorName(name: string): string | undefined {
        const n = name.toLowerCase();
        if (n === 'black') return '#000000';
        if (n === 'white') return '#ffffff';
        if (n === 'red') return '#ff0000';
        if (n === 'blue') return '#0000ff';
        if (n === 'green') return '#008000';
        if (n === 'gray' || n === 'grey') return '#808080';
        return undefined;
    }

    private static applyColorTransforms(hex: string, xml: string): string {
        const rgb = this.hexToRgb(hex);
        if (!rgb) return hex;

        const shade = Number(xml.match(/<a:shade[^>]*val="(\d+)"/)?.[1] || 100000) / 100000;
        const tint = Number(xml.match(/<a:tint[^>]*val="(\d+)"/)?.[1] || 0) / 100000;
        const lumMod = Number(xml.match(/<a:lumMod[^>]*val="(\d+)"/)?.[1] || 100000) / 100000;
        const lumOff = Number(xml.match(/<a:lumOff[^>]*val="(\d+)"/)?.[1] || 0) / 100000;

        const apply = (value: number): number => {
            let c = value * shade;
            c = c + (255 - c) * tint;
            c = c * lumMod + 255 * lumOff;
            return Math.max(0, Math.min(255, Math.round(c)));
        };

        return this.rgbToHex(apply(rgb.r), apply(rgb.g), apply(rgb.b));
    }

    private static hexToRgb(hex: string): { r: number; g: number; b: number } | null {
        const raw = hex.replace('#', '').trim();
        if (raw.length === 3) {
            const r = parseInt(raw[0] + raw[0], 16);
            const g = parseInt(raw[1] + raw[1], 16);
            const b = parseInt(raw[2] + raw[2], 16);
            if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
            return { r, g, b };
        }
        if (raw.length === 6) {
            const r = parseInt(raw.slice(0, 2), 16);
            const g = parseInt(raw.slice(2, 4), 16);
            const b = parseInt(raw.slice(4, 6), 16);
            if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
            return { r, g, b };
        }
        return null;
    }

    private static rgbToHex(r: number, g: number, b: number): string {
        return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    }

    private static parseNumber(raw: string | undefined): number | undefined {
        if (raw === undefined) return undefined;
        const value = Number(raw);
        return Number.isFinite(value) ? value : undefined;
    }

    private static isPlaceholderPromptText(text: string): boolean {
        const normalized = (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!normalized) return true;
        const promptPatterns = [
            /^click to edit master/i,
            /^click to edit/i,
            /^edit master text styles?$/i,
            /^insert text here$/i,
            /^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth) level$/i,
            /^list (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth) level$/i,
            /^click icon to add picture$/i,
            /^presentation title$/i,
            /^author$/i,
            /^department$/i,
            /^date$/i,
            /^location$/i,
            /^마스터 .* 스타일 편집$/i,
            /^마스터 텍스트 스타일을 편집합니다$/i,
            /^(첫째|둘째|셋째|넷째|다섯째|여섯째|일곱째|여덟째|아홉째) 수준$/i
        ];
        return promptPatterns.some((re) => re.test(normalized));
    }

    private static collectPartDiagnostics(
        slideXml: string,
        rels: Relationship[],
        context: ParserContext
    ): void {
        if (/<p:transition\b/.test(slideXml)) {
            this.addObjectDiagnostic(context, 'transition', 'omitted');
        }
        if (/<p:timing\b/.test(slideXml)) {
            this.addObjectDiagnostic(context, 'animation', 'omitted');
        }
        const hyperlinkCount = (
            slideXml.match(/<a:hlink(?:Click|MouseOver)\b|\baction="ppaction:/g) || []
        ).length;
        for (let i = 0; i < hyperlinkCount; i++) {
            this.addObjectDiagnostic(context, 'hyperlink', 'simplified');
        }
        if (/<p:oleObj\b|<p:embeddedFont\b/.test(slideXml)) {
            this.addObjectDiagnostic(context, 'ole', 'placeholder');
        }
        if (/<p:contentPart\b|<p14:media\b/.test(slideXml)) {
            this.addObjectDiagnostic(context, 'media', 'omitted');
        }
        for (const relationship of rels) {
            if (/\/(?:audio|video|media)$/.test(relationship.type)) {
                this.addObjectDiagnostic(context, 'media', 'omitted', undefined, {
                    target: relationship.target
                });
            } else if (/\/notesSlide$/.test(relationship.type)) {
                this.addObjectDiagnostic(context, 'notes', 'omitted', undefined, {
                    target: relationship.target
                });
            }
        }
    }

    private static addObjectDiagnostic(
        context: ParserContext,
        objectKind: SlideObjectDiagnostic['objectKind'],
        handling: SlideObjectDiagnostic['handling'],
        frame?: { x: number; y: number; width: number; height: number },
        args: Record<string, string | number> = {}
    ): void {
        const diagnostic: SlideObjectDiagnostic = {
            severity: 'warning',
            code: `pptx.${objectKind}.${handling}`,
            messageKey: 'diag.ppt.unsupported-object',
            args: {
                objectKind,
                handling,
                ...args
            },
            location: `slide:${context.slideNumber}`,
            slideNumber: context.slideNumber,
            objectKind,
            handling,
            ...(frame
                ? {
                    frame: {
                        x: frame.x,
                        y: frame.y,
                        width: frame.width,
                        height: frame.height
                    }
                }
                : {}),
            sourcePath: context.sourcePath
        };
        context.diagnostics.push(diagnostic);
    }

    private static isSupportedPresetGeometry(preset: string): boolean {
        return new Set([
            'rect',
            'roundRect',
            'ellipse',
            'oval',
            'triangle',
            'rightArrow',
            'leftArrow',
            'upArrow',
            'downArrow',
            'line',
            'straightConnector1'
        ]).has(preset);
    }

    private static async resolveImageSource(
        zip: JSZip,
        target: string,
        context: ParserContext,
        frame?: { x: number; y: number; width: number; height: number }
    ): Promise<{ src: string; vectorFallback?: boolean } | undefined> {
        const selectedTarget = this.resolveImageTarget(zip, target);
        const sourceExt = path.extname(target).toLowerCase();
        const selectedExt = path.extname(selectedTarget).toLowerCase();
        const metafile = sourceExt === '.emf' || sourceExt === '.wmf';
        const media = zip.file(selectedTarget);
        if (!media) {
            this.addObjectDiagnostic(context, 'image', 'placeholder', frame, {
                reason: 'missing-entry',
                target
            });
            return undefined;
        }

        if (!metafile || selectedTarget !== target) {
            const base64 = await media.async('base64');
            return {
                src: `data:${this.getMimeTypeByExtension(selectedTarget)};base64,${base64}`,
                vectorFallback: metafile && selectedTarget !== target
            };
        }

        // Preferred: convert the actual metafile to a raster/vector via the injected renderer.
        if (context.deps.renderMetafile) {
            try {
                context.guard.checkpoint(target);
                const bytes = await media.async('uint8array');
                const converted = await context.deps.renderMetafile(
                    bytes,
                    sourceExt.slice(1) as 'wmf' | 'emf',
                    context.guard.options.signal
                );
                context.guard.checkpoint(target);
                if (typeof converted === 'string' && converted) {
                    if (/^(?:data:|blob:|https?:)/i.test(converted)) {
                        return { src: converted };
                    }
                    if (converted.trimStart().startsWith('<svg')) {
                        return {
                            src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(converted)}`
                        };
                    }
                } else if (converted instanceof Uint8Array && converted.byteLength > 0) {
                    let binary = '';
                    for (let i = 0; i < converted.length; i += 0x8000) {
                        binary += String.fromCharCode(...converted.subarray(i, i + 0x8000));
                    }
                    return { src: `data:image/png;base64,${btoa(binary)}` };
                }
            } catch (error) {
                if (error?.name === 'PptxLimitError') throw error;
            }
        }

        // No conversion available/successful: a clean placeholder is safer than
        // substituting an unrelated same-directory raster (in PPTX every image lives
        // in ppt/media/, so a name-mismatched raster is almost certainly a different asset).
        this.addObjectDiagnostic(context, 'image', 'placeholder', frame, {
            reason: context.deps.renderMetafile
                ? 'metafile-conversion-failed'
                : 'metafile-converter-missing',
            type: sourceExt.slice(1)
        });
        return undefined;
    }

    private static resolveImageTarget(zip: JSZip, target: string): string {
        const ext = path.extname(target).toLowerCase();
        if (ext !== '.emf' && ext !== '.wmf') {
            return target;
        }

        const dir = path.posix.dirname(target);
        const base = path.posix.basename(target, ext);
        const exactCandidates = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']
            .map((e) => path.posix.join(dir, `${base}${e}`));
        for (const candidate of exactCandidates) {
            if (zip.file(candidate)) return candidate;
        }
        return target;
    }

    private static getMimeTypeByExtension(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const map: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.bmp': 'image/bmp',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
            '.wmf': 'image/wmf',
            '.emf': 'image/emf'
        };
        return map[ext] || 'application/octet-stream';
    }
}
