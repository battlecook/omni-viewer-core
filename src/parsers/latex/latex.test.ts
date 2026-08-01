import { describe, expect, it } from 'vitest';
import { parseLatex, plainText, type LatexBlock, type LatexDocument } from './index.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function parse(source: string, options?: Parameters<typeof parseLatex>[1]): LatexDocument {
    const { result } = parseLatex(enc(source), options);
    if (result.status === 'failed') throw new Error(`unexpected failure: ${result.failure.code}`);
    return result.document;
}

const doc = (body: string, preamble = '\\documentclass{article}\n'): string =>
    `${preamble}\\begin{document}\n${body}\n\\end{document}\n`;

const kinds = (blocks: readonly LatexBlock[]): string[] => blocks.map(block => block.kind);

describe('parseLatex — preamble', () => {
    it('reads the document class, its options, and packages', () => {
        const document = parse(doc('text', '\\documentclass[11pt,a4paper]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amsmath,amssymb}\n'));
        expect(document.preamble.documentClass).toBe('article');
        expect(document.preamble.classOptions).toEqual(['11pt', 'a4paper']);
        expect(document.preamble.packages).toEqual([
            { name: 'inputenc', options: ['utf8'] },
            { name: 'amsmath', options: [] },
            { name: 'amssymb', options: [] }
        ]);
    });

    it('collects macros, including parameterized ones the engine can expand', () => {
        const document = parse(doc('text', '\\documentclass{article}\n\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\norm}[1]{\\lVert #1 \\rVert}\n'));
        expect(document.preamble.macros).toEqual({
            R: '\\mathbb{R}',
            norm: '\\lVert #1 \\rVert'
        });
    });

    it('skips optional-argument macros, which a macro map cannot express', () => {
        const document = parse(doc('text', '\\documentclass{article}\n\\newcommand{\\f}[1][x]{f(#1)}\n\\newcommand{\\g}[1]{g(#1)}\n'));
        expect(document.preamble.macros).toEqual({ g: 'g(#1)' });
    });

    it('treats \\MakeShortVerb characters as inline verbatim', () => {
        // amsmath's technote.tex uses `|…|` to *show* LaTeX code; without this the
        // scanner executed what the author meant to display.
        const document = parse(doc(
            'Define |\\newcommand{\\env}[2]{\\begin{#1}#2\\end{#1}}| and use it.\n',
            '\\documentclass{article}\n\\MakeShortVerb{\\|}\n'
        ));
        expect(kinds(document.body)).toEqual(['paragraph']);
        const paragraph = document.body[0];
        if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
        expect(plainText(paragraph.content)).toBe('Define \\newcommand{\\env}[2]{\\begin{#1}#2\\end{#1}} and use it.');
    });

    it('honours \\DeleteShortVerb and leaves | alone without the declaration', () => {
        const off = parse(doc('a | b | c\n'));
        expect(off.preamble.shortVerbs).toEqual([]);
        const deleted = parse(doc('a | b | c\n', '\\documentclass{article}\n\\MakeShortVerb{\\|}\n\\DeleteShortVerb{\\|}\n'));
        expect(deleted.preamble.shortVerbs).toEqual([]);
    });

    it('follows \\let aliases, with or without the equals sign', () => {
        // amsmath's testmath.tex defines \abs this way; it was the single most
        // used undefined control sequence across the sample corpus.
        const document = parse(doc('text', '\\documentclass{article}\n\\newcommand{\\envert}[1]{\\left\\lvert#1\\right\\rvert}\n\\let\\abs=\\envert\n\\let\\magnitude\\envert\n'));
        expect(document.preamble.macros).toEqual({
            envert: '\\left\\lvert#1\\right\\rvert',
            abs: '\\envert',
            magnitude: '\\envert'
        });
    });

    it('collects \\DeclareMathOperator as an \\operatorname substitution', () => {
        // Found against amsmath's testmath.tex: \per rendered as an unknown
        // control sequence because only \newcommand was being collected.
        const document = parse(doc('text', '\\documentclass{article}\n\\DeclareMathOperator{\\per}{per}\n\\DeclareMathOperator*{\\argmax}{arg\\,max}\n'));
        expect(document.preamble.macros).toEqual({
            per: '\\operatorname{per}',
            argmax: '\\operatorname*{arg\\,max}'
        });
    });

    it('does not end the document at an \\end{document} shown inside verbatim', () => {
        // Package documentation prints the closing line as an example; treating
        // it as the real end truncated the body and the outline with it.
        const document = parse(doc(
            '\\section{Before}\n\\begin{verbatim}\n\\end{document}\n\\end{verbatim}\n\\section{After}\nTail.\n'
        ));
        expect(document.outline.map(x => x.text)).toEqual(['Before', 'After']);
        expect(kinds(document.body)).toContain('verbatim');
    });

    it('does not start the document at a \\begin{document} shown inside verbatim', () => {
        const withExample = parse(doc(
            'Real body.\n',
            '\\documentclass{article}\n\\begin{verbatim}\n\\begin{document}\n\\end{verbatim}\n\\newcommand{\\show}{x}\n'
        ));
        // The macro sits after the printed example, so it is only reachable if
        // the example was skipped when locating the real \begin{document}.
        expect(withExample.preamble.macros).toEqual({ show: 'x' });
    });

    it('reads a fragment that has a class but no document environment', () => {
        // The preamble was scanned up to \begin{document}; with no such marker
        // that range was empty, so \documentclass went unseen and the file was
        // rejected as not-LaTeX — leaving the recovery path unreachable.
        const { result } = parseLatex(enc('\\documentclass{article}\n\\newcommand{\\R}{\\mathbb{R}}\n\\section{Hi}\nText $x$.\n'));
        expect(result.status).toBe('partial');
        if (result.status === 'failed') throw new Error('unexpected failure');
        expect(result.document.preamble.documentClass).toBe('article');
        expect(result.document.preamble.macros).toEqual({ R: '\\mathbb{R}' });
        expect(result.document.outline.map(x => x.text)).toEqual(['Hi']);
        expect(result.diagnostics.map(x => x.code)).toContain('latex.no-document-environment');
        expect(result.diagnostics.map(x => x.code)).not.toContain('latex.not-latex');
        // The declarations must not surface as prose now that they are in range.
        const prose = result.document.body
            .filter(b => b.kind === 'paragraph')
            .map(b => b.kind === 'paragraph' ? plainText(b.content) : '')
            .join(' ');
        expect(prose).not.toContain('documentclass');
        expect(prose).not.toContain('newcommand');
    });

    it('reports a non-LaTeX .tex file instead of inventing an outline', () => {
        const { result } = parseLatex(enc('\\input plain\n$x$\n\\bye\n'));
        expect(result.status).toBe('partial');
        if (result.status === 'failed') throw new Error('unexpected failure');
        expect(result.document.body).toEqual([]);
        expect(result.document.outline).toEqual([]);
        expect(result.diagnostics.map(x => x.code)).toContain('latex.not-latex');
    });
});

