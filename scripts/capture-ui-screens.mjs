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

/**
 * Capture the confirmed-dead screen, which needs a real revocation.
 *
 * Off by default. The dry-run capture ends on "Not confirmed. Dry run. No request was
 * sent.", which is honest but useless in a demo, so that screen is skipped rather than
 * shipped misleading. Pass --real against a server started WITHOUT --dry-run to get the
 * genuine one, and understand that doing so destroys the credential permanently.
 *
 * The natural moment for that is while recording the demo video, when the token is
 * being spent anyway.
 */
const REAL = process.argv.includes("--real");

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

/**
 * Screenshot a viewport-sized window positioned over a section, using a clip rather
 * than a scroll.
 *
 * Scrolling cannot put a section at the top of the screen when it sits near the bottom
 * of the page: the browser clamps, and the capture ends up showing whatever is above
 * it. That is how the audit trail screen came out showing the approval panel and its
 * dry-run message instead.
 */
async function clipTo(page, headingText, name) {
  const y = await page.evaluate((text) => {
    // Case-insensitive. The headings are uppercased by CSS, so the DOM text reads
    // "Audit trail" while the screen reads "AUDIT TRAIL". Matching the rendered form
    // found nothing, and the fallback clipped from the top of the page.
    const wanted = text.toLowerCase();
    const heading = [...document.querySelectorAll("h2")].find((h) =>
      h.textContent?.toLowerCase().includes(wanted),
    );
    if (!heading) throw new Error(`no heading matching "${text}"`);
    return heading.getBoundingClientRect().top + window.scrollY - 40;
  }, headingText);

  // Give the page room below the fold, or a clip that runs past the last element comes
  // back short and the screen no longer matches the others.
  await page.evaluate(() => {
    document.body.style.paddingBottom = "1000px";
  });

  await page.screenshot({
    path: `${OUT}/${name}.png`,
    fullPage: true,
    clip: { x: 0, y, width: VIEWPORT.width, height: VIEWPORT.height },
  });

  await page.evaluate(() => {
    document.body.style.paddingBottom = "";
  });
  console.log(`  ${name}.png`);
}

/**
 * Centre the approval panel in the viewport, so it sits alone on the screen.
 *
 * Found by its heading text rather than by class: the stage rail's "Human approval"
 * step carries the same class name and appears first in the document, so a plain class
 * selector cropped the wrong element.
 */
/**
 * Fill the frame with one section, on its own.
 *
 * The audit trail is shorter than the viewport and sits at the end of the page, so both
 * scrolling and centring left most of the frame empty. This lifts a copy of the section
 * onto a full-screen backdrop instead, which gives it even margins and reads as a
 * deliberate slide rather than as the bottom of a page.
 */
async function spotlight(page, headingText, name) {
  await page.evaluate(
    ({ text, ground }) => {
      const wanted = text.toLowerCase();
      const heading = [...document.querySelectorAll("h2")].find((h) =>
        h.textContent?.toLowerCase().includes(wanted),
      );
      if (!heading) throw new Error(`no heading matching "${text}"`);

      const section = heading.closest("section") ?? heading.parentElement;
      const holder = document.createElement("div");
      holder.id = "contain-spotlight";
      holder.style.cssText = [
        "position:fixed",
        "inset:0",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        `background:${ground}`,
        "z-index:9999",
      ].join(";");

      const copy = section.cloneNode(true);
      copy.style.width = `${section.getBoundingClientRect().width}px`;
      holder.appendChild(copy);
      document.body.appendChild(holder);
    },
    { text: headingText, ground: "#0d1117" },
  );

  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  await page.evaluate(() => {
    document.getElementById("contain-spotlight")?.remove();
  });
  console.log(`  ${name}.png`);
}

async function centreGate(page) {
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("div.gate")].find((n) =>
      n.textContent?.includes("HUMAN APPROVAL REQUIRED"),
    );
    if (!el) throw new Error("approval panel not found");
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
  await clipTo(page, "Findings", "02-findings");

  await click(page, "2. Verify in sandbox");
  // Wait for the results heading, not for any element containing the words. A plain
  // text selector matched the stage rail's "Blast radius" step, which is on screen from
  // the start, so the script raced ahead before verification had finished.
  await page
    .getByRole("heading", { name: /blast radius . what the live credential/i })
    .waitFor({ timeout: 90_000 });
  await clipTo(page, "Findings", "03-verified");
  await clipTo(page, "Blast radius", "04-blast-radius");

  await click(page, "3. Build plan");
  await page.waitForSelector(GATE, { timeout: 30_000 });
  await clipTo(page, "REMEDIATION PLAN", "05-plan");

  await centreGate(page);
  await screen(page, "06-the-gate");

  await click(page, "Approve revocation");
  await page.waitForSelector("text=Revoke now", { timeout: 30_000 });
  await centreGate(page);
  await screen(page, "07-approved");

  if (REAL) {
    await click(page, "Revoke now");
    await page.waitForTimeout(3000);
    await centreGate(page);
    await screen(page, "08-confirmed");
  } else {
    console.log("  08-confirmed.png          skipped (needs --real, which spends a token)");
  }

  await spotlight(page, "Audit trail", "09-audit-trail");

  await browser.close();
  console.log(`\n9 screens at ${VIEWPORT.width}x${VIEWPORT.height} (2x) in ${OUT}/`);
}

await main();
