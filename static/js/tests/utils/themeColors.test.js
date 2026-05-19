import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME_COLORS,
  THEME_COLOR_KEYS,
  getThemeCssVariables,
  normalizeThemeColors,
  sanitizeThemeRecord
} from '../../utils/themeColors.js';

describe('themeColors', () => {
  it('normalizes colors to the canonical five-key contract', () => {
    const colors = normalizeThemeColors({
      primary: '#123',
      secondary: '#445566',
      accent: '#abcdef',
      background: '#000000',
      surface: '#111111',
      text: '#ffffff',
      unknown: '#999999'
    });

    expect(Object.keys(colors)).toEqual(THEME_COLOR_KEYS);
    expect(colors.primary).toBe('#112233');
    expect(colors.accent).toBe('#abcdef');
    expect(colors).not.toHaveProperty('secondary');
    expect(colors).not.toHaveProperty('unknown');
  });

  it('falls back to defaults for missing or invalid color values', () => {
    const colors = normalizeThemeColors({
      primary: 'not-a-color',
      accent: '#123456'
    });

    expect(colors.primary).toBe(DEFAULT_THEME_COLORS.primary);
    expect(colors.accent).toBe('#123456');
    expect(colors.background).toBe(DEFAULT_THEME_COLORS.background);
  });

  it('sanitizes theme records without preserving extra color fields', () => {
    const theme = sanitizeThemeRecord({
      id: 'custom-test',
      name: 'Test',
      colors: {
        primary: '#111111',
        secondary: '#222222',
        accent: '#333333',
        background: '#444444',
        surface: '#555555',
        text: '#ffffff'
      }
    });

    expect(theme.id).toBe('custom-test');
    expect(theme.colors).not.toHaveProperty('secondary');
    expect(Object.keys(theme.colors)).toEqual(THEME_COLOR_KEYS);
  });

  it('derives semantic UI tokens from the canonical theme colors', () => {
    const variables = getThemeCssVariables({
      primary: '#222222',
      accent: '#eeeeee',
      background: '#ffffff',
      surface: '#f5f5f5',
      text: '#111111'
    });

    expect(variables['--btn-secondary-bg']).toBe('rgba(245, 245, 245, 0.96)');
    expect(variables['--btn-secondary-fg']).toBe('#111111');
    expect(variables['--btn-primary-fg']).toBe('#000000');
    expect(variables['--modal-bg']).toBe('rgba(245, 245, 245, 0.96)');
    expect(variables).not.toHaveProperty('--secondary-color');
  });
});
