// Tier 0 — on-device (specs.md §5.3 T0-1..T0-5). Chrome's built-in `LanguageModel`
// (Prompt API), feature-detected; never assumed present, never blocks on download.

import type { Patch, PlanSummary, Turn } from "../types.js";
import type { Availability, PlanProvider } from "./types.js";
import { CORE_PATCH_OPS, FREEFORM_PATCH_OPS, buildPatchJsonSchema } from "./schema.js";
import { buildSystemPrompt, buildUserPrompt } from "./promptBuilder.js";
import { safeJsonParse } from "./safeJsonParse.js";

const TOKEN_BUDGET = 1500; // T0-3

type LanguageModelSession = {
  prompt(input: string, opts?: { responseConstraint?: unknown }): Promise<string>;
  clone?: () => Promise<LanguageModelSession>;
  destroy?: () => void;
};

type BrowserLanguageModel = {
  availability(): Promise<"available" | "downloadable" | "downloading" | "unavailable">;
  create(opts?: { initialPrompts?: Array<{ role: string; content: string }> }): Promise<LanguageModelSession>;
};

function getLanguageModel(): BrowserLanguageModel | null {
  const g = globalThis as unknown as { LanguageModel?: BrowserLanguageModel };
  return "LanguageModel" in globalThis && g.LanguageModel ? g.LanguageModel : null;
}

function errorName(e: unknown): string | undefined {
  return (e as { name?: string } | null)?.name;
}

/**
 * True for the failures where prompting the same session again cannot help: the user
 * aborted, the session is gone, or the prompt itself is over the model's window. Notably
 * *not* NotSupportedError — that is what Chrome raises for a responseConstraint it can't
 * compile, which is precisely the case the unconstrained retry exists for.
 */
function isSessionUnusable(e: unknown): boolean {
  const name = errorName(e);
  return name === "AbortError" || name === "InvalidStateError" || name === "QuotaExceededError";
}

/** The session handle outlived the session behind it — see the retry in propose(). */
function isSessionGone(e: unknown): boolean {
  return errorName(e) === "InvalidStateError";
}

export class Tier0Provider implements PlanProvider {
  readonly id = "tier0-on-device" as const;
  readonly tier = 0 as const;

  /**
   * Warm sessions, keyed by the system prompt they were primed with. Reused across turns
   * so the model's weights/context aren't reinitialized on every message — creating a
   * session is the expensive part, not prompting an existing one.
   *
   * A map rather than a single slot because this provider legitimately uses two system
   * prompts: the core vocabulary, and the reduced one a freeform level gets. A one-slot
   * cache destroyed and recreated the session on every switch between a generated and a
   * freeform level, so a user moving between levels paid the multi-second cold start
   * again and again — the exact cost warmup() exists to pay once.
   */
  private sessions = new Map<string, Promise<LanguageModelSession>>();

  /**
   * Fires off session creation without waiting on it, so the model is already warm by
   * the time the user sends a first message instead of paying the cold-start cost then.
   * Safe to call speculatively (e.g. right after availability() reports "available");
   * failures are swallowed here since propose() will surface them on the next real call.
   * Calling it repeatedly is free — an already-warm session is returned as-is.
   */
  warmup(): void {
    const lm = getLanguageModel();
    if (!lm) return;
    void this.warmSession(lm, buildSystemPrompt(CORE_PATCH_OPS)).catch(() => {});
  }

  /**
   * Makes sure a *live* session exists for `system`, without blocking the caller.
   *
   * An already-cached session is checked rather than trusted. The browser can reclaim an
   * idle on-device session — a backgrounded tab is the usual way — and the handle we hold
   * reveals nothing about that until it is next used, which is why a chat that answered
   * instantly before a tab switch can crawl after one. clone() is the check: it costs no
   * model reinit (the same reason propose() clones per turn) and throws on a session that
   * is gone, so a reclaimed session is rebuilt here, in the background, instead of on the
   * user's next message.
   */
  private async warmSession(lm: BrowserLanguageModel, system: string): Promise<void> {
    const cached = this.sessions.get(system);
    if (!cached) {
      await this.getBaseSession(lm, system);
      return;
    }
    try {
      const probe = await (await cached).clone?.();
      probe?.destroy?.();
    } catch (e) {
      // A create that failed has already removed itself from the map; only a session that
      // was built and later reclaimed needs evicting here.
      if (!isSessionGone(e)) return;
      this.sessions.delete(system);
      await this.getBaseSession(lm, system);
    }
  }

