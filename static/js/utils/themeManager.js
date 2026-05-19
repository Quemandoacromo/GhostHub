/**
 * Theme Manager
 * Handles theme switching and feature toggles for the application.
 * Settings are stored in server config (ghosthub_config.json) under javascript_config.ui
 */

import { bus, $ } from '../libs/ragot.esm.min.js';
import { APP_EVENTS } from '../core/appEvents.js';
import {
    getThemeCssVariables,
    normalizeThemeColors,
    THEME_CSS_VARIABLE_KEYS
} from './themeColors.js';

function getRuntimeConfig() {
    return window.ragotModules?.appStore?.get?.('config', {}) || {};
}

function setRuntimeConfig(nextConfig) {
    if (window.ragotModules?.appStore?.set) {
        window.ragotModules.appStore.set('config', nextConfig, { source: 'themeManager.setRuntimeConfig' });
    }
}

// Available themes (built-in)
const BUILT_IN_THEMES = [
    { id: 'dark', name: 'Dark (Default)', description: 'Classic dark theme with red accents' },
    { id: 'midnight', name: 'Midnight', description: 'Deep purple-blue with pink accents' },
    { id: 'nord', name: 'Nord', description: 'Arctic, bluish color palette' },
    { id: 'monokai', name: 'Monokai', description: 'Classic code editor theme' },
    { id: 'dracula', name: 'Dracula', description: 'Popular dark theme with purple accents' }
];

// Get all available themes including custom ones
function getAvailableThemes() {
    const customThemes = getRuntimeConfig()?.javascript_config?.ui?.customThemes || [];
    const customThemeOptions = customThemes.map(t => ({
        id: t.id,
        name: `${t.name} ★`,  // Use text star instead of SVG (option elements can't contain HTML)
        description: 'Custom theme',
        custom: true,
        colors: t.colors
    }));
    return [...BUILT_IN_THEMES, ...customThemeOptions];
}

// For backwards compatibility
const AVAILABLE_THEMES = BUILT_IN_THEMES;

// Available UI layouts
const AVAILABLE_LAYOUTS = [
    { id: 'streaming', name: 'Streaming', description: 'Netflix-style horizontal browsing with media rows' },
    { id: 'gallery', name: 'Gallery', description: 'Google Photos-style timeline with date groupings' }
];

// Feature toggles with defaults
const FEATURE_TOGGLES = {
    chat: { default: true, description: 'Enable chat sidebar' },
    syncButton: { default: true, description: 'Show sync button in the header' },
    headerBranding: { default: true, description: 'Show GhostHub branding in header' },
    search: { default: true, description: 'Enable global search bar' }
};

// Default UI config
const DEFAULT_UI_CONFIG = {
    theme: 'dark',
    layout: 'streaming',
    features: {
        chat: true,
        syncButton: true,
        headerBranding: true,
        search: true
    }
};

/**
 * Get the UI config from server config
 * @returns {Object} UI configuration object
 */
function getUIConfigFromServer() {
    return getRuntimeConfig()?.javascript_config?.ui || DEFAULT_UI_CONFIG;
}

/**
 * Get the current theme
 * @returns {string} Current theme ID
 */
function getCurrentTheme() {
    const uiConfig = getUIConfigFromServer();
    const theme = uiConfig.theme || 'dark';

    // Check built-in themes first
    if (BUILT_IN_THEMES.some(t => t.id === theme)) {
        return theme;
    }

    // Check custom themes (theme IDs starting with 'custom-')
    if (theme.startsWith('custom-')) {
        const customThemes = uiConfig.customThemes || [];
        if (customThemes.some(t => t.id === theme)) {
            return theme;
        }
        // Legacy fallback: customThemeColors from older configs
        if (uiConfig.customThemeColors) {
            return theme;
        }
    }

    return 'dark';
}

/**
 * Get the current layout
 * @returns {string} Current layout ID
 */
function getCurrentLayout() {
    const uiConfig = getUIConfigFromServer();
    const layout = uiConfig.layout || 'streaming';

    // Validate layout exists
    if (AVAILABLE_LAYOUTS.some(l => l.id === layout)) {
        return layout;
    }
    return 'streaming';
}

