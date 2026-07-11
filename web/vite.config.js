import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './test/setup.js',
    include: ['test/**/*.test.{js,jsx}'],
  },
  server: {
    port: 5544,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4400',
        ws: true,
      },
    },
  },
})
