/**
 * Streaming Layout - Container Components
 *
 * StreamingContainerComponent  — owns #streaming-container shell and scroll-to-top btn
 * StreamingFilterBarComponent  — owns filter pill bar DOM and click delegation
 *
 * No orchestration lives here. loadAndRender(), pagination, and all data
 * fetching/render coordination live in index.js.
 */

import { handlePillClear, getLeafName } from '../../ui/categoryFilterPill.js';
import { chevronUpIcon } from '../../../utils/icons.js';
import { Component, createElement, append } from '../../../libs/ragot.esm.min.js';

// ── StreamingContainerComponent ─────────────────────────────────────────────
/**
 * Owns the #streaming-container div shell.
 * Renders slots for hero, filter bar, rows area, and grid area.
 * Also mounts the floating scroll-to-top button.
 */
export class StreamingContainerComponent extends Component {
    constructor() {
        super({});
    }

    render() {
        return createElement('div', {
            className: 'streaming-container',
            id: 'streaming-container'
        },
            createElement('div', { id: 'streaming-hero-slot' }),
            createElement('div', { id: 'streaming-filter-bar-slot' }),
            createElement('div', { id: 'streaming-content-container' })
        );
    }

    onStart() {
        if (!this.element) return;

        // Keep this in the app shell so theme-builder minimization captures it
        // with the rest of the app instead of leaving it viewport-anchored.
        const existing = document.getElementById('streaming-scroll-top');
        if (existing) existing.remove();

        const scrollBtn = createElement('button', {
            id: 'streaming-scroll-top',
            className: 'streaming-scroll-top-btn',
            title: 'Scroll to top',
            'aria-label': 'Scroll to top',
            style: { display: 'none' }
        });
        scrollBtn.innerHTML = chevronUpIcon(24);
        append(this.element, scrollBtn);
        this._scrollBtn = scrollBtn;

        this.on(this.element, 'scroll', () => {
            if (!this.element || !this._scrollBtn) return;
            const visible = this.element.scrollTop > 300;
            this._scrollBtn.classList.toggle('visible', visible);
            this._scrollBtn.style.display = visible ? 'flex' : 'none';
        });

        this.on(scrollBtn, 'click', (e) => {
            e.preventDefault();
            if (this.element) this.element.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    onStop() {
        if (this._scrollBtn) {
            this._scrollBtn.remove();
            this._scrollBtn = null;
        }
    }

    scrollToTop(smooth = false) {
        if (this.element) this.element.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
    }
}

// ── StreamingFilterBarComponent ─────────────────────────────────────────────
/**
 * Owns the filter pill bar.
 * State: { mediaFilter, categoryIdFilter, subfolderFilter, parentNameFilter, categoryNameFilter }
 */
export class StreamingFilterBarComponent extends Component {
    constructor() {
        super({
            mediaFilter: 'all',
            categoryIdFilter: null,
            subfolderFilter: null,
            parentNameFilter: null,
            categoryNameFilter: null,
        });
        this._onFilterClick = null;
    }

    setFilterClickHandler(fn) { this._onFilterClick = fn; }

    render() {
        const { mediaFilter, categoryIdFilter, subfolderFilter, parentNameFilter, categoryNameFilter } = this.state;
        const hasNavFilter = !!(categoryIdFilter || subfolderFilter || parentNameFilter);

        const createBtn = (type, label) => createElement('button', {
            className: `pill pill--filter pill--sm ${mediaFilter === type && !hasNavFilter ? 'pill--active' : ''}`,
            dataset: { filter: type },
            textContent: label
        });

        let pillName = null;
        if (hasNavFilter) {
            if (subfolderFilter) {
                const leaf = subfolderFilter.split('/').pop();
                pillName = leaf ? leaf.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : subfolderFilter;
            } else {
                pillName = getLeafName(categoryNameFilter || parentNameFilter);
            }
        }

        return createElement('div', { className: 'gh-streaming__filter-bar', id: 'streaming-filter-bar' },
            createElement('div', { className: 'gh-streaming__filter-buttons' },
                createBtn('all', 'All'),
                createBtn('video', 'Videos'),
                createBtn('image', 'Photos')
            ),
            createElement('div', { className: `category-active-filter ${pillName ? '' : 'hidden'}` },
                createElement('span', {
                    className: `pill pill--breadcrumb pill--sm ${pillName ? 'pill--active' : 'hidden'}`,
                    dataset: { categoryFilterPill: '' },
                    textContent: pillName || ''
                })
            )
        );
    }

    onStart() {
        if (!this.element) return;
        this.on(this.element, 'click', (e) => {
            const btn = e.target.closest('.pill--filter[data-filter]');
            if (btn && this._onFilterClick) {
                this._onFilterClick(btn.dataset.filter);
                return;
            }
            const pill = e.target.closest('[data-category-filter-pill]');
            if (pill) handlePillClear();
        });
    }
}
