import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * Two builds, chosen by mode:
 *
 *   client (default) -> `web/dist/admin`, the console the browser loads;
 *   ssr              -> `web/build-test`, a Node-loadable bundle used by scripts/check-views-render.mjs.
 *
 * The SSR build is a TEST TOOL, not a deployment artifact: it renders each view once so a template that
 * references an undefined name throws here instead of blanking a page in the browser. That failure is
 * invisible to status-code checks — the shell, bundle and CSS all return 200 while the view draws nothing.
 *
 * It is emitted OUTSIDE `web/dist` on purpose: `assets.directory` points at `web/dist`, so a file placed
 * there is uploaded and served publicly.
 */
export default defineConfig(({ mode }) => {
  const isSsr = mode === 'ssr';

  return {
    // Vite resolves `index.html` relative to `root`, which defaults to the process cwd — so running from
    // the repo root would look for a top-level index.html that does not exist. Pinning root to `web`
    // makes the command work from either directory.
    root: __dirname,
    base: isSsr ? undefined : '/admin/',
    plugins: [vue()],
    build: isSsr
      ? {
          // The entry is the render-check module, not index.html. Passing the HTML entry makes Rollup refuse
          // the build ("rollupOptions.input should not be an html file when building for SSR").
          ssr: 'src/render-check.ts',
          // OUTSIDE the assets directory, deliberately. `assets.directory` is `web/dist`, so anything under
          // it is uploaded and served — putting this test bundle in `dist/ssr` would publish it at
          // `/ssr/render-check.js` with no authentication. A test artifact must not become a public asset.
          outDir: 'build-test',
          emptyOutDir: true,
          target: 'node20',
          rollupOptions: {
            input: 'src/render-check.ts',
            output: { entryFileNames: 'render-check.js', format: 'es' },
          },
          minify: false,
        }
      : {
          outDir: 'dist/admin',
          emptyOutDir: true,
          rollupOptions: {
            output: {
              entryFileNames: 'assets/[name]-[hash].js',
              chunkFileNames: 'assets/[name]-[hash].js',
              assetFileNames: 'assets/[name]-[hash][extname]',
            },
          },
          // Readable class names in production would be noise; the source map is what makes a stack trace
          // usable, so it is kept.
          sourcemap: true,
        },
  };
});
