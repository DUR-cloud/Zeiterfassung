// src/main.jsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

// ➊: automatisches SW-Update aktivieren
import { registerSW } from 'virtual:pwa-register'
const updateSW = registerSW({
  onRegistered(r) {
    // ➋: in Intervallen nach neuer Version suchen
    if (r && r.update) {
      setInterval(() => r.update(), 60 * 1000); // jede Minute
    }
  },
  onNeedRefresh() {
    // ➌: sofort übernehmen und Seite neu laden
    updateSW(true)
  }
})

createRoot(document.getElementById('root')).render(<App />)