describe('parseLatex — structure', () => {
    it('maps sectioning commands to accessible heading levels', () => {
        const document = parse(doc('\\section{One}\ntext\n\\subsection{Two}\nmore\n'));
        expect(document.outline.map(x => [x.level, x.text])).toEqual([[2, 'One'], [3, 'Two']]);
        expect(document.outline.map(x => x.id)).toEqual(['heading-0', 'heading-1']);
    });

    it('keeps chapter at level 1 until a \\part appears', () => {
        const withoutPart = parse(doc('\\chapter{C}\n\\section{S}\n', '\\documentclass{report}\n'));
        expect(withoutPart.outline.map(x => x.level)).toEqual([1, 2]);
        const withPart = parse(doc('\\part{P}\n\\chapter{C}\n\\section{S}\n', '\\documentclass{report}\n'));
        expect(withPart.outline.map(x => x.level)).toEqual([1, 2, 3]);
    });

    it('records heading source spans that address the original text', () => {
        const source = doc('\\section{One}\ntext\n');
        const document = parse(source);
        const heading = document.outline[0]!;
        expect(source.slice(heading.span.start, heading.span.end)).toBe('\\section{One}');
    });

    it('attaches a trailing label to its heading', () => {
        const document = parse(doc('\\section{One}\\label{sec:one}\ntext\n'));
        const heading = document.body.find(block => block.kind === 'heading');
        expect(heading?.kind === 'heading' && heading.label).toBe('sec:one');
    });

    it('splices transparent wrappers instead of leaving a gap', () => {
        const document = parse(doc('\\begin{abstract}\nSummary text.\n\\end{abstract}\n\\section{One}\n'));
        expect(kinds(document.body)).toEqual(['paragraph', 'heading']);
        const paragraph = document.body[0];
        expect(paragraph?.kind === 'paragraph' && plainText(paragraph.content)).toBe('Summary text.');
    });

    it('separates paragraphs on blank lines', () => {
        const document = parse(doc('First one.\n\nSecond one.\n'));
        expect(kinds(document.body)).toEqual(['paragraph', 'paragraph']);
    });
});

