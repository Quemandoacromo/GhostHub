/**
 * Theme Builder Module
 * Realtime Colors-inspired custom theme creator with live preview
 */

import { saveConfig } from '../../utils/configManager.js';
import { getUserPreference, saveUserPreference } from '../../utils/userPreferences.js';
import { $, $$, Component, createElement, attr, bus } from '../../libs/ragot.esm.min.js';
import { APP_EVENTS } from '../../core/appEvents.js';
import { toast, dialog } from '../../utils/notificationManager.js';
import { trashIcon, xIcon, diskIcon, eyeIcon, chevronDownIcon } from '../../utils/icons.js';
import {
    DEFAULT_THEME_COLORS,
    getThemeCssVariables,
    hexToHsl,
    hexToRgb,
    hslToHex,
    normalizeThemeColors,
    normalizeToHex,
    rgbToHex,
    sanitizeThemeRecord
} from '../../utils/themeColors.js';

let configModalFocusControlsPromise = null;

function getRuntimeConfig() {
    return window.ragotModules?.appStore?.get?.('config', {}) || {};
}

function buildConfigWithUI() {
    const nextConfig = JSON.parse(JSON.stringify(getRuntimeConfig() || {}));
    if (!nextConfig.javascript_config) nextConfig.javascript_config = {};
    if (!nextConfig.javascript_config.ui) nextConfig.javascript_config.ui = {};
    return nextConfig;
}

const EDITOR_COLOR_KEYS = [
    { key: 'primary', name: 'Header', description: 'Header and primary brand surfaces' },
    { key: 'accent', name: 'Action', description: 'Buttons, active states, focus rings, and highlights' },
    { key: 'background', name: 'Background', description: 'Main page background color' },
    { key: 'surface', name: 'Panels', description: 'Card, modal, and panel backgrounds' },
    { key: 'text', name: 'Text', description: 'Primary text color' }
];

// Preset color palettes - modern color combinations
const PRESET_PALETTES = [
    {
        id: 'cyberpunk',
        name: 'Cyberpunk',
        colors: { primary: '#ff006e', accent: '#ffbe0b', background: '#0a0e27', surface: '#1a1f3a', text: '#f0f3ff' }
    },
    {
        id: 'ocean-breeze',
        name: 'Ocean Breeze',
        colors: { primary: '#0077b6', accent: '#00b4d8', background: '#03045e', surface: '#023e8a', text: '#caf0f8' }
    },
    {
        id: 'sunset-glow',
        name: 'Sunset Glow',
        colors: { primary: '#d62828', accent: '#fcbf49', background: '#1a1423', surface: '#2d1b3d', text: '#fef6e4' }
    },
    {
        id: 'forest-night',
        name: 'Forest Night',
        colors: { primary: '#2d6a4f', accent: '#52b788', background: '#081c15', surface: '#1b4332', text: '#d8f3dc' }
    },
    {
        id: 'neon-dreams',
        name: 'Neon Dreams',
        colors: { primary: '#7209b7', accent: '#f72585', background: '#10002b', surface: '#240046', text: '#e0aaff' }
    },
    {
        id: 'golden-hour',
        name: 'Golden Hour',
        colors: { primary: '#c77dff', accent: '#ffd60a', background: '#1a0033', surface: '#3c096c', text: '#f9f6ff' }
    },
    {
        id: 'arctic-aurora',
        name: 'Arctic Aurora',
        colors: { primary: '#06ffa5', accent: '#fffb00', background: '#001233', surface: '#002855', text: '#f0f9ff' }
    },
    {
        id: 'cherry-blossom',
        name: 'Cherry Blossom',
        colors: { primary: '#ff85a1', accent: '#ffc2d1', background: '#2b1320', surface: '#4a1f35', text: '#ffe5ec' }
    },
    {
        id: 'electric-lime',
        name: 'Electric Lime',
        colors: { primary: '#84cc16', accent: '#bef264', background: '#14120b', surface: '#2c2915', text: '#f7fee7' }
    },
    {
        id: 'cosmic-purple',
        name: 'Cosmic Purple',
        colors: { primary: '#9333ea', accent: '#d946ef', background: '#1e0a3c', surface: '#3b1c6d', text: '#f5e6ff' }
    },
    {
        id: 'volcano-red',
        name: 'Volcano Red',
        colors: { primary: '#dc2626', accent: '#fb923c', background: '#1c0b0b', surface: '#3d1414', text: '#fee2e2' }
    },
    {
        id: 'sapphire-sky',
        name: 'Sapphire Sky',
        colors: { primary: '#1e40af', accent: '#60a5fa', background: '#0c1428', surface: '#1e293b', text: '#dbeafe' }
    }
];

// Color harmony modes for intelligent generation
const COLOR_HARMONIES = ['analogous', 'complementary', 'triadic', 'split-complementary', 'tetradic'];
let currentHarmonyIndex = 0;
let badgeTimeout = null; // Track badge animation timeout

// State
let currentColors = {};
let originalColors = null; // Store original colors for revert on cancel
let customThemes = [];
let colorFormat = 'hex'; // hex, rgb, hsl
let isOpen = false;
let originalThemeId = null;

// Undo/Redo state
let colorHistory = []; // Array of color states
let historyIndex = -1; // Current position in history
const MAX_HISTORY = 50; // Maximum history entries

// Track last known theme name to detect manual color changes
let lastSetThemeName = null;
let themeBuilderComponent = null;

function setThemeBuilderViewportState(mode = 'closed') {
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return;

    root.classList.toggle('theme-builder-edit', mode === 'edit');
    root.classList.toggle('theme-builder-preview', mode === 'preview');
    body.classList.toggle('theme-builder-active', mode === 'edit');
    body.classList.toggle('theme-builder-preview', mode === 'preview');
}

function notifyThemeBuilderOpened() {
    document.dispatchEvent(new CustomEvent('ghosthub:theme-builder-opened'));
}

function notifyThemeBuilderClosed() {
    document.dispatchEvent(new CustomEvent('ghosthub:theme-builder-closed'));
}

function suspendUnderlyingConfigModal() {
    const configModal = document.getElementById('config-modal');
    if (!configModal || configModal.classList.contains('hidden')) return;
    configModal.dataset.themeBuilderSuspended = 'true';
    configModal.setAttribute('inert', '');
    configModal.setAttribute('aria-hidden', 'true');
}

function resumeUnderlyingConfigModal() {
    const configModal = document.getElementById('config-modal');
    if (!configModal || configModal.dataset.themeBuilderSuspended !== 'true') return;
    delete configModal.dataset.themeBuilderSuspended;
    configModal.removeAttribute('inert');
    configModal.removeAttribute('aria-hidden');
}

async function withConfigModalFocusControls(callbackName) {
    try {
        if (!configModalFocusControlsPromise) {
            configModalFocusControlsPromise = import('./modal.js');
        }
        const modal = await configModalFocusControlsPromise;
        modal?.[callbackName]?.();
    } catch (error) {
        console.warn(`[ThemeBuilder] Failed to ${callbackName}:`, error);
    }
}

class ThemeBuilderComponent extends Component {
    start() {
        const overlay = $('.gh-theme-builder');
        if (this._isMounted && overlay) return;
        if (this._isMounted && !overlay) {
            // DOM was externally reset (tests/hot reload). Reset lifecycle so we can remount safely.
            this.unmount();
        }
        this._isMounted = true;
        this.onStart();
    }

