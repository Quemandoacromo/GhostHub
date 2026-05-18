/**
 * Streaming Layout - Main Entry Point
 * Netflix/HBO Max style horizontal browsing interface.
 *
 * Architecture:
 *   StreamingLayoutModule (Module)
 *     adopt(streamingState)
 *     adoptComponent(_containerComp)   ← #streaming-container shell + scroll-to-top
 *     adoptComponent(_heroComp)        ← hero banner
 *     adoptComponent(_filterBarComp)   ← filter pill bar
 *     adoptComponent(_rowsComp, sync)  ← rows — state-driven via sync, no refresh()
 *     adoptComponent(_gridComp)        ← single-category grid (mounted on demand)
 *
 *   Data flow: fetch → streamingState.setState → adoptComponent sync → component.setState → morphDOM
 *   No imperative refresh() or clear() on the rows component.
 */

import {
    isActive,
    getContainer,
    setContainer,
    setIsStreamingLayout,
    getIsLoading,
    getContinueWatchingData,
    clearCategoryMediaCache,
    getCategoriesData,
    getCategoryCache,
    setCategoriesData,
    setCategoryCache,
    setCategoryIdFilter,
    setCategoryNameFilter,
    setSubfolderFilter,
    setParentNameFilter,
    setCategoryIdsFilter,
    setMediaFilter,
    setCurrentPage,
    getCategoryIdFilter,
    getSubfolderFilter,
    getVideoProgressMap,
    setVideoProgress,
    deleteVideoProgress,
    setContinueWatchingData,
    getGridMode,
    setGridTotalItems,
    streamingState
} from './state.js';

import { resolveCategoryName, updateCategoryFilterPill, flushFilterBarScroll } from '../../ui/categoryFilterPill.js';
import { initLazyLoading, cleanupLazyLoading, refreshLazyLoader } from './lazyLoad.js';
import { StreamingContainerComponent, StreamingFilterBarComponent } from './renderer.js';
import { StreamingHeroComponent } from './hero.js';
import { StreamingRowsComponent, updateMediaCardProgressBars, cancelMediaCardProgressBars } from './rows.js';
import { StreamingGridComponent } from './grid.js';
import { openViewerByUrl, openViewer } from './navigation.js';
import {
    fetchCategories,
    fetchAllCategoryMedia,
    buildContinueWatchingData,
    fetchNewestMedia,
    fetchCategoryMedia,
    primeCategoryLoadingShells
} from './data.js';
import { registerLayoutHandler } from '../../../utils/layoutUtils.js';
import { initProgressSync } from '../../media/progressSync.js';
import { syncShowHiddenFromEvent } from '../../../utils/showHiddenManager.js';
import { createLayoutChangeLifecycle } from '../shared/layoutLifecycle.js';
import { createLayoutSocketHandlerManager } from '../shared/socketHandlers.js';
import { createLayoutFilterActions } from '../shared/filterActions.js';
import { createThumbnailProgressTracker } from '../shared/thumbnailProgressLifecycle.js';
import { withOptionalViewTransition } from '../../../utils/viewTransitions.js';
import { getActiveProfileId, hasActiveProfile } from '../../../utils/profileUtils.js';
import { calculateProgress } from '../../../utils/layoutUtils.js';
import { APP_EVENTS } from '../../../core/appEvents.js';
import { Module, createElement, append, clear, $, $$ } from '../../../libs/ragot.esm.min.js';

export function transitionToSingleCategoryGrid({
    category,
    cache,
    mountGrid,
    unmountRows,
}) {
    if (!category || !cache) return;

    withOptionalViewTransition(() => {
        mountGrid(category, cache);
        unmountRows();
    }, {
        fallbackClass: 'gh-transition-surface'
    });
}

// ── StreamingLayoutModule ────────────────────────────────────────────────────

class StreamingLayoutModule extends Module {
    constructor() {
        super({ isInitialized: false });
        this._containerComp = null;
        this._heroComp = null;
        this._filterBarComp = null;
        this._rowsComp = null;
        this._gridComp = null;
    }

    onStart() {
        this.adopt(streamingState);
    }

    // ── Root mount ────────────────────────────────────────────────────────

    async mountRoot(target) {
        if (this._containerComp) return this._containerComp.element;
        this._containerComp = new StreamingContainerComponent();
        this.adoptComponent(this._containerComp, {
            startMethod: 'mount',
            stopMethod: 'unmount',
            startArgs: [target]
        });
        setContainer(this._containerComp.element);
        return this._containerComp.element;
    }

    // ── Component mount ───────────────────────────────────────────────────

