#!/usr/bin/env node
// Renders the PNG icons from public/favicon.svg (the header mark: violet square, Lucide "play") with
// Playwright's Chromium: public/favicon-32.png (tab icon fallback) and public/apple-touch-icon.png
// (180×180, full-bleed and opaque: iOS rounds the corners itself and fills transparency black).
// Run: node scripts/make-icons.mjs (needs `pnpm exec playwright install chromium`).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const pub = fileURLToPath(new URL('../public/', import.meta.url));
const svg = await readFile(`${pub}favicon.svg`, 'utf8');
/** The glyph scaled by `k` about its own centre (play path bbox centre (13, 12) in Lucide units). */
function scaleGlyph(source, k) {
  return source.replace(
    /transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)"/,
    (_, x, y, s) => {
      const [cx, cy] = [+x + 13 * s, +y + 12 * s];
      const s2 = s * k;
      return `transform="translate(${(cx - 13 * s2).toFixed(2)} ${(cy - 12 * s2).toFixed(2)}) scale(${s2.toFixed(3)})"`;
    },
  );
}
const square = scaleGlyph(svg.replace(/ rx="[^"]*"/, ''), 0.85);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [name, size, source] of [
    ['favicon-32.png', 32, svg],
    // Apple's template keeps the glyph a little smaller than the tab icon's.
    ['apple-touch-icon.png', 180, square],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    const sized = source.replace('<svg ', `<svg width="${size}" height="${size}" `);
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`,
    );
    const png = await page.screenshot({ omitBackground: name !== 'apple-touch-icon.png' });
    await writeFile(`${pub}${name}`, png);
    console.log(`public/${name}`);
  }
} finally {
  await browser.close();
}