describe('parseLatex — lists', () => {
    it('parses itemize and enumerate items', () => {
        const document = parse(doc('\\begin{enumerate}\n\\item Alpha\n\\item Beta\n\\end{enumerate}\n'));
        const list = document.body[0];
        if (list?.kind !== 'list') throw new Error('expected a list');
        expect(list.ordered).toBe(true);
        expect(list.items.map(item => {
            const first = item[0];
            return first?.kind === 'paragraph' ? plainText(first.content) : null;
        })).toEqual(['Alpha', 'Beta']);
    });

    it('keeps a description term rather than dropping it', () => {
        const document = parse(doc('\\begin{description}\n\\item[Term] meaning\n\\end{description}\n'));
        const list = document.body[0];
        if (list?.kind !== 'list') throw new Error('expected a list');
        const first = list.items[0]![0]!;
        expect(first.kind === 'paragraph' && plainText(first.content)).toBe('Term meaning');
    });

    it('nests lists without leaking the inner items into the outer one', () => {
        const document = parse(doc('\\begin{itemize}\n\\item Outer\n\\begin{itemize}\n\\item Inner\n\\end{itemize}\n\\item Second\n\\end{itemize}\n'));
        const list = document.body[0];
        if (list?.kind !== 'list') throw new Error('expected a list');
        expect(list.items).toHaveLength(2);
        expect(kinds(list.items[0]!)).toEqual(['paragraph', 'list']);
    });
});

describe('parseLatex — math extraction', () => {
    it('extracts inline math from $…$ and \\(…\\)', () => {
        const document = parse(doc('Let $a_i + b_i$ and \\(c^2\\) hold.\n'));
        const paragraph = document.body[0];
        if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
        const math = paragraph.content.filter(node => node.kind === 'math');
        expect(math.map(node => node.kind === 'math' && node.source)).toEqual(['a_i + b_i', 'c^2']);
    });

    it('extracts display math from $$…$$ and \\[…\\]', () => {
        const document = parse(doc('$$E = mc^2$$\n\n\\[a+b\\]\n'));
        const math = document.body.filter(block => block.kind === 'math');
        expect(math.map(block => block.kind === 'math' && block.source)).toEqual(['E = mc^2', 'a+b']);
    });

    it('hands math environments to the renderer with their delimiters intact', () => {
        const document = parse(doc('\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\n'));
        const math = document.body[0];
        if (math?.kind !== 'math') throw new Error('expected math');
        expect(math.source.startsWith('\\begin{align}')).toBe(true);
        expect(math.source.endsWith('\\end{align}')).toBe(true);
        expect(math.display).toBe(true);
    });

    it('captures an equation label', () => {
        const document = parse(doc('\\begin{equation}\\label{eq:one}\nx = y\n\\end{equation}\n'));
        const math = document.body[0];
        expect(math?.kind === 'math' && math.label).toBe('eq:one');
    });

    it('demotes oversized math to unsupported rather than truncating it', () => {
        const document = parse(doc(`$${'x'.repeat(50)}$`), { latexLimits: { maxInlineMathLength: 10 } });
        const paragraph = document.body[0];
        if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
        expect(paragraph.content.some(node => node.kind === 'unsupported')).toBe(true);
    });
});