    mountComponents() {
        if (!this._containerComp || !this._containerComp.element) return;

        const heroSlot = document.getElementById('streaming-hero-slot');
        const filterSlot = document.getElementById('streaming-filter-bar-slot');
        const rowsSlot = document.getElementById('streaming-content-container');

        // ── Hero ──
        if (!this._heroComp) {
            this._heroComp = new StreamingHeroComponent();
            this.adoptComponent(this._heroComp, {
                startMethod: 'mount',
                stopMethod: 'unmount',
                startArgs: [heroSlot]
            });
            // Only push hero state when hero-relevant data actually changes.
            // categoryMediaCache updates on every row chunk load — if we pushed
            // on every change the hero title/image would flicker constantly.
            const heroSelector = (s) => {
                const cw = s.continueWatchingData;
                const cats = s.categoriesData;
                const cache = s.categoryMediaCache;

                // Hero priority 1: first CW item fingerprint
                if (cw && cw.length > 0) {
                    const item = cw[0];
                    return `cw|${item.videoUrl}|${item.videoTimestamp}|${item.videoDuration}`;
                }

                // Hero priority 2: first media item from first cached category
                if (cats && cats.length > 0) {
                    for (const cat of cats) {
                        const cacheKey = `${cat.id}|sf:|mf:all`;
                        const entry = cache && cache[cacheKey];
                        if (entry && entry.media && entry.media.length > 0) {
                            const m = entry.media[0];
                            return `cat|${cat.id}|${m.url || m.name}`;
                        }
                    }
                    // Priority 3: just the first category thumbnail
                    const fc = cats[0];
                    return `cat|${fc.id}|${fc.thumbnailUrl || fc.thumbnail || ''}`;
                }

                return 'empty';
            };

            streamingState.subscribe((_slice, s) => {
                this._heroComp.setState({
                    continueWatchingData: s.continueWatchingData || [],
                    categoriesData: s.categoriesData || [],
                    categoryMediaCache: s.categoryMediaCache || {},
                });
            }, { owner: this, immediate: true, selector: heroSelector });
        }

        // ── Filter bar ──
        if (!this._filterBarComp) {
            this._filterBarComp = new StreamingFilterBarComponent();
            this.adoptComponent(this._filterBarComp, {
                startMethod: 'mount',
                stopMethod: 'unmount',
                startArgs: [filterSlot]
            });
            streamingState.subscribe((_slice, s) => {
                this._filterBarComp.setState({
                    mediaFilter: s.mediaFilter,
                    categoryIdFilter: s.categoryIdFilter,
                    subfolderFilter: s.subfolderFilter,
                    parentNameFilter: s.parentNameFilter,
                    categoryNameFilter: s.categoryNameFilter,
                });
            }, {
                owner: this,
                immediate: true,
                // Only re-run when a filter field actually changes — avoids re-rendering
                // the filter bar on every streaming state mutation (e.g. cache updates).
                // NOTE: when a selector is provided, fn receives (slice, fullState, module)
                // — use the second arg for the full state object.
                selector: (s) => `${s.mediaFilter}|${s.categoryIdFilter}|${s.subfolderFilter}|${s.parentNameFilter}|${s.categoryNameFilter}|${s.categoryIdsFilter}`,
            });

            this._filterBarComp.setFilterClickHandler((filter) => {
                const activeFilter = streamingState.state.mediaFilter;
                const hasAnyNavFilter = streamingState.state.categoryIdFilter !== null ||
                    streamingState.state.parentNameFilter !== null ||
                    streamingState.state.subfolderFilter !== null;
                if (filter !== activeFilter || hasAnyNavFilter) {
                    setMediaFilter(filter);
                    setCurrentPage(1);
                    setCategoryIdFilter(null);
                    setCategoryNameFilter(null);
                    setSubfolderFilter(null);
                    setParentNameFilter(null);
                    setCategoryIdsFilter(null);
                    updateCategoryFilterPill(null);
                    loadAndRender();
                }
            });
        }

        // ── Rows ──
        // Rows are mounted on demand in mountRows() / unmounted in unmountRows()
        // rather than being kept alive as a persistent singleton. This avoids
        // the display:none ↔ display:'' toggle that caused a visible scroll-snap
        // artifact on any row the user had horizontally scrolled before switching
        // to grid/subfolder view.
        //
        // State-driven updates still go through setState() calls in loadAndRender(),
        // refreshSecondaryRows(), and handleViewerClosed(). No continuous
        // streamingState subscription — that caused a feedback loop where
        // chunk loads (which update categoryMediaCache in streamingState)
        // triggered _rebuildRows(), destroying all VirtualScroller instances
        // and causing visible flickering across every row.
    }

    // ── Grid management ───────────────────────────────────────────────────

    mountGrid(category, cache) {
        const scrollRoot = this._containerComp?.element || document.getElementById('streaming-container');
        const gridSlot = document.getElementById('streaming-content-container');
        if (!gridSlot) return;

        if (this._gridComp && this._gridComp.element) {
            // Grid already mounted — recycle VS and patch DOM in-place
            this._gridComp.rebind(category, cache);
            return;
        }

        this.unmountGrid();
        this._gridComp = new StreamingGridComponent(category, cache, scrollRoot);
        this.adoptComponent(this._gridComp, {
            startMethod: 'mount',
            stopMethod: 'unmount',
            startArgs: [gridSlot]
        });
    }

    unmountGrid() {
        const hadMountedGrid = !!(this._gridComp && this._gridComp.element);
        if (this._gridComp) {
            this._gridComp.unmount();
            this._gridComp = null;
        }
        // rows and grid share #streaming-content-container.
        // Only clear that slot when a grid was actually mounted; otherwise we can
        // accidentally remove an already-mounted rows component from the DOM.
        if (hadMountedGrid) {
            const activeGridSlot = document.getElementById('streaming-content-container');
            if (activeGridSlot) clear(activeGridSlot);
        }
        return hadMountedGrid;
    }

    isGridMounted() {
        return !!(this._gridComp && this._gridComp.element);
    }

    mountRows() {
        const rowsSlot = document.getElementById('streaming-content-container');
        if (!rowsSlot) return false;
        if (this._rowsComp) {
            // Recovery guard: if rows were detached from the shared slot (for example
            // by an out-of-order clear) or the component lifecycle got stale, remount
            // a fresh rows component so subsequent state updates render normally.
            const rowsMounted = !!(
                this._rowsComp.element &&
                rowsSlot.contains(this._rowsComp.element) &&
                this._rowsComp._isMounted === true
            );
            if (rowsMounted) return false;
            this._rowsComp.unmount();
            this._rowsComp = null;
        }
        this._rowsComp = new StreamingRowsComponent();
        this.adoptComponent(this._rowsComp, {
            startMethod: 'mount',
            stopMethod: 'unmount',
            startArgs: [rowsSlot]
        });
        return true;
    }

    unmountRows() {
        if (this._rowsComp) {
            this._rowsComp.unmount();
            this._rowsComp = null;
        }
    }

    // ── Event wiring ──────────────────────────────────────────────────────

    wireEvents() {
        // Categories loaded (bus)
        this.on(document, 'categoriesLoaded', async (e) => {
            if (!isActive()) return;
            await loadAndRender(false, { refreshContinueWatching: false, refreshWhatsNew: false });
        });

        // Progress updated (DOM event from legacy path)
        this.on(document, 'progressUpdated', () => {
            if (!isActive()) return;
            buildContinueWatchingData().catch(() => { });
        });

        // Local progress update (IndexedDB path for no-profile session mode)
        this.listen(APP_EVENTS.LOCAL_PROGRESS_UPDATE, (detail) => {
            if (!isActive() || !detail) return;
            _handleProgressUpdate({ ...detail, __localProgress: true });
        });

        // File renamed
        this.listen(APP_EVENTS.FILE_RENAMED_UPDATED, (detail) => {
            if (!isActive()) return;
            const { oldPath, newPath } = detail || {};
            if (!oldPath || !newPath) return;

            import('./state.js').then(({ updateContinueWatchingVideoUrl, updateVideoProgressMapUrl, updateCategoryMediaCacheForRename }) => {
                updateContinueWatchingVideoUrl(oldPath, newPath);
                updateVideoProgressMapUrl(oldPath, newPath);
                updateCategoryMediaCacheForRename(oldPath, newPath);
            }).catch(() => { });

            $$('.streaming-card[data-media-url]').forEach(card => {
                const cardUrl = card.dataset.mediaUrl;
                if (!cardUrl) return;
                let decoded = null;
                try { decoded = decodeURIComponent(cardUrl); } catch (_) { decoded = cardUrl; }
                if (cardUrl === oldPath || cardUrl === encodeURI(oldPath) || decoded === oldPath) {
                    card.dataset.mediaUrl = newPath;
                    const newFilename = newPath.split('/').pop();
                    const newTitle = newFilename ? newFilename.replace(/\.[^/.]+$/, '') : '';
                    if (newTitle) {
                        const titleEl = $('.streaming-card-title', card);
                        if (titleEl) { titleEl.textContent = newTitle; titleEl.title = newTitle; }
                    }
                }
            });
        });

        // Pagination clicks delegated from the container
        const container = this._containerComp?.element;
        if (container) {
            this.on(container, 'click', (e) => {
                const btn = e.target.closest('.pagination-btn');
                if (btn) _handlePaginationClick(e);
            });
        }
    }

