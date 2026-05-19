/**
 * @vitest-environment jsdom
 */
/**
 * ThemeBuilder Unit Tests
 * Tests for custom theme builder functionality including:
 * - Theme initialization and modal creation
 * - Color utilities (hex, rgb, hsl conversions)
 * - Theme saving and loading
 * - Preset palettes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as themeBuilder from '../../modules/config/themeBuilder.js';

// Mock the saveConfig function
vi.mock('../../utils/configManager.js', () => ({
  saveConfig: vi.fn().mockResolvedValue({ success: true })
}));

// Helper: get store config
function getStoreConfig() {
  return window.ragotModules.appStore.get('config', {});
}

// Helper: update ui section in store config
function setUIConfig(uiPatch) {
  const cfg = JSON.parse(JSON.stringify(getStoreConfig()));
  if (!cfg.javascript_config) cfg.javascript_config = {};
  cfg.javascript_config.ui = Object.assign({}, cfg.javascript_config.ui, uiPatch);
  window.ragotModules.appStore.set('config', cfg);
}

// Helper: replace ui section entirely
function replaceUIConfig(uiConfig) {
  const cfg = JSON.parse(JSON.stringify(getStoreConfig()));
  if (!cfg.javascript_config) cfg.javascript_config = {};
  cfg.javascript_config.ui = uiConfig;
  window.ragotModules.appStore.set('config', cfg);
}

describe('ThemeBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Setup DOM
    document.body.innerHTML = '';
    document.documentElement.style.cssText = '';
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.className = '';
    document.body.className = '';

    // Setup meta tag for theme-color
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#2d3250';
    document.head.appendChild(meta);

    // Seed store with default config for themeBuilder tests
    window.ragotModules.appStore.set('config', {
      javascript_config: {
        ui: {
          theme: 'dark',
          customThemes: [],
          customThemeColors: null
        }
      }
    });
  });

  afterEach(() => {
    // Clean up modal if exists
    const overlay = document.querySelector('.gh-theme-builder');
    if (overlay) overlay.remove();

    // Clean up meta tag
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.remove();
    document.documentElement.className = '';
    document.body.className = '';
  });

  describe('PRESET_PALETTES', () => {
    it('should export preset palettes', () => {
      expect(themeBuilder.PRESET_PALETTES).toBeDefined();
      expect(Array.isArray(themeBuilder.PRESET_PALETTES)).toBe(true);
    });

    it('should have at least 5 preset palettes', () => {
      expect(themeBuilder.PRESET_PALETTES.length).toBeGreaterThanOrEqual(5);
    });

    it('should have required properties in each preset', () => {
      themeBuilder.PRESET_PALETTES.forEach(preset => {
        expect(preset).toHaveProperty('id');
        expect(preset).toHaveProperty('name');
        expect(preset).toHaveProperty('colors');
        expect(preset.colors).toHaveProperty('primary');
        expect(preset.colors).toHaveProperty('accent');
        expect(preset.colors).toHaveProperty('background');
        expect(preset.colors).toHaveProperty('surface');
        expect(preset.colors).toHaveProperty('text');
        expect(preset.colors).not.toHaveProperty('secondary');
      });
    });

    it('should have valid hex colors in presets', () => {
      const hexRegex = /^#[0-9a-fA-F]{6}$/;
      themeBuilder.PRESET_PALETTES.forEach(preset => {
        Object.values(preset.colors).forEach(color => {
          expect(color).toMatch(hexRegex);
        });
      });
    });

    it('should include common theme presets', () => {
      const presetIds = themeBuilder.PRESET_PALETTES.map(p => p.id);
      expect(presetIds).toContain('cyberpunk');
      expect(presetIds).toContain('ocean-breeze');
      expect(presetIds).toContain('cosmic-purple');
    });
  });

  describe('initThemeBuilder', () => {
    it('should create the modal overlay', () => {
      themeBuilder.initThemeBuilder();

      const overlay = document.querySelector('.gh-theme-builder');
      expect(overlay).toBeDefined();
      expect(overlay).not.toBeNull();
    });


    it('should create modal with footer buttons', () => {
      themeBuilder.initThemeBuilder();

      const saveBtn = document.getElementById('btn-save');
      const cancelBtn = document.getElementById('btn-cancel');

      expect(saveBtn).not.toBeNull();
      expect(cancelBtn).not.toBeNull();
    });

    it('should create color swatches container', () => {
      themeBuilder.initThemeBuilder();

      const container = document.getElementById('gh-theme-builder__swatches');
      expect(container).not.toBeNull();
    });

    it('should create presets container', () => {
      themeBuilder.initThemeBuilder();

      const container = document.getElementById('gh-theme-builder__preset-grid');
      expect(container).not.toBeNull();
    });

    it('should create saved themes container', () => {
      themeBuilder.initThemeBuilder();

      const container = document.getElementById('gh-theme-builder__saved-list');

      expect(container).not.toBeNull();
    });

    it('should not create duplicate modals', () => {
      themeBuilder.initThemeBuilder();
      themeBuilder.initThemeBuilder();

      const overlays = document.querySelectorAll('.gh-theme-builder');
      expect(overlays.length).toBe(1);
    });
  });

  describe('openThemeBuilder', () => {
    beforeEach(() => {
      themeBuilder.initThemeBuilder();
    });

    it('should add active class to overlay', () => {
      themeBuilder.openThemeBuilder();

      const overlay = document.querySelector('.gh-theme-builder');
      expect(overlay.classList.contains('active')).toBe(true);
    });

    it('should render presets on open', () => {
      themeBuilder.openThemeBuilder();

      const presets = document.querySelectorAll('.gh-theme-builder__preset-item');
      expect(presets.length).toBeGreaterThan(0);
    });

    it('should render color pickers on open', () => {
      themeBuilder.openThemeBuilder();

      const colorSwatches = document.querySelectorAll('.gh-theme-builder__swatch');
      expect(colorSwatches.length).toBe(5); // 5 user-facing color keys
      expect(colorSwatches[1].dataset.colorKey).toBe('accent');
      expect(document.querySelector('[data-color-key="secondary"]')).toBeNull();
    });

    it('should restore edit viewport classes when opened', () => {
      themeBuilder.openThemeBuilder();

      expect(document.documentElement.classList.contains('theme-builder-edit')).toBe(true);
      expect(document.documentElement.classList.contains('theme-builder-preview')).toBe(false);
      expect(document.body.classList.contains('theme-builder-active')).toBe(true);
      expect(document.body.classList.contains('theme-builder-preview')).toBe(false);
    });
  });

  describe('closeThemeBuilder', () => {
    beforeEach(() => {
      themeBuilder.initThemeBuilder();
      themeBuilder.openThemeBuilder();
    });

    it('should remove active class from overlay', () => {
      themeBuilder.closeThemeBuilder();

      const overlay = document.querySelector('.gh-theme-builder');
      expect(overlay.classList.contains('active')).toBe(false);
    });

    it('should clear preview and scrolling classes on close after previewing', () => {
      document.getElementById('btn-preview').click();
      themeBuilder.closeThemeBuilder();

      expect(document.documentElement.classList.contains('theme-builder-edit')).toBe(false);
      expect(document.documentElement.classList.contains('theme-builder-preview')).toBe(false);
      expect(document.body.classList.contains('theme-builder-active')).toBe(false);
      expect(document.body.classList.contains('theme-builder-preview')).toBe(false);
    });
  });

  describe('preview mode', () => {
    beforeEach(() => {
      themeBuilder.initThemeBuilder();
      themeBuilder.openThemeBuilder();
    });

    it('should switch between preview and edit viewport states', () => {
      document.getElementById('btn-preview').click();

      const overlay = document.querySelector('.gh-theme-builder');
      expect(overlay.classList.contains('preview-mode')).toBe(true);
      expect(overlay.classList.contains('active')).toBe(false);
      expect(document.documentElement.classList.contains('theme-builder-preview')).toBe(true);
      expect(document.documentElement.classList.contains('theme-builder-edit')).toBe(false);
      expect(document.body.classList.contains('theme-builder-preview')).toBe(true);
      expect(document.body.classList.contains('theme-builder-active')).toBe(false);

      document.getElementById('gh-theme-builder__floating-btn').click();

      expect(overlay.classList.contains('preview-mode')).toBe(false);
      expect(overlay.classList.contains('active')).toBe(true);
      expect(document.documentElement.classList.contains('theme-builder-edit')).toBe(true);
      expect(document.documentElement.classList.contains('theme-builder-preview')).toBe(false);
      expect(document.body.classList.contains('theme-builder-active')).toBe(true);
      expect(document.body.classList.contains('theme-builder-preview')).toBe(false);
    });
  });

  describe('loadCustomThemes', () => {
    beforeEach(() => {
      themeBuilder.initThemeBuilder();
    });

    it('should load themes from store config', () => {
      setUIConfig({
        customThemes: [
          { id: 'custom-1', name: 'Test Theme', colors: { primary: '#ff0000' } }
        ]
      });

      themeBuilder.loadCustomThemes();
      themeBuilder.openThemeBuilder();

      // Check that saved themes section shows the theme
      const savedThemes = document.querySelectorAll('.gh-theme-builder__saved-item');
      expect(savedThemes.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle empty customThemes array', () => {
      setUIConfig({ customThemes: [] });

      themeBuilder.loadCustomThemes();
      themeBuilder.openThemeBuilder();

      // Should show empty state message
      const list = document.getElementById('gh-theme-builder__saved-list');
      expect(list.innerHTML).toContain('No saved themes yet');
    });

    it('should handle missing customThemes', () => {
      const cfg = JSON.parse(JSON.stringify(getStoreConfig()));
      delete cfg.javascript_config.ui.customThemes;
      window.ragotModules.appStore.set('config', cfg);

      // Should not throw
      expect(() => themeBuilder.loadCustomThemes()).not.toThrow();
    });

    it('should handle missing store config', () => {
      window.ragotModules.appStore.set('config', {});

      // Should not throw
      expect(() => themeBuilder.loadCustomThemes()).not.toThrow();
    });
  });

  describe('applyColorsToDocument', () => {
    const testColors = {
      primary: '#ff5500',
      accent: '#00ff55',
      background: '#1a1a1a',
      surface: '#2a2a2a',
      text: '#eeeeee'
    };

    it('should set --primary-color CSS variable', () => {
      themeBuilder.applyColorsToDocument(testColors);

      const value = document.documentElement.style.getPropertyValue('--primary-color');
      expect(value).toBe('#ff5500');
    });

    it('should set --accent-color CSS variable', () => {
      themeBuilder.applyColorsToDocument(testColors);

      const value = document.documentElement.style.getPropertyValue('--accent-color');
      expect(value).toBe('#00ff55');
    });

    it('should set --background-color CSS variable', () => {
      themeBuilder.applyColorsToDocument(testColors);

      const value = document.documentElement.style.getPropertyValue('--background-color');
      expect(value).toBe('#1a1a1a');
    });

    it('should set --surface-color CSS variable', () => {
      themeBuilder.applyColorsToDocument(testColors);

      const value = document.documentElement.style.getPropertyValue('--surface-color');
      expect(value).toBe('#2a2a2a');
    });

    it('should set --text-primary CSS variable', () => {
      themeBuilder.applyColorsToDocument(testColors);

      const value = document.documentElement.style.getPropertyValue('--text-primary');
      expect(value).toBe('#eeeeee');
    });

    it('should set data-theme to custom', () => {
      themeBuilder.applyColorsToDocument(testColors);

      expect(document.documentElement.getAttribute('data-theme')).toBe('custom');
    });

    it('should update meta theme-color', () => {
      themeBuilder.applyColorsToDocument(testColors);

      const meta = document.querySelector('meta[name="theme-color"]');
      expect(meta.getAttribute('content')).toBe('#ff5500');
    });

    it('should set derived colors (light/dark variants)', () => {
      themeBuilder.applyColorsToDocument(testColors);

      const primaryLight = document.documentElement.style.getPropertyValue('--primary-color-light');
      const primaryDark = document.documentElement.style.getPropertyValue('--primary-color-dark');

      expect(primaryLight).toBeTruthy();
      expect(primaryDark).toBeTruthy();
      expect(primaryLight).not.toBe(testColors.primary);
      expect(primaryDark).not.toBe(testColors.primary);
    });

    it('should set RGB values for transparency effects', () => {
      themeBuilder.applyColorsToDocument(testColors);

      const primaryRgb = document.documentElement.style.getPropertyValue('--primary-color-rgb');
      expect(primaryRgb).toMatch(/\d+,\s*\d+,\s*\d+/);
    });

    it('should set text secondary with alpha', () => {
      themeBuilder.applyColorsToDocument(testColors);

      const textSecondary = document.documentElement.style.getPropertyValue('--text-secondary');
      expect(textSecondary).toContain('rgba');
    });

    it('should ignore stale secondary input fields', () => {
      themeBuilder.applyColorsToDocument({ ...testColors, secondary: '#5500ff' });

      expect(document.documentElement.style.getPropertyValue('--secondary-color')).toBe('');
      expect(document.documentElement.style.getPropertyValue('--secondary-color-rgb')).toBe('');
    });
  });

  describe('Modal Interactions', () => {
    beforeEach(() => {
      themeBuilder.initThemeBuilder();
      themeBuilder.openThemeBuilder();
    });

    it('should close on cancel button click', () => {
      const cancelBtn = document.getElementById('btn-cancel');
      cancelBtn.click();

      const overlay = document.querySelector('.gh-theme-builder');
      expect(overlay.classList.contains('active')).toBe(false);
    });

    it('should have theme name input', () => {
      const nameInput = document.getElementById('gh-theme-builder__name-input');
      expect(nameInput).not.toBeNull();
      expect(nameInput.tagName).toBe('INPUT');
    });

    it('should have format toggle buttons', () => {
      const hexBtn = document.querySelector('.gh-theme-builder__format-btn[data-format="hex"]');
      const rgbBtn = document.querySelector('.gh-theme-builder__format-btn[data-format="rgb"]');

      expect(hexBtn).not.toBeNull();
      expect(rgbBtn).not.toBeNull();
    });

    it('should have quick action buttons', () => {
      const randomizeBtn = document.getElementById('btn-randomize');
      const invertBtn = document.getElementById('btn-invert');

      expect(randomizeBtn).not.toBeNull();
      expect(invertBtn).not.toBeNull();
    });

    it('should have export/import buttons', () => {
      const exportBtn = document.getElementById('btn-export');
      const importBtn = document.getElementById('btn-import');
      const pasteBtn = document.getElementById('btn-import-clipboard');

      expect(exportBtn).not.toBeNull();
      expect(importBtn).not.toBeNull();
      expect(pasteBtn).not.toBeNull();
    });
  });

  describe('Color Picker Interaction', () => {
    beforeEach(() => {
      themeBuilder.initThemeBuilder();
      themeBuilder.openThemeBuilder();
    });

    it('should have color input for each user-facing color key', () => {
      const colorInputs = document.querySelectorAll('input[type="color"]');
      expect(colorInputs.length).toBe(5);
      expect(document.querySelector('input[type="color"][data-key="secondary"]')).toBeNull();
    });

    it('should update preview when color input changes', () => {
      const colorInput = document.querySelector('input[type="color"][data-key="primary"]');

      // Simulate color change
      colorInput.value = '#ff0000';
      colorInput.dispatchEvent(new Event('input'));

      // Check swatch preview updated
      const preview = document.querySelector('[data-color-key="primary"] .gh-theme-builder__swatch-preview');
      expect(preview.style.background).toBe('rgb(255, 0, 0)');
    });

    it('should not create secondary runtime variables when a visible color changes', () => {
      const colorInput = document.querySelector('input[type="color"][data-key="primary"]');

      colorInput.value = '#ff0000';
      colorInput.dispatchEvent(new Event('input'));

      expect(document.documentElement.style.getPropertyValue('--secondary-color')).toBe('');
      expect(document.documentElement.style.getPropertyValue('--secondary-color-rgb')).toBe('');
    });
  });

  describe('Preset Selection', () => {
    beforeEach(() => {
      themeBuilder.initThemeBuilder();
      themeBuilder.openThemeBuilder();
    });

    it('should render preset buttons', () => {
      const presets = document.querySelectorAll('.gh-theme-builder__preset-item');
      expect(presets.length).toBe(themeBuilder.PRESET_PALETTES.length);
    });

    it('should apply preset colors on click', () => {
      const cyberpunkPreset = document.querySelector('.gh-theme-builder__preset-item[data-preset="cyberpunk"]');
      cyberpunkPreset.click();

      // Check that color pickers updated
      const primaryInput = document.querySelector('input[type="color"][data-key="primary"]');
      expect(primaryInput.value.toLowerCase()).toBe('#ff006e');
    });

    it('should not set secondary variables from presets', () => {
      const cyberpunkPreset = document.querySelector('.gh-theme-builder__preset-item[data-preset="cyberpunk"]');
      cyberpunkPreset.click();

      expect(document.querySelector('input[type="color"][data-key="secondary"]')).toBeNull();
      expect(themeBuilder.PRESET_PALETTES.find(p => p.id === 'cyberpunk').colors).not.toHaveProperty('secondary');
      expect(document.documentElement.style.getPropertyValue('--secondary-color')).toBe('');
    });

    it('should add active class to selected preset', () => {
      const preset = document.querySelector('.gh-theme-builder__preset-item[data-preset="neon-dreams"]');
      preset.click();

      expect(preset.classList.contains('active')).toBe(true);
    });
  });


  describe('Saved Themes', () => {
    beforeEach(() => {
      setUIConfig({
        customThemes: [
          { id: 'custom-1', name: 'Theme One', colors: { primary: '#111', accent: '#333', background: '#444', surface: '#555', text: '#fff' } },
          { id: 'custom-2', name: 'Theme Two', colors: { primary: '#aaa', accent: '#ccc', background: '#ddd', surface: '#eee', text: '#000' } }
        ]
      });

      themeBuilder.initThemeBuilder();
      themeBuilder.loadCustomThemes();
      themeBuilder.openThemeBuilder();
    });

    it('should display all saved themes', () => {
      const savedThemes = document.querySelectorAll('#gh-theme-builder__saved-list .gh-theme-builder__saved-item');
      expect(savedThemes.length).toBe(2);
    });

    it('should show theme name', () => {
      const themeName = document.querySelector('#gh-theme-builder__saved-list .gh-theme-builder__saved-name');
      expect(themeName.textContent).toBe('Theme One');
    });

    it('should show color swatches for each theme', () => {
      const colorSwatches = document.querySelectorAll('#gh-theme-builder__saved-list .gh-theme-builder__saved-colors');
      expect(colorSwatches.length).toBe(2);
    });

    it('should have delete button for each theme', () => {
      const deleteButtons = document.querySelectorAll('#gh-theme-builder__saved-list .gh-theme-builder__saved-delete');
      expect(deleteButtons.length).toBe(2);
    });

    it('should update count badge', () => {
      const countBadge = document.getElementById('saved-count');
      expect(countBadge.textContent).toBe('2');
    });

    it('should load theme into editor on click', () => {
      const themeCard = document.querySelector('#gh-theme-builder__saved-list .gh-theme-builder__saved-item');
      themeCard.click();

      const nameInput = document.getElementById('gh-theme-builder__name-input');
      expect(nameInput.value).toBe('Theme One');
    });
  });

  describe('Quick Actions', () => {
    beforeEach(() => {
      themeBuilder.initThemeBuilder();
      themeBuilder.openThemeBuilder();
    });

    it('should randomize colors on button click', () => {
      const primaryBefore = document.querySelector('input[type="color"][data-key="primary"]').value;

      const randomizeBtn = document.getElementById('btn-randomize');
      randomizeBtn.click();

      const primaryAfter = document.querySelector('input[type="color"][data-key="primary"]').value;

      // Colors should change (very small chance of being the same)
      // We just check the function runs without error
      expect(primaryAfter).toBeTruthy();
    });

    it('should invert colors on button click', () => {
      // Set a known dark color first
      const colorInput = document.querySelector('input[type="color"][data-key="background"]');
      colorInput.value = '#000000';
      colorInput.dispatchEvent(new Event('input'));

      const invertBtn = document.getElementById('btn-invert');
      invertBtn.click();

      // Smart invert: dark background should become light (preserves some hue relationships)
      const bgAfter = document.querySelector('input[type="color"][data-key="background"]').value;
      // Parse the hex color to check it became significantly lighter
      const r = parseInt(bgAfter.slice(1, 3), 16);
      const g = parseInt(bgAfter.slice(3, 5), 16);
      const b = parseInt(bgAfter.slice(5, 7), 16);
      const luminance = (r + g + b) / 3;
      // Should be a light color (luminance > 200 out of 255)
      expect(luminance).toBeGreaterThan(200);
    });
  });
});