    onStart() {
        createThemeBuilderModal(this);
    }

    onStop() {
        const overlay = $('.gh-theme-builder');
        if (overlay) overlay.remove();
    }
}

/**
 * Initialize the theme builder
 */
function initThemeBuilder() {
    if (!themeBuilderComponent) {
        themeBuilderComponent = new ThemeBuilderComponent();
    }
    if (themeBuilderComponent._isMounted && !$('.gh-theme-builder')) {
        // Keep singleton component healthy when DOM was cleared out of band.
        themeBuilderComponent.unmount();
    }
    themeBuilderComponent.start();
    console.log('Theme Builder initialized');
}

/**
 * Load saved custom themes from config
 */
function loadCustomThemes() {
    console.log('[ThemeBuilder] Loading themes. Full UI config:', JSON.stringify(getRuntimeConfig()?.javascript_config?.ui, null, 2));

    const saved = getRuntimeConfig()?.javascript_config?.ui?.customThemes;
    console.log('[ThemeBuilder] Raw customThemes from config:', saved);

    // Deep clone and normalize to avoid carrying stale theme fields forward.
    if (Array.isArray(saved) && saved.length > 0) {
        customThemes = JSON.parse(JSON.stringify(saved)).map(sanitizeThemeRecord);
    } else {
        customThemes = [];
    }
    console.log('[ThemeBuilder] After load, customThemes array:', customThemes.length, customThemes.map(t => t.name));
}

/**
 * Create the theme builder modal HTML
 */
function createThemeBuilderModal(owner) {
    // Reuse existing overlay if already mounted to avoid duplicate listeners.
    const existing = $('.gh-theme-builder');
    if (existing) return existing;

    const overlay = createElement('div', { className: 'gh-theme-builder', innerHTML: `
        <!-- Click Blocker Backdrop (blocks app interaction in edit mode) -->
        <div class="gh-theme-builder__backdrop" id="gh-theme-builder__backdrop"></div>

        <!-- Floating Theme Icon (appears only in preview mode) -->
        <button class="gh-theme-builder__floating-btn" id="gh-theme-builder__floating-btn" title="Open Theme Builder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M12 1v6m0 6v6m6-11H6m12 6H6"/>
            </svg>
        </button>

        <div class="gh-theme-builder__top-controls">
            <div class="gh-theme-builder__name-panel">
                <input type="text" id="gh-theme-builder__name-input" class="gh-theme-builder__name-input" placeholder="My Custom Theme" maxlength="30">
            </div>
            <div class="gh-theme-builder__save-panel">
                <button class="btn btn--secondary gh-theme-builder__cancel-btn" id="btn-cancel">
                    ${xIcon(18)}
                    Cancel
                </button>
                <button class="btn btn--primary gh-theme-builder__save-btn" id="btn-save">
                    ${diskIcon(18)}
                    Save
                </button>
            </div>
        </div>

        <button class="btn btn--secondary gh-theme-builder__preview-btn" id="btn-preview" title="Toggle Preview Mode">
            ${eyeIcon(18)}
            <span class="gh-theme-builder__preview-label">Preview</span>
        </button>

        <!-- Bottom Dock: editing tools only -->
        <div class="gh-theme-builder__dock">
            <button class="btn btn--secondary gh-theme-builder__dock-nav gh-theme-builder__dock-nav--prev" id="btn-dock-prev" type="button" aria-label="Previous theme controls">
                ${chevronDownIcon(22)}
            </button>
            <div class="gh-theme-builder__dock-scroll" aria-label="Theme editing controls">
                <div class="gh-theme-builder__dock-page gh-theme-builder__dock-page--swatches">
                    <div class="gh-theme-builder__dock-cluster gh-theme-builder__dock-cluster--swatches">
                        <div class="gh-theme-builder__swatches" id="gh-theme-builder__swatches"></div>
                    </div>
                </div>

                <div class="gh-theme-builder__dock-page gh-theme-builder__dock-page--tools">
                    <div class="gh-theme-builder__actions gh-theme-builder__dock-cluster">
                        <button class="btn btn--secondary gh-theme-builder__action-btn" id="btn-undo" disabled title="Undo">
                            <div class="gh-theme-builder__action-label">Undo</div>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M3 7v6h6"/>
                                <path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"/>
                            </svg>
                        </button>
                        <button class="btn btn--secondary gh-theme-builder__action-btn" id="btn-redo" disabled title="Redo">
                            <div class="gh-theme-builder__action-label">Redo</div>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M21 7v6h-6"/>
                                <path d="M3 17a9 9 0 019-9 9 9 0 016 2.3l3 2.7"/>
                            </svg>
                        </button>
                    </div>
                    <div class="gh-theme-builder__dock-divider" aria-hidden="true"></div>
                    <div class="gh-theme-builder__color-tools gh-theme-builder__dock-cluster">
                        <button class="btn btn--secondary gh-theme-builder__action-btn" id="btn-randomize" title="Random Colors">
                            <div class="gh-theme-builder__action-label">Random Colors</div>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                            </svg>
                        </button>
                        <button class="btn btn--secondary gh-theme-builder__action-btn" id="btn-invert" title="Invert Theme">
                            <div class="gh-theme-builder__action-label">Invert Theme</div>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"/>
                                <path d="M12 2v20"/>
                            </svg>
                        </button>
                    </div>
                </div>

                <div class="gh-theme-builder__dock-page gh-theme-builder__dock-page--library">
                    <div class="gh-theme-builder__panel-toggles gh-theme-builder__dock-cluster">
                        <button class="btn btn--secondary gh-theme-builder__panel-toggle" id="toggle-presets">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="3" y="3" width="7" height="7"/>
                                <rect x="14" y="3" width="7" height="7"/>
                                <rect x="3" y="14" width="7" height="7"/>
                                <rect x="14" y="14" width="7" height="7"/>
                            </svg>
                            <span class="gh-theme-builder__panel-label">Presets</span>
                        </button>
                        <button class="btn btn--secondary gh-theme-builder__panel-toggle" id="toggle-saved">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
                            </svg>
                            <span class="gh-theme-builder__panel-label">Saved</span>
                            <span id="saved-count-inline">0</span>
                        </button>
                    </div>
                    <div class="gh-theme-builder__dock-divider" aria-hidden="true"></div>
                    <div class="gh-theme-builder__format gh-theme-builder__dock-cluster">
                        <div class="gh-theme-builder__format-toggle">
                            <button class="btn btn--secondary gh-theme-builder__format-btn active" data-format="hex">HEX</button>
                            <button class="btn btn--secondary gh-theme-builder__format-btn" data-format="rgb">RGB</button>
                        </div>
                    </div>
                </div>
            </div>
            <button class="btn btn--secondary gh-theme-builder__dock-nav gh-theme-builder__dock-nav--next" id="btn-dock-next" type="button" aria-label="Next theme controls">
                ${chevronDownIcon(22)}
            </button>
        </div>

        <div class="gh-theme-builder__harmony-popover" id="gh-theme-builder__harmony-popover" aria-live="polite"></div>

        <!-- Floating Panel: Presets -->
        <div class="gh-theme-builder__side-panel" id="presets-panel">
            <div class="gh-theme-builder__side-header">Preset Themes</div>
            <div class="gh-theme-builder__preset-grid" id="gh-theme-builder__preset-grid"></div>
        </div>

        <!-- Floating Panel: Saved Themes -->
        <div class="gh-theme-builder__side-panel" id="saved-panel">
            <div class="gh-theme-builder__side-header">
                Saved Themes
                <span class="gh-theme-builder__saved-count" id="saved-count">0</span>
            </div>
            <div class="gh-theme-builder__saved-list" id="gh-theme-builder__saved-list"></div>
            <div class="gh-theme-builder__io-actions">
                <button class="btn btn--secondary gh-theme-builder__io-btn" id="btn-export">Export JSON</button>
                <button class="btn btn--secondary gh-theme-builder__io-btn" id="btn-import">Import JSON</button>
                <button class="btn btn--secondary gh-theme-builder__io-btn" id="btn-import-clipboard">Paste JSON</button>
            </div>
        </div>
    ` });

    document.body.appendChild(overlay);

    // Set up event listeners
    setupEventListeners(overlay, owner);

    // Render color swatches (compact inline version)
    renderColorSwatches();

    // Render presets
    renderPresets();

    // Mark current preset as active
    const activePreset = PRESET_PALETTES.find(p =>
        JSON.stringify(p.colors) === JSON.stringify(currentColors)
    );
    if (activePreset) {
        const presetBtn = $(`.gh-theme-builder__preset-item[data-preset="${activePreset.id}"]`);
        if (presetBtn) presetBtn.classList.add('active');
    }

    renderColorSwatches();
    renderSavedThemes();

    // Don't show the overlay automatically - wait for openThemeBuilder() to be called
    // This prevents it from blocking the app on page load

    return overlay;
}