describe('parseLatex — inline text', () => {
    it('strips comments but keeps escaped percent signs', () => {
        const document = parse(doc('Visible % hidden comment\nrest 50\\% done\n'));
        const paragraph = document.body[0];
        if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
        const text = plainText(paragraph.content);
        expect(text).not.toContain('hidden comment');
        expect(text).toContain('50% done');
    });

    it('parses emphasis, references, citations, and links', () => {
        const document = parse(doc('See \\textbf{bold}, \\ref{sec:one}, \\cite{knuth1984,lamport1994} and \\url{https://example.test}.\n'));
        const paragraph = document.body[0];
        if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
        const found = paragraph.content.map(node => node.kind);
        expect(found).toContain('emphasis');
        expect(found).toContain('ref');
        expect(found).toContain('cite');
        expect(found).toContain('link');
        const cite = paragraph.content.find(node => node.kind === 'cite');
        expect(cite?.kind === 'cite' && cite.keys).toEqual(['knuth1984', 'lamport1994']);
    });

    it('drops commands that typeset nothing, including their arguments', () => {
        // Found against amsmath's testmath.tex, where `\setlength{\multlinegap}0pt`
        // leaked into the prose — note the unbraced second argument.
        const document = parse(doc('Before \\setlength{\\multlinegap}0pt after.\n'));
        const paragraph = document.body[0];
        if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
        expect(plainText(paragraph.content)).toBe('Before after.');
    });

    it('swallows a mid-document \\renewcommand instead of showing its body', () => {
        const document = parse(doc('\\renewcommand{\\labelenumi}{(\\roman{enumi})}\nList intro.\n'));
        const paragraph = document.body[0];
        expect(paragraph?.kind === 'paragraph' && plainText(paragraph.content)).toBe('List intro.');
    });

    it('renders the prose inside presentation commands rather than their source', () => {
        // Found against beamer's official example, where \alert alone wrapped 35
        // pieces of the talk's own text.
        const document = parse(doc('We \\alert{must} note \\textcolor{red}{this} and \\uncover<2->{that}.\n'));
        const paragraph = document.body[0];
        if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
        expect(plainText(paragraph.content)).toBe('We must note this and that.');
        expect(paragraph.content.some(n => n.kind === 'emphasis' && n.style === 'bf')).toBe(true);
    });

    it('drops beamer slide plumbing that has nothing to show', () => {
        const document = parse(doc('\\column{0.5\\textwidth}\nSlide prose.\\qedhere\n'));
        const paragraph = document.body[0];
        expect(paragraph?.kind === 'paragraph' && plainText(paragraph.content)).toBe('Slide prose.');
    });

    it('keeps unknown commands as unsupported source instead of dropping them', () => {
        const document = parse(doc('Before \\weirdcommand{payload} after.\n'));
        const paragraph = document.body[0];
        if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
        const unsupported = paragraph.content.find(node => node.kind === 'unsupported');
        expect(unsupported?.kind === 'unsupported' && unsupported.source).toBe('\\weirdcommand{payload}');
    });

    it('treats \\verb content as literal, not as commands', () => {
        // Found against latex2e's own sample2e.tex: `\verb|\section|` used to
        // start a section and cut the paragraph in half.
        const document = parse(doc('Use \\verb|\\section{x}| to start one.\n'));
        expect(document.outline).toHaveLength(0);
        expect(kinds(document.body)).toEqual(['paragraph']);
        const paragraph = document.body[0];
        if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
        expect(plainText(paragraph.content)).toBe('Use \\section{x} to start one.');
    });

    it('keeps a multi-line inline formula whole, environments and all', () => {
        // Found against beamer's official example: the \begin inside a spanning
        // $…$ used to cut the paragraph and orphan the matrix.
        const document = parse(doc('the submatrix\n$\\left(\n\\begin{smallmatrix}\n0 & 0\n\\end{smallmatrix}\n\\right)$ shown above.\n'));
        expect(kinds(document.body)).toEqual(['paragraph']);
        const paragraph = document.body[0];
        if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
        const math = paragraph.content.find(node => node.kind === 'math');
        expect(math?.kind === 'math' && math.source).toContain('\\begin{smallmatrix}');
        expect(plainText(paragraph.content)).toContain('shown above.');
    });

    it('still ends the paragraph at a blank line when a $ is unbalanced', () => {
        const document = parse(doc('broken $math here\n\n\\section{After}\n'));
        expect(document.outline.map(x => x.text)).toEqual(['After']);
    });

    it('accepts any \\verb delimiter and the starred form', () => {
        const document = parse(doc('A \\verb+a_b+ and B \\verb*!c%d! end.\n'));
        const paragraph = document.body[0];
        if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
        expect(plainText(paragraph.content)).toBe('A a_b and B c%d end.');
    });

    it('collapses source line wrapping into single spaces', () => {
        const document = parse(doc('one\ntwo    three\n'));
        const paragraph = document.body[0];
        expect(paragraph?.kind === 'paragraph' && plainText(paragraph.content)).toBe('one two three');
    });
});

