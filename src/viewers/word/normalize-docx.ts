/** Normalizes glyphs emitted by docx-preview for Wingdings/PUA list markers. */
export function normalizeDocxPreviewDom(wordContent: HTMLElement): void {
    const brokenBulletPrefix = /^[\u25A1\u25A0\u25FB\u25FC\uF0A7\uF0B7]\s*/;
    const brokenBulletSingle = /[\u25A1\u25A0\u25FB\u25FC\uF0A7\uF0B7]/;
    const normalizeLeadingGlyph = (element: Element): void => {
        for (const node of element.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE) continue;
            const value = node.textContent ?? '', trimmed = value.trimStart();
            if (!trimmed) continue;
            if (brokenBulletPrefix.test(trimmed)) {
                const leadingSpaces = value.slice(0, value.length - trimmed.length);
                node.textContent = `${leadingSpaces}${trimmed.replace(brokenBulletPrefix, '* ')}`;
            }
            break;
        }
    };
    wordContent.querySelectorAll('p, li').forEach((element) => {
        normalizeLeadingGlyph(element);
        const firstSpan = element.querySelector('span');
        if (firstSpan && brokenBulletPrefix.test(firstSpan.textContent ?? '')) firstSpan.textContent = (firstSpan.textContent ?? '').replace(brokenBulletPrefix, '* ');
    });
    wordContent.querySelectorAll('p[class*="docx-num-"], li[class*="docx-num-"]').forEach((element) => {
        const beforeContent = window.getComputedStyle(element, '::before').content ?? '';
        if (brokenBulletSingle.test(beforeContent)) element.setAttribute('data-ov-bullet-fix', '1');
    });
    normalizeChartSpacerParagraphs(wordContent);
}

function normalizeChartSpacerParagraphs(root: HTMLElement): void {
    const visualEmpty = (paragraph: Element): boolean => paragraph.tagName === 'P' && !paragraph.querySelector('.omni-word__chart,.ov-chart-card,table,img,svg,canvas,object,iframe') && (paragraph.textContent ?? '').replace(/\u200b/g, '').trim() === '';
    root.querySelectorAll('p[data-ov-chart-spacer]').forEach((element) => element.removeAttribute('data-ov-chart-spacer'));
    root.querySelectorAll('p').forEach((paragraph) => {
        if (!paragraph.querySelector('.omni-word__chart,.ov-chart-card')) return;
        const clone = paragraph.cloneNode(true) as Element; clone.querySelectorAll('.omni-word__chart,.ov-chart-card').forEach((node) => node.remove());
        if ((clone.textContent ?? '').replace(/\u200b/g, '').trim()) return;
        const empty: Element[] = []; let sibling = paragraph.nextElementSibling;
        while (sibling && visualEmpty(sibling)) { empty.push(sibling); sibling = sibling.nextElementSibling; }
        empty.forEach((element, index) => element.setAttribute('data-ov-chart-spacer', index === 0 ? 'keep' : 'trim'));
    });
}