    // ── Unmount ───────────────────────────────────────────────────────────

    unmountComponents() {
        this.unmountGrid();
        this.unmountRows();
        if (this._filterBarComp) { this._filterBarComp.unmount(); this._filterBarComp = null; }
        if (this._heroComp) { this._heroComp.unmount(); this._heroComp = null; }
        if (this._containerComp) { this._containerComp.unmount(); this._containerComp = null; }
    }

    onStop() {
        this.unmountComponents();
    }

    _getVideoProgressMap() {
        return streamingState.state.videoProgressMap;
    }
}

// ── Module singleton ─────────────────────────────────────────────────────────

const _module = new StreamingLayoutModule();

// Abort controller for in-flight loadAndRender — lets filter clicks cancel stale loads
let _loadAbortController = null;
let _indexUpdateLifecycle = null;
const _pendingIndexRefreshes = new Map();
const _pendingShellRefreshes = new Map();
let _pendingSecondaryRefresh = null;

function cleanupIndexUpdateLifecycle() {
    if (_indexUpdateLifecycle) {
        _indexUpdateLifecycle.stop();
        _indexUpdateLifecycle = null;
    }
    _pendingIndexRefreshes.clear();
    _pendingShellRefreshes.clear();
    _pendingSecondaryRefresh = null;
}

function clearPendingShellRefresh(categoryId) {
    const timer = _pendingShellRefreshes.get(categoryId);
    if (timer && _indexUpdateLifecycle) {
        _indexUpdateLifecycle.clearTimeout(timer);
    }
    _pendingShellRefreshes.delete(categoryId);
}

function scheduleShellRefresh(categoryId, delayMs = 1800) {
    if (!_indexUpdateLifecycle || !categoryId) return;
    clearPendingShellRefresh(categoryId);
    const timer = _indexUpdateLifecycle.timeout(() => {
        _pendingShellRefreshes.delete(categoryId);
        refreshIndexedCategorySurface(categoryId);
    }, delayMs);
    _pendingShellRefreshes.set(categoryId, timer);
}

function clearPendingSecondaryRefresh() {
    if (_pendingSecondaryRefresh && _indexUpdateLifecycle) {
        _indexUpdateLifecycle.clearTimeout(_pendingSecondaryRefresh);
    }
    _pendingSecondaryRefresh = null;
}

function scheduleSecondaryRowsRefresh(delayMs = 900) {
    if (!_indexUpdateLifecycle) return;
    clearPendingSecondaryRefresh();
    _pendingSecondaryRefresh = _indexUpdateLifecycle.timeout(() => {
        _pendingSecondaryRefresh = null;
        refreshSecondaryRows({
            refreshContinueWatching: false,
            refreshWhatsNew: true
        });
    }, delayMs);
}

async function refreshIndexedCategorySurface(categoryId) {
    if (!isActive() || !categoryId) return;

    const categories = getCategoriesData() || [];
    const category = categories.find((item) => item?.id === categoryId);
    if (!category) return;

    const activeSubfolder = (getSubfolderFilter() && getCategoryIdFilter() === categoryId)
        ? getSubfolderFilter()
        : null;
    const isSingleCategoryView = getCategoryIdFilter() !== null || getSubfolderFilter() !== null;
    const mediaFilter = streamingState.state.mediaFilter;
    const currentCache = getCategoryCache(categoryId, activeSubfolder, mediaFilter)
        || (mediaFilter && mediaFilter !== 'all' ? getCategoryCache(categoryId, activeSubfolder, 'all') : null);
    const currentCount = (currentCache?.media?.length || 0) + (currentCache?.subfolders?.length || 0);
    const currentIsShell = currentCount === 0 && (currentCache?.loading === true || currentCache?.asyncIndexing === true);
    const fetchOptions = {
        ...((isSingleCategoryView && categories.length === 1) ? { includeTotal: true, limit: 30 } : {}),
        bypassClientCache: true
    };

    try {
        const result = await fetchCategoryMedia(categoryId, 1, false, activeSubfolder, fetchOptions);
        if (!isActive()) return;

        const nextCache = {
            media: result.media || [],
            page: 1,
            hasMore: result.hasMore || false,
            loading: false,
            subfolders: result.subfolders || [],
            asyncIndexing: result.asyncIndexing === true,
            indexingProgress: result.indexingProgress || 0
        };

        if (isSingleCategoryView && result.total !== null && result.total !== undefined) {
            setGridTotalItems(result.total);
        }

        setCategoryCache(categoryId, nextCache, activeSubfolder, mediaFilter);

        const nextCount = (nextCache.media?.length || 0) + (nextCache.subfolders?.length || 0);
        const stillShell = nextCount === 0 && nextCache.asyncIndexing === true;

        if (_module.isGridMounted() && categories.length === 1) {
            _module.mountGrid(category, nextCache);
            requestAnimationFrame(() => refreshLazyLoader());
        } else if (_module._rowsComp) {
            const didRefreshRow = typeof _module._rowsComp.refreshCategoryRow === 'function'
                ? _module._rowsComp.refreshCategoryRow(categoryId)
                : false;
            if (!didRefreshRow) {
                _module._rowsComp.setState({
                    categoryMediaCache: streamingState.state.categoryMediaCache || {}
                });
            }
            requestAnimationFrame(() => refreshLazyLoader());
        }

        if (stillShell) scheduleShellRefresh(categoryId);
        else clearPendingShellRefresh(categoryId);
    } catch (error) {
        console.error('[StreamingLayout] Error refreshing indexed category row:', error);
    }
}