describe('parseLatex — verbatim', () => {
    it('preserves verbatim content including percent signs', () => {
        const document = parse(doc('\\begin{verbatim}\n50% not a comment\n\\end{verbatim}\n'));
        const verbatim = document.body[0];
        expect(verbatim?.kind === 'verbatim' && verbatim.source).toContain('50% not a comment');
    });
});

describe('parseLatex — wrapper environments', () => {
    it('sees through subequations so the renderer still gets the inner math', () => {
        // Found against amsmath's testmath.tex: subequations was classified as
        // an unsupported environment, which buried the align inside it.
        const document = parse(doc('\\begin{subequations}\n\\begin{align}\na &= b\n\\end{align}\n\\end{subequations}\n'));
        expect(kinds(document.body)).toEqual(['math']);
        const math = document.body[0];
        expect(math?.kind === 'math' && math.source.startsWith('\\begin{align}')).toBe(true);
    });

    it('treats \\begin{math} as inline, not display', () => {
        const document = parse(doc('\\begin{math}x+y\\end{math}\n'));
        const math = document.body[0];
        expect(math?.kind === 'math' && math.display).toBe(false);
        expect(math?.kind === 'math' && math.source).toBe('x+y');
    });

    it('sees through em and verse wrappers', () => {
        const document = parse(doc('\\begin{em}emphasised prose\\end{em}\n'));
        expect(kinds(document.body)).toEqual(['paragraph']);
    });

    it('strips a beamer frame overlay spec and title from its prose', () => {
        const document = parse(doc('\\begin{frame}[t]{Slide title}\nSlide body.\n\\end{frame}\n'));
        expect(kinds(document.body)).toEqual(['paragraph', 'paragraph']);
        const [title, body] = document.body;
        expect(title?.kind === 'paragraph' && plainText(title.content)).toBe('Slide title');
        expect(body?.kind === 'paragraph' && plainText(body.content)).toBe('Slide body.');
    });

    it('sees through beamer block and column layout wrappers', () => {
        const document = parse(doc(
            '\\begin{columns}\n\\begin{column}{0.5\\textwidth}\n\\begin{block}{Box}\nBoxed text.\n\\end{block}\n\\end{column}\n\\end{columns}\n'
        ));
        expect(kinds(document.body)).toEqual(['paragraph', 'paragraph']);
        const boxTitle = document.body[0];
        expect(boxTitle?.kind === 'paragraph' && plainText(boxTitle.content)).toBe('Box');
        // The column width must not survive as prose.
        expect(document.body.map(b => b.kind === 'paragraph' ? plainText(b.content) : '').join(' '))
            .not.toContain('textwidth');
    });

    it('reads a bibliography as a list keyed by \\bibitem', () => {
        const document = parse(doc('\\begin{thebibliography}{99}\n\\bibitem{knuth1984} The TeXbook.\n\\bibitem{lamport1994} LaTeX.\n\\end{thebibliography}\n'));
        const list = document.body[0];
        if (list?.kind !== 'list') throw new Error('expected a list');
        expect(list.items).toHaveLength(2);
        const first = list.items[0]![0];
        expect(first?.kind === 'paragraph' && plainText(first.content)).toBe('knuth1984 The TeXbook.');
    });
});

