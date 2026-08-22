// Smoke tests for FR-7 direct manipulation against a real browser, not just the
// dragPlan.ts unit math. Each test gets a fresh browser context (Playwright's default),
// so IndexedDB starts empty and every run begins from the same blank plan.

import { test, expect, type Page } from "@playwright/test";

async function addRoomsForOneWall(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Manual editor" }).click();

  const addRoomFieldset = page.locator("fieldset").filter({ has: page.locator("legend", { hasText: "Add room" }) });
  const programSelect = addRoomFieldset.locator("select").first();
  const addRoomButton = page.getByRole("button", { name: "Add room", exact: true });

  // Default program is "kitchen" (first entry in ROOM_PROGRAM_MIN_DIMENSIONS).
  await addRoomButton.click();
  await expect(page.locator("polygon[data-room-id]")).toHaveCount(1);

  await programSelect.selectOption("living");
  await addRoomButton.click();
  await expect(page.locator("polygon[data-room-id]")).toHaveCount(2);

  // Two rooms with no adjacency hint produce exactly one split, hence one interior wall.
  await expect(page.locator(".fc-wall-grab")).toHaveCount(1);
}

test("adding two rooms renders a draggable interior wall", async ({ page }) => {
  await page.goto("/");
  await addRoomsForOneWall(page);
});

test("dragging a wall resizes the adjoining rooms and is undoable (FR-7, FR-3, SLV-5)", async ({ page }) => {
  await page.goto("/");
  await addRoomsForOneWall(page);

  const firstRoom = page.locator("polygon[data-room-id]").first();
  const before = await firstRoom.getAttribute("points");

  const wall = page.locator(".fc-wall-grab").first();
  const box = await wall.boundingBox();
  if (!box) throw new Error("wall handle has no bounding box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy, { steps: 8 });
  await page.mouse.up();

  await expect(async () => {
    const after = await firstRoom.getAttribute("points");
    expect(after).not.toBe(before);
  }).toPass({ timeout: 2000 });

  // FR-3: every applied patch, including a drag, is reversible via undo.
  const undoButton = page.getByRole("button", { name: "Undo" });
  await expect(undoButton).toBeEnabled();
  await undoButton.click();

  await expect(async () => {
    const restored = await firstRoom.getAttribute("points");
    expect(restored).toBe(before);
  }).toPass({ timeout: 2000 });
});

test("double-clicking a room label renames it inline (FR-7)", async ({ page }) => {
  await page.goto("/");
  await addRoomsForOneWall(page);

  // The visible <text> sits under an invisible .fc-label-grab rect (added after it in
  // the same <g>, so it paints on top) that exists to give the label a bigger touch
  // target (FR-9). A real double-click on the label actually lands on that rect, not the
  // text — and it carries the same data-room-id, so canvas.ts resolves the room from it
  // via closest(). Target the rect here to match what a real pointer hits.
  const labelHandle = page.locator('.fc-label-grab[data-room-id="room-0"]');
  await labelHandle.dblclick();

  const input = page.locator("input.inline-rename");
  await expect(input).toBeVisible();
  await input.fill("Great Room");
  await input.press("Enter");

  await expect(page.locator('[data-label-room-id="room-0"] text').first()).toHaveText("Great Room");
});

test("resizing the outer boundary via its handle changes the footprint (FR-7)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Manual editor" }).click();

  const statusBefore = await page.locator(".canvas-status").textContent();

  const handle = page.locator('[data-drag="boundary"][data-handle="southeast"]');
  const box = await handle.boundingBox();
  if (!box) throw new Error("boundary handle has no bounding box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 60, { steps: 6 });
  await page.mouse.up();

  await expect(async () => {
    const statusAfter = await page.locator(".canvas-status").textContent();
    expect(statusAfter).not.toBe(statusBefore);
  }).toPass({ timeout: 2000 });
});

test("with no inference tier reachable, chat is disabled and manual editing still works (RTE-4)", async ({ page }) => {
  await page.goto("/");
  // Tier 0 is Chrome-desktop-only and unavailable in this sandboxed browser profile;
  // Tier 1 needs a live Turnstile secret this local run doesn't have configured — so the
  // release-blocking fallback (RTE-4) is exactly what should be showing here.
  const chatDisabledNote = page.locator(".chat-disabled-note");
  await expect(chatDisabledNote).toBeVisible({ timeout: 10_000 });

  await addRoomsForOneWall(page);
  await expect(page.locator("polygon[data-room-id]")).toHaveCount(2);
});
