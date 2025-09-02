import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
// PWA: Service Worker Registrierung (autoUpdate)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const { registerSW } = await import('virtual:pwa-register')
      registerSW({ immediate: true })
    } catch (e) {
      // ignore
    }
  })
}
  <StrictMode>
    <App />
  </StrictMode>,
)
// Service Worker Registrierung (plugin steuert das)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {/* ignore */})
  })
}