describe('parseLatex — theorem environments', () => {
    it('recognises environments declared with \\newtheorem', () => {
        const document = parse(doc(
            '\\begin{thm}\nEvery bounded sequence has a convergent subsequence.\n\\end{thm}\n',
            '\\documentclass{article}\n\\newtheorem{thm}{Theorem}[section]\n'
        ));
        const theorem = document.body[0];
        if (theorem?.kind !== 'theorem') throw new Error('expected a theorem');
        expect(theorem.title).toBe('Theorem');
        expect(theorem.environment).toBe('thm');
        const statement = theorem.body[0];
        expect(statement?.kind === 'paragraph' && plainText(statement.content))
            .toBe('Every bounded sequence has a convergent subsequence.');
    });

    it('handles the shared-counter and unnumbered declaration forms', () => {
        const preamble = '\\documentclass{article}\n\\newtheorem{thm}{Theorem}\n\\newtheorem{cor}[thm]{Corollary}\n\\newtheorem*{notation}{Notation}\n';
        const document = parse(doc('\\begin{cor}A\\end{cor}\n\n\\begin{notation}B\\end{notation}\n', preamble));
        expect(document.body.map(b => b.kind === 'theorem' && b.title)).toEqual(['Corollary', 'Notation']);
    });

    it('recognises class-provided theorem environments without a declaration', () => {
        const document = parse(doc('\\begin{theorem}[Optimality]\\label{thm:opt}\nStatement.\n\\end{theorem}\n'));
        const theorem = document.body[0];
        if (theorem?.kind !== 'theorem') throw new Error('expected a theorem');
        expect(theorem.title).toBe('Theorem');
        expect(plainText(theorem.note ?? [])).toBe('Optimality');
        expect(theorem.label).toBe('thm:opt');
    });

    it('keeps math inside a theorem body available to the renderer', () => {
        const document = parse(doc('\\begin{proof}\nSince $a=b$, we have\n\\[c=d\\]\nas required.\n\\end{proof}\n'));
        const theorem = document.body[0];
        if (theorem?.kind !== 'theorem') throw new Error('expected a theorem');
        expect(theorem.title).toBe('Proof');
        expect(theorem.body.some(b => b.kind === 'math')).toBe(true);
    });
});

