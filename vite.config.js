import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
  },
  build: {
    sourcemap: false,
    rolldownOptions: {
      onLog(level, log, handler) {
        // This app is entirely client-rendered; server-component directives have no effect.
        if (log.code === 'MODULE_LEVEL_DIRECTIVE' && log.message.includes('use client')) return;
        handler(level, log);
      },
      output: {
        codeSplitting: { groups: [{ name: 'ui', test: /node_modules/ }] },
      },
    },
  },
});
