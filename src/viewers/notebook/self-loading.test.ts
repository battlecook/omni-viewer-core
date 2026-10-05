// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { loadNotebookViewerDeps } from './self-loading.js';

describe('loadNotebookViewerDeps', () => {
    it('loads the real Markdown renderer and sanitizer even when optional peers are absent', async () => {
        const dependencies = await loadNotebookViewerDeps();
        expect(dependencies.render.parse('**Notebook**')).toContain('<strong>Notebook</strong>');
        const html = dependencies.createDOMPurify(window).sanitize('<p onclick="bad()">Safe</p><script>bad()</script>',
            { USE_PROFILES: { html: true } });
        expect(html).toBe('<p>Safe</p>');
    });
});