describe('parseLatex — unsupported and unresolved', () => {
    it('keeps an unsupported environment’s source and reports it once per kind', () => {
        const document = parse(doc('\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}\n\n\\begin{tikzpicture}\\draw (1,1);\\end{tikzpicture}\n'));
        const unsupported = document.body.filter(block => block.kind === 'unsupported');
        expect(unsupported).toHaveLength(2);
        expect(unsupported[0]?.kind === 'unsupported' && unsupported[0].source).toContain('\\draw (0,0);');
        const { result } = parseLatex(enc(doc('\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}\n\n\\begin{tikzpicture}\\draw (1,1);\\end{tikzpicture}\n')));
        if (result.status === 'failed') throw new Error('unexpected failure');
        expect(result.diagnostics.filter(x => x.code === 'latex.unsupported-environment')).toHaveLength(1);
    });

    it('parses tabular rows, cells and column alignment (L14)', () => {
        const document = parse(doc('\\begin{tabular}{|l|r|c|}\n\\hline\nName & Value & Unit \\\\\n\\hline\nalpha & 1.0 & m \\\\\nbeta & 2.5 & s \\\\\n\\hline\n\\end{tabular}\n'));
        const table = document.body[0];
        if (table?.kind !== 'table') throw new Error('expected a table');
        expect(table.columns).toEqual(['left', 'right', 'center']);
        expect(table.rows.map(row => row.map(cell => plainText(cell.content))))
            .toEqual([['Name', 'Value', 'Unit'], ['alpha', '1.0', 'm'], ['beta', '2.5', 's']]);
    });

    it('keeps a multicolumn span and ignores rules and row spacing', () => {
        const document = parse(doc('\\begin{tabular}{ll}\n\\multicolumn{2}{c}{Heading} \\\\[4pt]\n\\hline\na & b \\\\\n\\end{tabular}\n'));
        const table = document.body[0];
        if (table?.kind !== 'table') throw new Error('expected a table');
        expect(table.rows[0]).toEqual([{ content: [{ kind: 'text', value: 'Heading' }], span: 2 }]);
        expect(table.rows[1]?.map(cell => plainText(cell.content))).toEqual(['a', 'b']);
    });

    it('treats escaped braces in cells as content, not as grouping', () => {
        // `\{` used to open a brace that never closed, so no `&` or `\\` was ever
        // seen at depth zero again and the whole table collapsed into one row.
        const document = parse(doc('\\begin{tabular}{ll}\n\\{ & b \\\\\nc & \\} \\\\\n\\end{tabular}\n'));
        const table = document.body[0];
        if (table?.kind !== 'table') throw new Error('expected a table');
        expect(table.rows.map(row => row.map(cell => plainText(cell.content))))
            .toEqual([['{', 'b'], ['c', '}']]);
    });

    it('keeps an escaped ampersand inside a cell', () => {
        const document = parse(doc('\\begin{tabular}{ll}\nA \\& B & second \\\\\n\\end{tabular}\n'));
        const table = document.body[0];
        if (table?.kind !== 'table') throw new Error('expected a table');
        expect(table.rows[0]?.map(cell => plainText(cell.content))).toEqual(['A & B', 'second']);
    });

    it('keeps math inside table cells available to the renderer', () => {
        const document = parse(doc('\\begin{tabular}{ll}\n$x^2$ & text \\\\\n\\end{tabular}\n'));
        const table = document.body[0];
        if (table?.kind !== 'table') throw new Error('expected a table');
        expect(table.rows[0]?.[0]?.content[0]).toEqual({ kind: 'math', source: 'x^2', display: false });
    });

    it('reads the width argument of tabularx before its column spec', () => {
        const document = parse(doc('\\begin{tabularx}{\\textwidth}{lr}\na & b \\\\\n\\end{tabularx}\n'));
        const table = document.body[0];
        if (table?.kind !== 'table') throw new Error('expected a table');
        expect(table.columns).toEqual(['left', 'right']);
        expect(table.rows[0]?.map(cell => plainText(cell.content))).toEqual(['a', 'b']);
    });

    it('extracts only the caption from a float', () => {
        const document = parse(doc('\\begin{figure}\n\\includegraphics{plot.png}\n\\caption{A plot}\n\\end{figure}\n'));
        const float = document.body[0];
        if (float?.kind !== 'float') throw new Error('expected a float');
        expect(float.environment).toBe('figure');
        expect(plainText(float.caption ?? [])).toBe('A plot');
    });

    it('marks external file references unresolved without reading anything', () => {
        const { result } = parseLatex(enc(doc('\\input{chapter1}\n\\include{chapter2}\n')));
        if (result.status === 'failed') throw new Error('unexpected failure');
        const unresolved = result.document.body.filter(block => block.kind === 'unresolved');
        expect(unresolved.map(block => block.kind === 'unresolved' && block.path)).toEqual(['chapter1', 'chapter2']);
        expect(result.diagnostics.some(x => x.code === 'latex.unresolved-input')).toBe(true);
    });

    it('does not close an environment at an \\end printed inside \\verb', () => {
        const document = parse(doc(
            '\\begin{itemize}\n\\item Use \\verb|\\end{itemize}| here.\n\\item Second\n\\end{itemize}\n\\section{After}\n'
        ));
        expect(kinds(document.body)).toEqual(['list', 'heading']);
        const list = document.body[0];
        if (list?.kind !== 'list') throw new Error('expected a list');
        expect(list.items).toHaveLength(2);
    });

    it('does not close an environment at an \\end inside a nested verbatim', () => {
        const document = parse(doc(
            '\\begin{itemize}\n\\item One\n\\begin{verbatim}\n\\end{itemize}\n\\end{verbatim}\n\\item Two\n\\end{itemize}\n\\section{After}\n'
        ));
        expect(kinds(document.body)).toEqual(['list', 'heading']);
    });

    it('does not split a list at an \\item printed inside \\verb', () => {
        const document = parse(doc('\\begin{itemize}\n\\item show \\verb|\\item| literally\n\\end{itemize}\n'));
        const list = document.body[0];
        if (list?.kind !== 'list') throw new Error('expected a list');
        expect(list.items).toHaveLength(1);
        const first = list.items[0]![0];
        expect(first?.kind === 'paragraph' && plainText(first.content)).toBe('show \\item literally');
    });

    it('records preamble \\input targets for the resolver', () => {
        // A document that keeps its \newcommands in a separate file needs those
        // paths surfaced, or every formula using them fails to render.
        const document = parse(doc('Text.\n', '\\documentclass{article}\n\\input{macros}\n\\include{extra}\n'));
        expect(document.preamble.inputs).toEqual(['macros', 'extra']);
    });

    it('keeps scanning past a stray \\end and reports it', () => {
        // A single mistyped \end used to end the scan: the rest of the document
        // vanished with no diagnostic and a status of `ok`.
        const { result } = parseLatex(enc(doc('\\section{A}\ntext a\n\\end{itemize}\n\\section{B}\ntext b\n')));
        expect(result.status).toBe('partial');
        if (result.status === 'failed') throw new Error('unexpected failure');
        expect(result.document.outline.map(x => x.text)).toEqual(['A', 'B']);
        expect(result.diagnostics.map(x => x.code)).toContain('latex.unbalanced-environment');
    });

    it('does not rescan the document for a location on every dropped diagnostic', () => {
        // Locations were computed before the duplicate check, so every formula
        // past the segment limit cost one full-document scan — 71 s on a 700 KB
        // file that parses in well under a second.
        const body = '\\[x\\]\n\n'.repeat(20_000);
        const started = Date.now();
        const { result } = parseLatex(enc(doc(body)), { latexLimits: { maxMathSegments: 10 } });
        expect(Date.now() - started).toBeLessThan(5_000);
        if (result.status === 'failed') throw new Error('unexpected failure');
        expect(result.diagnostics.filter(x => x.code === 'latex.math-limit-exceeded')).toHaveLength(1);
        expect(result.diagnostics.find(x => x.code === 'latex.math-limit-exceeded')?.location).toMatch(/^line \d+$/);
    });

    it('does not read a nested tabular\u2019s cells as the outer table\u2019s', () => {
        const document = parse(doc(
            '\\begin{tabular}{ll}\nouter & \\begin{tabular}{ll}i & j \\\\ k & l\\end{tabular} \\\\\nnext & cell \\\\\n\\end{tabular}\n'
        ));
        const table = document.body[0];
        if (table?.kind !== 'table') throw new Error('expected a table');
        expect(table.rows).toHaveLength(2);
        expect(table.rows.map(row => row.length)).toEqual([2, 2]);
        expect(plainText(table.rows[1]![0]!.content)).toBe('next');
    });

    it('reports an unbalanced environment instead of hanging', () => {
        const { result } = parseLatex(enc(doc('\\begin{itemize}\n\\item orphan\n')));
        if (result.status === 'failed') throw new Error('unexpected failure');
        expect(result.diagnostics.some(x => x.code === 'latex.unbalanced-environment')).toBe(true);
    });
});

