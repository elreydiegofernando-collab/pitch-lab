#!/usr/bin/env node
/**
 * Rasterizes public/icons/icon.svg and icon-maskable.svg to every PNG the PWA
 * manifest and iOS need, plus favicon-32.png, and copies icon.svg to
 * public/favicon.svg. Run with `npm run icons` after editing either source SVG;
 * the PNGs are checked in (vite.config.ts's VitePWA plugin globs them for
 * precaching, and index.html links them directly).
 *
 * `icon.svg` bakes in its own rounded-square corners (used where nothing else
 * masks it: icon-192, icon-512, the favicons). `icon-maskable.svg` fills edge to
 * edge with no rounding of its own and keeps its glyph inside a ~40% safe zone,
 * because the OS (maskable icons) or iOS (apple-touch-icon) applies its own mask
 * shape on top - see the comment in that file.
 */
import { Resvg } from '@resvg/resvg-js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const iconsDir = join(root, 'public', 'icons');

/** @param {string} svg @param {number} size @returns {Buffer} */
function rasterize(svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return resvg.render().asPng();
}

async function main() {
  await mkdir(iconsDir, { recursive: true });

  const [iconSvg, maskableSvg] = await Promise.all([
    readFile(join(iconsDir, 'icon.svg'), 'utf8'),
    readFile(join(iconsDir, 'icon-maskable.svg'), 'utf8'),
  ]);

  /** @type {Array<[string, Buffer]>} */
  const outputs = [
    ['icon-192.png', rasterize(iconSvg, 192)],
    ['icon-512.png', rasterize(iconSvg, 512)],
    ['icon-maskable-512.png', rasterize(maskableSvg, 512)],
    // iOS reads only this one; render from the full-bleed source so iOS's own
    // corner mask has nothing pre-rounded to clash with. The source has an
    // opaque background covering every pixel, so the PNG has no transparency.
    ['apple-touch-icon-180.png', rasterize(maskableSvg, 180)],
    ['favicon-32.png', rasterize(iconSvg, 32)],
  ];

  await Promise.all(outputs.map(([name, buf]) => writeFile(join(iconsDir, name), buf)));
  await writeFile(join(root, 'public', 'favicon.svg'), iconSvg);

  for (const [name, buf] of outputs) {
    console.log(`  icons/${name}  (${buf.length.toLocaleString()} bytes)`);
  }
  console.log('  favicon.svg  (copy of icons/icon.svg)');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