function registerIndexUpdateSocketHandler(socket) {
    cleanupIndexUpdateLifecycle();
    if (!socket) return;

    _indexUpdateLifecycle = new Module();
    _indexUpdateLifecycle.start();

    _indexUpdateLifecycle.onSocket(socket, 'category_updated', (data) => {
        if (!isActive() || data?.reason !== 'index_updated') return;

        const mediaViewerEl = $('#media-viewer');
        if (mediaViewerEl && !mediaViewerEl.classList.contains('hidden')) return;

        const categoryId = data?.category_id || data?.categoryId;
        if (!categoryId) return;

        const existingTimer = _pendingIndexRefreshes.get(categoryId);
        if (existingTimer) {
            _indexUpdateLifecycle.clearTimeout(existingTimer);
        }

        const timer = _indexUpdateLifecycle.timeout(() => {
            _pendingIndexRefreshes.delete(categoryId);
            refreshIndexedCategorySurface(categoryId);
        }, 400);

        _pendingIndexRefreshes.set(categoryId, timer);
        scheduleSecondaryRowsRefresh();
    });
}

// ── Thumbnail progress tracker ───────────────────────────────────────────────

const thumbnailProgressTracker = createThumbnailProgressTracker({
    label: 'StreamingLayout',
    getProcessingCategories: () =>
        (getCategoriesData() || []).filter(c => c && c.processingStatus === 'generating'),
});
function formatSubfolderPillName(subfolder, fallbackName = null) {
    if (!subfolder) return fallbackName;
    const leaf = subfolder.split('/').pop();
    if (!leaf) return fallbackName;
    return leaf.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

async function navigateToSubfolderInstant(categoryId, subfolder, categoryName = null) {
    if (!isActive() || !categoryId || !subfolder) return;

    if (_loadAbortController) {
        _loadAbortController.abort();
        _loadAbortController = null;
    }
    socketHandlerManager.cancelPendingRefresh();

    const existingCategories = getCategoriesData() || [];
    const resolvedName = resolveCategoryName(categoryId, existingCategories, categoryName);
    const fallbackCategory = {
        id: categoryId,
        name: resolvedName || formatSubfolderPillName(subfolder, 'Subfolder')
    };
    const category = existingCategories.find((item) => item?.id === categoryId) || fallbackCategory;
    const mediaFilter = 'all';
    const placeholderCache = { media: [], page: 1, hasMore: false, loading: true, subfolders: [] };

    setCurrentPage(1);
    setCategoryIdFilter(categoryId);
    setCategoryNameFilter(resolvedName);
    setSubfolderFilter(subfolder);
    setParentNameFilter(null);
    setCategoryIdsFilter(null);
    setMediaFilter(mediaFilter);
    setCategoriesData([category]);
    setGridTotalItems(0);
    setCategoryCache(categoryId, placeholderCache, subfolder, mediaFilter);

    updateCategoryFilterPill(formatSubfolderPillName(subfolder, resolvedName));

    const existingPagination = document.querySelector('#streaming-container .pagination-container');
    if (existingPagination) existingPagination.remove();

    transitionToSingleCategoryGrid({
        category,
        cache: placeholderCache,
        mountGrid: (nextCategory, nextCache) => _module.mountGrid(nextCategory, nextCache),
        unmountRows: () => _module.unmountRows(),
        scrollRoot: _module._containerComp?.element || document.getElementById('streaming-container'),
        scrollToTop: null,
        activeSubfolder: subfolder
    });

    try {
        const result = await fetchCategoryMedia(categoryId, 1, false, subfolder, { includeTotal: true, limit: 30 });
        const nextCache = {
            media: result.media || [],
            page: 1,
            hasMore: result.hasMore || false,
            loading: false,
            subfolders: result.subfolders || []
        };
        if (result.total !== null && result.total !== undefined) {
            setGridTotalItems(result.total);
        }
        setCategoryCache(categoryId, nextCache, subfolder, mediaFilter);
        _module.mountGrid(category, nextCache);
        requestAnimationFrame(() => refreshLazyLoader());
    } catch (error) {
        console.error('[StreamingLayout] navigateToSubfolderInstant error:', error);
        const nextCache = { media: [], page: 1, hasMore: false, loading: false, subfolders: [] };
        setCategoryCache(categoryId, nextCache, subfolder, mediaFilter);
        _module.mountGrid(category, nextCache);
    }
}

// ── loadAndRender ────────────────────────────────────────────────────────────

export async function loadAndRender(forceRefresh = false, options = {}) {
    if (!isActive()) return;

    // Cancel any pending socket-debounced refresh — a user-initiated load (filter click,
    // pagination, nav) must not be followed by a stale socket refresh that wipes the cache
    // and tears down VS instances while thumbnails are in-flight.
    if (options._fromSocketRefresh !== true) {
        socketHandlerManager.cancelPendingRefresh();
    }

    // Cancel any in-flight load — filter clicks must win over stale background loads
    if (_loadAbortController) {
        _loadAbortController.abort();
    }
    _loadAbortController = new AbortController();
    const { signal } = _loadAbortController;

    const refreshContinueWatching = options.refreshContinueWatching !== false;
    const refreshWhatsNew = options.refreshWhatsNew !== false;
    const refreshCategoryList = options.refreshCategoryList === true;
    const categoryListForceRefresh = forceRefresh || refreshCategoryList;
    const isNavigatingToSingleView = getCategoryIdFilter() !== null || getSubfolderFilter() !== null;

    streamingState.setState({ isLoading: true });

    try {
        await fetchCategories(categoryListForceRefresh, {
            bypassClientCache: refreshCategoryList,
            pruneMissingCategories: refreshCategoryList,
            signal
        });
        if (signal.aborted) return;

        if (!isNavigatingToSingleView) {
            primeCategoryLoadingShells({ replaceExisting: forceRefresh || refreshCategoryList });
            _module.unmountGrid();
            _module.mountRows();
            if (_module._rowsComp) {
                const s = streamingState.state;
                // When rows already have category data and this is not a hard refresh,
                // only update secondary-row loading indicators. Passing non-secondary
                // keys (categoriesData, mediaFilter, isLoading, etc.) here would trigger
                // a full _rebuildRows() and destroy+recreate all VS instances and cards,
                // causing the visible "two-jump" flicker on every filter pill click and
                // reveal/stop-reveal operation. The full setState below (after the fetch)
                // handles the single authoritative rebuild with fresh data.
                const hasExistingCategories = _module._rowsComp.state.categoriesData?.length > 0;
                if (!hasExistingCategories || forceRefresh) {
                    _module._rowsComp.setState({
                        categoriesData: s.categoriesData || [],
                        continueWatchingData: s.continueWatchingData || [],
                        whatsNewData: s.whatsNewData || [],
                        categoryMediaCache: s.categoryMediaCache || {},
                        videoProgressMap: s.videoProgressMap || {},
                        continueWatchingLoading: refreshContinueWatching,
                        whatsNewLoading: refreshWhatsNew,
                        mediaFilter: s.mediaFilter,
                        categoryIdFilter: s.categoryIdFilter,
                        subfolderFilter: s.subfolderFilter,
                        isLoading: true,
                    });
                } else {
                    // Secondary-only: update CW/WN loading indicators without
                    // triggering a full category row rebuild.
                    _module._rowsComp.setState({
                        ...(refreshContinueWatching ? { continueWatchingLoading: true } : {}),
                        ...(refreshWhatsNew ? { whatsNewLoading: true } : {}),
                    });
                }
            }
        }

        const secondaryTasks = [];
        if (refreshContinueWatching) secondaryTasks.push(buildContinueWatchingData());
        if (refreshWhatsNew) secondaryTasks.push(fetchNewestMedia(10));
        if (secondaryTasks.length > 0) await Promise.all(secondaryTasks);
        if (signal.aborted) return;

        // Refresh each category row in place as its cache fills, so skeleton
        // cards swap to real cards progressively without a final global
        // _rebuildRows tearing down every VirtualScroller (which produced the
        // visible "two-jump" flicker on every filter step-back).
        const onCategoryLoaded = (category) => {
            if (!_module._rowsComp || !category?.id) return;
            const isSingleView = getCategoryIdFilter() !== null || getSubfolderFilter() !== null;
            if (isSingleView) return;
            try { _module._rowsComp.refreshCategoryRow(category.id); } catch (_) { /* ignore */ }
        };
        await fetchAllCategoryMedia(forceRefresh, onCategoryLoaded, {
            signal,
            bypassClientCache: options.bypassMediaClientCache === true
        });
        if (signal.aborted) return;

        // Decide view mode
        const categoriesData = getCategoriesData();
        const isSingleCategoryView = getCategoryIdFilter() !== null || getSubfolderFilter() !== null;

        if (isSingleCategoryView && categoriesData.length === 1) {
            const category = categoriesData[0];
            const subfolder = getSubfolderFilter();
            const mediaFilter = streamingState.state.mediaFilter;
            const cache = getCategoryCache(category?.id, subfolder, mediaFilter);
            if (category && cache && (cache.media?.length > 0 || cache.subfolders?.length > 0)) {
                // Grid mode — unmount rows, show grid, remove any stale pagination
                const existingPagination = document.querySelector('#streaming-container .pagination-container');
                if (existingPagination) existingPagination.remove();
                transitionToSingleCategoryGrid({
                    category,
                    cache,
                    mountGrid: (nextCategory, nextCache) => _module.mountGrid(nextCategory, nextCache),
                    unmountRows: () => _module.unmountRows(),
                    scrollRoot: document.getElementById('streaming-container'),
                    activeSubfolder: subfolder
                });
                
                // Reset lazy loader for grid mode (early return skips the rows handling)
                cleanupLazyLoading();
                initLazyLoading(document.getElementById('streaming-container') || null);
                requestAnimationFrame(() => refreshLazyLoader());
                return;
            }
        }

        // Row mode — unmount grid, mount rows (if not already), push data into rows component.
        // Reveal/stop-reveal changes the category set and can leave individual
        // row shells stuck if the progressive row refresh misses one. After the
        // fresh visibility-aware data is fetched, remount rows once so every
        // skeleton is rebuilt from current cache rather than recycled state.
        if (refreshCategoryList) {
            _module.unmountRows();
        }
        const hadGridMounted = _module.unmountGrid();
        const rowsMountedOrRecovered = _module.mountRows();
        if (hadGridMounted || rowsMountedOrRecovered || refreshCategoryList) {
            // Reset lazy loader bookkeeping when row/grid surface swaps.
            // This prevents stale observed-node state from suppressing thumbnail loads
            // after remounts.
            cleanupLazyLoading();
            initLazyLoading(document.getElementById('streaming-container') || null);
        }

        syncRowsComponentFromStreamingState({ isLoading: false });

        _renderPaginationControls();
        _flushFilterBarScroll();

    } catch (error) {
        if (signal.aborted) return;
        console.error('[StreamingLayout] loadAndRender error:', error);
        _renderError();
    } finally {
        if (!signal.aborted) {
            streamingState.setState({ isLoading: false });
        } else {
            // When a load is aborted (e.g. competing reveal-hidden refresh),
            // primeCategoryLoadingShells may have set loading:true on cache
            // entries that never got replaced by real fetch results. Clear
            // those stale shells so rows don't stay stuck as placeholders.
            const cache = streamingState.state.categoryMediaCache;
            if (cache) {
                let patched = false;
                const next = { ...cache };
                for (const key of Object.keys(next)) {
                    if (next[key]?.loading === true) {
                        next[key] = { ...next[key], loading: false };
                        patched = true;
                    }
                }
                if (patched) {
                    streamingState.setState({ categoryMediaCache: next });
                    // Rows are intentionally not subscribed live to streamingState
                    // because cache churn from chunk loading would cause rebuild loops.
                    // When a reveal-hidden refresh is aborted, we must manually sync
                    // the mounted rows so stale skeleton shells disappear immediately.
                    syncRowsComponentFromStreamingState({
                        categoryMediaCache: next,
                        isLoading: false
                    });
                    // syncRowsComponentFromStreamingState's diff only pushes
                    // categoryMediaCache through the secondary-rows path, which
                    // doesn't touch category rows. Refresh the rows whose
                    // skeleton state we just cleared so they don't stay stuck.
                    if (_module._rowsComp) {
                        const seen = new Set();
                        for (const key of Object.keys(next)) {
                            const id = key.split('|sf:')[0];
                            if (!id || seen.has(id)) continue;
                            seen.add(id);
                            try { _module._rowsComp.refreshCategoryRow(id); } catch (_) { /* ignore */ }
                        }
                    }
                }
            }
        }
    }
}

function syncRowsComponentFromStreamingState({
    categoryMediaCache = null,
    isLoading = false
} = {}) {
    if (!_module._rowsComp) return;
    const s = streamingState.state;
    const current = _module._rowsComp.state || {};
    const desired = {
        categoriesData: s.categoriesData || [],
        continueWatchingData: s.continueWatchingData || [],
        whatsNewData: s.whatsNewData || [],
        categoryMediaCache: categoryMediaCache || s.categoryMediaCache || {},
        videoProgressMap: s.videoProgressMap || {},
        continueWatchingLoading: s.continueWatchingLoading === true,
        whatsNewLoading: s.whatsNewLoading === true,
        mediaFilter: s.mediaFilter,
        categoryIdFilter: s.categoryIdFilter,
        subfolderFilter: s.subfolderFilter,
        isLoading,
    };

    // Shallow diff: only forward keys whose value reference actually changed.
    // This keeps the post-fetch sync in the secondary-only path (CW/WN/cache)
    // when structural keys (categoriesData, filters) haven't changed since the
    // first setState in loadAndRender, avoiding the visible "two-jump" flicker
    // caused by a second full _rebuildRows tearing down all VS instances.
    const patch = {};
    for (const key of Object.keys(desired)) {
        if (current[key] !== desired[key]) patch[key] = desired[key];
    }
    // isLoading only matters structurally when categoriesData is empty (it
    // toggles between loading skeletons and the "no media yet" message). With
    // categories populated, the flag is cosmetic — drop it to avoid forcing a
    // full _rebuildRows on every post-fetch sync.
    if ('isLoading' in patch && (desired.categoriesData?.length || 0) > 0) {
        delete patch.isLoading;
    }
    if (Object.keys(patch).length > 0) {
        _module._rowsComp.setState(patch);
    }
    requestAnimationFrame(() => refreshLazyLoader());
}

// ── Secondary rows refresh ───────────────────────────────────────────────────

export async function refreshSecondaryRows(options = {}) {
    if (!isActive()) return;
    const refreshContinueWatching = options.refreshContinueWatching !== false;
    const refreshWhatsNew = options.refreshWhatsNew !== false;
    try {
        if (_module._rowsComp) {
            _module._rowsComp.setState({
                ...(refreshContinueWatching ? { continueWatchingLoading: true } : {}),
                ...(refreshWhatsNew ? { whatsNewLoading: true } : {})
            });
        }

        const secondaryTasks = [];
        if (refreshContinueWatching) secondaryTasks.push(buildContinueWatchingData(true));
        if (refreshWhatsNew) secondaryTasks.push(fetchNewestMedia(10, true));
        await Promise.all(secondaryTasks);

        if (_module._rowsComp) {
            const s = streamingState.state;
            _module._rowsComp.setState({
                ...(refreshContinueWatching
                    ? {
                        continueWatchingData: s.continueWatchingData || [],
                        continueWatchingLoading: s.continueWatchingLoading === true
                    }
                    : {}),
                ...(refreshWhatsNew
                    ? {
                        whatsNewData: s.whatsNewData || [],
                        whatsNewLoading: s.whatsNewLoading === true,
                        categoryMediaCache: s.categoryMediaCache || {}
                    }
                    : {}),
            });
            // _rebuildRows runs synchronously inside setState; scan for new lazy images after
            requestAnimationFrame(() => refreshLazyLoader());
        }
    } catch (error) {
        console.error('[StreamingLayout] refreshSecondaryRows error:', error);
    }
}

// ── Pagination ───────────────────────────────────────────────────────────────

function _renderPaginationControls() {
    const container = document.getElementById('streaming-container');
    if (!container) return;

    const totalPages = streamingState.state.totalPages;
    const currentPage = streamingState.state.currentPage;

    if (totalPages <= 1) {
        const existing = container.querySelector('.pagination-container');
        if (existing) existing.remove();
        return;
    }

    const maxVisible = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    if (endPage - startPage < maxVisible - 1) startPage = Math.max(1, endPage - maxVisible + 1);

    const makeBtn = (text, cls, dataPage, disabled) => createElement('button', {
        className: `pagination-btn ${cls}${disabled ? ' disabled' : ''}`,
        ...(dataPage !== null ? { dataset: { page: String(dataPage) } } : {}),
        ...(disabled ? { disabled: true } : {}),
        textContent: text
    });

    const pageChildren = [];
    if (startPage > 1) {
        pageChildren.push(makeBtn('1', 'pagination-page', 1, false));
        if (startPage > 2) pageChildren.push(createElement('span', { className: 'pagination-ellipsis', textContent: '…' }));
    }
    for (let i = startPage; i <= endPage; i++) {
        pageChildren.push(makeBtn(String(i), `pagination-page${i === currentPage ? ' active' : ''}`, i, false));
    }
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) pageChildren.push(createElement('span', { className: 'pagination-ellipsis', textContent: '…' }));
        pageChildren.push(makeBtn(String(totalPages), 'pagination-page', totalPages, false));
    }

    const newEl = createElement('div', { className: 'pagination-container' },
        makeBtn('‹ Prev', 'pagination-prev', null, currentPage <= 1),
        createElement('div', { className: 'pagination-pages' }, ...pageChildren),
        makeBtn('Next ›', 'pagination-next', null, currentPage >= totalPages)
    );

    const existing = container.querySelector('.pagination-container');
    if (existing) existing.replaceWith(newEl);
    else append(container, newEl);
}

