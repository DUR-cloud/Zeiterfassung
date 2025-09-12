// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// PWA-Plugin bewusst auskommentiert, damit kein Service Worker dazwischenfunkt
export default defineConfig({
  plugins: [
    react()
  ],
})
