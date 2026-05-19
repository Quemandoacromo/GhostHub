/**
 * ThemeManager Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as themeManager from '../../utils/themeManager.js';
import { bus } from '../../libs/ragot.esm.min.js';
import { APP_EVENTS } from '../../core/appEvents.js';

// Helper: get the store config (mutable reference via set)
function getStoreConfig() {
  return window.ragotModules.appStore.get('config', {});
}

// Helper: update store config with a deep merge patch on javascript_config.ui
function setUIConfig(uiPatch) {
  const cfg = JSON.parse(JSON.stringify(getStoreConfig()));
  if (!cfg.javascript_config) cfg.javascript_config = {};
  cfg.javascript_config.ui = Object.assign({}, cfg.javascript_config.ui, uiPatch);
  window.ragotModules.appStore.set('config', cfg);
}

// Helper: replace javascript_config.ui entirely
function replaceUIConfig(uiConfig) {
  const cfg = JSON.parse(JSON.stringify(getStoreConfig()));
  if (!cfg.javascript_config) cfg.javascript_config = {};
  cfg.javascript_config.ui = uiConfig;
  window.ragotModules.appStore.set('config', cfg);
}

// Helper: clear the store config entirely (simulate no config)
function clearStoreConfig() {
  window.ragotModules.appStore.set('config', {});
}

describe('ThemeManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset document attributes
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-layout');
    document.documentElement.removeAttribute('data-feature-chat');

    // Reset store config to default state (setup.js beforeEach does this too,
    // but we set it explicitly here so tests in this file are self-contained)
    window.ragotModules.appStore.set('config', {
      javascript_config: {
        ui: {
          theme: 'dark',
          layout: 'streaming',
          features: {
            chat: true,
            syncButton: true,
            headerBranding: true
          }
        }
      }
    });
  });

  describe('Constants', () => {
    it('should export available themes', () => {
      expect(themeManager.AVAILABLE_THEMES).toBeDefined();
      expect(themeManager.AVAILABLE_THEMES.length).toBe(5);
      expect(themeManager.AVAILABLE_THEMES.map(t => t.id)).toContain('dark');
      expect(themeManager.AVAILABLE_THEMES.map(t => t.id)).toContain('dracula');
    });

    it('should export available layouts', () => {
      expect(themeManager.AVAILABLE_LAYOUTS).toBeDefined();
      expect(themeManager.AVAILABLE_LAYOUTS.length).toBe(2);
      expect(themeManager.AVAILABLE_LAYOUTS.map(l => l.id)).toContain('streaming');
      expect(themeManager.AVAILABLE_LAYOUTS.map(l => l.id)).toContain('gallery');
    });

    it('should export feature toggles with defaults', () => {
      expect(themeManager.FEATURE_TOGGLES).toBeDefined();
      expect(themeManager.FEATURE_TOGGLES.chat.default).toBe(true);
      expect(themeManager.FEATURE_TOGGLES.syncButton.default).toBe(true);
      expect(themeManager.FEATURE_TOGGLES.headerBranding.default).toBe(true);
      expect(themeManager.FEATURE_TOGGLES.search.default).toBe(true);
    });
  });

  describe('getCurrentTheme', () => {
    it('should return theme from server config', () => {
      setUIConfig({ theme: 'nord' });
      expect(themeManager.getCurrentTheme()).toBe('nord');
    });

    it('should return dark as fallback for unknown theme', () => {
      setUIConfig({ theme: 'unknown-theme' });
      expect(themeManager.getCurrentTheme()).toBe('dark');
    });

    it('should return dark when no config exists', () => {
      clearStoreConfig();
      expect(themeManager.getCurrentTheme()).toBe('dark');
    });
  });

  describe('getCurrentLayout', () => {
    it('should return layout from server config', () => {
      setUIConfig({ layout: 'streaming' });
      expect(themeManager.getCurrentLayout()).toBe('streaming');
    });

    it('should return streaming as fallback', () => {
      setUIConfig({ layout: 'invalid-layout' });
      expect(themeManager.getCurrentLayout()).toBe('streaming');
    });
  });

  describe('getFeatureToggles', () => {
    it('should return merged feature toggles', () => {
      const features = themeManager.getFeatureToggles();

      expect(features.chat).toBe(true);
      expect(features.syncButton).toBe(true);
    });

    it('should use defaults when no config', () => {
      clearStoreConfig();

      const features = themeManager.getFeatureToggles();

      expect(features.chat).toBe(true);
    });

    it('should override defaults with server config', () => {
      setUIConfig({ features: { chat: false } });

      const features = themeManager.getFeatureToggles();

      expect(features.chat).toBe(false);
    });
  });

  describe('applyTheme', () => {
    it('should set data-theme attribute on document', () => {
      themeManager.applyTheme('nord');

      expect(document.documentElement.getAttribute('data-theme')).toBe('nord');
    });

    it('should emit themeChanged event', () => {
      const handler = vi.fn();
      const unsub = bus.on(APP_EVENTS.THEME_CHANGED, handler);

      themeManager.applyTheme('dracula');

      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].theme).toBe('dracula');

      unsub();
    });

    it('should fallback to dark for invalid theme', () => {
      themeManager.applyTheme('nonexistent');

      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('should update meta theme-color', () => {
      const meta = document.querySelector('meta[name="theme-color"]');

      themeManager.applyTheme('monokai');

      expect(meta.getAttribute('content')).toBe('#272822');
    });

    it('should update store config when updateConfig is true', () => {
      themeManager.applyTheme('midnight', true);

      expect(getStoreConfig().javascript_config.ui.theme).toBe('midnight');
    });

    it('should not update store config when updateConfig is false', () => {
      const originalTheme = getStoreConfig().javascript_config.ui.theme;

      themeManager.applyTheme('midnight', false);

      expect(getStoreConfig().javascript_config.ui.theme).toBe(originalTheme);
    });

    it('should apply immediately without view-transition fallback classes', () => {
      document.startViewTransition = vi.fn();

      themeManager.applyTheme('nord');

      expect(document.startViewTransition).not.toHaveBeenCalled();
      expect(document.documentElement.getAttribute('data-theme')).toBe('nord');
      expect(document.documentElement.classList.contains('gh-transition-theme')).toBe(false);
    });
  });

  describe('applyLayout', () => {
    it('should set data-layout attribute', () => {
      themeManager.applyLayout('streaming');

      expect(document.documentElement.getAttribute('data-layout')).toBe('streaming');
    });

    it('should emit layoutChanged event', () => {
      const handler = vi.fn();
      const unsub = bus.on(APP_EVENTS.LAYOUT_CHANGED, handler);

      themeManager.applyLayout('gallery');

      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].layout).toBe('gallery');

      unsub();
    });

    it('should fallback to streaming for invalid layout', () => {
      themeManager.applyLayout('invalid');

      expect(document.documentElement.getAttribute('data-layout')).toBe('streaming');
    });

    it('should apply immediately without view transitions or fallback classes', () => {
      document.startViewTransition = vi.fn();
      themeManager.applyLayout('gallery');

      expect(document.startViewTransition).not.toHaveBeenCalled();
      expect(document.documentElement.getAttribute('data-layout')).toBe('gallery');
      expect(document.documentElement.classList.contains('gh-transition-layout')).toBe(false);
    });
  });

  describe('applyFeatureToggles', () => {
    it('should set feature data attributes', () => {
      themeManager.applyFeatureToggles({ chat: false, syncButton: true });

      expect(document.documentElement.getAttribute('data-feature-chat')).toBe('false');
      expect(document.documentElement.getAttribute('data-feature-sync-button')).toBe('true');
    });

    it('should emit featuresChanged event', () => {
      const handler = vi.fn();
      const unsub = bus.on(APP_EVENTS.FEATURES_CHANGED, handler);

      themeManager.applyFeatureToggles({ chat: true });

      expect(handler).toHaveBeenCalled();

      unsub();
    });
  });

  describe('setFeatureToggle', () => {
    it('should toggle a single feature', () => {
      themeManager.setFeatureToggle('chat', false);

      expect(document.documentElement.getAttribute('data-feature-chat')).toBe('false');
    });
  });

  describe('initThemeManager', () => {
    it('should apply theme, layout, and features from config', () => {
      replaceUIConfig({
        theme: 'monokai',
        layout: 'gallery',
        features: { chat: false }
      });

      themeManager.initThemeManager();

      expect(document.documentElement.getAttribute('data-theme')).toBe('monokai');
      expect(document.documentElement.getAttribute('data-layout')).toBe('gallery');
      expect(document.documentElement.getAttribute('data-feature-chat')).toBe('false');
    });
  });

  describe('getUIConfig', () => {
    it('should return current UI configuration', () => {
      replaceUIConfig({
        theme: 'nord',
        layout: 'streaming',
        features: { chat: true, syncButton: false }
      });

      const config = themeManager.getUIConfig();

      expect(config.theme).toBe('nord');
      expect(config.layout).toBe('streaming');
      expect(config.features.chat).toBe(true);
    });
  });

  describe('applyUIConfig', () => {
    it('should apply full UI configuration', () => {
      themeManager.applyUIConfig({
        theme: 'dracula',
        layout: 'streaming',
        features: { chat: false }
      });

      expect(document.documentElement.getAttribute('data-theme')).toBe('dracula');
      expect(document.documentElement.getAttribute('data-layout')).toBe('streaming');
      expect(document.documentElement.getAttribute('data-feature-chat')).toBe('false');
    });

    it('should handle partial config', () => {
      themeManager.applyUIConfig({ theme: 'midnight' });

      expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');
    });
  });

  describe('Custom Themes', () => {
    describe('getAvailableThemes', () => {
      it('should return built-in themes when no custom themes exist', () => {
        setUIConfig({ customThemes: [] });

        const themes = themeManager.getAvailableThemes();

        expect(themes.length).toBe(5);
        expect(themes.every(t => !t.custom)).toBe(true);
      });

      it('should include custom themes in available themes list', () => {
        setUIConfig({
          customThemes: [
            {
              id: 'custom-123',
              name: 'My Custom Theme',
              colors: { primary: '#ff0000' }
            }
          ]
        });

        const themes = themeManager.getAvailableThemes();

        expect(themes.length).toBe(6);
        expect(themes.some(t => t.id === 'custom-123')).toBe(true);
        expect(themes.find(t => t.id === 'custom-123').custom).toBe(true);
      });

      it('should add sparkle icon to custom theme names', () => {
        setUIConfig({
          customThemes: [
            { id: 'custom-456', name: 'Test Theme', colors: {} }
          ]
        });

        const themes = themeManager.getAvailableThemes();
        const customTheme = themes.find(t => t.id === 'custom-456');

        expect(customTheme.name).toContain('Test Theme');
        expect(customTheme.name).toContain('★');
      });
    });

    describe('getCurrentTheme with custom themes', () => {
      it('should return custom theme ID when valid', () => {
        setUIConfig({
          theme: 'custom-789',
          customThemes: [
            { id: 'custom-789', name: 'Custom', colors: { primary: '#000' } }
          ]
        });

        expect(themeManager.getCurrentTheme()).toBe('custom-789');
      });

      it('should return custom theme ID when customThemeColors exists', () => {
        setUIConfig({
          theme: 'custom-999',
          customThemeColors: { primary: '#123456' }
        });

        expect(themeManager.getCurrentTheme()).toBe('custom-999');
      });

      it('should fallback to dark when custom theme not found', () => {
        setUIConfig({
          theme: 'custom-nonexistent',
          customThemes: []
        });
        // No customThemeColors either

        expect(themeManager.getCurrentTheme()).toBe('dark');
      });
    });

    describe('applyTheme with custom themes', () => {
      it('should apply custom theme from customThemes array', () => {
        const handler = vi.fn();
        const unsub = bus.on(APP_EVENTS.THEME_CHANGED, handler);

        setUIConfig({
          customThemes: [
            {
              id: 'custom-apply-test',
              name: 'Apply Test',
              colors: {
                primary: '#ff0000',
                accent: '#0000ff',
                background: '#121212',
                surface: '#1e1e1e',
                text: '#ffffff'
              }
            }
          ]
        });

        themeManager.applyTheme('custom-apply-test');

        expect(document.documentElement.getAttribute('data-theme')).toBe('custom');
        expect(handler).toHaveBeenCalled();
        expect(handler.mock.calls[0][0].custom).toBe(true);

        unsub();
      });

      it('should apply custom theme from customThemeColors fallback', () => {
        setUIConfig({
          customThemeColors: {
            primary: '#abcdef',
            accent: '#123456',
            background: '#000000',
            surface: '#111111',
            text: '#ffffff'
          }
        });

        themeManager.applyTheme('custom-fallback-test');

        expect(document.documentElement.getAttribute('data-theme')).toBe('custom');
        // Check that CSS variable was set
        expect(document.documentElement.style.getPropertyValue('--primary-color')).toBe('#abcdef');
      });

      it('should set CSS variables for custom theme colors', () => {
        setUIConfig({
          customThemes: [
            {
              id: 'custom-css-test',
              name: 'CSS Test',
              colors: {
                primary: '#ff5500',
                accent: '#00ff55',
                background: '#1a1a1a',
                surface: '#2a2a2a',
                text: '#eeeeee'
              }
            }
          ]
        });

        themeManager.applyTheme('custom-css-test');

        const root = document.documentElement;
        expect(root.style.getPropertyValue('--primary-color')).toBe('#ff5500');
        expect(root.style.getPropertyValue('--accent-color')).toBe('#00ff55');
        expect(root.style.getPropertyValue('--background-color')).toBe('#1a1a1a');
        expect(root.style.getPropertyValue('--text-primary')).toBe('#eeeeee');
      });

      it('should ignore stale secondary fields in custom theme colors', () => {
        setUIConfig({
          customThemes: [
            {
              id: 'custom-ignore-secondary-test',
              name: 'Ignore Secondary',
              colors: {
                primary: '#ff0000',
                secondary: '#00ff00',
                accent: '#0000ff',
                background: '#1a1a1a',
                surface: '#2a2a2a',
                text: '#eeeeee'
              }
            }
          ]
        });

        themeManager.applyTheme('custom-ignore-secondary-test');

        expect(document.documentElement.style.getPropertyValue('--secondary-color')).toBe('');
        expect(document.documentElement.style.getPropertyValue('--secondary-color-rgb')).toBe('');
      });
    });

    describe('clearCustomThemeColors', () => {
      it('should remove custom CSS variables when switching to built-in theme', () => {
        // First apply a custom theme
        setUIConfig({
          customThemes: [
            {
              id: 'custom-clear-test',
              name: 'Clear Test',
              colors: {
                primary: '#123456',
                accent: '#345678',
                background: '#456789',
                surface: '#56789a',
                text: '#6789ab'
              }
            }
          ]
        });

        themeManager.applyTheme('custom-clear-test');
        expect(document.documentElement.style.getPropertyValue('--primary-color')).toBe('#123456');

        // Now switch to built-in theme
        themeManager.applyTheme('dark');

        // Custom CSS variables should be cleared
        expect(document.documentElement.style.getPropertyValue('--primary-color')).toBe('');
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      });
    });

    describe('initThemeManager with custom themes', () => {
      it('should apply saved custom theme on initialization', () => {
        replaceUIConfig({
          theme: 'custom-init-test',
          layout: 'streaming',
          features: { chat: true },
          customThemes: [
            {
              id: 'custom-init-test',
              name: 'Init Test',
              colors: {
                primary: '#aabbcc',
                accent: '#ccddee',
                background: '#112233',
                surface: '#223344',
                text: '#ffffff'
              }
            }
          ],
          customThemeColors: {
            primary: '#aabbcc',
            accent: '#ccddee',
            background: '#112233',
            surface: '#223344',
            text: '#ffffff'
          }
        });

        themeManager.initThemeManager();

        expect(document.documentElement.getAttribute('data-theme')).toBe('custom');
        expect(document.documentElement.style.getPropertyValue('--primary-color')).toBe('#aabbcc');
      });
    });
  });
});