async function _handlePaginationClick(e) {
    if (!isActive()) return;
    const target = e.target.closest('.pagination-btn');
    if (!target || target.disabled || target.classList.contains('active')) return;

    const page = target.dataset.page;
    if (page) setCurrentPage(parseInt(page));
    else if (target.classList.contains('pagination-prev')) setCurrentPage(Math.max(1, streamingState.state.currentPage - 1));
    else if (target.classList.contains('pagination-next')) setCurrentPage(streamingState.state.currentPage + 1);

    if (getCategoryIdFilter() !== null || getSubfolderFilter() !== null ||
        streamingState.state.parentNameFilter !== null || streamingState.state.categoryIdsFilter !== null) {
        setCategoryIdFilter(null);
        setCategoryNameFilter(null);
        setSubfolderFilter(null);
        setParentNameFilter(null);
        setCategoryIdsFilter(null);
        updateCategoryFilterPill(null);
    }

    if (_module._containerComp) _module._containerComp.scrollToTop();
    await loadAndRender(false, { refreshContinueWatching: false, refreshWhatsNew: false });
}

function _flushFilterBarScroll() {
    if (typeof flushFilterBarScroll === 'function') flushFilterBarScroll();
}

function _renderError() {
    const rowsContainer = document.getElementById('streaming-content-container');
    if (!rowsContainer) return;
    clear(rowsContainer);
    append(rowsContainer, createElement('div', {
        className: 'streaming-row-empty',
        style: { padding: '100px 20px', textAlign: 'center' }
    },
        createElement('p', { textContent: 'Failed to load content. Please try again.' }),
        createElement('button', {
            className: 'streaming-hero-btn secondary',
            style: { marginTop: '20px' },
            onClick: () => loadAndRender()
        }, 'Retry')
    ));
}