/**
 * Render compact color swatches for the edge panel (vertical)
 */
function renderColorSwatches() {
    const container = $('#gh-theme-builder__swatches');
    if (!container) return;

    container.innerHTML = EDITOR_COLOR_KEYS.map(({ key, name }) => {
        const color = currentColors[key] || '#000000';
        return `
            <div class="gh-theme-builder__swatch" data-color-key="${key}">
                <div class="gh-theme-builder__swatch-label">${name}</div>
                <div class="gh-theme-builder__swatch-preview" style="background: ${color}">
                    <input type="color" value="${normalizeToHex(color)}" data-key="${key}">
                </div>
            </div>
        `;
    }).join('');

    // Add event listeners
    $$('input[type="color"]', container).forEach(input => {
        let startColor = null;
        let hasCommittedSwatchChange = false;
        const beginSwatchSession = () => {
            startColor = currentColors[input.dataset.key];
            hasCommittedSwatchChange = false;
        };
        const captureStartColor = () => {
            if (startColor === null) beginSwatchSession();
        };
        const resetSwatchSession = () => {
            startColor = null;
            hasCommittedSwatchChange = false;
        };
        const applySwatchColor = (target) => {
            const key = target.dataset.key;
            currentColors[key] = target.value;
            // Update the swatch background
            target.closest('.gh-theme-builder__swatch-preview').style.background = target.value;
            // Apply live to document
            applyColorsToDocument(currentColors);
        };

        attr(input, {
            onMousedown: beginSwatchSession,
            onTouchstart: beginSwatchSession,
            onFocus: captureStartColor,
            onBlur: resetSwatchSession,
            onInput: (e) => {
                captureStartColor();
                applySwatchColor(e.target);
            },
            onChange: (e) => {
                const previousColor = startColor ?? currentColors[e.target.dataset.key];
                applySwatchColor(e.target);

                if (normalizeToHex(previousColor) !== normalizeToHex(e.target.value)) {
                    if (hasCommittedSwatchChange) {
                        replaceCurrentHistory(currentColors);
                    } else {
                        pushToHistory(currentColors);
                        hasCommittedSwatchChange = true;
                        // Clear theme name when user manually changes colors
                        clearThemeNameIfNeeded('Manual color change');
                    }
                }
            }
        });
    });

    // Fallback: ensure clicking the swatch preview opens the color picker
    // even on platforms where the invisible input doesn't receive native clicks.
    $$('.gh-theme-builder__swatch-preview', container).forEach(preview => {
        preview.addEventListener('click', (e) => {
            // Don't re-trigger if the click originated from the input itself
            if (e.target.tagName === 'INPUT') return;
            const input = preview.querySelector('input[type="color"]');
            if (input) input.click();
        });
    });
}

/**
 * Set up all event listeners
 */
function setupEventListeners(overlay, owner = null) {
    if (!owner) {
        throw new Error('[ThemeBuilder] setupEventListeners called without a lifecycle owner. Pass a Module or Component instance as `owner`.');
    }
    const on = (target, type, handler, options) => {
        if (!target) return;
        owner.on(target, type, handler, options);
    };

    // Save, Cancel, and Preview buttons
    on($('.gh-theme-builder__save-btn', overlay), 'click', saveAndApplyTheme);
    on($('.gh-theme-builder__cancel-btn', overlay), 'click', cancelThemeBuilder);
    on($('.gh-theme-builder__preview-btn', overlay), 'click', togglePreviewMode);

    // Quick actions
    on($('#btn-undo', overlay), 'click', undo);
    on($('#btn-redo', overlay), 'click', redo);
    on($('#btn-randomize', overlay), 'click', randomizeColors);
    on($('#btn-invert', overlay), 'click', invertColors);

    const dockScroll = $('.gh-theme-builder__dock-scroll', overlay);
    const dockPrev = $('#btn-dock-prev', overlay);
    const dockNext = $('#btn-dock-next', overlay);
    const dockPages = $$('.gh-theme-builder__dock-page', overlay);
    const updateDockNav = () => {
        if (!dockScroll || dockPages.length === 0) return;
        const pageWidth = dockScroll.clientWidth || 1;
        const pageIndex = Math.round(dockScroll.scrollLeft / pageWidth);
        dockPrev?.classList.toggle('disabled', pageIndex <= 0);
        dockNext?.classList.toggle('disabled', pageIndex >= dockPages.length - 1);
        dockPrev?.setAttribute('aria-disabled', pageIndex <= 0 ? 'true' : 'false');
        dockNext?.setAttribute('aria-disabled', pageIndex >= dockPages.length - 1 ? 'true' : 'false');
    };
    const scrollDockPage = (direction) => {
        if (!dockScroll || dockPages.length === 0) return;
        const pageWidth = dockScroll.clientWidth;
        const currentIndex = Math.round(dockScroll.scrollLeft / pageWidth);
        const nextIndex = Math.max(0, Math.min(dockPages.length - 1, currentIndex + direction));
        dockScroll.scrollTo({ left: nextIndex * pageWidth, behavior: 'smooth' });
        owner.timeout(updateDockNav, 220);
    };
    on(dockPrev, 'click', () => scrollDockPage(-1));
    on(dockNext, 'click', () => scrollDockPage(1));
    on(dockScroll, 'scroll', updateDockNav);
    updateDockNav();

    // Color format toggle
    $$('.gh-theme-builder__format-btn', overlay).forEach(btn => {
        on(btn, 'click', (e) => {
            $$('.gh-theme-builder__format-btn', overlay).forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            colorFormat = e.target.dataset.format;
            renderColorSwatches(); // Re-render with new format
        });
    });

    // Export/Import
    on($('#btn-export', overlay), 'click', exportTheme);
    on($('#btn-import', overlay), 'click', importTheme);
    on($('#btn-import-clipboard', overlay), 'click', importThemeFromClipboard);

    // Panel toggles
    const presetsPanel = $('#presets-panel', overlay);
    const savedPanel = $('#saved-panel', overlay);
    const togglePresets = $('#toggle-presets', overlay);
    const toggleSaved = $('#toggle-saved', overlay);

    on(togglePresets, 'click', () => {
        presetsPanel?.classList.toggle('active');
        // Close the other panel
        savedPanel?.classList.remove('active');
    });

    on(toggleSaved, 'click', () => {
        savedPanel?.classList.toggle('active');
        // Close the other panel
        presetsPanel?.classList.remove('active');
        // Re-render saved themes when opening
        if (savedPanel?.classList.contains('active')) {
            renderSavedThemes();
        }
    });

    // Floating theme icon click - reopen theme builder
    const floatingIcon = $('#gh-theme-builder__floating-btn', overlay);
    on(floatingIcon, 'click', (e) => {
        e.stopPropagation();
        openThemeBuilder();
    });

    // Backdrop click - enter preview mode (deliberate action to test theme)
    const backdrop = $('#gh-theme-builder__backdrop', overlay);
    on(backdrop, 'click', (e) => {
        e.stopPropagation();
        closeThemeLibraryPanels();
        enterPreviewMode();
    });
    on(document, 'keydown', handleKeyDown);
    owner.listen(APP_EVENTS.THEME_CHANGED, handleThemeChanged);
}

