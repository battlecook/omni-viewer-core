// @ts-nocheck — DOM pagination ported verbatim from the VS Code viewer.
export function paginateLegacyDocument(wordContent: HTMLElement): void {

    const legacyRoot = wordContent.querySelector('.ov-doc-legacy');
    if (!legacyRoot) return;

    if (legacyRoot.dataset.ovPaginated === 'true') {
        return;
    }

    const sections = Array.from(legacyRoot.children)
        .filter((node) => node.classList && node.classList.contains('ov-doc-legacy-section'));
    if (sections.length === 0) {
        legacyRoot.dataset.ovPaginated = 'true';
        return;
    }

    const paginatedSections = [];

    for (const section of sections) {
        let sectionMeta = {};
        const metaNode = section.querySelector('.ov-doc-legacy-section-meta');
        if (metaNode && metaNode.textContent) {
            try {
                sectionMeta = JSON.parse(metaNode.textContent);
            } catch (error) {
                console.warn('Failed to parse legacy section meta:', error);
            }
        }

        const blocks = Array.from(section.children)
            .filter((node) => node.classList && node.classList.contains('ov-doc-legacy-block'));
        if (blocks.length === 0) {
            continue;
        }

        const shouldClearAfterFloatingMedia = (floatingBlock, block) => {
            if (!floatingBlock || !block) {
                return false;
            }
            const floatingSide = floatingBlock.dataset.ovFloatingSide || 'right';
            const floatingWidth = floatingBlock.dataset.ovFloatingWidth || 'regular';
            const floatingPlacement = floatingBlock.dataset.ovFloatingPlacement || '';
            const semanticKind = block.dataset.ovSemanticKind || '';
            const semanticTag = block.dataset.ovSemanticTag || '';
            const textLength = Number.parseInt(block.dataset.ovTextLength || '', 10) || 0;

            if (floatingPlacement === 'center-block' || floatingSide === 'center' || floatingWidth === 'wide') {
                return true;
            }

            if (semanticKind === 'table' || semanticKind === 'sheet' || semanticKind === 'list' || semanticKind === 'images' || semanticKind === 'image') {
                return true;
            }
            if (semanticKind === 'content' && (semanticTag === 'h1' || semanticTag === 'h2')) {
                return true;
            }
            if (semanticKind === 'content' && textLength > 120) {
                return true;
            }

            if (floatingWidth === 'narrow' && semanticKind === 'content' && textLength > 0 && textLength <= 80) {
                return false;
            }

            return semanticKind === 'content' && textLength > 80;
        };

        for (let index = 0; index < blocks.length - 1; index++) {
            const currentBlock = blocks[index];
            const nextBlock = blocks[index + 1];
            const floatingClearance = Math.max(4, Number.parseInt(currentBlock.dataset.ovFloatingClearance || '0', 10) || 0);
            if (currentBlock.dataset.ovSemanticRole === 'floating-media' && floatingClearance > 0) {
                currentBlock.style.setProperty('--ov-floating-clearance', `${floatingClearance}px`);
            }
            if (currentBlock.dataset.ovSemanticRole === 'floating-media' && shouldClearAfterFloatingMedia(currentBlock, nextBlock)) {
                nextBlock.dataset.ovClearFloat = 'true';
                nextBlock.style.setProperty('--ov-clear-float-padding', `${floatingClearance}px`);
            }
        }

        const pagesHost = document.createElement('div');
        pagesHost.className = 'ov-doc-legacy-pages';
        section.innerHTML = '';
        section.appendChild(pagesHost);
        const sectionColumnCount = Math.max(1, Number.parseInt(section.dataset.ovColumns || '1', 10) || 1);
        const explicitColumnWidths = (section.dataset.ovColumnWidths || '')
            .split(',')
            .map((value) => Number.parseFloat(value))
            .filter((value) => Number.isFinite(value) && value > 0);
        const explicitColumnSpacings = (section.dataset.ovColumnSpacings || '')
            .split(',')
            .map((value) => Number.parseFloat(value))
            .filter((value) => Number.isFinite(value) && value >= 0);
        const customColumns = section.dataset.ovCustomColumns === 'true'
            && explicitColumnWidths.length > 1
            && sectionColumnCount > 1;
        const hasColumns = sectionColumnCount > 1;
        const columnGapMms = resolveColumnGapMms(section, explicitColumnSpacings, sectionColumnCount);
        let createdPageCount = 0;

        const createPageChrome = () => {
            const sectionPageNumber = createdPageCount + 1;
            const headerCandidates = getHeaderFooterCandidateTexts(sectionMeta, 'header', sectionPageNumber);
            const footerCandidates = getHeaderFooterCandidateTexts(sectionMeta, 'footer', sectionPageNumber);
            const activeHeaderMm = estimateHeaderFooterReserveMm(
                headerCandidates,
                Number.parseFloat(section.dataset.ovHeaderMm || '0')
            );
            const activeFooterMm = estimateHeaderFooterReserveMm(
                footerCandidates,
                Number.parseFloat(section.dataset.ovFooterMm || '0')
            );
            const page = document.createElement('section');
            page.className = 'ov-doc-legacy-page';
            page.dataset.ovSectionPageNumber = String(sectionPageNumber);
            const header = document.createElement('div');
            header.className = 'ov-doc-legacy-page-header';
            const content = document.createElement('div');
            content.className = 'ov-doc-legacy-page-content';
            const footer = document.createElement('div');
            footer.className = 'ov-doc-legacy-page-footer';
            header.textContent = '';
            footer.textContent = '';
            if (headerCandidates.length === 0) {
                header.setAttribute('hidden', 'hidden');
            }
            if (footerCandidates.length === 0) {
                footer.setAttribute('hidden', 'hidden');
            }
            content.style.setProperty('--ov-page-active-header-mm', `${activeHeaderMm.toFixed(2)}mm`);
            content.style.setProperty('--ov-page-active-footer-mm', `${activeFooterMm.toFixed(2)}mm`);
            header.style.setProperty('--ov-page-active-header-mm', `${activeHeaderMm.toFixed(2)}mm`);
            footer.style.setProperty('--ov-page-active-footer-mm', `${activeFooterMm.toFixed(2)}mm`);
            page.appendChild(header);
            page.appendChild(content);
            page.appendChild(footer);

            if (hasColumns) {
                content.classList.add('ov-doc-legacy-page-content-custom-columns');
                const columnsWrap = document.createElement('div');
                columnsWrap.className = 'ov-doc-legacy-page-columns';
                const columnCount = customColumns ? explicitColumnWidths.length : sectionColumnCount;
                const templateTracks = [];
                for (let index = 0; index < columnCount; index++) {
                    templateTracks.push(customColumns ? `${explicitColumnWidths[index].toFixed(2)}mm` : 'minmax(0, 1fr)');
                    if (index < columnCount - 1) {
                        templateTracks.push(`${columnGapMms[index].toFixed(2)}mm`);
                    }
                }
                columnsWrap.style.gridTemplateColumns = templateTracks.join(' ');
                for (let index = 0; index < columnCount; index++) {
                    const column = document.createElement('div');
                    column.className = 'ov-doc-legacy-page-column';
                    columnsWrap.appendChild(column);
                    if (index < columnCount - 1) {
                        const gap = document.createElement('div');
                        gap.className = 'ov-doc-legacy-page-column-gap';
                        gap.setAttribute('aria-hidden', 'true');
                        columnsWrap.appendChild(gap);
                    }
                }
                content.appendChild(columnsWrap);
            }

            pagesHost.appendChild(page);
            createdPageCount += 1;
            return {
                content,
                header,
                footer,
                page,
                columns: hasColumns ? Array.from(content.querySelectorAll(':scope .ov-doc-legacy-page-column')) : [content],
                activeColumnIndex: 0
            };
        };

        const pageHasContent = (page) => page.columns.some((column) => column.children.length > 0);
        const getActiveColumn = (page) => page.columns[page.activeColumnIndex];
        const doesColumnOverflow = (column) => (column.scrollHeight - column.clientHeight) > 1;
        const getColumnRemainingHeight = (column) => Math.max(0, column.clientHeight - column.scrollHeight);
        const ensureNewPage = () => createPageChrome();
        const isTableBlock = (block) => block.classList.contains('ov-doc-legacy-block-table');
        const isListBlock = (block) => (
            block.classList.contains('ov-doc-legacy-block-content')
            && !!block.querySelector(':scope > ul, :scope > ol')
        );
        const isImageGalleryBlock = (block) => block.classList.contains('ov-doc-legacy-block-images');
        const isSheetBlock = (block) => block.classList.contains('ov-doc-legacy-block-sheet');
        const parseBlockMetric = (block, key) => Number.parseInt(block?.dataset?.[key] || '', 10) || 0;
        const isMediaLikeKind = (kind) => ['table', 'sheet', 'image', 'images'].includes(kind);
        const getBlockSemanticKind = (block) => block?.dataset?.ovSemanticKind || '';
        const getBlockSemanticRole = (block) => block?.dataset?.ovSemanticRole || '';
        const estimateListFragmentHeight = (itemCount) => 28 + Math.max(1, itemCount) * 24;
        const estimateTableFragmentHeight = (totalRowCount, headerRowCount) => (
            32 + Math.max(1, headerRowCount) * 28 + Math.max(0, totalRowCount - headerRowCount) * 24
        );
        const estimateImageFragmentHeight = (mediaCount) => (mediaCount <= 1 ? 260 : 120 + (Math.ceil(mediaCount / 2) * 180));
        const estimateSheetFragmentHeight = (hasChart, rowCount) => 72 + (hasChart ? 180 : 0) + Math.max(0, rowCount) * 22;
        const estimateGroupHeight = (candidateBlocks) => candidateBlocks.reduce((sum, block) => (
            sum + parseBlockMetric(block, 'ovEstimatedHeight')
        ), 0);
        const estimateMinimumFollowupHeight = (block) => {
            if (!block) {
                return 0;
            }

            const explicitMinimum = parseBlockMetric(block, 'ovMinFragmentHeight');
            if (explicitMinimum > 0) {
                return explicitMinimum;
            }

            const semanticKind = getBlockSemanticKind(block);
            const totalEstimate = parseBlockMetric(block, 'ovEstimatedHeight');
            if (semanticKind === 'table') {
                const rowCount = parseBlockMetric(block, 'ovRowCount');
                const minRows = Math.min(rowCount, 3);
                return minRows > 0 ? Math.min(totalEstimate, 44 + (minRows * 24)) : totalEstimate;
            }
            if (semanticKind === 'list') {
                const itemCount = parseBlockMetric(block, 'ovItemCount');
                const minItems = Math.min(itemCount, 2);
                return minItems > 0 ? Math.min(totalEstimate, 24 + (minItems * 24)) : totalEstimate;
            }
            if (isMediaLikeKind(semanticKind)) {
                return totalEstimate;
            }
            return 0;
        };
        const shouldPreflightMoveCompoundGroup = (column, candidateBlocks) => {
            if (!column || column.children.length === 0 || candidateBlocks.length < 2) {
                return false;
            }

            const leadBlock = candidateBlocks[0];
            const followBlock = candidateBlocks[1];
            const leadKind = getBlockSemanticKind(leadBlock);
            const leadRole = getBlockSemanticRole(leadBlock);
            const leadTextLength = parseBlockMetric(leadBlock, 'ovTextLength');
            const leadEstimate = parseBlockMetric(leadBlock, 'ovEstimatedHeight');
            const minimumFollowupHeight = estimateMinimumFollowupHeight(followBlock);
            if (leadEstimate <= 0 || minimumFollowupHeight <= 0) {
                return false;
            }

            const isShortLeadContent = (
                (leadKind === 'content' && leadTextLength > 0 && leadTextLength <= 120)
                || leadRole === 'caption'
            );
            if (!isShortLeadContent) {
                return false;
            }

            const remainingHeight = getColumnRemainingHeight(column);
            const requiredHeight = leadEstimate + minimumFollowupHeight;
            return requiredHeight > remainingHeight && requiredHeight <= (column.clientHeight * 0.9);
        };
        const shouldPreflightMoveGroup = (column, candidateBlocks) => {
            if (!column || column.children.length === 0 || candidateBlocks.length === 0) {
                return false;
            }

            const estimatedHeight = estimateGroupHeight(candidateBlocks);
            if (estimatedHeight <= 0) {
                return false;
            }

            const remainingHeight = getColumnRemainingHeight(column);
            return remainingHeight > 0 && estimatedHeight > remainingHeight && estimatedHeight <= (column.clientHeight * 0.92);
        };
        const shouldKeepWithFollowingBlock = (block, nextBlock) => {
            if (!block || !nextBlock) {
                return false;
            }

            if (block.dataset.ovKeepWithNext === 'true') {
                return true;
            }

            const semanticKind = block.dataset.ovSemanticKind || '';
            const semanticTag = block.dataset.ovSemanticTag || '';
            const semanticRole = block.dataset.ovSemanticRole || '';
            const nextSemanticKind = nextBlock.dataset.ovSemanticKind || '';
            const nextSemanticRole = nextBlock.dataset.ovSemanticRole || '';
            const textLength = parseBlockMetric(block, 'ovTextLength');
            const nextTextLength = parseBlockMetric(nextBlock, 'ovTextLength');
            const itemCount = parseBlockMetric(block, 'ovItemCount');
            const rowCount = parseBlockMetric(block, 'ovRowCount');
            const hasInlineField = block.dataset.ovInlineField === 'true';
            const hasInlineBreak = block.dataset.ovInlineBreak === 'true';

            if (semanticKind === 'content' && (semanticTag === 'h1' || semanticTag === 'h2')) {
                if (nextSemanticKind === 'content') {
                    return nextTextLength > 0 && nextTextLength <= 220;
                }
                return ['list', 'table', 'sheet', 'image', 'images'].includes(nextSemanticKind);
            }

            if (semanticRole === 'caption') {
                return isMediaLikeKind(nextSemanticKind);
            }

            if (semanticRole === 'floating-media' || nextSemanticRole === 'floating-media') {
                return false;
            }

            if (isMediaLikeKind(semanticKind) && nextSemanticRole === 'caption') {
                return true;
            }

            if (semanticKind === 'content' && textLength > 0 && textLength <= 48 && nextSemanticKind === 'image') {
                return true;
            }

            if (
                semanticKind === 'content'
                && semanticTag === 'p'
                && !semanticRole
                && !hasInlineField
                && !hasInlineBreak
                && textLength > 0
                && textLength <= 96
                && ['list', 'table', 'image', 'images'].includes(nextSemanticKind)
            ) {
                return true;
            }

            if (semanticKind === 'list' && itemCount > 0 && itemCount <= 3 && isMediaLikeKind(nextSemanticKind)) {
                return true;
            }

            if (semanticKind === 'table' && rowCount > 0 && rowCount <= 4 && nextSemanticRole === 'caption') {
                return true;
            }

            return false;
        };

        const moveToNextSlot = (page) => {
            if (page.activeColumnIndex < page.columns.length - 1) {
                page.activeColumnIndex += 1;
                return page;
            }
            return ensureNewPage();
        };

        const createTableFragmentBlock = (sourceBlock, headerRows, bodyRows, keepPageBreakBefore) => {
            const fragmentBlock = sourceBlock.cloneNode(true);
            const table = fragmentBlock.querySelector('table');
            const thead = table?.querySelector('thead');
            const tbody = table?.querySelector('tbody');
            if (!table || !tbody) {
                return null;
            }

            if (thead) {
                thead.innerHTML = '';
            }
            tbody.innerHTML = '';
            headerRows.forEach((row) => {
                if (thead) {
                    thead.appendChild(row.cloneNode(true));
                } else {
                    tbody.appendChild(row.cloneNode(true));
                }
            });
            if (!thead && headerRows.length > 0) {
                fragmentBlock.dataset.ovSyntheticHeaderRows = String(headerRows.length);
            }
            bodyRows.forEach((row) => tbody.appendChild(row.cloneNode(true)));

            if (!keepPageBreakBefore) {
                fragmentBlock.removeAttribute('data-ov-page-break-before');
            }
            fragmentBlock.dataset.ovTableFragment = 'true';
            fragmentBlock.dataset.ovRowCount = String(headerRows.length + bodyRows.length);
            fragmentBlock.dataset.ovEstimatedHeight = String(
                estimateTableFragmentHeight(headerRows.length + bodyRows.length, headerRows.length)
            );
            return fragmentBlock;
        };

        const splitTableBlockAcrossSlots = (sourceBlock) => {
            const wrapper = sourceBlock.querySelector('.ov-doc-legacy-table');
            const sourceTable = sourceBlock.querySelector('table');
            const sourceHead = sourceTable?.querySelector('thead');
            const sourceBody = sourceTable?.querySelector('tbody');
            if (!sourceTable || !sourceBody) {
                return false;
            }

            let headerRows = sourceHead
                ? Array.from(sourceHead.querySelectorAll(':scope > tr'))
                : [];
            if (!sourceHead && headerRows.length === 0) {
                const headerRowCount = Number.parseInt(wrapper?.dataset.ovTableHeaderRows || '0', 10) || 0;
                if (headerRowCount > 0) {
                    const bodyRows = Array.from(sourceBody.querySelectorAll(':scope > tr'));
                    headerRows = bodyRows.slice(0, headerRowCount);
                }
            }
            const dataRows = Array.from(sourceBody.querySelectorAll(':scope > tr'));
            if (dataRows.length < 1) {
                return false;
            }

            let page = currentPage;
            let column = getActiveColumn(page);
            if (sourceBlock.parentNode === column) {
                column.removeChild(sourceBlock);
            }

            if (column.children.length > 0) {
                page = moveToNextSlot(page);
                column = getActiveColumn(page);
            }

            let rowIndex = 0;
            let firstFragment = true;

            while (rowIndex < dataRows.length) {
                const fragmentStartIndex = rowIndex;
                const fragmentRows = [];
                let fragmentBlock = null;
                let retriedSingleRowFragment = false;

                while (true) {
                    while (rowIndex < dataRows.length) {
                        fragmentRows.push(dataRows[rowIndex]);
                        const nextFragment = createTableFragmentBlock(
                            sourceBlock,
                            headerRows,
                            fragmentRows,
                            firstFragment
                        );
                        if (!nextFragment) {
                            return false;
                        }

                        if (fragmentBlock && fragmentBlock.parentNode === column) {
                            column.removeChild(fragmentBlock);
                        }

                        fragmentBlock = nextFragment;
                        column.appendChild(fragmentBlock);

                        if (doesColumnOverflow(column)) {
                            column.removeChild(fragmentBlock);
                            fragmentBlock = null;

                            if (fragmentRows.length === 1) {
                                const forcedFragment = createTableFragmentBlock(
                                    sourceBlock,
                                    headerRows,
                                    fragmentRows,
                                    firstFragment
                                );
                                if (!forcedFragment) {
                                    return false;
                                }
                                forcedFragment.classList.add('ov-doc-legacy-block-overflow');
                                column.appendChild(forcedFragment);
                                fragmentBlock = forcedFragment;
                                rowIndex += 1;
                                break;
                            }

                            fragmentRows.pop();
                            const fittedFragment = createTableFragmentBlock(
                                sourceBlock,
                                headerRows,
                                fragmentRows,
                                firstFragment
                            );
                            if (!fittedFragment) {
                                return false;
                            }
                            column.appendChild(fittedFragment);
                            fragmentBlock = fittedFragment;
                            break;
                        }

                        rowIndex += 1;
                    }

                    const remainingRows = dataRows.length - rowIndex;
                    const singleRowFragment = fragmentRows.length === 1;
                    if (
                        fragmentBlock
                        && !fragmentBlock.classList.contains('ov-doc-legacy-block-overflow')
                        && singleRowFragment
                        && remainingRows > 0
                        && !retriedSingleRowFragment
                    ) {
                        if (fragmentBlock.parentNode === column) {
                            column.removeChild(fragmentBlock);
                        }
                        fragmentRows.length = 0;
                        fragmentBlock = null;
                        rowIndex = fragmentStartIndex;
                        retriedSingleRowFragment = true;
                        page = moveToNextSlot(page);
                        column = getActiveColumn(page);
                        continue;
                    }

                    break;
                }

                if (!fragmentBlock) {
                    return false;
                }

                firstFragment = false;
                if (rowIndex < dataRows.length) {
                    page = moveToNextSlot(page);
                    column = getActiveColumn(page);
                }
            }

            currentPage = page;
            return true;
        };

        const createListFragmentBlock = (sourceBlock, items, keepPageBreakBefore) => {
            const fragmentBlock = sourceBlock.cloneNode(true);
            const list = fragmentBlock.querySelector(':scope > ul, :scope > ol');
            if (!list) {
                return null;
            }

            list.innerHTML = '';
            items.forEach((item) => list.appendChild(item.cloneNode(true)));

            if (!keepPageBreakBefore) {
                fragmentBlock.removeAttribute('data-ov-page-break-before');
            }
            fragmentBlock.dataset.ovListFragment = 'true';
            fragmentBlock.dataset.ovItemCount = String(items.length);
            fragmentBlock.dataset.ovEstimatedHeight = String(estimateListFragmentHeight(items.length));
            return fragmentBlock;
        };

        const splitListBlockAcrossSlots = (sourceBlock) => {
            const sourceList = sourceBlock.querySelector(':scope > ul, :scope > ol');
            if (!sourceList) {
                return false;
            }

            const items = Array.from(sourceList.querySelectorAll(':scope > li'));
            if (items.length < 2) {
                return false;
            }

            let page = currentPage;
            let column = getActiveColumn(page);
            if (sourceBlock.parentNode === column) {
                column.removeChild(sourceBlock);
            }

            if (column.children.length > 0) {
                page = moveToNextSlot(page);
                column = getActiveColumn(page);
            }

            let itemIndex = 0;
            let firstFragment = true;

            while (itemIndex < items.length) {
                const fragmentStartIndex = itemIndex;
                const fragmentItems = [];
                let fragmentBlock = null;
                let retriedSingleItemFragment = false;

                while (true) {
                    while (itemIndex < items.length) {
                        fragmentItems.push(items[itemIndex]);
                        const nextFragment = createListFragmentBlock(
                            sourceBlock,
                            fragmentItems,
                            firstFragment
                        );
                        if (!nextFragment) {
                            return false;
                        }

                        if (fragmentBlock && fragmentBlock.parentNode === column) {
                            column.removeChild(fragmentBlock);
                        }

                        fragmentBlock = nextFragment;
                        column.appendChild(fragmentBlock);

                        if (doesColumnOverflow(column)) {
                            column.removeChild(fragmentBlock);
                            fragmentBlock = null;

                            if (fragmentItems.length === 1) {
                                const forcedFragment = createListFragmentBlock(
                                    sourceBlock,
                                    fragmentItems,
                                    firstFragment
                                );
                                if (!forcedFragment) {
                                    return false;
                                }
                                forcedFragment.classList.add('ov-doc-legacy-block-overflow');
                                column.appendChild(forcedFragment);
                                fragmentBlock = forcedFragment;
                                itemIndex += 1;
                                break;
                            }

                            fragmentItems.pop();
                            const fittedFragment = createListFragmentBlock(
                                sourceBlock,
                                fragmentItems,
                                firstFragment
                            );
                            if (!fittedFragment) {
                                return false;
                            }
                            column.appendChild(fittedFragment);
                            fragmentBlock = fittedFragment;
                            break;
                        }

                        itemIndex += 1;
                    }

                    const remainingItems = items.length - itemIndex;
                    const singleItemFragment = fragmentItems.length === 1;
                    if (
                        fragmentBlock
                        && !fragmentBlock.classList.contains('ov-doc-legacy-block-overflow')
                        && singleItemFragment
                        && remainingItems > 0
                        && !retriedSingleItemFragment
                    ) {
                        if (fragmentBlock.parentNode === column) {
                            column.removeChild(fragmentBlock);
                        }
                        fragmentItems.length = 0;
                        fragmentBlock = null;
                        itemIndex = fragmentStartIndex;
                        retriedSingleItemFragment = true;
                        page = moveToNextSlot(page);
                        column = getActiveColumn(page);
                        continue;
                    }

                    break;
                }

                if (!fragmentBlock) {
                    return false;
                }

                firstFragment = false;
                if (itemIndex < items.length) {
                    page = moveToNextSlot(page);
                    column = getActiveColumn(page);
                }
            }

            currentPage = page;
            return true;
        };

        const createImageGalleryFragmentBlock = (sourceBlock, figures, keepPageBreakBefore) => {
            const fragmentBlock = sourceBlock.cloneNode(true);
            const grid = fragmentBlock.querySelector('.ov-doc-legacy-image-grid');
            const title = fragmentBlock.querySelector(':scope > h2');
            if (!grid) {
                return null;
            }

            grid.innerHTML = '';
            figures.forEach((figure) => grid.appendChild(figure.cloneNode(true)));
            if (title) {
                title.hidden = figures.length <= 1;
            }

            if (!keepPageBreakBefore) {
                fragmentBlock.removeAttribute('data-ov-page-break-before');
            }
            fragmentBlock.dataset.ovImageFragment = 'true';
            fragmentBlock.dataset.ovMediaCount = String(figures.length);
            fragmentBlock.dataset.ovEstimatedHeight = String(estimateImageFragmentHeight(figures.length));
            fragmentBlock.dataset.ovMinFragmentHeight = String(estimateImageFragmentHeight(Math.min(figures.length, 2)));
            return fragmentBlock;
        };

        const splitImageGalleryBlockAcrossSlots = (sourceBlock) => {
            const grid = sourceBlock.querySelector('.ov-doc-legacy-image-grid');
            if (!grid) {
                return false;
            }

            const figures = Array.from(grid.querySelectorAll(':scope > figure'));
            if (figures.length < 2) {
                return false;
            }

            let page = currentPage;
            let column = getActiveColumn(page);
            if (sourceBlock.parentNode === column) {
                column.removeChild(sourceBlock);
            }

            if (column.children.length > 0) {
                page = moveToNextSlot(page);
                column = getActiveColumn(page);
            }

            let figureIndex = 0;
            let firstFragment = true;

            while (figureIndex < figures.length) {
                const fragmentStartIndex = figureIndex;
                const fragmentFigures = [];
                let fragmentBlock = null;
                let retriedSingleFigureFragment = false;

                while (true) {
                    while (figureIndex < figures.length) {
                        fragmentFigures.push(figures[figureIndex]);
                        const nextFragment = createImageGalleryFragmentBlock(
                            sourceBlock,
                            fragmentFigures,
                            firstFragment
                        );
                        if (!nextFragment) {
                            return false;
                        }

                        if (fragmentBlock && fragmentBlock.parentNode === column) {
                            column.removeChild(fragmentBlock);
                        }

                        fragmentBlock = nextFragment;
                        column.appendChild(fragmentBlock);

                        if (doesColumnOverflow(column)) {
                            column.removeChild(fragmentBlock);
                            fragmentBlock = null;

                            if (fragmentFigures.length === 1) {
                                const forcedFragment = createImageGalleryFragmentBlock(
                                    sourceBlock,
                                    fragmentFigures,
                                    firstFragment
                                );
                                if (!forcedFragment) {
                                    return false;
                                }
                                forcedFragment.classList.add('ov-doc-legacy-block-overflow');
                                column.appendChild(forcedFragment);
                                fragmentBlock = forcedFragment;
                                figureIndex += 1;
                                break;
                            }

                            fragmentFigures.pop();
                            const fittedFragment = createImageGalleryFragmentBlock(
                                sourceBlock,
                                fragmentFigures,
                                firstFragment
                            );
                            if (!fittedFragment) {
                                return false;
                            }
                            column.appendChild(fittedFragment);
                            fragmentBlock = fittedFragment;
                            break;
                        }

                        figureIndex += 1;
                    }

                    const remainingFigures = figures.length - figureIndex;
                    const singleFigureFragment = fragmentFigures.length === 1;
                    if (
                        fragmentBlock
                        && !fragmentBlock.classList.contains('ov-doc-legacy-block-overflow')
                        && singleFigureFragment
                        && remainingFigures > 0
                        && !retriedSingleFigureFragment
                    ) {
                        if (fragmentBlock.parentNode === column) {
                            column.removeChild(fragmentBlock);
                        }
                        fragmentFigures.length = 0;
                        fragmentBlock = null;
                        figureIndex = fragmentStartIndex;
                        retriedSingleFigureFragment = true;
                        page = moveToNextSlot(page);
                        column = getActiveColumn(page);
                        continue;
                    }

                    break;
                }

                if (!fragmentBlock) {
                    return false;
                }

                firstFragment = false;
                if (figureIndex < figures.length) {
                    page = moveToNextSlot(page);
                    column = getActiveColumn(page);
                }
            }

            currentPage = page;
            return true;
        };

        const createSheetFragmentBlock = (sourceBlock, options) => {
            const fragmentBlock = sourceBlock.cloneNode(true);
            const chart = fragmentBlock.querySelector('.ov-doc-embedded-chart');
            const tableWrap = fragmentBlock.querySelector('.ov-doc-embedded-table-wrap');
            const rowCount = options.rowCount || 0;
            if (chart) {
                chart.hidden = !options.includeChart;
            }
            if (tableWrap) {
                tableWrap.hidden = !options.includeTable;
            }

            if (!options.keepPageBreakBefore) {
                fragmentBlock.removeAttribute('data-ov-page-break-before');
            }
            fragmentBlock.dataset.ovSheetFragment = 'true';
            fragmentBlock.dataset.ovRowCount = String(rowCount);
            fragmentBlock.dataset.ovEstimatedHeight = String(
                estimateSheetFragmentHeight(!!options.includeChart, rowCount)
            );
            fragmentBlock.dataset.ovMinFragmentHeight = String(
                estimateSheetFragmentHeight(!!options.includeChart, Math.min(rowCount, 3))
            );
            return fragmentBlock;
        };

        const createSheetTableFragmentBlock = (sourceBlock, headerRows, bodyRows, keepPageBreakBefore) => {
            const fragmentBlock = createSheetFragmentBlock(sourceBlock, {
                includeChart: false,
                includeTable: true,
                rowCount: headerRows.length + bodyRows.length,
                keepPageBreakBefore
            });
            const table = fragmentBlock?.querySelector('.ov-doc-embedded-table-wrap table');
            const thead = table?.querySelector('thead');
            const tbody = table?.querySelector('tbody');
            if (!fragmentBlock || !table || !tbody) {
                return null;
            }

            if (thead) {
                thead.innerHTML = '';
                headerRows.forEach((row) => thead.appendChild(row.cloneNode(true)));
            }
            tbody.innerHTML = '';
            bodyRows.forEach((row) => tbody.appendChild(row.cloneNode(true)));
            fragmentBlock.dataset.ovSheetTableFragment = 'true';
            fragmentBlock.dataset.ovRowCount = String(headerRows.length + bodyRows.length);
            fragmentBlock.dataset.ovEstimatedHeight = String(
                estimateSheetFragmentHeight(false, headerRows.length + bodyRows.length)
            );
            fragmentBlock.dataset.ovMinFragmentHeight = String(
                estimateSheetFragmentHeight(false, Math.min(headerRows.length + bodyRows.length, 3))
            );
            return fragmentBlock;
        };

        const splitSheetTableAcrossSlots = (sourceBlock, startPage, includeChartFirst) => {
            const table = sourceBlock.querySelector('.ov-doc-embedded-table-wrap table');
            const thead = table?.querySelector('thead');
            const tbody = table?.querySelector('tbody');
            if (!table || !tbody) {
                return { success: false, page: startPage };
            }

            const headerRows = thead
                ? Array.from(thead.querySelectorAll(':scope > tr'))
                : [];
            const dataRows = Array.from(tbody.querySelectorAll(':scope > tr'));
            if (dataRows.length < 1) {
                return { success: false, page: startPage };
            }
            let page = startPage;
            let column = getActiveColumn(page);
            let rowIndex = 0;
            let firstFragment = includeChartFirst;

            while (rowIndex < dataRows.length) {
                const fragmentStartIndex = rowIndex;
                const fragmentRows = [];
                let fragmentBlock = null;
                let retriedSingleRowFragment = false;

                while (true) {
                    while (rowIndex < dataRows.length) {
                        fragmentRows.push(dataRows[rowIndex]);
                        const nextFragment = createSheetTableFragmentBlock(
                            sourceBlock,
                            headerRows,
                            fragmentRows,
                            firstFragment
                        );
                        if (!nextFragment) {
                            return { success: false, page };
                        }

                        if (fragmentBlock && fragmentBlock.parentNode === column) {
                            column.removeChild(fragmentBlock);
                        }

                        fragmentBlock = nextFragment;
                        column.appendChild(fragmentBlock);

                        if (doesColumnOverflow(column)) {
                            column.removeChild(fragmentBlock);
                            fragmentBlock = null;

                            if (fragmentRows.length === 1) {
                                const forcedFragment = createSheetTableFragmentBlock(
                                    sourceBlock,
                                    headerRows,
                                    fragmentRows,
                                    firstFragment
                                );
                                if (!forcedFragment) {
                                    return { success: false, page };
                                }
                                forcedFragment.classList.add('ov-doc-legacy-block-overflow');
                                column.appendChild(forcedFragment);
                                fragmentBlock = forcedFragment;
                                rowIndex += 1;
                                break;
                            }

                            fragmentRows.pop();
                            const fittedFragment = createSheetTableFragmentBlock(
                                sourceBlock,
                                headerRows,
                                fragmentRows,
                                firstFragment
                            );
                            if (!fittedFragment) {
                                return { success: false, page };
                            }
                            column.appendChild(fittedFragment);
                            fragmentBlock = fittedFragment;
                            break;
                        }

                        rowIndex += 1;
                    }

                    const remainingRows = dataRows.length - rowIndex;
                    const singleRowFragment = fragmentRows.length === 1;
                    if (
                        fragmentBlock
                        && !fragmentBlock.classList.contains('ov-doc-legacy-block-overflow')
                        && singleRowFragment
                        && remainingRows > 0
                        && !retriedSingleRowFragment
                    ) {
                        if (fragmentBlock.parentNode === column) {
                            column.removeChild(fragmentBlock);
                        }
                        fragmentRows.length = 0;
                        fragmentBlock = null;
                        rowIndex = fragmentStartIndex;
                        retriedSingleRowFragment = true;
                        page = moveToNextSlot(page);
                        column = getActiveColumn(page);
                        continue;
                    }

                    break;
                }

                if (!fragmentBlock) {
                    return { success: false, page };
                }

                firstFragment = false;
                if (rowIndex < dataRows.length) {
                    page = moveToNextSlot(page);
                    column = getActiveColumn(page);
                }
            }

            return { success: true, page };
        };

        const splitSheetBlockAcrossSlots = (sourceBlock) => {
            const chart = sourceBlock.querySelector('.ov-doc-embedded-chart');
            const tableWrap = sourceBlock.querySelector('.ov-doc-embedded-table-wrap');
            if (!chart || !tableWrap) {
                return false;
            }

            const rowCount = parseBlockMetric(sourceBlock, 'ovRowCount');
            let page = currentPage;
            let column = getActiveColumn(page);
            if (sourceBlock.parentNode === column) {
                column.removeChild(sourceBlock);
            }

            const chartFragment = createSheetFragmentBlock(sourceBlock, {
                includeChart: true,
                includeTable: false,
                rowCount: 0,
                keepPageBreakBefore: true
            });
            const tableFragment = createSheetFragmentBlock(sourceBlock, {
                includeChart: false,
                includeTable: true,
                rowCount,
                keepPageBreakBefore: false
            });

            if (!chartFragment || !tableFragment) {
                return false;
            }

            column.appendChild(chartFragment);
            if (doesColumnOverflow(column)) {
                column.removeChild(chartFragment);
                return false;
            }

            const splitResult = splitSheetTableAcrossSlots(sourceBlock, page, false);
            if (splitResult.success) {
                currentPage = splitResult.page;
                return true;
            }

            column.appendChild(tableFragment);
            if (doesColumnOverflow(column)) {
                column.removeChild(tableFragment);
                page = moveToNextSlot(page);
                column = getActiveColumn(page);
                column.appendChild(tableFragment);
                if (doesColumnOverflow(column)) {
                    if (tableFragment.parentNode === column) {
                        column.removeChild(tableFragment);
                    }
                    return false;
                }
            }

            currentPage = page;
            return true;
        };

        const placeBlocks = (candidateBlocks) => {
            let page = currentPage;
            let column = getActiveColumn(page);

            while (candidateBlocks.some((block) => block.dataset.ovPageBreakBefore === 'true') && pageHasContent(page)) {
                page = ensureNewPage();
                column = getActiveColumn(page);
                break;
            }

            if (shouldPreflightMoveCompoundGroup(column, candidateBlocks) || shouldPreflightMoveGroup(column, candidateBlocks)) {
                page = moveToNextSlot(page);
                column = getActiveColumn(page);
            }

            for (const block of candidateBlocks) {
                column.appendChild(block);
            }

            while (doesColumnOverflow(column)) {
                candidateBlocks.forEach((block) => {
                    if (block.parentNode === column) {
                        column.removeChild(block);
                    }
                });

                const nextPage = moveToNextSlot(page);
                if (nextPage === page && getActiveColumn(nextPage) === column) {
                    break;
                }

                page = nextPage;
                column = getActiveColumn(page);
                candidateBlocks.forEach((block) => column.appendChild(block));

                if (candidateBlocks.length === 1 && isTableBlock(candidateBlocks[0])) {
                    const didSplit = splitTableBlockAcrossSlots(candidateBlocks[0]);
                    if (didSplit) {
                        return;
                    }
                }

                if (candidateBlocks.length === 1 && isListBlock(candidateBlocks[0])) {
                    const didSplit = splitListBlockAcrossSlots(candidateBlocks[0]);
                    if (didSplit) {
                        return;
                    }
                }

                if (candidateBlocks.length === 1 && isImageGalleryBlock(candidateBlocks[0])) {
                    const didSplit = splitImageGalleryBlockAcrossSlots(candidateBlocks[0]);
                    if (didSplit) {
                        return;
                    }
                }

                if (candidateBlocks.length === 1 && isSheetBlock(candidateBlocks[0])) {
                    const didSplit = splitSheetBlockAcrossSlots(candidateBlocks[0]);
                    if (didSplit) {
                        return;
                    }
                }

                if (doesColumnOverflow(column) && candidateBlocks.length === 1 && column.children.length === 1) {
                    candidateBlocks[0].classList.add('ov-doc-legacy-block-overflow');
                    break;
                }
            }

            currentPage = page;
        };

        const collectKeepTogetherBlocks = (startIndex) => {
            const grouped = [blocks[startIndex]];
            let nextIndex = startIndex + 1;

            while (nextIndex < blocks.length && shouldKeepWithFollowingBlock(grouped[grouped.length - 1], blocks[nextIndex])) {
                grouped.push(blocks[nextIndex]);
                nextIndex += 1;
            }

            return {
                grouped,
                nextIndex
            };
        };

        let currentPage = createPageChrome();

        for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
            const { grouped, nextIndex } = collectKeepTogetherBlocks(blockIndex);
            placeBlocks(grouped);
            blockIndex = nextIndex - 1;
        }

        paginatedSections.push({ section, sectionMeta, pagesHost });
    }

    const totalDocumentPages = paginatedSections.reduce((sum, entry) => sum + entry.pagesHost.children.length, 0);
    let globalPageNumber = 0;

    for (const entry of paginatedSections) {
        const sectionPageCount = entry.pagesHost.children.length;
        Array.from(entry.pagesHost.children).forEach((pageNode, index) => {
            const sectionPageNumber = index + 1;
            globalPageNumber += 1;
            const headerNode = pageNode.querySelector('.ov-doc-legacy-page-header');
            const footerNode = pageNode.querySelector('.ov-doc-legacy-page-footer');
            if (headerNode) {
                headerNode.textContent = resolveHeaderFooterText(
                    entry.sectionMeta,
                    'header',
                    globalPageNumber,
                    totalDocumentPages,
                    sectionPageNumber,
                    sectionPageCount
                );
            }
            if (footerNode) {
                footerNode.textContent = resolveHeaderFooterText(
                    entry.sectionMeta,
                    'footer',
                    globalPageNumber,
                    totalDocumentPages,
                    sectionPageNumber,
                    sectionPageCount
                );
            }
        });
    }

    legacyRoot.dataset.ovPaginated = 'true';
}
function resolveHeaderFooterText(meta, type, pageNumber, totalPages, sectionPageNumber, sectionPageCount) {
    const sourceText = getHeaderFooterSourceText(meta, type, pageNumber, sectionPageNumber);
    return renderHeaderFooterFields(sourceText, pageNumber, totalPages, sectionPageNumber, sectionPageCount, meta);
}

