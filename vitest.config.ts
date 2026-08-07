import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // 加密模組只用 Web Crypto / CompressionStream / Blob，Node 22 全都有，
    // 不需要 jsdom 或瀏覽器環境
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