/**
 * Handle APP_EVENTS.THEME_CHANGED updates to keep the input in sync.
 */
function handleThemeChanged() {
    const nameInput = $('#gh-theme-builder__name-input');
    if (!nameInput) return;

    const currentThemeId = getRuntimeConfig()?.javascript_config?.ui?.theme;
    if (!currentThemeId) {
        nameInput.value = '';
        return;
    }

    if (currentThemeId.startsWith('custom-')) {
        const activeTheme = customThemes.find(t => t.id === currentThemeId);
        if (activeTheme) {
            nameInput.value = activeTheme.name;
        }
    } else {
        const builtInTheme = BUILT_IN_THEME_NAMES.find(t => t.id === currentThemeId);
        nameInput.value = builtInTheme ? `${builtInTheme.name} Custom` : 'Custom Theme';
    }
}

const BUILT_IN_THEME_NAMES = [
    { id: 'dark', name: 'Dark' },
    { id: 'midnight', name: 'Midnight' },
    { id: 'nord', name: 'Nord' },
    { id: 'monokai', name: 'Monokai' },
    { id: 'dracula', name: 'Dracula' }
];

function handleKeyDown(e) {
    if (e.key === 'Escape') {
        const overlay = $('.gh-theme-builder');
        if (overlay?.classList.contains('preview-mode')) {
            // In preview mode - escape returns to edit mode
            openThemeBuilder();
        } else if (isOpen) {
            // In edit mode - escape enters preview mode
            enterPreviewMode();
        }
    }
}

/**
 * Toggle between preview mode and edit mode
 * Preview mode: hides controls except preview button, allows app interaction
 * Edit mode: shows all controls, blocks app interaction
 */
function togglePreviewMode() {
    const overlay = $('.gh-theme-builder');
    if (!overlay) return;

    if (overlay.classList.contains('preview-mode')) {
        // Currently in preview mode - switch to edit mode
        exitPreviewMode();
    } else {
        // Currently in edit mode - switch to preview mode
        enterPreviewMode();
    }
}

function closeThemeLibraryPanels() {
    const overlay = $('.gh-theme-builder');
    if (!overlay) return;

    $('#presets-panel', overlay)?.classList.remove('active');
    $('#saved-panel', overlay)?.classList.remove('active');
    $('#toggle-presets', overlay)?.classList.remove('active');
    $('#toggle-saved', overlay)?.classList.remove('active');
}

/**
 * Enter preview mode - hides controls but keeps preview button visible
 * User can test the theme by interacting with the app at full size
 */
function enterPreviewMode() {
    const overlay = $('.gh-theme-builder');
    if (overlay) {
        closeThemeLibraryPanels();
        isOpen = false;
        overlay.classList.remove('active'); // Remove active class to allow clicks through
        overlay.classList.add('preview-mode');
        setThemeBuilderViewportState('preview');
        // Re-enable the underlying config modal so the user can interact with it
        // through the preview viewport (undoes the inert/focus-trap suspension
        // that exitPreviewMode/openThemeBuilder applied when entering edit mode).
        resumeUnderlyingConfigModal();
        notifyThemeBuilderClosed();
        withConfigModalFocusControls('resumeConfigModalFocusTrap');
    }
}

/**
 * Exit preview mode - return to edit mode with all controls visible and app minified
 */
function exitPreviewMode() {
    const overlay = $('.gh-theme-builder');
    if (overlay) {
        notifyThemeBuilderOpened();
        suspendUnderlyingConfigModal();
        withConfigModalFocusControls('suspendConfigModalFocusTrap');
        isOpen = true;
        overlay.classList.remove('preview-mode');
        overlay.classList.add('active');
        setThemeBuilderViewportState('edit');
    }
}

/**
 * Initialize colors from current theme
 */
function initializeColors() {
    const style = getComputedStyle(document.documentElement);

    currentColors = buildThemeColors({
        primary: style.getPropertyValue('--primary-color').trim() || '#2d3250',
        accent: style.getPropertyValue('--accent-color').trim() || '#f05454',
        background: style.getPropertyValue('--background-color').trim() || '#121212',
        surface: style.getPropertyValue('--surface-color').trim() || '#1e1e2e',
        text: style.getPropertyValue('--text-primary').trim() || '#ffffff'
    }, DEFAULT_THEME_COLORS);
}

/**
 * Render preset palette buttons
 */
function renderPresets() {
    const container = $('#gh-theme-builder__preset-grid');
    if (!container) return;

    container.innerHTML = PRESET_PALETTES.map(preset => {
        const chips = ['primary', 'accent', 'surface', 'background'].map(key => (
            `<div style="background: ${preset.colors[key]}"></div>`
        )).join('');

        return `
        <button class="btn btn--secondary gh-theme-builder__preset-item"
             type="button"
             data-preset="${preset.id}"
             title="${preset.name}">
            <span class="gh-theme-builder__preset-checkmark" aria-hidden="true"></span>
            <div class="gh-theme-builder__swatches" aria-hidden="true">${chips}</div>
            <span class="gh-theme-builder__preset-name">${preset.name}</span>
        </button>
    `;
    }).join('');

    // Add click handlers
    $$('.gh-theme-builder__preset-item', container).forEach(btn => {
        attr(btn, {
            onClick: () => {
                const presetId = btn.dataset.preset;
            const preset = PRESET_PALETTES.find(p => p.id === presetId);
            if (preset) {
                currentColors = buildThemeColors(preset.colors);
                renderColorSwatches(); // Re-render compact swatches

                // Apply live to document for preview
                applyColorsToDocument(currentColors);

                // Update active state
                $$('.gh-theme-builder__preset-item', container).forEach(p => p.classList.remove('active'));
                btn.classList.add('active');

                // Update theme name
                const nameInput = $('#gh-theme-builder__name-input');
                if (nameInput) {
                    const newName = preset.name + ' Custom';
                    nameInput.value = newName;
                    lastSetThemeName = newName; // Track this as intentional name set
                }

                // Add to history
                pushToHistory(currentColors);
                }
            }
        });
    });
}

