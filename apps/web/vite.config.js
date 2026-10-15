import { defineConfig } from 'vite';
export default defineConfig({
  build: { target: 'es2022', assetsDir: 'src' },
  server: { proxy: { '/api': 'http://127.0.0.1:4177', '/health': 'http://127.0.0.1:4177' } }
});
