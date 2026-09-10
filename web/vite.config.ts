import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The API is the Python adapter in api/server.py. In development Vite
// proxies /api to it; in a build the adapter serves this dist folder.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:8765', changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