/**
 * Render the saved themes list to all containers (mobile and desktop)
 */
function renderSavedThemes() {
    const container = $('#gh-theme-builder__saved-list');
    if (!container) return;

    // Update count badges (both locations)
    const countEl = $('#saved-count');
    const countInlineEl = $('#saved-count-inline');
    if (countEl) {
        countEl.textContent = customThemes.length;
    }
    if (countInlineEl) {
        countInlineEl.textContent = customThemes.length;
    }

    const emptyHtml = '<div style="text-align: center; padding: 20px; color: rgba(255, 255, 255, 0.5); font-size: 0.75rem;">No saved themes yet.<br>Create one!</div>';

    const themesHtml = customThemes.map((theme, index) => `
        <div class="gh-theme-builder__saved-item" data-index="${index}">
            <span class="gh-theme-builder__saved-checkmark"></span>
            <div class="gh-theme-builder__saved-colors">
                <div class="gh-theme-builder__saved-color" style="background: ${theme.colors.primary}"></div>
                <div class="gh-theme-builder__saved-color" style="background: ${theme.colors.accent}"></div>
                <div class="gh-theme-builder__saved-color" style="background: ${theme.colors.background}"></div>
            </div>
            <span class="gh-theme-builder__saved-name">${escapeHtml(theme.name)}</span>
            <button class="btn btn--danger btn--icon gh-theme-builder__saved-delete" title="Delete theme">
                ${trashIcon(16, 'Delete theme')}
            </button>
        </div>
    `).join('');

    container.innerHTML = customThemes.length === 0 ? emptyHtml : themesHtml;

    // Click to activate and load theme
    $$('.gh-theme-builder__saved-item', container).forEach(el => {
        attr(el, {
            onClick: async (e) => {
                if (e.target.closest('.gh-theme-builder__saved-delete')) return;
                const index = parseInt(el.dataset.index);
                const theme = customThemes[index];
                if (theme) {
                    currentColors = buildThemeColors(theme.colors);
                    const nameInput = $('#gh-theme-builder__name-input');
                    if (nameInput) {
                        nameInput.value = theme.name;
                        lastSetThemeName = theme.name; // Track this as intentional name set
                    }
                    renderColorSwatches(); // Re-render swatches
                    // Apply preview immediately
                    applyColorsToDocument(currentColors);
                    // Add to history
                    pushToHistory(currentColors);

                    if (!await persistSelectedCustomTheme(theme, currentColors, 'Failed to select theme. Please try again.')) return;

                    // Mark as active
                    $$('.gh-theme-builder__saved-item', container).forEach(i => i.classList.remove('active'));
                    el.classList.add('active');
                }
            }
        });
    });

    // Mark current theme as active (compare colors)
    const currentThemeId = getRuntimeConfig()?.javascript_config?.ui?.theme;
    if (currentThemeId) {
        const activeIndex = customThemes.findIndex(t => t.id === currentThemeId);
        if (activeIndex >= 0) {
            $(`.gh-theme-builder__saved-item[data-index="${activeIndex}"]`, container)?.classList.add('active');
        }
    }

    // Delete theme
    $$('.gh-theme-builder__saved-delete', container).forEach(btn => {
        attr(btn, {
            onClick: async (e) => {
                e.stopPropagation();
                const themeEl = btn.closest('.gh-theme-builder__saved-item');
            const index = parseInt(themeEl.dataset.index);
            const themeId = customThemes[index]?.id;
            const themeName = customThemes[index]?.name || 'this theme';

            if (await dialog.confirm(`Delete "${themeName}"?`, { type: 'danger' })) {
                const serverTheme = getRuntimeConfig()?.javascript_config?.ui?.theme || 'dark';
                const selectedTheme = getUserPreference('theme', serverTheme);
                const wasActiveTheme = selectedTheme === themeId || serverTheme === themeId;
                customThemes.splice(index, 1);

                // Update config and save
                const nextConfig = buildConfigWithUI();
                nextConfig.javascript_config.ui.customThemes = [...customThemes];
                if (wasActiveTheme) {
                    nextConfig.javascript_config.ui.theme = 'dark';
                }

                try {
                    await saveConfig(nextConfig);
                    console.log('Theme deleted:', themeName);

                    // If we just deleted the currently active theme, fallback to dark
                    if (wasActiveTheme) {
                        const { applyTheme } = await import('../../utils/themeManager.js');
                        console.log('Active theme deleted, falling back to dark');
                        applyTheme('dark', false);
                        await saveUserPreference('theme', 'dark');
                        initializeColors();
                        originalColors = { ...currentColors };
                        originalThemeId = 'dark';
                    }
                } catch (err) {
                    console.error('Failed to delete theme:', err);
                }

                    renderSavedThemes();
                }
            }
        });
    });
}

/**
 * Randomize colors using intelligent color harmony theory
 * Cycles through different harmony modes for variety
 */
function randomizeColors() {
    const btn = $('#btn-randomize');
    btn?.classList.add('randomizing');
    setTimeout(() => btn.classList.remove('randomizing'), 500);

    // Cycle through harmony modes
    const harmony = COLOR_HARMONIES[currentHarmonyIndex];
    currentHarmonyIndex = (currentHarmonyIndex + 1) % COLOR_HARMONIES.length;

    // Generate base hue and saturation
    const baseHue = Math.random() * 360;
    const baseSat = 45 + Math.random() * 25; // 45-70%

    // Calculate accent hue based on harmony
    let accentHue;

    switch (harmony) {
        case 'complementary':
            accentHue = (baseHue + 180) % 360;
            break;
        case 'triadic':
            accentHue = (baseHue + 120) % 360;
            break;
        case 'split-complementary':
            accentHue = (baseHue + 150) % 360;
            break;
        case 'tetradic':
            accentHue = (baseHue + 90) % 360;
            break;
        case 'analogous':
        default:
            accentHue = (baseHue + 30) % 360;
            break;
    }

    // Determine if dark or light theme (80% dark, 20% light for variety)
    const isDark = Math.random() > 0.2;

    if (isDark) {
        currentColors = {
            primary: hslToHex(baseHue, baseSat, 22 + Math.random() * 8),
            accent: hslToHex(accentHue, 65 + Math.random() * 20, 50 + Math.random() * 15),
            background: hslToHex(baseHue, 10 + Math.random() * 10, 6 + Math.random() * 4),
            surface: hslToHex(baseHue, 15 + Math.random() * 10, 12 + Math.random() * 6),
            text: hslToHex(baseHue, 5 + Math.random() * 10, 92 + Math.random() * 6)
        };
    } else {
        // Light theme
        currentColors = {
            primary: hslToHex(baseHue, baseSat, 35 + Math.random() * 10),
            accent: hslToHex(accentHue, 70 + Math.random() * 20, 45 + Math.random() * 10),
            background: hslToHex(baseHue, 5 + Math.random() * 10, 95 + Math.random() * 4),
            surface: hslToHex(baseHue, 8 + Math.random() * 10, 90 + Math.random() * 5),
            text: hslToHex(baseHue, 15 + Math.random() * 15, 8 + Math.random() * 10)
        };
    }

    // Ensure good contrast between text and background
    currentColors = ensureContrast(currentColors);

    renderColorSwatches();
    applyColorsToDocument(currentColors);

    // Add to history
    pushToHistory(currentColors);

    // Clear theme name when randomizing
    clearThemeNameIfNeeded('Randomized colors');

    // Show harmony badge (clear any previous timeout first)
    const badge = $('#gh-theme-builder__harmony-popover');
    if (badge) {
        if (badgeTimeout) clearTimeout(badgeTimeout);
        if (btn && badge.id === 'gh-theme-builder__harmony-popover') {
            const rect = btn.getBoundingClientRect();
            badge.style.setProperty('--harmony-popover-left', `${rect.left + rect.width / 2}px`);
            badge.style.setProperty('--harmony-popover-bottom', `${window.innerHeight - rect.top + 12}px`);
        }
        badge.textContent = harmony.charAt(0).toUpperCase() + harmony.slice(1).replace('-', ' ');
        badge.classList.add('visible');
        badgeTimeout = setTimeout(() => {
            badge.classList.remove('visible');
            badgeTimeout = setTimeout(() => { badge.textContent = ''; }, 300);
        }, 2000);
    }

    console.log(`[ThemeBuilder] Generated ${harmony} palette (${isDark ? 'dark' : 'light'})`);
}