function getHeaderFooterCandidateTexts(meta, type, sectionPageNumber) {
    if (!meta || typeof meta !== 'object') {
        return [];
    }

    const firstKey = type === 'header' ? 'firstHeaderText' : 'firstFooterText';
    const evenKey = type === 'header' ? 'evenHeaderText' : 'evenFooterText';
    const oddKey = type === 'header' ? 'oddHeaderText' : 'oddFooterText';
    const candidates = [];
    const seen = new Set();

    if (sectionPageNumber === 1) {
        const firstValue = typeof meta[firstKey] === 'string' ? meta[firstKey].trim() : '';
        if (firstValue) {
            seen.add(firstValue);
            candidates.push(firstValue);
        }
    }

    [oddKey, evenKey].forEach((key) => {
        const value = typeof meta[key] === 'string' ? meta[key].trim() : '';
        if (value && !seen.has(value)) {
            seen.add(value);
            candidates.push(value);
        }
    });

    return candidates;
}

function getHeaderFooterSourceText(meta, type, pageNumber, sectionPageNumber) {
    if (!meta || typeof meta !== 'object') {
        return '';
    }

    const isFirstPage = sectionPageNumber === 1;
    const isEvenPage = pageNumber % 2 === 0;
    const firstKey = type === 'header' ? 'firstHeaderText' : 'firstFooterText';
    const evenKey = type === 'header' ? 'evenHeaderText' : 'evenFooterText';
    const oddKey = type === 'header' ? 'oddHeaderText' : 'oddFooterText';

    return (
        (isFirstPage && typeof meta[firstKey] === 'string' && meta[firstKey].trim() && meta[firstKey])
        || (isEvenPage && typeof meta[evenKey] === 'string' && meta[evenKey].trim() && meta[evenKey])
        || (typeof meta[oddKey] === 'string' && meta[oddKey].trim() && meta[oddKey])
        || (typeof meta[evenKey] === 'string' && meta[evenKey].trim() && meta[evenKey])
        || ''
    );
}