// ── Progress update handler ──────────────────────────────────────────────────

function _handleProgressUpdate(data) {
    if (!data) return;
    const isLocalProgress = data.__localProgress === true;
    if (!isLocalProgress && !hasActiveProfile()) return;
    if (!isLocalProgress && data.profile_id && data.profile_id !== getActiveProfileId()) return;

    const { video_url: videoUrl, video_timestamp: timestamp, video_duration: duration, category_id: categoryId, thumbnail_url: thumbnailUrl } = data;
    if (!videoUrl) return;

    const urlsMatch = (a, b) => {
        if (!a || !b) return false;
        if (a === b) return true;
        try { if (decodeURIComponent(a) === decodeURIComponent(b)) return true; } catch (_) { /* ignore */ }
        try { if (a === encodeURI(b)) return true; } catch (_) { /* ignore */ }
        try { if (encodeURI(a) === b) return true; } catch (_) { /* ignore */ }
        return false;
    };

    if (data.video_progress_deleted) {
        deleteVideoProgress(videoUrl);
        const nextContinueWatching = getContinueWatchingData().filter((item) => {
                if (!item.videoUrl) return true;
                return !urlsMatch(item.videoUrl, videoUrl);
            });
        setContinueWatchingData(nextContinueWatching);
        if (_module._rowsComp) {
            _module._rowsComp.setState({ continueWatchingData: nextContinueWatching });
        }

        // Remove progress bars from visible cards for this video
        const container = document.getElementById('streaming-container');
        if (container) {
            container.querySelectorAll('.streaming-card[data-media-url]').forEach(card => {
                const cardUrl = card.dataset.mediaUrl || card.dataset.videoUrl;
                if (cardUrl && urlsMatch(cardUrl, videoUrl)) {
                    const progressBar = $('.streaming-card-progress', card);
                    if (progressBar) progressBar.remove();
                }
            });
        }
        return;
    }

    if (!timestamp || timestamp <= 0) return;

    setVideoProgress(videoUrl, { video_timestamp: timestamp, video_duration: duration || 0 });

    const continueWatching = [...getContinueWatchingData()];
    const categories = getCategoriesData();
    const category = categories.find(c => c.id === categoryId);

    const existingIndex = continueWatching.findIndex(item => {
        if (!item.videoUrl) return false;
        return urlsMatch(item.videoUrl, videoUrl);
    });
    if (existingIndex >= 0) continueWatching.splice(existingIndex, 1);

    continueWatching.unshift({
        videoUrl,
        categoryId,
        categoryName: category?.name || 'Unknown',
        thumbnailUrl,
        videoTimestamp: timestamp,
        videoDuration: duration || 0,
        lastWatched: Date.now() / 1000
    });
    if (continueWatching.length > 15) continueWatching.pop();

    setContinueWatchingData(continueWatching);
    if (_module._rowsComp) {
        _module._rowsComp.setState({ continueWatchingData: continueWatching });
    }

    // Update progress bars on visible cards directly
    const container = document.getElementById('streaming-container');
    if (!container || !duration) return;

    container.querySelectorAll('.streaming-card[data-media-url]').forEach(card => {
        const cardUrl = card.dataset.mediaUrl || card.dataset.videoUrl;
        if (!cardUrl) return;
        const matches = cardUrl === videoUrl ||
            (() => { try { return decodeURIComponent(cardUrl) === videoUrl; } catch (_) { return false; } })() ||
            (() => { try { return cardUrl === decodeURIComponent(videoUrl); } catch (_) { return false; } })();

        if (matches && duration > 0) {
            const progressPercent = Math.min((timestamp / duration) * 100, 100);
            if (progressPercent > 0 && progressPercent < 100) {
                let progressBar = $('.streaming-card-progress', card);
                if (!progressBar) {
                    progressBar = createElement('div', { className: 'streaming-card-progress' });
                    const infoSection = $('.streaming-card-info', card);
                    if (infoSection) infoSection.parentNode.insertBefore(progressBar, infoSection);
                    else append(card, progressBar);
                }
                let fill = progressBar.firstElementChild;
                if (!fill) {
                    fill = createElement('div', { className: 'streaming-card-progress-fill' });
                    append(progressBar, fill);
                }
                fill.style.width = `${progressPercent}%`;
            }
        }
    });
}

