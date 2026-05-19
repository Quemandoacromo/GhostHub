/**
 * Config Modal Module
 * Thin orchestrator that lazy-loads section modules on demand.
 * Each section (preferences, admin settings, WiFi, users, GhostStream,
 * system monitor, JS config) lives in its own file under ./sections/.
 */

import { folderIcon, uploadIcon } from '../../utils/icons.js';
import { saveConfig } from '../../utils/configManager.js';
import { openFileManager, openManageContent } from '../admin/files.js';
import { ensureFeatureAccess } from '../../utils/authManager.js';
import { initThemeBuilder } from './themeBuilder.js';
import { Module, createElement, attr, clear, append, show, hide, $, $$ } from '../../libs/ragot.esm.min.js';
import { initUsersModule, cleanupUsersModule } from '../admin/users.js';
import { toast } from '../../utils/notificationManager.js';
import { createFocusTrap } from '../../utils/focusTrap.js';

// DOM elements - lazily cached
let configModal;
let configModalBody;
let configModalCloseBtn;
let configModalCancelBtn;
let configModalSaveBtn;

// Settings mode (basic/advanced) for admin settings filtering
let currentSettingsMode = 'basic';
let configModalFocusTrap = null;
let configModalReturnFocusEl = null;

// Track loaded cleanup callbacks (e.g. system stats interval)
let sectionCleanups = [];

function parseTransitionTimeList(value = '') {
    return value
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)
        .map((part) => {
            if (part.endsWith('ms')) return Number.parseFloat(part);
            if (part.endsWith('s')) return Number.parseFloat(part) * 1000;
            const parsed = Number.parseFloat(part);
            return Number.isFinite(parsed) ? parsed : 0;
        });
}

function getMaxTransitionMs(element) {
    if (!element || typeof window === 'undefined') return 0;
    const styles = window.getComputedStyle(element);
    const durations = parseTransitionTimeList(styles.transitionDuration);
    const delays = parseTransitionTimeList(styles.transitionDelay);
    const count = Math.max(durations.length, delays.length);
    let maxMs = 0;

    for (let i = 0; i < count; i += 1) {
        const duration = durations[i] ?? durations[durations.length - 1] ?? 0;
        const delay = delays[i] ?? delays[delays.length - 1] ?? 0;
        maxMs = Math.max(maxMs, duration + delay);
    }

    return maxMs;
}

function runAfterModalClose(elements, callback) {
    if (typeof callback !== 'function') return;

    const modalEl = elements?.configModal;
    const modalContent = $('.modal__content', modalEl) || modalEl;
    const waitMs = Math.max(
        getMaxTransitionMs(modalEl),
        getMaxTransitionMs(modalContent)
    );

    if (waitMs <= 0) {
        requestAnimationFrame(() => callback());
        return;
    }

    let settled = false;
    const finish = () => {
        if (settled) return;
        settled = true;
        if (modalContent) modalContent.removeEventListener('transitionend', onTransitionEnd);
        callback();
    };
    const onTransitionEnd = (event) => {
        if (event.target !== modalContent) return;
        finish();
    };

    if (modalContent) {
        modalContent.addEventListener('transitionend', onTransitionEnd);
    }
    window.setTimeout(finish, waitMs + 40);
}

function getIsAdminForModal() {
    return window.ragotModules?.appStore?.get?.('isAdmin') === true;
}

function getRuntimeConfig() {
    return window.ragotModules?.appStore?.get?.('config', {}) || {};
}

function getAppSocket() {
    return window.ragotModules?.appStore?.get?.('socket', null) || null;
}

async function refreshAdminFlagForModal() {
    try {
        const resp = await fetch('/api/admin/status', { cache: 'no-store' });
        if (!resp.ok) return;
        const data = await resp.json();
        if (typeof data?.isAdmin === 'boolean') {
            window.ragotModules?.appStore?.set?.('isAdmin', data.isAdmin);
        }
    } catch (e) {
        // Keep last known role on transient failures.
    }
}

class ConfigModalLifecycle extends Module {
    constructor() {
        super();
        this._overlayClickHandler = (e) => {
            const elements = ensureDOMElementsInitialized();
            if (e.target === elements.configModal) {
                closeConfigModal();
            }
        };
        this._escapeHandler = (e) => {
            if (e.key === 'Escape' && configModal && !configModal.classList.contains('hidden')) {
                closeConfigModal();
            }
        };
    }

