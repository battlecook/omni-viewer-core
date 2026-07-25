import type { Diagnostic } from './types.js';

export interface SlideTextRun {
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
}

export interface SlideParagraph {
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
    runs?: SlideTextRun[];
}

export interface SlideChartSeries {
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
}

export type SlideChartKind =
    | 'clusteredColumn'
    | 'stackedColumn'
    | 'percentStackedColumn'
    | 'clusteredBar'
    | 'stackedBar'
    | 'percentStackedBar'
    | 'line'
    | 'pie';

export interface SlideChartAxis {
    numFmt?: string;
    fontSizePx?: number;
    color?: string;
    lineColor?: string;
}

export interface SlideChartData {
    kind: SlideChartKind;
    /** Raw OOXML values, retained so a host renderer can reproduce PowerPoint semantics. */
    grouping?: string;
    barDir?: string;
    categories: string[];
    series: SlideChartSeries[];
    gapWidth?: number;
    overlap?: number;
    legend?: {
        position?: string;
        fontSizePx?: number;
        color?: string;
        align?: string;
    };
    categoryAxis?: SlideChartAxis;
    valueAxis?: SlideChartAxis & {
        gridColor?: string;
        majorUnit?: number;
        min?: number;
        max?: number;
        crossesAt?: number;
    };
}

export interface TableCellBorders {
    left?: string;
    right?: string;
    top?: string;
    bottom?: string;
}

export interface TableCellMargins {
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
}

export interface SlideTableCell {
    paragraphs: SlideParagraph[];
    rowSpan?: number;
    colSpan?: number;
    fillColor?: string;
    borders?: TableCellBorders;
    verticalAlign?: string;
    margins?: TableCellMargins;
    /** Continuation cell covered by a row/column merge. Renderers should omit it. */
    merged?: boolean;
}

export interface SlideTableRow {
    height?: number;
    cells: SlideTableCell[];
}

export interface SlideTable {
    rows: SlideTableRow[];
    columnWidths?: number[];
    firstRow?: boolean;
    firstColumn?: boolean;
    bandedRows?: boolean;
    bandedColumns?: boolean;
}

export interface SlideTextMargins {
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
}

export interface SlideElement {
    type: 'text' | 'image' | 'table' | 'chart' | 'shape';
    x: number;
    y: number;
    width: number;
    height: number;
    rotateDeg?: number;
    zIndex: number;
    placeholderKey?: string;
    isTitle?: boolean;
    paragraphs?: SlideParagraph[];
    textMargins?: SlideTextMargins;
    verticalAlign?: string;
    autofit?: 'none' | 'normal' | 'shape';
    src?: string;
    srcRect?: { l: number; t: number; r: number; b: number };
    vectorFallback?: boolean;
    /** Backward-compatible plain-text projection of `table`. */
    tableRows?: string[][];
    table?: SlideTable;
    chartKind?: string;
    chartTitle?: string;
    chartData?: SlideChartData;
    fillColor?: string;
    borderColor?: string;
    borderWidthPx?: number;
    customSvgPath?: string;
    presetGeom?: string;
    headEnd?: string;
    tailEnd?: string;
    flipH?: boolean;
    flipV?: boolean;
    textStylePreset?: string;
}

export interface Slide {
    slideNumber: number;
    widthPx: number;
    heightPx: number;
    backgroundColor: string;
    elements: SlideElement[];
}

export interface SlideDeck {
    slides: Slide[];
    totalSlides: number;
    slideSize?: { widthPx: number; heightPx: number };
}

export interface SlideObjectDiagnostic extends Diagnostic {
    slideNumber: number;
    objectKind:
        | 'shape'
        | 'chart'
        | 'smartart'
        | 'ole'
        | 'media'
        | 'image'
        | 'animation'
        | 'transition'
        | 'hyperlink'
        | 'notes';
    handling: 'omitted' | 'placeholder' | 'simplified';
    frame?: { x: number; y: number; width: number; height: number };
    sourcePath?: string;
}