describe('parseLatex — limits and cancellation', () => {
    it('fails when the input exceeds the byte limit', () => {
        const { result } = parseLatex(enc(doc('text')), { limits: { maxInputBytes: 4 } });
        expect(result.status).toBe('failed');
        if (result.status !== 'failed') throw new Error('expected failure');
        expect(result.failure.code).toBe('limit-exceeded');
    });

    it('reports partial when the block budget is reached', () => {
        const body = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
        const { result } = parseLatex(enc(doc(body)), { latexLimits: { maxBlocks: 5 } });
        expect(result.status).toBe('partial');
        if (result.status === 'failed') throw new Error('unexpected failure');
        expect(result.document.body.length).toBeLessThanOrEqual(5);
        const limit = result.diagnostics.find(x => x.code === 'latex.limit-exceeded');
        expect(limit).toBeDefined();
        // §4: the reader has to be able to tell where the document stopped.
        expect(limit?.location).toMatch(/^line \d+$/);
    });

    it('fails with aborted when the signal is already aborted', () => {
        const controller = new AbortController();
        controller.abort();
        const { result } = parseLatex(enc(doc('text')), { signal: controller.signal });
        expect(result.status).toBe('failed');
        if (result.status !== 'failed') throw new Error('expected failure');
        expect(result.failure.code).toBe('aborted');
    });

    it('keeps the complete source even when the scan stops early', () => {
        const source = doc(Array.from({ length: 20 }, (_, i) => `Paragraph ${i}.`).join('\n\n'));
        const document = parse(source, { latexLimits: { maxBlocks: 3 } });
        expect(document.text).toBe(source);
    });
});

describe('parseLatex — determinism', () => {
    it('produces an identical result for identical bytes', () => {
        const source = doc('\\section{One}\nText with $x^2$ and \\cite{a}.\n\n\\begin{itemize}\\item A\\end{itemize}\n');
        const first = parseLatex(enc(source));
        const second = parseLatex(enc(source));
        expect(first.result).toEqual(second.result);
    });
});
