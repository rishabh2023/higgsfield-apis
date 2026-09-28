import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    port: Number(process.env.FRONTEND_PORT ?? 5173),
    // Same-origin proxy so the workspace cookie and API key never leave the backend.
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.BACKEND_PORT ?? '8010'}`, changeOrigin: false } },
  },
})
