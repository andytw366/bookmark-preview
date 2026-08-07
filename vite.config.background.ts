import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('./src', import.meta.url));

/**
 * 背景腳本專用建置。
 *
 * Firefox 的 MV3 不支援 background.service_worker（Firefox bug 1573659），
 * 只支援 background.scripts 事件頁。事件頁載入的是傳統腳本，
 * 因此這裡打包成單一自足的 IIFE 檔，不依賴 ES module 載入。
 */
export default defineConfig({
  resolve: {
    alias: { '@': src },
  },
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: false,
    target: 'firefox140',
    sourcemap: true,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./src/background/index.ts', import.meta.url)),
      formats: ['iife'],
      name: 'bookmarkPreviewBackground',
      fileName: () => 'background.js',
    },
  },
});
