/**
 * Canonical custom theme color contract.
 */

export const THEME_COLOR_KEYS = Object.freeze(['primary', 'accent', 'background', 'surface', 'text']);

export const DEFAULT_THEME_COLORS = Object.freeze({
    primary: '#2d3250',
    accent: '#f05454',
    background: '#121212',
    surface: '#1e1e2e',
    text: '#ffffff'
});

export const THEME_CSS_VARIABLE_KEYS = Object.freeze([
    '--primary-color',
    '--primary-color-light',
    '--primary-color-dark',
    '--accent-color',
    '--accent-color-light',
    '--background-color',
    '--background-color-dark',
    '--background-color-light',
    '--surface-color',
    '--text-primary',
    '--text-secondary',
    '--text-tertiary',
    '--card-background',
    '--card-hover',
    '--overlay-color',
    '--primary-color-rgb',
    '--accent-color-rgb',
    '--surface-color-rgb',
    '--background-color-rgb',
    '--divider-color',
    '--divider-color-light',
    '--gh-surface-solid',
    '--gh-surface-glass',
    '--gh-surface-glass-strong',
    '--gh-surface-pressed',
    '--gh-border-soft',
    '--gh-border-strong',
    '--gh-overlay-strong',
    '--gh-overlay-immersive',
    '--gh-overlay-gradient-bottom',
    '--btn-primary-fg',
    '--btn-secondary-bg',
    '--btn-secondary-bg-hover',
    '--btn-secondary-fg',
    '--btn-secondary-border',
    '--btn-ghost-bg-hover',
    '--btn-ghost-fg',
    '--btn-ghost-border',
    '--btn-icon-bg-hover',
    '--pill-bg',
    '--pill-border',
    '--pill-fg',
    '--pill-hover-bg',
    '--pill-hover-fg',
    '--pill-hover-border',
    '--pill-active-fg',
    '--input-bg',
    '--input-border',
    '--input-fg',
    '--modal-bg',
    '--modal-border',
    '--card-bg',
    '--card-border',
    '--theme-soft-accent',
    '--theme-soft-accent-muted'
]);

export function normalizeThemeColorValue(value, fallback) {
    if (!value) return fallback;
    const raw = String(value).trim();
    const parsed = raw.startsWith('#') ? raw : parseColor(raw);
    if (!parsed) return fallback;
    const normalized = normalizeToHex(parsed).toLowerCase();
    return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : fallback;
}

export function normalizeThemeColors(colors = {}, baseColors = DEFAULT_THEME_COLORS) {
    const sourceColors = colors && typeof colors === 'object' ? colors : {};
    const sourceBase = baseColors && typeof baseColors === 'object' ? baseColors : DEFAULT_THEME_COLORS;

    return THEME_COLOR_KEYS.reduce((resolved, key) => {
        const fallback = normalizeThemeColorValue(sourceBase[key], DEFAULT_THEME_COLORS[key]);
        resolved[key] = normalizeThemeColorValue(sourceColors[key], fallback);
        return resolved;
    }, {});
}

export function sanitizeThemeRecord(theme) {
    if (!theme || typeof theme !== 'object') return theme;
    return {
        ...theme,
        colors: normalizeThemeColors(theme.colors || {}, DEFAULT_THEME_COLORS)
    };
}