function estimateHeaderFooterReserveMm(textOrCandidates, fallbackMm) {
    const safeFallback = Number.isFinite(fallbackMm) && fallbackMm > 0 ? fallbackMm : 0;
    const candidates = Array.isArray(textOrCandidates)
        ? textOrCandidates
        : [textOrCandidates];
    const normalizedCandidates = candidates
        .map((value) => String(value || '').trim())
        .filter((value) => value.length > 0);
    if (normalizedCandidates.length === 0) {
        return 0;
    }

    const estimatedMm = normalizedCandidates.reduce((maxMm, normalized) => {
        const explicitLines = normalized.split(/\r?\n/).length;
        const estimatedWrappedLines = Math.max(explicitLines, Math.ceil(normalized.length / 48));
        return Math.max(maxMm, 2.5 + (estimatedWrappedLines * 4.8));
    }, 0);
    return Math.max(safeFallback, Math.min(28, estimatedMm));
}

function resolveColumnGapMms(section, explicitColumnSpacings, sectionColumnCount) {
    const computedGap = Number.parseFloat(window.getComputedStyle(section).getPropertyValue('--ov-column-gap-mm'));
    const fallbackGap = Number.isFinite(computedGap) && computedGap >= 0 ? computedGap : 12.7;
    const gapCount = Math.max(0, sectionColumnCount - 1);
    const resolved = [];

    for (let index = 0; index < gapCount; index++) {
        const explicitGap = explicitColumnSpacings[index];
        resolved.push(Number.isFinite(explicitGap) && explicitGap >= 0 ? explicitGap : fallbackGap);
    }

    return resolved;
}

function renderHeaderFooterFields(text, pageNumber, totalPages, sectionPageNumber, sectionPageCount, meta) {
    const sectionNumber = Number.isFinite(Number(meta?.sectionNumber))
        ? Number(meta.sectionNumber)
        : 1;
    const sectionCount = Number.isFinite(Number(meta?.sectionCount))
        ? Number(meta.sectionCount)
        : 1;
    return String(text || '')
        .replace(/\bSECTIONPAGES\b/gi, sectionPageCount > 0 ? String(sectionPageCount) : '')
        .replace(/\bSECTIONS\b/gi, sectionCount > 0 ? String(sectionCount) : '')
        .replace(/\bNUMPAGES\b/gi, totalPages > 0 ? String(totalPages) : '')
        .replace(/\bPAGE\b/gi, pageNumber > 0 ? String(pageNumber) : '')
        .replace(/\bSECTION\b/gi, sectionNumber > 0 ? String(sectionNumber) : '1')
        .replace(/\bSECTIONPAGE\b/gi, sectionPageNumber > 0 ? String(sectionPageNumber) : '')
        .trim();
}