    onStart() {
        const elements = ensureDOMElementsInitialized();

        // Initialize theme builder once listeners are ready
        initThemeBuilder();

        // config toggle button is owned by ui/controller.js
        if (elements.configModalCloseBtn) this.on(elements.configModalCloseBtn, 'click', closeConfigModal);
        if (elements.configModalCancelBtn) this.on(elements.configModalCancelBtn, 'click', closeConfigModal);
        if (elements.configModalSaveBtn) this.on(elements.configModalSaveBtn, 'click', handleSaveConfig);
        if (elements.configModal) this.on(elements.configModal, 'click', this._overlayClickHandler);
        this.on(document, 'keydown', this._escapeHandler);
        this.on(document, 'ghosthub:theme-builder-opened', suspendConfigModalFocusTrap);
        this.on(document, 'ghosthub:theme-builder-closed', resumeConfigModalFocusTrap);
    }
}

let configModalLifecycle = null;

/**
 * Ensures DOM element references are cached.
 */
function ensureDOMElementsInitialized() {
    configModal = configModal || $('#config-modal');
    configModalBody = configModalBody || $('#config-modal-body');
    configModalCloseBtn = configModalCloseBtn || $('#config-modal-close-btn');
    configModalCancelBtn = configModalCancelBtn || $('#config-modal-cancel-btn');
    configModalSaveBtn = configModalSaveBtn || $('#config-modal-save-btn');

    return {
        configModal,
        configModalBody,
        configModalCloseBtn,
        configModalCancelBtn,
        configModalSaveBtn
    };
}

/**
 * Updates the modal footer buttons based on admin status.
 */
function updateConfigModalFooterButtons() {
    const elements = ensureDOMElementsInitialized();
    const isAdmin = getIsAdminForModal();

    if (!elements.configModalCancelBtn || !elements.configModalSaveBtn) return;

    if (isAdmin) {
        show(elements.configModalSaveBtn);
        elements.configModalSaveBtn.disabled = false;
        elements.configModalCancelBtn.textContent = 'Cancel';
        elements.configModalCancelBtn.classList.remove('btn--primary');
        elements.configModalCancelBtn.classList.add('btn--secondary');
        return;
    }

    hide(elements.configModalSaveBtn);
    elements.configModalSaveBtn.disabled = true;
    elements.configModalCancelBtn.textContent = 'Close';
    elements.configModalCancelBtn.classList.remove('btn--secondary');
    elements.configModalCancelBtn.classList.add('btn--primary');
}

/**
 * Builds the Content Tools button (Upload for guests, Manage Content for admins).
 */
function buildContentToolsSection() {
    const container = createElement('div', { className: 'config-file-manager-section' });
    const isAdmin = getIsAdminForModal();
    const isPasswordActive = getRuntimeConfig()?.isPasswordProtectionActive;

    const buttonText = isAdmin ? 'Content Management' : 'File Upload';
    const buttonIcon = isAdmin ? folderIcon(18) : uploadIcon(18);

    const hintText = isAdmin
        ? 'Upload, browse, rename, delete, and hide media files'
        : (isPasswordActive ? 'Upload files (Session Password required)' : 'Upload files to connected USB drives');

    append(container,
        createElement('button', {
            id: 'config-content-btn',
            className: 'btn btn--primary config-file-manager-btn',
            innerHTML: `${buttonIcon} ${buttonText}`
        }),
        createElement('p', {
            className: 'config-file-manager-hint',
            textContent: hintText
        })
    );

    const contentBtn = $('#config-content-btn', container);
    if (contentBtn) {
        attr(contentBtn, {
            onClick: async (e) => {
                e.preventDefault();
                const accessGranted = await ensureFeatureAccess();
                if (accessGranted) {
                    closeConfigModal();
                    if (isAdmin) {
                        openManageContent();
                    } else {
                        openFileManager();
                    }
                }
            }
        });
    }

    return container;
}

/**
 * Populates the configuration modal by lazy-loading section modules.
 */