/**
 * Get feature toggle states
 * @returns {Object} Feature toggle states
 */
function getFeatureToggles() {
    // Start with defaults
    const features = {};
    for (const [key, config] of Object.entries(FEATURE_TOGGLES)) {
        features[key] = config.default;
    }

    // Apply server config overrides
    const uiConfig = getUIConfigFromServer();
    if (uiConfig.features) {
        Object.assign(features, uiConfig.features);
    }

    return features;
}

/**
 * Update the in-memory appConfig with new UI settings
 * This is called during live preview - actual save happens when user clicks Save
 * @param {string} key - 'theme', 'layout', or 'features'
 * @param {*} value - The new value
 */
function updateAppConfigUI(key, value) {
    const nextConfig = JSON.parse(JSON.stringify(getRuntimeConfig() || {}));
    if (!nextConfig.javascript_config) nextConfig.javascript_config = {};
    if (!nextConfig.javascript_config.ui) {
        nextConfig.javascript_config.ui = { ...DEFAULT_UI_CONFIG };
    }

    if (key === 'features' && typeof value === 'object') {
        nextConfig.javascript_config.ui.features = {
            ...nextConfig.javascript_config.ui.features,
            ...value
        };
    } else {
        nextConfig.javascript_config.ui[key] = value;
    }
    setRuntimeConfig(nextConfig);
}

/**
 * Apply theme to the document
 * @param {string} themeId - Theme ID to apply
 * @param {boolean} updateConfig - Whether to update in-memory config (default: true)
 */
function applyTheme(themeId, updateConfig = true) {
    const allThemes = getAvailableThemes();
    let theme = allThemes.find(t => t.id === themeId);

    // If custom theme ID but not found in list, check legacy customThemeColors fallback
    if (!theme && themeId.startsWith('custom-')) {
        const uiConfig = getUIConfigFromServer();
        if (uiConfig.customThemeColors) {
            theme = {
                id: themeId,
                custom: true,
                colors: uiConfig.customThemeColors
            };
        }
    }

    // Check if it's a custom theme
    if (theme && theme.custom && theme.colors) {
        applyCustomThemeColors(theme.colors);
        document.documentElement.setAttribute('data-theme', 'custom');

        if (updateConfig) {
            updateAppConfigUI('theme', themeId);
        }

        const metaThemeColor = $('meta[name="theme-color"]');
        if (metaThemeColor) {
            metaThemeColor.setAttribute('content', theme.colors.primary || '#2d3250');
        }

        console.log(`Custom theme applied: ${themeId}`);
        bus.emit(APP_EVENTS.THEME_CHANGED, { theme: themeId, custom: true });
        return;
    }

    if (!BUILT_IN_THEMES.some(t => t.id === themeId)) {
        console.warn(`Unknown theme: ${themeId}, falling back to dark`);
        themeId = 'dark';
    }

    clearCustomThemeColors();
    document.documentElement.setAttribute('data-theme', themeId);

    if (updateConfig) {
        updateAppConfigUI('theme', themeId);
    }

    const themeColors = {
        dark: '#2d3250',
        midnight: '#1a1a2e',
        nord: '#3b4252',
        monokai: '#272822',
        dracula: '#282a36'
    };

    const metaThemeColor = $('meta[name="theme-color"]');
    if (metaThemeColor) {
        metaThemeColor.setAttribute('content', themeColors[themeId] || themeColors.dark);
    }

    console.log(`Theme applied: ${themeId}`);
    bus.emit(APP_EVENTS.THEME_CHANGED, { theme: themeId });
}

/**
 * Apply custom theme colors to document
 * @param {Object} colors - Color values
 */
function applyCustomThemeColors(colors) {
    const root = document.documentElement;
    const resolvedColors = normalizeThemeColors(colors);

    Object.entries(getThemeCssVariables(resolvedColors)).forEach(([property, value]) => {
        root.style.setProperty(property, value);
    });
}

/**
 * Clear custom theme CSS variables (revert to stylesheet defaults)
 */