/**
 * Intelligently invert colors - swap light/dark while preserving hue relationships
 * and ensuring proper contrast between elements
 */
function invertColors() {
    const newColors = {};

    // Get HSL values for all colors
    const hslColors = {};
    for (const key of Object.keys(currentColors)) {
        hslColors[key] = hexToHsl(currentColors[key]);
    }

    // Determine if current theme is dark or light based on background luminance
    const bgLuminance = getRelativeLuminance(currentColors.background);
    const isDark = bgLuminance < 0.5;

    // Invert luminance values while preserving hue and adjusting saturation
    for (const key of Object.keys(currentColors)) {
        const [h, s, l] = hslColors[key];

        // Invert lightness with role-aware adjustments
        let newL;
        let newS = s;

        switch (key) {
            case 'background':
                // Swap dark bg to light or vice versa
                newL = isDark ? 96 - (l * 0.3) : 8 + (l * 0.1);
                newS = isDark ? Math.max(5, s * 0.5) : Math.min(20, s * 1.5);
                break;
            case 'surface':
                // Surface should be slightly different from background
                newL = isDark ? 90 - (l * 0.3) : 15 + (l * 0.15);
                newS = isDark ? Math.max(8, s * 0.6) : Math.min(25, s * 1.4);
                break;
            case 'text':
                // Text should contrast with background
                newL = isDark ? 15 + (100 - l) * 0.1 : 92 - (100 - l) * 0.1;
                newS = isDark ? Math.min(30, s * 1.5) : Math.max(5, s * 0.6);
                break;
            case 'primary':
                // UI elements - moderate inversion
                newL = isDark ? Math.min(75, 100 - l + 15) : Math.max(25, 100 - l - 15);
                newS = Math.max(30, Math.min(80, s)); // Keep saturation moderate
                break;
            case 'accent':
                // Accent should stay vibrant - only slight luminance shift
                newL = Math.max(40, Math.min(65, 100 - l + (isDark ? 10 : -10)));
                newS = Math.max(60, Math.min(90, s * 1.1)); // Keep high saturation
                break;
            default:
                newL = 100 - l;
                break;
        }

        newColors[key] = hslToHex(h, Math.max(0, Math.min(100, newS)), Math.max(0, Math.min(100, newL)));
    }

    // Ensure proper contrast
    currentColors = ensureContrast(newColors);

    renderColorSwatches();
    applyColorsToDocument(currentColors);

    // Add to history
    pushToHistory(currentColors);

    // Clear theme name when inverting
    clearThemeNameIfNeeded('Inverted colors');

    console.log(`[ThemeBuilder] Inverted theme (was ${isDark ? 'dark' : 'light'}, now ${isDark ? 'light' : 'dark'})`);
}

/**
 * Adjust saturation of all colors
 */
function adjustSaturation(factor) {
    for (const key of Object.keys(currentColors)) {
        currentColors[key] = adjustColorSaturation(currentColors[key], factor);
    }
    renderColorSwatches();
}

async function persistSelectedCustomTheme(theme, colors, errorMessage) {
    const nextConfig = buildConfigWithUI();
    const themesToSave = JSON.parse(JSON.stringify(customThemes)).map(sanitizeThemeRecord);
    const persistedColors = buildThemeColors(colors);

    nextConfig.javascript_config.ui.theme = theme.id;
    nextConfig.javascript_config.ui.customThemes = themesToSave;

    try {
        const result = await saveConfig(nextConfig);
        console.log('[ThemeBuilder] Save result:', result);
        console.log('[ThemeBuilder] Selected custom theme:', theme.id);
        await saveUserPreference('theme', theme.id);
    } catch (err) {
        console.error('[ThemeBuilder] Failed to persist selected custom theme:', err);
        toast.error(errorMessage);
        return false;
    }

    originalColors = { ...persistedColors };
    originalThemeId = theme.id;
    bus.emit(APP_EVENTS.THEME_CHANGED, { theme: theme.id, custom: true, colors: persistedColors });
    return true;
}

/**
 * Save and apply the custom theme
 */
async function saveAndApplyTheme() {
    const nameInput = $('#gh-theme-builder__name-input');
    const name = nameInput?.value.trim() || `Custom ${Date.now()}`;
    currentColors = buildThemeColors(currentColors);

    console.log('[ThemeBuilder] Saving theme. Current customThemes before:', customThemes.length, customThemes.map(t => t.name));

    // Create theme object
    const theme = {
        id: 'custom-' + Date.now(),
        name: name,
        colors: { ...currentColors },
        createdAt: new Date().toISOString()
    };

    // Check if updating existing theme by name
    const existingIndex = customThemes.findIndex(t => t.name === name);
    if (existingIndex >= 0) {
        theme.id = customThemes[existingIndex].id; // Keep same ID when updating
        customThemes[existingIndex] = theme;
        console.log('[ThemeBuilder] Updated existing theme at index:', existingIndex);
    } else {
        customThemes.push(theme);
        console.log('[ThemeBuilder] Added new theme. Total now:', customThemes.length);
    }

    applyColorsToDocument(currentColors);
    if (!await persistSelectedCustomTheme(theme, currentColors, 'Failed to save theme. Please try again.')) return;

    closeThemeBuilder();
}

/**
 * Apply colors directly to document CSS variables
 */
function applyColorsToDocument(colors) {
    colors = buildThemeColors(colors, currentColors);
    const root = document.documentElement;
    Object.entries(getThemeCssVariables(colors)).forEach(([property, value]) => {
        root.style.setProperty(property, value);
    });

    // Update meta theme color
    const metaThemeColor = $('meta[name="theme-color"]');
    if (metaThemeColor) {
        metaThemeColor.setAttribute('content', colors.primary);
    }

    // Mark as custom theme
    root.setAttribute('data-theme', 'custom');
}

