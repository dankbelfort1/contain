/**
 * Captures the real interface at laptop resolution, one PNG per state.
 *
 * These are screenshots of the running application, not mockups, so an interactive
 * prototype built from them behaves like the thing it depicts. Every screen is exactly
 * one 1440x900 laptop viewport, scrolled to the part of the page that step is about, so
 * the frames can be wired together without any of them needing to scroll.
 *
 * Point it at a server started with --dry-run. The approve and revoke steps press the
 * real buttons, and in dry-run mode that records the decision without destroying a
 * credential, so the capture can be repeated.
 *
 *   npm run ui:dry            # terminal 1
 *   npm run screens           # terminal 2
 */
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = process.env.CONTAIN_UI_URL ?? "http://localhost:8910";
const OUT = "ui-screens";

// A common laptop viewport. Deliberately not a desktop size: the demo is watched on a
// laptop, and a wider capture would shrink the type in the prototype.
const VIEWPORT = { width: 1440, height: 900 };

/** The approval panel, not the rail step that happens to share its class name. */
const GATE = "div.gate:has-text('HUMAN APPROVAL REQUIRED')";

async function screen(page, name) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`  ${name}.png`);
}

/** Put a section at the top of the viewport, with a little breathing room above it. */
async function focus(page, selector, offset = 40) {
  await page.evaluate(
    ({ sel, off }) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY - off;
      window.scrollTo({ top, behavior: "instant" });
    },
    { sel: selector, off: offset },
  );
  await page.waitForTimeout(250);
}

/**
 * Centre the approval panel in the viewport, so it sits alone on the screen.
 *
 * Found by its heading text rather than by class: the stage rail's "Human approval"
 * step carries the same class name and appears first in the document, so a plain
 * class selector cropped the wrong element.
 */
async function centreGate(page) {
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("div.gate")].find((n) =>
      n.textContent?.includes("HUMAN APPROVAL REQUIRED"),
    );
    if (!el) return;
    const box = el.getBoundingClientRect();
    window.scrollTo({
      top: box.top + window.scrollY - (window.innerHeight - box.height) / 2,
      behavior: "instant",
    });
  });
  await page.waitForTimeout(250);
}

async function click(page, label) {
  await page.getByRole("button", { name: label }).click();
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: VIEWPORT,
    // Retina, so the prototype stays sharp when a tool scales it.
    deviceScaleFactor: 2,
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(() => fetch("/api/reset", { method: "POST" }));
  await page.reload({ waitUntil: "networkidle" });

  console.log(`capturing ${VIEWPORT.width}x${VIEWPORT.height} at 2x from ${BASE}\n`);

  await screen(page, "01-start");

  await click(page, "1. Scan repository");
  await page.waitForSelector("table", { timeout: 30_000 });
  await focus(page, "table");
  await screen(page, "02-findings");

  await click(page, "2. Verify in sandbox");
  await page.waitForSelector("text=BLAST RADIUS", { timeout: 90_000 });
  await focus(page, "table");
  await screen(page, "03-verified");

  await focus(page, ".blast", 120);
  await screen(page, "04-blast-radius");

  await click(page, "3. Build plan");
  await page.waitForSelector(GATE, { timeout: 30_000 });
  await page.evaluate(() => {
    const heads = [...document.querySelectorAll("h2")];
    const plan = heads.find((h) => h.textContent?.includes("REMEDIATION PLAN"));
    if (plan) window.scrollTo({ top: plan.getBoundingClientRect().top + window.scrollY - 40 });
  });
  await screen(page, "05-plan");

  await centreGate(page);
  await screen(page, "06-the-gate");

  await click(page, "Approve revocation");
  await page.waitForSelector("text=Revoke now", { timeout: 30_000 });
  await centreGate(page);
  await screen(page, "07-approved");

  await click(page, "Revoke now");
  await page.waitForTimeout(2500);
  await centreGate(page);
  await screen(page, "08-confirmed");

  await page.evaluate(() => {
    const heads = [...document.querySelectorAll("h2")];
    const trail = heads.find((h) => h.textContent?.includes("AUDIT TRAIL"));
    if (trail) window.scrollTo({ top: trail.getBoundingClientRect().top + window.scrollY - 40 });
  });
  await screen(page, "09-audit-trail");

  await browser.close();
  console.log(`\n9 screens at ${VIEWPORT.width}x${VIEWPORT.height} (2x) in ${OUT}/`);
}

await main();
