import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('./src', import.meta.url));

/**
 * 擴充套件「頁面」的建置設定（側邊欄，日後加設定頁）。
 * 背景腳本走 vite.config.background.ts —— Firefox MV3 只支援事件頁，
 * 背景必須是單一 IIFE 檔，無法與 ES module 頁面共用同一次建置。
 */
export default defineConfig({
  root: src,
  base: './',
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: { '@': src },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    // 由 npm run clean 統一清空，避免 watch 模式下兩份建置互相覆蓋
    emptyOutDir: false,
    target: 'firefox140',
    // MV3 的預設 CSP 禁止 inline script，而 modulepreload polyfill 會注入 inline script
    modulePreload: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        sidebar: fileURLToPath(new URL('./src/sidebar/index.html', import.meta.url)),
        options: fileURLToPath(new URL('./src/options/index.html', import.meta.url)),
        gallery: fileURLToPath(new URL('./src/gallery/index.html', import.meta.url)),
      },
    },
  },
});