  async availability(): Promise<Availability> {
    const lm = getLanguageModel();
    if (!lm) return "unavailable";
    try {
      const status = await lm.availability();
      if (status === "available") return "available";
      if (status === "downloadable" || status === "downloading") return "downloadable";
      return "unavailable";
    } catch {
      return "unavailable";
    }
  }

  private getBaseSession(lm: BrowserLanguageModel, system: string): Promise<LanguageModelSession> {
    // Keyed on the system prompt: a cached session is only reusable if it was primed with
    // this exact vocabulary, or it would silently answer with ops the caller never offered.
    const cached = this.sessions.get(system);
    if (cached) return cached;

    const created = lm.create({ initialPrompts: [{ role: "system", content: system }] }).catch((err) => {
      // A failed create must not be left in the map, or every later turn would await the
      // same rejection and the provider would be permanently poisoned by one bad moment.
      this.sessions.delete(system);
      throw err;
    });
    this.sessions.set(system, created);
    return created;
  }

  async propose(input: { summary: PlanSummary; utterance: string; history: Turn[] }): Promise<Patch> {
    const lm = getLanguageModel();
    if (!lm) throw new Error("Tier 0 model unavailable");

    // A freeform level has no generator tree to restructure — see FREEFORM_PATCH_OPS.
    const ops = input.summary.mode === "freeform" ? FREEFORM_PATCH_OPS : CORE_PATCH_OPS;
    const system = buildSystemPrompt(ops);
    const user = buildUserPrompt({ ...input, tokenBudget: TOKEN_BUDGET });
    const schema = buildPatchJsonSchema(ops);

    try {
      // Returned unvalidated on purpose. The orchestrator validates every provider
      // response anyway (INF-4), and it is the only layer that can run the repair
      // retry — throwing here would turn a fixable bad answer into a dead turn.
      return safeJsonParse(await this.promptOnce(lm, system, user, schema)) as Patch;
    } catch (e) {
      // The browser can reclaim an idle on-device session — a tab left in the background
      // is the usual way — and a cached handle only reveals that when it is next used.
      // Rebuilding here costs the cold start once; surfacing it would cost the user their
      // turn as well, on a message that was fine, for a reason they can do nothing about.
      if (!isSessionGone(e)) throw e;
      this.sessions.delete(system);
      return safeJsonParse(await this.promptOnce(lm, system, user, schema)) as Patch;
    }
  }

  private async promptOnce(lm: BrowserLanguageModel, system: string, user: string, schema: unknown): Promise<string> {
    const base = await this.getBaseSession(lm, system);
    // Clone per turn (cheap — no model reinit) so each call is stateless: our own prompt
    // already carries summary+history (T0-3), so the session itself must not accumulate
    // its own turn-by-turn memory on top of that or context would double up and grow
    // unbounded. Browsers without clone() fall back to prompting the shared session directly.
    const session = base.clone ? await base.clone() : base;
    try {
      try {
        return await session.prompt(user, { responseConstraint: schema });
      } catch (e) {
        // Constrained decoding is the browser compiling our schema into a grammar, and
        // it can reject a schema it otherwise supports the shape of. That is a failure of
        // the constraint, not of the model — asking again in plain text usually answers
        // the question fine, and safeJsonParse plus the orchestrator's repair retry are
        // already built for un-constrained output. Only the retry's failure is surfaced.
        if (isSessionUnusable(e)) throw e;
        return await session.prompt(user);
      }
    } finally {
      if (session !== base) session.destroy?.();
    }
  }
}
