import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CSS_ROOT = path.resolve(TEST_DIR, '../../../css');

function readCssFile(name) {
    return fs.readFileSync(path.join(CSS_ROOT, name), 'utf8');
}

describe('shared shell tokens', () => {
    it('uses shell offset tokens for the search dropdown', () => {
        const css = readCssFile('search-bar.css');

        expect(css).toContain('top: var(--app-overlay-top-offset);');
        expect(css).toContain('left: var(--app-page-padding-x);');
        expect(css).not.toContain('top: 56px;');
    });

    it('uses the shared content-top token for streaming and gallery containers', () => {
        const streamingCss = readCssFile('streaming-layout.css');
        const galleryCss = readCssFile('gallery-layout.css');

        expect(streamingCss).toContain('top: var(--app-content-top);');
        expect(galleryCss).toContain('top: var(--app-content-top);');
    });

    it('uses shared shell tokens for theme-builder panel anchors', () => {
        const css = readCssFile('theme-builder.css');

        expect(css).toContain('left: var(--app-page-padding-x);');
        expect(css).toContain('right: var(--app-page-padding-x);');
        expect(css).toContain('top: var(--app-overlay-top-offset);');
    });

    it('lets the app shell main resolve child container height', () => {
        const baseCss = readCssFile('base.css');
        const layoutCss = readCssFile('layout.css');

        expect(baseCss).toContain('#app-shell > main');
        expect(baseCss).toContain('flex: 1 1 auto;');
        expect(baseCss).toContain('min-height: 0;');
        expect(layoutCss).toContain('height: 100%;');
        expect(layoutCss).toContain('padding: var(--space-lg) var(--app-page-padding-x);');
    });
});
