// src/registerServiceWorker.ts

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        console.log("✅ Service Worker registered:", registration);

        // Wenn eine neue Version gefunden wird
        registration.onupdatefound = () => {
          const installingWorker = registration.installing;
          if (installingWorker) {
            installingWorker.onstatechange = () => {
              if (
                installingWorker.state === "installed" &&
                navigator.serviceWorker.controller
              ) {
                console.log("🔄 Neue Version gefunden – aktualisiere…");
                // Neue Version sofort aktivieren
                installingWorker.postMessage({ type: "SKIP_WAITING" });
                window.location.reload();
              }
            };
          }
        };
      })
      .catch((err) => console.error("❌ Service Worker registration failed:", err));

    // Aktiviert sofort, wenn der SW "waiting" ist
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!refreshing) {
        refreshing = true;
        console.log("♻️ Neue Version aktiv – Seite neu laden");
        window.location.reload();
      }
    });
  });
}
