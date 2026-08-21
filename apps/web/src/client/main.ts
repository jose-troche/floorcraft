import "./style.css";
import { PlanStore } from "./store";
import { ProviderManager } from "./providers";
import { AppUI } from "./ui";

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("missing #app root element");

  const store = await PlanStore.load();
  const providers = new ProviderManager();

  const ui = new AppUI(root, store, providers);
  ui.render();

  // Track the active provider for the whole session instead of reading it once: Tier 0
  // now goes live partway through init(), and the store has to see that the moment it
  // happens or the first turn would still be routed to "no provider".
  providers.subscribe(() => store.setProvider(providers.getActiveProvider()));

  await providers.init();
  store.setProvider(providers.getActiveProvider());

  // Register the service worker for offline editing/export once loaded (NFR-4).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline support is a nicety, not a hard requirement for Phase 1's exit criteria.
    });
  }
}

void main();