/**
 * Export theme as JSON
 * Uses the theme's actual name from the input field
 */
function exportTheme() {
    const nameInput = $('#gh-theme-builder__name-input');
    const name = nameInput?.value.trim() || 'My Custom Theme';
    currentColors = buildThemeColors(currentColors);

    const theme = {
        name: name,
        colors: { ...currentColors }, // Deep copy
        exportedAt: new Date().toISOString(),
        version: '1.0'
    };

    const json = JSON.stringify(theme, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    // Sanitize filename: lowercase, replace spaces/special chars with dash
    const sanitizedName = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with dash
        .replace(/^-+|-+$/g, '');      // Remove leading/trailing dashes

    const a = createElement('a', { href: url, download: `ghosthub-theme-${sanitizedName}.json` });
    a.click();

    URL.revokeObjectURL(url);
    console.log(`[ThemeBuilder] Exported theme: ${name}`);
}

async function applyImportedTheme(theme, source = 'file') {
    if (!theme?.colors || typeof theme.colors !== 'object') {
        toast.error('Invalid theme JSON format');
        return;
    }

    currentColors = buildThemeColors(theme.colors, currentColors);

    const themeName = theme.name || `Imported ${Date.now()}`;
    const nameInput = $('#gh-theme-builder__name-input');
    if (nameInput) nameInput.value = themeName;

    const newTheme = {
        id: 'custom-' + Date.now(),
        name: themeName,
        colors: { ...currentColors },
        createdAt: new Date().toISOString(),
        imported: true
    };

    const existingIndex = customThemes.findIndex(t => t.name === themeName);
    if (existingIndex >= 0) {
        if (await dialog.confirm(`A theme named "${themeName}" already exists. Replace it?`)) {
            newTheme.id = customThemes[existingIndex].id;
            customThemes[existingIndex] = newTheme;
        } else {
            renderColorSwatches();
            applyColorsToDocument(currentColors);
            pushToHistory(currentColors);
            return;
        }
    } else {
        customThemes.push(newTheme);
    }

    renderColorSwatches();
    applyColorsToDocument(currentColors);
    pushToHistory(currentColors);

    if (!await persistSelectedCustomTheme(newTheme, currentColors, 'Failed to import theme. Please try again.')) return;
    renderSavedThemes();

    toast.success(`Imported "${themeName}"`);
    console.log(`[ThemeBuilder] Imported and saved theme from ${source}: ${themeName}`);
}

async function importThemeJson(text, source = 'file') {
    if (!text?.trim()) {
        toast.error(source === 'clipboard' ? 'Clipboard is empty' : 'Theme JSON is empty');
        return;
    }

    try {
        await applyImportedTheme(JSON.parse(text), source);
    } catch (err) {
        toast.error('Failed to import theme: ' + err.message);
    }
}

/**
 * Import theme from JSON file
 * Loads the theme, saves it to customThemes, and applies it
 */
function importTheme() {
    const input = createElement('input', {
        type: 'file',
        accept: '.json',
        onChange: async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const text = await file.text();
                await importThemeJson(text, 'file');
            } catch (err) {
                toast.error('Failed to import theme: ' + err.message);
            }
        }
    });

    input.click();
}

async function importThemeFromClipboard() {
    let text = '';

    if (navigator.clipboard?.readText) {
        try {
            text = await navigator.clipboard.readText();
        } catch (err) {
            console.warn('[ThemeBuilder] Clipboard read failed:', err);
        }
    }

    if (!text) {
        const pasted = await dialog.prompt('Paste theme JSON', {
            title: 'Import Theme',
            confirmText: 'Import',
            placeholder: '{"name":"...","colors":{...}}'
        });
        if (pasted === null) return;
        text = pasted;
    }

    await importThemeJson(text, 'clipboard');
}

/**
 * Open the theme builder
 */
function openThemeBuilder() {
    let overlay = $('.gh-theme-builder');
    if (!overlay) {
        initThemeBuilder();
        overlay = $('.gh-theme-builder');
    }
    if (overlay) {
        notifyThemeBuilderOpened();
        suspendUnderlyingConfigModal();
        withConfigModalFocusControls('suspendConfigModalFocusTrap');
        isOpen = true;
        setThemeBuilderViewportState('edit');
        overlay.classList.remove('preview-mode'); // Hide floating icon when controls visible

        // Reload custom themes from config (in case they were updated externally)
        loadCustomThemes();

        // Check if we're resuming from preview mode (originalColors still set)
        if (!originalColors) {
            // Fresh open - store original colors for revert
            const serverTheme = getRuntimeConfig()?.javascript_config?.ui?.theme || 'dark';
            originalThemeId = getUserPreference('theme', serverTheme);
            initializeColors();
            originalColors = { ...currentColors };
        }
        // If originalColors exists, we're resuming preview - keep currentColors as-is

        renderPresets();
        renderColorSwatches();
        renderSavedThemes();

        // Display current theme name if applicable
        const currentThemeId = getRuntimeConfig()?.javascript_config?.ui?.theme;
        const nameInput = $('#gh-theme-builder__name-input');
        if (currentThemeId) {
            if (currentThemeId.startsWith('custom-')) {
                // Custom theme - find by ID
                const activeTheme = customThemes.find(t => t.id === currentThemeId);
                if (activeTheme && nameInput) {
                    nameInput.value = activeTheme.name;
                }
            } else {
                // Built-in theme - use name + " Custom"
                const builtInTheme = BUILT_IN_THEME_NAMES.find(t => t.id === currentThemeId);
                if (nameInput) {
                    nameInput.value = builtInTheme ? `${builtInTheme.name} Custom` : 'Custom Theme';
                }
            }
        }

        // Initialize history
        initializeHistory();

        overlay.classList.add('active');
    }
}

/**
 * Hide the theme builder (enters preview mode)
 * @deprecated Use enterPreviewMode() instead
 */
function hideThemeBuilder() {
    enterPreviewMode();
}

function restoreThemeOnCancel(themeId, colors) {
    if (themeId) {
        import('../../utils/themeManager.js')
            .then(({ applyTheme }) => applyTheme(themeId, false))
            .catch((err) => {
                console.warn('[ThemeBuilder] Failed to restore selected theme on cancel:', err);
                if (colors) applyColorsToDocument(colors);
            });
        return;
    }

    if (colors) applyColorsToDocument(colors);
}

/**
 * Cancel and revert only unsaved color edits
 */
function cancelThemeBuilder() {
    const overlay = $('.gh-theme-builder');
    if (overlay) {
        restoreThemeOnCancel(originalThemeId, originalColors ? { ...originalColors } : null);

        isOpen = false;
        originalColors = null;
        originalThemeId = null;
        overlay.classList.remove('active');
        overlay.classList.remove('preview-mode');
        setThemeBuilderViewportState('closed');
        resumeUnderlyingConfigModal();
        notifyThemeBuilderClosed();
        withConfigModalFocusControls('resumeConfigModalFocusTrap');
    }
}

/**
 * Close the theme builder (called after save)
 */
