import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves the site from https://<user>.github.io/pitch-lab/
export const BASE = '/pitch-lab/';

export default defineConfig(({ mode }) => ({
  base: BASE,
  resolve: {
    alias: [
      // Upstream packaging bug in @fontsource-variable/big-shoulders-display@5.3.0: its
      // exports map has "./*" -> "./*.css" but, unlike @fontsource-variable/instrument-sans,
      // is missing the "./*.css" -> "./*.css" entry. Under strict Node exports resolution
      // (what Rolldown's bundler build uses), the documented `/wght.css` import therefore
      // resolves to the literal, nonexistent file `wght.css.css`. Dev (esbuild) resolves it
      // fine, so this only surfaces at `vite build`. Alias the exact specifier to the real
      // file so main.tsx's documented `import '@fontsource-variable/big-shoulders-display/wght.css'`
      // keeps working without touching package.json or node_modules.
      {
        find: '@fontsource-variable/big-shoulders-display/wght.css',
        replacement: fileURLToPath(
          new URL(
            './node_modules/@fontsource-variable/big-shoulders-display/wght.css',
            import.meta.url
          )
        ),
      },
    ],
  },
  // `npm run dev:host` (mode "https") serves over self-signed HTTPS on the LAN:
  // getUserMedia needs a secure context, so plain http://<lan-ip> fails on an iPhone.
  plugins: [
    preact({
      // The AudioWorklet's modules (src/audio, src/dsp, src/core, config) run in AudioWorkletGlobalScope, where the
      // dev-only HMR/prefresh code the preset injects (it imports /@vite/client, which needs a window) stops the
      // module before registerProcessor runs, so `vite` dev could never start the mic. None of them is a component.
      exclude: [/node_modules/, /\/src\/(audio|dsp|core)\//, /\/src\/config\.ts$/],
    }),
    ...(mode === 'https' ? [basicSsl()] : []),
    VitePWA({
      strategies: 'generateSW',
      registerType: 'prompt',
      // We register the service worker ourselves (src/pwa/register-sw.ts) so the UI
      // owns the "update available" prompt instead of the plugin's default banner.
      injectRegister: false,
      // No dev service worker: GitHub Pages serves no COOP/COEP anyway (no
      // SharedArrayBuffer), and a dev SW would just get in the way of iterating.
      devOptions: { enabled: false },
      manifest: {
        name: 'Pitch Lab',
        short_name: 'Pitch Lab',
        description:
          'Free, open-source, mobile-first singing-technique trainer with real-time pitch feedback.',
        // All three must match for the installed app to be recognised as the same app
        // across updates (and for iOS/Android to treat it as a distinct PWA at all).
        id: BASE,
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'any',
        background_color: '#0E0F13',
        theme_color: '#0E0F13',
        categories: ['music', 'education'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Everything the built app can ship, including the AudioWorklet chunk
        // (emitted from `?worker&url`, a plain hashed .js file like any other),
        // the self-hosted variable font files and the bundled public-domain song
        // charts (public/songs: an index.json plus UltraStar .txt files, a few KB
        // each, so a first launch offline still has its starter songs).
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}', 'songs/**/*.{txt,json}'],
        navigateFallback: `${BASE}index.html`,
        cleanupOutdatedCaches: true,
        // No runtime caching: every request the app makes at runtime is same-origin
        // (self-hosted fonts, no analytics, no third-party calls - docs/SPEC.md §4),
        // so there is nothing for a runtimeCaching entry to intercept.
      },
    }),
  ],
  // worker.format stays at Vite's default ('iife'): the AudioWorklet bundle must be
  // one self-contained script with no runtime imports.
  build: {
    target: ['safari16', 'chrome110', 'edge110'],
    sourcemap: true,
  },
}));