async function populateConfigModal() {
    const elements = ensureDOMElementsInitialized();

    if (!elements.configModalBody) {
        console.error('Config modal body element not found');
        return;
    }

    const body = elements.configModalBody;
    if (!getRuntimeConfig() || Object.keys(getRuntimeConfig()).length === 0) {
        clear(body);
        append(body, createElement('p', { textContent: 'Configuration not yet loaded. Please try again shortly.' }));
        return;
    }

    clear(body);

    // Reset section cleanups (prevents duplicates on re-populate)
    for (const cleanup of sectionCleanups) {
        try { cleanup(); } catch (e) { /* ignore */ }
    }
    sectionCleanups = [];

    // --- Content Tools (always shown) ---
    append(body, buildContentToolsSection());

    // --- User Preferences (always shown, lazy-loaded) ---
    const { createUserPreferencesSection } = await import('./sections/preferencesSection.js');
    const userPrefsSection = createUserPreferencesSection(closeConfigModal);
    append(body, userPrefsSection);
    if (typeof userPrefsSection.__cleanup === 'function') {
        sectionCleanups.push(userPrefsSection.__cleanup);
    }

    // --- Admin-only sections ---
    if (getIsAdminForModal()) {
        // Divider
        append(body, createElement('hr', { className: 'admin-settings-divider' }));

        // Server Settings Header
        append(body, createElement('h2', {
            className: 'admin-settings-header',
            textContent: 'Server Settings',
        }));

        // Load all admin sections in parallel
        const [
            { createSettingsModeToggle, createAdminSettingsSection },
            { createWifiSettingsSection },
            { createUsersManagementSection },
            { createGhostStreamSection, reloadGhostStreamPreferences },
            { createSystemMonitorSection, cleanupSystemMonitorSection },
            { createJsConfigSections }
        ] = await Promise.all([
            import('./sections/adminSettingsSection.js'),
            import('./sections/wifiSection.js'),
            import('./sections/usersSection.js'),
            import('./sections/ghoststreamSection.js'),
            import('./sections/systemMonitorSection.js'),
            import('./sections/jsConfigSection.js')
        ]);

        // Register cleanup for system monitor lifecycle/timers
        sectionCleanups.push(cleanupSystemMonitorSection);

        // Basic/Advanced toggle
        append(body, createSettingsModeToggle(currentSettingsMode, (newMode) => {
            currentSettingsMode = newMode;
            populateConfigModal();
        }));

        // App/Media Settings (Python config)
        const adminSettingsSection = createAdminSettingsSection(currentSettingsMode, closeConfigModal);
        append(body, adminSettingsSection);
        if (typeof adminSettingsSection.__cleanup === 'function') {
            sectionCleanups.push(adminSettingsSection.__cleanup);
        }

        // WiFi
        append(body, createWifiSettingsSection());

        // Users Management
        append(body, createUsersManagementSection());
        initUsersModule(getAppSocket());
        sectionCleanups.push(cleanupUsersModule);

        // GhostStream
        append(body, createGhostStreamSection(currentSettingsMode));

        // System Monitor
        append(body, createSystemMonitorSection());

        // JavaScript Config Sections
        append(body, createJsConfigSections(currentSettingsMode));

        // Reload GhostStream preferences after DOM is ready
        setTimeout(reloadGhostStreamPreferences, 50);
    }
}

/**
 * Opens the configuration modal and populates it.
 */
async function openConfigModal() {
    const elements = ensureDOMElementsInitialized();

    if (!elements.configModal || !elements.configModalBody) {
        console.error('Config modal elements not found');
        return;
    }

    configModalReturnFocusEl = document.activeElement;

    // Show modal with loading state
    const modalContent = $('.modal__content', elements.configModal) || elements.configModal;
    attr(modalContent, {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Settings'
    });
    elements.configModal.classList.remove('hidden');
    clear(elements.configModalBody);
    append(elements.configModalBody, createElement('p', {
        className: 'config-modal-loading',
        textContent: 'Loading settings...'
    }));

    // Ensure admin sections are rendered from live status, not stale config snapshot.
    await refreshAdminFlagForModal();
    updateConfigModalFooterButtons();

    // Load saved settings mode preference
    currentSettingsMode = getRuntimeConfig()?.python_config?.UI_SETTINGS_MODE || 'basic';
    console.log(`Loaded settings mode preference: ${currentSettingsMode}`);

    // Populate (async - lazy loads sections)
    await populateConfigModal();

    configModalFocusTrap?.deactivate({ restoreFocus: false });
    configModalFocusTrap = createFocusTrap(modalContent, {
        initialFocus: () =>
            elements.configModalBody.querySelector('button, input, select, textarea, [tabindex]:not([tabindex="-1"])') ||
            elements.configModalCloseBtn,
        returnFocusTo: configModalReturnFocusEl
    });
    requestAnimationFrame(() => configModalFocusTrap?.activate());
}