function closeThemeBuilder() {
    const overlay = $('.gh-theme-builder');
    if (overlay) {
        isOpen = false;
        originalColors = null;
        originalThemeId = null;
        overlay.classList.remove('active');
        overlay.classList.remove('preview-mode');
        setThemeBuilderViewportState('closed');
        resumeUnderlyingConfigModal();
        notifyThemeBuilderClosed();
        withConfigModalFocusControls('resumeConfigModalFocusTrap');
    }
}

/**
 * Hard teardown for tests/hot-reload flows.
 */
function destroyThemeBuilder() {
    if (themeBuilderComponent) {
        themeBuilderComponent.unmount();
        themeBuilderComponent = null;
    } else {
        const overlay = $('.gh-theme-builder');
        if (overlay) overlay.remove();
    }
    isOpen = false;
    originalColors = null;
    originalThemeId = null;
    setThemeBuilderViewportState('closed');
    resumeUnderlyingConfigModal();
    notifyThemeBuilderClosed();
    withConfigModalFocusControls('resumeConfigModalFocusTrap');
}

// ==================== Color Utility Functions ====================

/**
 * Escape HTML to prevent injection of HTML/SVG code in theme names
 */
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function buildThemeColors(colors = {}, baseColors = currentColors) {
    return normalizeThemeColors(colors, baseColors);
}

function formatColor(hex, format) {
    hex = normalizeToHex(hex);

    switch (format) {
        case 'rgb': {
            const [r, g, b] = hexToRgb(hex);
            return `rgb(${r}, ${g}, ${b})`;
        }
        case 'hsl': {
            const [h, s, l] = hexToHsl(hex);
            return `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`;
        }
        default:
            return hex;
    }
}

function invertColor(hex) {
    const [r, g, b] = hexToRgb(hex);
    return rgbToHex(255 - r, 255 - g, 255 - b);
}

/**
 * Calculate relative luminance (WCAG formula)
 */
function getRelativeLuminance(hex) {
    const [r, g, b] = hexToRgb(hex).map(c => {
        c = c / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Calculate contrast ratio between two colors (WCAG)
 */
function getContrastRatio(hex1, hex2) {
    const l1 = getRelativeLuminance(hex1);
    const l2 = getRelativeLuminance(hex2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Ensure proper contrast between text and background
 * WCAG AA requires 4.5:1 for normal text, 3:1 for large text
 */
function ensureContrast(colors) {
    const adjusted = { ...colors };
    const minContrast = 4.5; // WCAG AA for normal text

    // Check text vs background contrast
    let textBgContrast = getContrastRatio(adjusted.text, adjusted.background);
    let iterations = 0;

    while (textBgContrast < minContrast && iterations < 20) {
        const [h, s, l] = hexToHsl(adjusted.text);
        const bgLuminance = getRelativeLuminance(adjusted.background);

        // Adjust text lightness away from background
        if (bgLuminance > 0.5) {
            // Light background - darken text
            adjusted.text = hslToHex(h, s, Math.max(0, l - 5));
        } else {
            // Dark background - lighten text
            adjusted.text = hslToHex(h, s, Math.min(100, l + 5));
        }

        textBgContrast = getContrastRatio(adjusted.text, adjusted.background);
        iterations++;
    }

    // Check accent contrast against surface (for buttons)
    let accentSurfaceContrast = getContrastRatio(adjusted.accent, adjusted.surface);
    iterations = 0;

    while (accentSurfaceContrast < 3 && iterations < 15) {
        const [h, s, l] = hexToHsl(adjusted.accent);
        const surfaceLuminance = getRelativeLuminance(adjusted.surface);

        if (surfaceLuminance > 0.5) {
            adjusted.accent = hslToHex(h, Math.min(100, s + 5), Math.max(20, l - 5));
        } else {
            adjusted.accent = hslToHex(h, Math.min(100, s + 5), Math.min(80, l + 5));
        }

        accentSurfaceContrast = getContrastRatio(adjusted.accent, adjusted.surface);
        iterations++;
    }

    return adjusted;
}

function adjustColorSaturation(hex, factor) {
    const [h, s, l] = hexToHsl(hex);
    return hslToHex(h, Math.min(100, Math.max(0, s * factor)), l);
}

// ==================== Undo/Redo Functions ====================

/**
 * Add current color state to history
 * @param {Object} colors - Color state to save
 */
function pushToHistory(colors) {
    // Remove any history after current index (when making changes after undo)
    colorHistory = colorHistory.slice(0, historyIndex + 1);

    // Add new state
    colorHistory.push({ ...colors });

    // Trim history if too large
    if (colorHistory.length > MAX_HISTORY) {
        colorHistory.shift();
    } else {
        historyIndex++;
    }

    updateUndoRedoButtons();
}

function replaceCurrentHistory(colors) {
    if (historyIndex < 0 || historyIndex >= colorHistory.length) {
        pushToHistory(colors);
        return;
    }

    colorHistory[historyIndex] = { ...colors };
    updateUndoRedoButtons();
}

/**
 * Undo to previous color state
 */
function undo() {
    if (historyIndex <= 0) return;

    historyIndex--;
    const previousState = colorHistory[historyIndex];
    if (previousState) {
        currentColors = { ...previousState };
        renderColorSwatches();
        applyColorsToDocument(currentColors);
        updateUndoRedoButtons();
    }
}

/**
 * Redo to next color state
 */
function redo() {
    if (historyIndex >= colorHistory.length - 1) return;

    historyIndex++;
    const nextState = colorHistory[historyIndex];
    if (nextState) {
        currentColors = { ...nextState };
        renderColorSwatches();
        applyColorsToDocument(currentColors);
        updateUndoRedoButtons();
    }
}

/**
 * Update undo/redo button states
 */
function updateUndoRedoButtons() {
    const undoBtn = $('#btn-undo');
    const redoBtn = $('#btn-redo');

    if (undoBtn) {
        undoBtn.disabled = historyIndex <= 0;
        undoBtn.style.opacity = historyIndex <= 0 ? '0.5' : '1';
    }

    if (redoBtn) {
        redoBtn.disabled = historyIndex >= colorHistory.length - 1;
        redoBtn.style.opacity = historyIndex >= colorHistory.length - 1 ? '0.5' : '1';
    }
}

/**
 * Clear history and initialize with current colors
 */
function initializeHistory() {
    colorHistory = [{ ...currentColors }];
    historyIndex = 0;
    updateUndoRedoButtons();
}

/**
 * Clear theme name if user made manual changes (not from preset/saved theme)
 * @param {string} reason - Reason for clearing (for debugging)
 */
function clearThemeNameIfNeeded(reason) {
    const nameInput = $('#gh-theme-builder__name-input');
    if (!nameInput) return;

    // Don't clear if the name was just set from a preset or saved theme
    if (lastSetThemeName && nameInput.value === lastSetThemeName) {
        // User is working with a named theme - keep the name
        return;
    }

    // Clear the theme name for better UX (user is creating a variant)
    if (nameInput.value) {
        console.log(`[ThemeBuilder] Clearing theme name: ${reason}`);
        nameInput.value = '';
        lastSetThemeName = null;
    }
}

// ==================== Exports ====================

export {
    initThemeBuilder,
    openThemeBuilder,
    closeThemeBuilder,
    destroyThemeBuilder,
    applyColorsToDocument,
    loadCustomThemes,
    PRESET_PALETTES
};