// ── init / cleanup / refresh ─────────────────────────────────────────────────

let _isInitializing = false;

function getLayoutMountTarget() {
    return document.querySelector('#app-shell > main') || document.getElementById('app-shell') || document.body;
}

async function init() {
    if (_isInitializing) return;
    if (!isActive()) return;

    _isInitializing = true;
    setIsStreamingLayout(true);

    try {
        const socket = window.ragotModules?.appStore?.get?.('socket', null);
    if (socket) initProgressSync(socket);

        registerLayoutHandler('streaming', {
            viewMedia: async (categoryId, mediaUrl, index) => {
                if (mediaUrl) await openViewerByUrl(categoryId, mediaUrl);
                else await openViewer(categoryId, index);
            },
            getCurrentState: () => null,
            setupNavigation: () => { },
            onMediaRendered: () => { },
            onViewerClosed: () => { handleViewerClosed(); }
        });

        setCurrentPage(1);
        setCategoryIdFilter(null);
        setCategoryNameFilter(null);
        setSubfolderFilter(null);
        setParentNameFilter(null);
        setCategoryIdsFilter(null);
        setMediaFilter('all');

        const _initSpinner = createElement('div', { className: 'layout-init-spinner' },
            createElement('div', { className: 'layout-init-spinner__wheel' }),
            createElement('p', { className: 'layout-init-spinner__label', textContent: 'Loading content...' })
        );
        append(document.body, _initSpinner);

        _module.start();
        await _module.mountRoot(getLayoutMountTarget());
        _initSpinner.remove();
        _module.mountComponents();
        _module.wireEvents();

        initLazyLoading(document.getElementById('streaming-container') || null);
        thumbnailProgressTracker.init();
        await loadAndRender();
    } finally {
        _isInitializing = false;
    }
}