function clearCustomThemeColors() {
    const root = document.documentElement;
    THEME_CSS_VARIABLE_KEYS.forEach(property => root.style.removeProperty(property));
}

/**
 * Apply layout to the document
 * @param {string} layoutId - Layout ID to apply
 * @param {boolean} updateConfig - Whether to update in-memory config (default: true)
 */
function applyLayout(layoutId, updateConfig = true) {
    if (!AVAILABLE_LAYOUTS.some(l => l.id === layoutId)) {
        console.warn(`Unknown layout: ${layoutId}, falling back to streaming`);
        layoutId = 'streaming';
    }

    document.documentElement.setAttribute('data-layout', layoutId);

    // Update in-memory config for saving
    if (updateConfig) {
        updateAppConfigUI('layout', layoutId);
    }

    console.log(`Layout applied: ${layoutId}`);

    // Notify other modules.
    bus.emit(APP_EVENTS.LAYOUT_CHANGED, { layout: layoutId });
}

/**
 * Apply feature toggles to the document
 * @param {Object} features - Feature toggle states
 * @param {boolean} updateConfig - Whether to update in-memory config (default: true)
 */
function applyFeatureToggles(features, updateConfig = true) {
    // Apply each feature as a data attribute on html element
    for (const [key, enabled] of Object.entries(features)) {
        const attrName = `data-feature-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
        // Ensure enabled is not null/undefined before calling toString()
        const value = (enabled !== null && enabled !== undefined) ? enabled.toString() : 'false';
        document.documentElement.setAttribute(attrName, value);
    }

    // Update in-memory config for saving
    if (updateConfig) {
        updateAppConfigUI('features', features);
    }

    console.log('Feature toggles applied:', features);

    // Notify other modules.
    bus.emit(APP_EVENTS.FEATURES_CHANGED, { features });
}

/**
 * Set a single feature toggle
 * @param {string} featureKey - Feature key
 * @param {boolean} enabled - Whether feature is enabled
 */
function setFeatureToggle(featureKey, enabled) {
    const features = getFeatureToggles();
    features[featureKey] = enabled;
    applyFeatureToggles(features);
}

/**
 * Initialize theme manager
 * Applies stored/default theme and features on page load
 */
function initThemeManager() {
    console.log('Initializing Theme Manager...');

    // Apply theme (don't update config, just apply from server)
    const storedTheme = getUIConfigFromServer().theme;
    const theme = getCurrentTheme();
    // Heal orphan theme ids (e.g. a custom theme that was deleted) so the
    // in-memory config matches what's actually applied — otherwise selectors
    // bound to the stored value will show a stale id until the next save.
    if (storedTheme && storedTheme !== theme) {
        updateAppConfigUI('theme', theme);
    }
    applyTheme(theme, false);

    // Apply layout
    const layout = getCurrentLayout();
    applyLayout(layout, false);

    // Apply feature toggles
    const features = getFeatureToggles();
    applyFeatureToggles(features, false);

    console.log('Theme Manager initialized');
}

/**
 * Get configuration for UI settings section
 * @returns {Object} UI configuration for settings modal
 */
function getUIConfig() {
    return {
        theme: getCurrentTheme(),
        layout: getCurrentLayout(),
        features: getFeatureToggles()
    };
}

/**
 * Apply UI configuration from settings
 * @param {Object} config - UI configuration object
 */
function applyUIConfig(config) {
    if (config.theme) {
        applyTheme(config.theme);
    }
    if (config.layout) {
        applyLayout(config.layout);
    }
    if (config.features) {
        applyFeatureToggles(config.features);
    }
}

export {
    AVAILABLE_THEMES,
    BUILT_IN_THEMES,
    AVAILABLE_LAYOUTS,
    FEATURE_TOGGLES,
    DEFAULT_UI_CONFIG,
    getAvailableThemes,
    getCurrentTheme,
    getCurrentLayout,
    getFeatureToggles,
    applyTheme,
    applyLayout,
    applyFeatureToggles,
    setFeatureToggle,
    initThemeManager,
    getUIConfig,
    applyUIConfig,
    applyCustomThemeColors,
    clearCustomThemeColors
};
