import "./style.css";
import { PlanStore } from "./store";
import { ProviderManager } from "./providers";
import { AppUI } from "./ui";
import { PlanSync, fetchSharedPlan, readShareParams } from "./sync";
import { completeConnectIfPending } from "./openrouterAuth";

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("missing #app root element");

  const providers = new ProviderManager();
  // Kicked off before anything else on the page. Spinning up the on-device model takes
  // seconds and needs nothing from IndexedDB, the network, or the DOM — so it runs
  // alongside all of that rather than after it. Behind a share link this was the whole
  // difference between a warm first turn and a cold one: the warm-up used to sit behind
  // a plan fetch it had no reason to wait for. Deliberately not awaited.
  void providers.warmTier0();

  const store = await PlanStore.load();

  const ui = new AppUI(root, store, providers);
  ui.render();

  // Track the active provider for the whole session instead of reading it once: Tier 0
  // now goes live partway through init(), and the store has to see that the moment it
  // happens or the first turn would still be routed to "no provider".
  providers.subscribe(() => store.setProvider(providers.getActiveProvider()));
  // Tier 0 now starts probing before the store exists to subscribe, so its "available"
  // may already have been published to nobody. Read the current state once here rather
  // than waiting for the next change that happens to come along.
  store.setProvider(providers.getActiveProvider());

  // A share link is opened before init finishes: someone following a link wants to see
  // the plan, and nothing about viewing it needs an inference tier (FR-14, RTE-4).
  const share = readShareParams();
  const opened = share ? await openShared(store, share) : false;

  // Completes the OpenRouter PKCE flow (T2-1) if this load is the redirect back from
  // /auth. Runs before providers.init() so a freshly-connected Tier 2 is reflected in
  // the very first availability check rather than needing a manual refresh.
  try {
    if (await completeConnectIfPending()) providers.setActive("tier2-openrouter");
  } catch (e) {
    console.warn("Could not complete the OpenRouter connection:", (e as Error).message);
    window.alert(`Could not connect OpenRouter: ${(e as Error).message}`);
  }

  await providers.init();
  store.setProvider(providers.getActiveProvider());

  attachSync(store, providers.getConfig().cloudSyncEnabled === true, opened);
  ui.render();

  // Register the service worker for offline editing/export once loaded (NFR-4).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline support is a nicety, not a hard requirement for Phase 1's exit criteria.
    });
  }
}

async function openShared(store: PlanStore, share: { id: string; token: string }): Promise<boolean> {
  try {
    const opened = await fetchSharedPlan(share.id, share.token);
    await store.adoptShared(opened);
    return true;
  } catch (e) {
    // A dead or revoked link must not strand the app on a blank page — the local plan is
    // still there, and the failure is worth saying out loud.
    console.warn("Could not open the shared plan:", (e as Error).message);
    window.alert(`Could not open that shared plan: ${(e as Error).message}`);
    return false;
  }
}

function attachSync(store: PlanStore, cloudSyncEnabled: boolean, openedFromShare: boolean): void {
  const sync = new PlanSync({
    // A plan opened read-only belongs to someone else; syncing it back would be writing
    // to a document the viewer has no edit token for.
    enabled: cloudSyncEnabled && !store.readOnly,
    getDoc: () => store.doc,
    getRef: () => store.cloudRef,
    saveRef: (ref) => store.setCloudRef(ref),
  });
  store.attachSync(sync);
  // An edit link's plan is already in the cloud; a purely local plan is only uploaded
  // once the user does something, so nothing is published by merely opening the app.
  if (openedFromShare) sync.schedule();
}

void main();
