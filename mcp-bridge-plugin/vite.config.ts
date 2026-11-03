import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Two bundles from one config:
//   --mode code -> dist/code.js  (IIFE for the Figma/QuickJS sandbox, es2017: no ?. or ?? in the output)
//   --mode ui   -> dist/ui.html  (single HTML file with inlined JS/CSS)
//   vitest      -> mode 'test', project root (no root: 'src')
export default defineConfig(({ mode }) => {
  if (mode === 'test') {
    return { test: { include: ['src/**/*.test.ts'] } };
  }
  if (mode === 'code') {
    return {
      build: {
        target: 'es2017',
        outDir: 'dist',
        emptyOutDir: false,
        minify: false,
        lib: {
          entry: fileURLToPath(new URL('./src/code.ts', import.meta.url)),
          formats: ['iife'],
          name: 'figmaMcpBridge',
          fileName: () => 'code.js',
        },
      },
    };
  }
  return {
    root: 'src',
    plugins: [viteSingleFile()],
    build: {
      target: 'es2020',
      outDir: '../dist',
      emptyOutDir: false,
      rollupOptions: { input: fileURLToPath(new URL('./src/ui.html', import.meta.url)) },
    },
  };
});
