// Cloudflare Turnstile — specs.md T1-2 (every /api/infer request needs a valid
// token). Uses the managed, invisible widget and re-executes per request so a
// fresh token backs every Tier 1 call.

type TurnstileApi = {
  render(container: HTMLElement, opts: Record<string, unknown>): string;
  execute(widgetId: string, opts?: Record<string, unknown>): void;
  reset(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let widgetId: string | null = null;
let pending: { resolve: (token: string) => void; reject: (err: Error) => void } | null = null;

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Turnstile"));
    document.head.appendChild(script);
  });
}

export async function initTurnstile(siteKey: string): Promise<void> {
  await loadScript();
  if (!window.turnstile) throw new Error("Turnstile script did not initialize window.turnstile");

  const container = document.createElement("div");
  container.id = "turnstile-container";
  container.style.display = "none";
  document.body.appendChild(container);

  widgetId = window.turnstile.render(container, {
    sitekey: siteKey,
    size: "invisible",
    callback: (token: string) => {
      pending?.resolve(token);
      pending = null;
    },
    "error-callback": () => {
      pending?.reject(new Error("Turnstile verification failed"));
      pending = null;
    },
  });
}

export function getTurnstileToken(): Promise<string> {
  if (!window.turnstile || !widgetId) return Promise.reject(new Error("Turnstile not initialized"));
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    window.turnstile!.execute(widgetId!);
  });
}
