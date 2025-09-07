// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',          // <— wichtig
      workbox: {
        cleanupOutdatedCaches: true,        // alte Caches weg
        clientsClaim: true,                 // SW übernimmt sofort
        skipWaiting: true                   // neue Version sofort aktiv
      },
      devOptions: {
        enabled: true                       // SW auch im dev (optional)
      },
      manifest: {
        name: 'Zeiterfassung',
        short_name: 'Zeiterfassung',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#0f172a',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      }
    })
  ]
})
