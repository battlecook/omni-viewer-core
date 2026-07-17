import { describe, expect, it } from 'vitest';
import { parseChart } from './docx-preprocess.js';

describe('DOCX preprocessing', () => {
    it('extracts cached chart categories, series, title and color', () => {
        const chart = parseChart(`<c:chart><c:title><a:t>Revenue</a:t></c:title><c:ser><c:tx><c:v>Sales</c:v></c:tx><a:srgbClr val="112233"/><c:cat><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:cat><c:val><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:val></c:ser></c:chart>`);
        expect(chart).toEqual({ title: 'Revenue', categories: ['Q1', 'Q2'], series: [{ name: 'Sales', color: '#112233', values: [10, 20] }] });
    });
});