/**
 * Initializes the config modal event listeners.
 */
function initConfigModal() {
    ensureDOMElementsInitialized();
    if (!configModalLifecycle) {
        configModalLifecycle = new ConfigModalLifecycle();
    }
    configModalLifecycle.start();
    updateConfigModalFooterButtons();
}

/**
 * Closes the configuration modal and runs section cleanups.
 */
function closeConfigModal(options = {}) {
    const { afterClose = null, restoreFocus = true } = options;
    const elements = ensureDOMElementsInitialized();
    configModalFocusTrap?.deactivate({ restoreFocus });
    configModalFocusTrap = null;
    if (elements.configModal) {
        elements.configModal.classList.add('hidden');
    }

    // Run any registered cleanup callbacks (e.g. stop system stats polling)
    for (const cleanup of sectionCleanups) {
        try { cleanup(); } catch (e) { /* ignore */ }
    }

    runAfterModalClose(elements, afterClose);
}

function suspendConfigModalFocusTrap() {
    configModalFocusTrap?.deactivate({ restoreFocus: false });
}

function resumeConfigModalFocusTrap() {
    if (!configModalFocusTrap) {
        return;
    }

    const elements = ensureDOMElementsInitialized();
    if (elements.configModal?.classList.contains('hidden')) {
        return;
    }

    configModalFocusTrap.activate();
}

/**
 * Handles saving the configuration.
 */
async function handleSaveConfig() {
    if (!getIsAdminForModal()) {
        closeConfigModal();
        return;
    }

    const newConfig = JSON.parse(JSON.stringify(getRuntimeConfig() || { python_config: {}, javascript_config: {} }));

    const body = ensureDOMElementsInitialized().configModalBody;
    const inputs = $$('[data-path]', body);
    inputs.forEach(input => {
        const path = input.dataset.path.split('.');
        let currentLevel = newConfig;

        for (let i = 0; i < path.length - 1; i++) {
            currentLevel = currentLevel[path[i]] = currentLevel[path[i]] || {};
        }

        const key = path[path.length - 1];
        if (input.type === 'checkbox') {
            currentLevel[key] = input.checked;
        } else if (input.type === 'number') {
            currentLevel[key] = parseFloat(input.value);
        } else {
            currentLevel[key] = input.value;
        }
    });

    // Save the current settings mode preference
    if (!newConfig.python_config) {
        newConfig.python_config = {};
    }
    newConfig.python_config.UI_SETTINGS_MODE = currentSettingsMode;
    console.log(`Saving settings mode preference: ${currentSettingsMode}`);

    try {
        const elements = ensureDOMElementsInitialized();
        if (elements.configModalSaveBtn) {
            elements.configModalSaveBtn.textContent = 'Saving...';
            elements.configModalSaveBtn.disabled = true;
        }

        const result = await saveConfig(newConfig);
        toast.success(result.message || 'Settings saved successfully! Some changes may require a page reload or app restart.');
        closeConfigModal();
    } catch (error) {
        console.error('Failed to save configuration:', error);
        toast.error(`Error saving settings: ${error.message || 'Unknown error'}`);
    } finally {
        const elements = ensureDOMElementsInitialized();
        if (elements.configModalSaveBtn) {
            elements.configModalSaveBtn.textContent = 'Save Changes';
            elements.configModalSaveBtn.disabled = false;
        }
    }
}

export {
    initConfigModal,
    openConfigModal,
    suspendConfigModalFocusTrap,
    resumeConfigModalFocusTrap
};