function cleanup() {
    setIsStreamingLayout(false);
    thumbnailProgressTracker.cleanup();
    cancelMediaCardProgressBars();
    cleanupIndexUpdateLifecycle();
    cleanupLazyLoading();
    if (_loadAbortController) {
        _loadAbortController.abort();
        _loadAbortController = null;
    }
    _module.stop();
    setContainer(null);
}

async function refresh(forceRefresh = false, secondaryOnly = false, refreshCategoryList = false) {
    if (!isActive()) return;

    if (secondaryOnly) {
        await refreshSecondaryRows();
        return;
    }

    // Do NOT call clearCategoryMediaCache() here. Clearing the cache before
    // loadAndRender creates a race: if the subsequent fetch gets aborted (e.g.
    // by a rapid reveal→stop-reveal toggle or competing navigation), all rows
    // are left permanently stuck in the loading/shimmer state because the cache
    // was wiped but the post-fetch setState that would reset it never fires.
    //
    // Cache management is handled safely inside loadAndRender's fetch pipeline:
    // - forceRefresh=true: fetchAllCategoryMedia clears the cache itself, after
    //   the abort controller is set up, so an abort doesn't leave a stale state.
    // - reveal/stop-reveal: bypassMediaClientCache forces fresh HTTP fetches that
    //   overwrite stale cache entries without ever clearing them first.
    setCurrentPage(1);
    if (refreshCategoryList) {
        // Reveal/hide visibility toggles should always return to the main rows view.
        // Keeping stale single-category/subfolder filters can suppress pagination controls.
        setCategoryIdFilter(null);
        setCategoryNameFilter(null);
        setSubfolderFilter(null);
        setParentNameFilter(null);
        setCategoryIdsFilter(null);
        updateCategoryFilterPill(null);
        // Reveal-hidden toggles can remove or reintroduce whole shelves. Reusing
        // the existing rows component across that shape change has proven brittle:
        // recycled VirtualScroller and lazy-loader state can leave rows marooned
        // in placeholder mode. Force a fresh rows mount for this path only.
        _module.unmountRows();
    }
    _module.unmountGrid();

    await loadAndRender(forceRefresh, {
        refreshCategoryList,
        bypassMediaClientCache: refreshCategoryList === true,
        _fromSocketRefresh: true
    });
    if (forceRefresh) {
        thumbnailProgressTracker.cleanup();
        thumbnailProgressTracker.init();
    }
}

// ── Layout lifecycle wiring ──────────────────────────────────────────────────

const ensureLayoutLifecycle = createLayoutChangeLifecycle({
    layoutName: 'streaming',
    initLayout: init,
    cleanupLayout: cleanup
});

const socketHandlerManager = createLayoutSocketHandlerManager({
    isActive,
    refresh,
    handleProgressUpdate: _handleProgressUpdate,
    syncShowHiddenFromEvent,
    forceRefreshOnShowHiddenToggle: false,
    shouldScheduleCategoryRefresh: (data) => data?.reason !== 'index_updated'
});

const filterActions = createLayoutFilterActions({
    isActive,
    resolveCategoryName: (categoryId, categoryName = null) =>
        resolveCategoryName(categoryId, getCategoriesData(), categoryName),
    beforeFilterChange: () => _module.unmountGrid(),
    applyCategoryState: ({ categoryId, resolvedName }) => {
        setCurrentPage(1);
        setCategoryIdFilter(categoryId);
        setCategoryNameFilter(resolvedName);
        setParentNameFilter(null);
        setSubfolderFilter(null);
        setCategoryIdsFilter(null);
        setMediaFilter('all');
    },
    applyParentState: ({ parentName, categoryIds = null }) => {
        setCurrentPage(1);
        setCategoryIdFilter(null);
        setCategoryNameFilter(null);
        setSubfolderFilter(null);
        setParentNameFilter(parentName);
        setCategoryIdsFilter(categoryIds);
        setMediaFilter('all');
    },
    applySubfolderState: ({ categoryId, subfolder, resolvedName }) => {
        setCurrentPage(1);
        setCategoryIdFilter(categoryId);
        setCategoryNameFilter(resolvedName);
        setSubfolderFilter(subfolder);
        setParentNameFilter(null);
        setCategoryIdsFilter(null);
        setMediaFilter('all');
    },
    refreshForFilter: () => loadAndRender(false)
});

ensureLayoutLifecycle();

// ── Viewer closed handler ────────────────────────────────────────────────────

export async function handleViewerClosed() {
    if (!isActive()) return;
    try {
        await buildContinueWatchingData(true);
        if (_module._rowsComp) {
            _module._rowsComp.setState({
                continueWatchingData: streamingState.state.continueWatchingData || [],
            });
        }
        updateMediaCardProgressBars();
    } catch (e) {
        console.error('[StreamingLayout] Error refreshing after viewer closed:', e);
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function registerSocketHandlers(socket) {
    initProgressSync(socket);
    socketHandlerManager.register(socket);
    registerIndexUpdateSocketHandler(socket);
}

export function cleanupSocketHandlers() {
    socketHandlerManager.cleanup();
    cleanupIndexUpdateLifecycle();
}

export function setCategoryFilter(categoryId, categoryName = null) {
    filterActions.setCategoryFilter(categoryId, categoryName);
}

export function setParentFilter(parentName, categoryIds = null) {
    filterActions.setParentFilter(parentName, categoryIds);
}

export function setSubfolderFilterAction(categoryId, subfolder, categoryName = null) {
    navigateToSubfolderInstant(categoryId, subfolder, categoryName);
}

export {
    init,
    cleanup,
    refresh,
    isActive,
    getContinueWatchingData,
    getCategoryIdFilter,
    getSubfolderFilter,
    setCategoryIdFilter,
    setCategoryNameFilter,
    setSubfolderFilter,
    setParentNameFilter,
    setCategoryIdsFilter,
    getCategoriesData
};

export { getGridMode } from './state.js';
