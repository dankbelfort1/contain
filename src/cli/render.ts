/**
 * Terminal rendering.
 *
 * The point of this file is that the harness should be visible while it runs. Someone
 * watching should be able to see the real scanner run, the sandbox come up, and the
 * agent stop at the gate, without being asked to trust that any of it happened.
 *
 * The approval prompt in particular is meant to be impossible to miss or to click
 * through by reflex.
 */
import type { PlanItem } from "../agent/plan.js";
import type { Severity } from "../templates/blast-radius.js";
import type { VerificationRecord } from "../tools/verify.js";
import type { SecretStatus } from "../types.js";

const useColour = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;

// Written as an escape rather than a literal control character, which does not
// survive copy-paste or every editor.
const ESC = "\u001b";

const code = (n: string) => (text: string) => (useColour ? `${ESC}[${n}m${text}${ESC}[0m` : text);

export const bold = code("1");
export const dim = code("2");
export const red = code("31");
export const green = code("32");
export const yellow = code("33");
export const blue = code("34");
export const magenta = code("35");
export const cyan = code("36");

const WIDTH = 74;

export function rule(char = "─"): string {
  return dim(char.repeat(WIDTH));
}

export function heading(step: string, title: string): string {
  return `\n${bold(cyan(step))}  ${bold(title)}\n${rule()}`;
}

export function statusBadge(status: SecretStatus): string {
  switch (status) {
    case "LIVE":
      return red(bold(" LIVE "));
    case "DEAD":
      return green(" DEAD ");
    case "UNKNOWN":
      return yellow(" UNKNOWN ");
    default:
      return dim(" UNVERIFIED ");
  }
}

export function severityLabel(severity: Severity): string {
  const colour = { critical: red, high: magenta, medium: yellow, low: dim }[severity];
  return colour(severity.toUpperCase());
}

/**
 * Pad to a visible width, ignoring colour codes.
 *
 * String.padEnd counts escape sequences as characters, so a coloured cell pads short
 * and the panel border comes out ragged. Measure what a terminal actually shows.
 */
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

export function padVisible(text: string, width: number): string {
  const visibleLength = text.replace(ANSI_PATTERN, "").length;
  return text + " ".repeat(Math.max(0, width - visibleLength));
}

/**
 * Strip control characters from untrusted text before printing it.
 *
 * Commit messages, author names and file paths come from the repository being scanned,
 * which is by definition not ours. Printed raw, a crafted commit message could move the
 * cursor, clear the screen, or repaint the approval panel to say something other than
 * what is about to happen. The gate is only meaningful if it cannot be forged.
 */
export function safe(text: string): string {
  return String(text)
    .split("")
    .filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp < 32 || cp === 127) return false; // C0 controls and DEL
      if (cp >= 0x80 && cp <= 0x9f) return false; // C1 controls
      if (BIDI_AND_INVISIBLE.has(cp)) return false;
      return true;
    })
    .join("");
}

/**
 * Bidirectional overrides and invisible characters.
 *
 * Stripping the C0 range alone is not enough. These are printable by the usual test but
 * reorder what a terminal displays, so a commit message can be written to render as
 * something other than what it contains. That is the Trojan Source trick, and the
 * approval panel is exactly the place it would pay off.
 */
const BIDI_AND_INVISIBLE = new Set([
  0x200b, 0x200c, 0x200d, // zero width space, non-joiner, joiner
  0x200e, 0x200f, // left-to-right and right-to-left marks
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // embedding and override
  0x2066, 0x2067, 0x2068, 0x2069, // isolates
  0xfeff, // zero width no-break space
]);

/** Wrap prose to the panel width, preserving whole words. */
export function wrap(text: string, indent = 0, width = WIDTH): string[] {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  let current = "";

  for (const word of text.split(/\s+/)) {
    if (current.length + word.length + 1 > width - indent) {
      lines.push(pad + current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(pad + current);
  return lines;
}

export function renderVerification(record: VerificationRecord, location: string, masked: string): string {
  const out: string[] = [];
  out.push(`  ${statusBadge(record.status)}  ${bold(safe(masked))}  ${dim(safe(location))}`);
  out.push(
    dim(
      `         template ${record.templateId ?? "none"} | sandbox ${record.sandboxKind ?? "none"} | ${record.elapsedMs}ms`,
    ),
  );

  if (record.status === "LIVE") {
    out.push("");
    for (const line of wrap(safe(record.blastRadius.headline), 9)) out.push(red(line));
    if (record.blastRadius.reach.length > 0) {
      out.push(dim(`         reaches: ${record.blastRadius.reach.join("; ")}`));
    }
    out.push("");
    out.push(dim("         what this key can do:"));
    for (const capability of record.blastRadius.capabilities.slice(0, 6)) {
      out.push(`           ${severityLabel(capability.severity).padEnd(18)} ${capability.plain}`);
    }
    const rest = record.blastRadius.capabilities.length - 6;
    if (rest > 0) out.push(dim(`           and ${rest} more`));
  } else if (record.reason) {
    for (const line of wrap(record.reason, 9)) out.push(dim(line));
  }

  return out.join("\n");
}

export function renderPlanItem(item: PlanItem, index: number): string {
  const out: string[] = [];
  const gate = item.requiresApproval
    ? red(bold("APPROVAL REQUIRED"))
    : green("no approval needed");

  out.push(`  ${bold(`${index + 1}.`)} ${statusBadge(item.status)} ${bold(safe(item.location))}`);
  out.push(`     action: ${bold(item.action)}   ${gate}`);
  for (const line of wrap(safe(item.reason), 5)) out.push(dim(line));
  return out.join("\n");
}

/**
 * The gate.
 *
 * Rendered as a full-width panel rather than a one-line prompt, because this is the
 * moment the whole design exists for and it should read as a stop, not a formality.
 */
export function renderApprovalGate(item: PlanItem): string {
  const out: string[] = [];
  out.push("");
  out.push(red(bold("┌" + "─".repeat(WIDTH - 2) + "┐")));
  out.push(red(bold("│")) + padVisible(bold("  HUMAN APPROVAL REQUIRED"), WIDTH - 2) + red(bold("│")));
  out.push(red(bold("│")) + "  This action may affect production.".padEnd(WIDTH - 2) + red(bold("│")));
  out.push(red(bold("├" + "─".repeat(WIDTH - 2) + "┤")));

  const rows = [
    ["credential", safe(item.maskedSecret)],
    ["found at", safe(item.location)],
    ["status", safe(item.status)],
    ["action", safe(item.action)],
  ];
  for (const [label, value] of rows) {
    const cell = `  ${dim((label ?? "").padEnd(12))}${value ?? ""}`;
    out.push(red(bold("│")) + padVisible(cell, WIDTH - 2) + red(bold("│")));
  }

  out.push(red(bold("│")) + " ".repeat(WIDTH - 2) + red(bold("│")));
  for (const line of wrap(safe(item.blastRadius), 2, WIDTH - 4)) {
    out.push(red(bold("│")) + line.padEnd(WIDTH - 2) + red(bold("│")));
  }
  out.push(red(bold("│")) + " ".repeat(WIDTH - 2) + red(bold("│")));
  out.push(
    red(bold("│")) +
      "  Revoking is permanent. GitHub cannot restore it.".padEnd(WIDTH - 2) +
      red(bold("│")),
  );
  out.push(red(bold("└" + "─".repeat(WIDTH - 2) + "┘")));
  return out.join("\n");
}