export function getThemeCssVariables(colors = {}, baseColors = DEFAULT_THEME_COLORS) {
    const resolved = normalizeThemeColors(colors, baseColors);
    const accentRgb = hexToRgbString(resolved.accent);
    const textRgb = hexToRgbString(resolved.text);
    const softAccent = `color-mix(in srgb, ${resolved.primary} 78%, ${resolved.accent} 22%)`;

    return {
        '--primary-color': resolved.primary,
        '--primary-color-light': lightenColor(resolved.primary, 15),
        '--primary-color-dark': darkenColor(resolved.primary, 15),
        '--accent-color': resolved.accent,
        '--accent-color-light': lightenColor(resolved.accent, 15),
        '--background-color': resolved.background,
        '--background-color-dark': darkenColor(resolved.background, 5),
        '--background-color-light': lightenColor(resolved.background, 10),
        '--surface-color': resolved.surface,
        '--text-primary': resolved.text,
        '--text-secondary': setAlpha(resolved.text, 0.7),
        '--text-tertiary': setAlpha(resolved.text, 0.5),
        '--card-background': resolved.surface,
        '--card-hover': `color-mix(in srgb, ${resolved.surface} 88%, ${resolved.text} 12%)`,
        '--overlay-color': setAlpha(resolved.background, 0.8),
        '--primary-color-rgb': hexToRgbString(resolved.primary),
        '--accent-color-rgb': accentRgb,
        '--surface-color-rgb': hexToRgbString(resolved.surface),
        '--background-color-rgb': hexToRgbString(resolved.background),
        '--divider-color': setAlpha(resolved.text, 0.18),
        '--divider-color-light': setAlpha(resolved.text, 0.1),
        '--gh-surface-solid': setAlpha(resolved.surface, 0.98),
        '--gh-surface-glass': setAlpha(resolved.surface, 0.9),
        '--gh-surface-glass-strong': setAlpha(resolved.surface, 0.96),
        '--gh-surface-pressed': setAlpha(resolved.text, 0.12),
        '--gh-border-soft': setAlpha(resolved.text, 0.12),
        '--gh-border-strong': `rgba(${accentRgb}, 0.34)`,
        '--gh-overlay-strong': setAlpha(resolved.background, 0.82),
        '--gh-overlay-immersive': setAlpha(resolved.background, 0.94),
        '--gh-overlay-gradient-bottom': `linear-gradient(transparent, ${setAlpha(resolved.background, 0.82)})`,
        '--btn-primary-fg': getReadableTextColor(resolved.accent),
        '--btn-secondary-bg': setAlpha(resolved.surface, 0.96),
        '--btn-secondary-bg-hover': `color-mix(in srgb, ${resolved.surface} 88%, ${resolved.text} 12%)`,
        '--btn-secondary-fg': resolved.text,
        '--btn-secondary-border': setAlpha(resolved.text, 0.18),
        '--btn-ghost-bg-hover': `rgba(${accentRgb}, 0.1)`,
        '--btn-ghost-fg': setAlpha(resolved.text, 0.7),
        '--btn-ghost-border': setAlpha(resolved.text, 0.18),
        '--btn-icon-bg-hover': `rgba(${textRgb}, 0.08)`,
        '--pill-bg': setAlpha(resolved.surface, 0.72),
        '--pill-border': setAlpha(resolved.text, 0.18),
        '--pill-fg': setAlpha(resolved.text, 0.7),
        '--pill-hover-bg': `rgba(${accentRgb}, 0.14)`,
        '--pill-hover-fg': resolved.text,
        '--pill-hover-border': `rgba(${accentRgb}, 0.34)`,
        '--pill-active-fg': getReadableTextColor(resolved.accent),
        '--input-bg': setAlpha(resolved.surface, 0.9),
        '--input-border': setAlpha(resolved.text, 0.18),
        '--input-fg': resolved.text,
        '--modal-bg': setAlpha(resolved.surface, 0.96),
        '--modal-border': setAlpha(resolved.text, 0.12),
        '--card-bg': setAlpha(resolved.surface, 0.9),
        '--card-border': setAlpha(resolved.text, 0.12),
        '--theme-soft-accent': softAccent,
        '--theme-soft-accent-muted': `color-mix(in srgb, ${softAccent} 16%, transparent)`
    };
}

export function getReadableTextColor(hex) {
    const [r, g, b] = hexToRgb(hex).map(channel => {
        const normalized = channel / 255;
        return normalized <= 0.03928
            ? normalized / 12.92
            : Math.pow((normalized + 0.055) / 1.055, 2.4);
    });
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.5 ? '#000000' : '#ffffff';
}

export function normalizeToHex(color) {
    if (!color) return '#000000';
    const value = String(color).trim();
    if (value.startsWith('#')) {
        return value.length === 4
            ? '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3]
            : value;
    }

    const parsed = parseColor(value);
    return parsed || '#000000';
}

export function parseColor(input) {
    if (!input) return null;
    const value = String(input).trim();

    if (value.startsWith('#')) {
        return value;
    }

    const rgbMatch = value.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
    if (rgbMatch) {
        return rgbToHex(parseInt(rgbMatch[1]), parseInt(rgbMatch[2]), parseInt(rgbMatch[3]));
    }

    const hslMatch = value.match(/hsl\s*\(\s*(\d+)\s*,\s*(\d+)%?\s*,\s*(\d+)%?\s*\)/i);
    if (hslMatch) {
        return hslToHex(parseInt(hslMatch[1]), parseInt(hslMatch[2]), parseInt(hslMatch[3]));
    }

    return null;
}

export function hexToRgb(hex) {
    hex = normalizeToHex(hex).replace('#', '');
    return [
        parseInt(hex.substr(0, 2), 16),
        parseInt(hex.substr(2, 2), 16),
        parseInt(hex.substr(4, 2), 16)
    ];
}

export function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => {
        const hex = Math.max(0, Math.min(255, Math.round(x))).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    }).join('');
}

export function hexToHsl(hex) {
    const [r, g, b] = hexToRgb(hex).map(x => x / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h;
    let s;
    const l = (max + min) / 2;

    if (max === min) {
        h = 0;
        s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }

    return [h * 360, s * 100, l * 100];
}

export function hslToHex(h, s, l) {
    h /= 360;
    s /= 100;
    l /= 100;

    let r;
    let g;
    let b;
    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
    }

    return rgbToHex(r * 255, g * 255, b * 255);
}

export function lightenColor(hex, percent) {
    const [h, s, l] = hexToHsl(hex);
    return hslToHex(h, s, Math.min(100, l + percent));
}

export function darkenColor(hex, percent) {
    const [h, s, l] = hexToHsl(hex);
    return hslToHex(h, s, Math.max(0, l - percent));
}

export function setAlpha(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function hexToRgbString(hex) {
    return hexToRgb(hex).join(', ');
}
