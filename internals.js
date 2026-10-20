/**
 * Internal helpers for mighty-reviewer, kept OUT of index.js on purpose:
 * opencode calls every export of a plugin module as a plugin factory and
 * registers the return value as a hooks object, so any helper exported from
 * the plugin entry point (returning null/objects that are not hooks) breaks
 * opencode's bootstrap. Test-only and shared helpers live here instead.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

export const PKG_NAME = "mighty-reviewer";
// Shown in the sidebar header; read from package.json so it cannot drift
// from the published version. Empty when the lookup fails (odd loaders).
export const PKG_VERSION = readPackageVersion();

function readPackageVersion() {
  try {
    return createRequire(import.meta.url)("./package.json").version ?? "";
  } catch {
    return "";
  }
}

// Metadata key both the server side (index.js, v2.js) and the TUI side
// (tui.js, sidebar.js) read and write: notices queued as synthetic inbox
// items, and the review-progress snapshot kept on the review session itself.
export const METADATA_KEY = "mightyReviewer";

// npm dist-tag names never contain range operators or whitespace; anything
// else ("^0.4.0", "~1.x") must not be silently retargeted to latest.
const DIST_TAG = /^[A-Za-z][0-9A-Za-z._-]*$/;

// The prompt requires the verdict as the single word SHIP or NO-SHIP on
// its own line, so take the last such line, tolerating markdown wrappers
// (**SHIP**, ## SHIP, - SHIP), a "Verdict:" prefix, and trailing
// punctuation. No substring fallback: the report body legitimately
// contains phrases like "forces NO-SHIP" that must never win; with no
// verdict line the caller shows a neutral toast instead of guessing.
export function extractVerdict(text) {
  if (typeof text !== "string") return null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
      .replace(/[*_`]/g, "")
      .replace(/^\s*(?:#{1,6}|[->]|\d+\.)?\s*(?:verdict\s*:)?\s*/i, "")
      .replace(/[.:!\s]+$/, "");
    if (/^NO-SHIP$/i.test(line)) return "NO-SHIP";
    if (/^SHIP$/i.test(line)) return "SHIP";
  }
  return null;
}

export function compareSemver(a, b) {
  const parse = (v) => {
    const [core, ...pre] = String(v).split("-");
    const [major, minor, patch] = core.split(".").map((n) => parseInt(n, 10) || 0);
    return { major, minor, patch, pre: pre.join("-") };
  };
  const x = parse(a);
  const y = parse(b);
  for (const key of ["major", "minor", "patch"]) {
    if (x[key] !== y[key]) return x[key] - y[key];
  }
  if (!x.pre && y.pre) return 1;
  if (x.pre && !y.pre) return -1;
  if (!x.pre && !y.pre) return 0;
  return comparePrerelease(x.pre, y.pre);
}

// Semver 11.4: dot-separated identifiers compared left to right, numeric
// identifiers compared numerically and sorting below alphanumeric ones,
// fewer identifiers sorting first when all shared ones are equal.
function comparePrerelease(a, b) {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (as[i] === undefined) return -1;
    if (bs[i] === undefined) return 1;
    const aNum = /^\d+$/.test(as[i]);
    const bNum = /^\d+$/.test(bs[i]);
    if (aNum && bNum) {
      const diff = Number(as[i]) - Number(bs[i]);
      if (diff !== 0) return diff;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (as[i] !== bs[i]) {
      return as[i] < bs[i] ? -1 : 1;
    }
  }
  return 0;
}

// opencode installs npm plugins into
// <cache>/packages/<spec>/node_modules/mighty-reviewer/, so the <spec>
// directory name carries the pin/channel signal ("mighty-reviewer",
// "mighty-reviewer@1.2.3", "mighty-reviewer@beta"). Local file installs
// return null; the user manages those.
export function describeInstall(moduleUrl) {
  let filePath;
  try {
    filePath = fileURLToPath(moduleUrl);
  } catch {
    return null;
  }
  const marker = `${path.sep}node_modules${path.sep}${PKG_NAME}${path.sep}`;
  const idx = filePath.lastIndexOf(marker);
  if (idx === -1) return null;
  const workspaceDir = filePath.slice(0, idx);
  const specDir = path.basename(workspaceDir);
  // Only opencode's own cache workspaces are managed. A nested install
  // (another package depending on us) has the parent package's name here,
  // and rewriting that parent's manifest would override its constraints.
  if (specDir !== PKG_NAME && !specDir.startsWith(`${PKG_NAME}@`)) return null;
  let pinned = false;
  let channel = "latest";
  if (specDir.startsWith(`${PKG_NAME}@`)) {
    const spec = specDir.slice(PKG_NAME.length + 1);
    if (DIST_TAG.test(spec)) channel = spec;
    else pinned = true;
  }
  return { workspaceDir, pinned, channel };
}

// ---------------------------------------------------------------- findings
//
// Lives here, not in sidebar.js, so smoke-test.mjs can exercise it directly:
// sidebar.js imports @opentui/solid at module load, which is only present
// inside the OpenCode TUI host and never installed for plain Node test runs.

export const SEVERITIES = ["P0", "P1", "P2", "P3"];

const DECORATION = /^(?:\s+|[#>*+|-]+|\d+[.)]|__|[[(`])/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s*#/;
const TOP_LEVEL_ITEM = /^ ?(?:[-*+]|\d+[.)])\s/;
const STRUCTURAL = /^\s*(?:#|[-*+]\s|\d+[.)]\s|\|)/;
const LEADING_TAG = /^(P[0-3])\b/i;
const FIELD_TAG = /^severity\b[\s*_]*[:=-]?[\s*_]*[[(`]?\s*(P[0-3])\b/i;
const BRACKET_TAG = /[[(](P[0-3])[\])]/i;
// A bare severity label used as a group heading: "### P1", "**P2 findings**",
// "P1 - High:", "P3 (nits)". Items listed under it carry its severity.
const GROUP_LABEL =
  /^(P[0-3])\b[\s*_:\u2013-]*(?:\(?\s*(?:critical|high|medium|low|minor|major|nits?|findings?|issues?|blocking|none|n\/a|nothing)(?:\s+(?:findings?|issues?))?\s*\)?)?[\s*_:.\u2013-]*$/i;
const EMPTY_LABEL = /\b(?:none|n\/a|nothing)\b/i;
// After a tag on a plain paragraph line, only a separator marks a finding
// ("P1: foo.ts:3 ...", "P2 - ..."); "P1 is reserved for ..." is prose.
const PLAIN_SEPARATOR = /^[\])*_`]*\s*[:|\u2013-]/;
// What may follow a leading tag without it being a finding: a range or pair
// ("P0-P3", "P0/P1"), prose about the severity itself ("P1 findings must"),
// a summary of nothing ("P1: none"), or a bare tally ("P1: 2").
const NOT_A_FINDING =
  /^(?:\s*[-/\u2013]\s*P?[0-3]\b|[\s\])`*_:\u2013-]*findings?\b|[\s\])`*_:\u2013-]*(?:none|n\/a|nothing)\b|[\s\])`*_:=\u2013-]*\d+[\s*_.]*$)/i;

/**
 * Counts one report's (a critic's, or the review's own merged report)
 * findings by severity, and keeps the raw line each counted finding came
 * from so a detail view can show them.
 *
 * The critic prompts (index.js AGENT_DEFINITIONS) require a P0-P3 severity on
 * every finding but leave the layout free, so three shapes are recognized,
 * each only at the start of a line after markdown decoration
 * (#, -, *, 1., |, **):
 *   - a severity tag that opens the finding: "### [P1] ...", "- **P2** ...",
 *     "| P3 | file:line |", or a bracketed tag in a heading or list item;
 *   - a group heading that is only a severity label ("### P1", "**P2**"),
 *     where each top-level list item under it is one finding;
 *   - a severity field inside a finding block: "- Severity: P1".
 * A finding written in two shapes (tagged heading plus a Severity field)
 * must count once, so field lines are tallied separately and the larger
 * tally wins. Severity mentions inside prose, ranges like "P0-P3", and lines
 * like "P1: none" or "P1: 2" never count. Code fences are skipped.
 */
export function countFindings(report) {
  const tagged = emptyCounts();
  const fields = emptyCounts();
  const taggedLines = emptyLines();
  const fieldLines = emptyLines();
  let fenced = false;
  let section = null;
  let sectionLevel = 0;
  let sectionByHeadings = false;
  for (const raw of String(report ?? "").split("\n")) {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !raw.trim()) continue;
    const line = stripDecoration(raw);
    const isItem = TOP_LEVEL_ITEM.test(raw);
    const structural = STRUCTURAL.test(raw);
    const level = headingLevel(raw);

    const group = isGroupLine(raw, isItem) ? GROUP_LABEL.exec(line) : null;
    if (group) {
      section = EMPTY_LABEL.test(line) ? null : group[1].toUpperCase();
      sectionLevel = level || 99;
      sectionByHeadings = false;
      continue;
    }
    // A deeper heading inside a severity group is one finding of that group;
    // a heading at the group's level or above ends the group.
    const subHeading = level > 0 && section !== null && level > sectionLevel;
    if (level > 0 && !subHeading) section = null;
    // Once a group lists its findings as sub-headings, list items below them
    // are details of those findings, not findings of their own.
    if (subHeading) sectionByHeadings = true;

    const field = FIELD_TAG.exec(line);
    if (field) {
      const severity = field[1].toUpperCase();
      fields[severity] += 1;
      fieldLines[severity].push(raw.trim());
      continue;
    }
    const lead = LEADING_TAG.exec(line);
    const rest = lead ? line.slice(lead[0].length) : "";
    const leadCounts = lead && !NOT_A_FINDING.test(rest) && (structural || PLAIN_SEPARATOR.test(rest));
    const bracket = lead || !structural ? null : BRACKET_TAG.exec(line);
    const tag = leadCounts ? lead[1] : bracket?.[1];
    if (tag) {
      const severity = tag.toUpperCase();
      tagged[severity] += 1;
      taggedLines[severity].push(raw.trim());
    } else if (!lead && section && (subHeading || (isItem && !sectionByHeadings))) {
      tagged[section] += 1;
      taggedLines[section].push(raw.trim());
    }
  }
  const useTagged = sumCounts(tagged) >= sumCounts(fields);
  return { counts: useTagged ? tagged : fields, lines: useTagged ? taggedLines : fieldLines };
}

function headingLevel(raw) {
  const match = /^\s*(#+)\s/.exec(raw);
  return match ? match[1].length : 0;
}

// Group labels only come as headings, bold lines, or lines ending in ":".
function isGroupLine(raw, isItem) {
  if (isItem) return false;
  return HEADING.test(raw) || /^\s*(\*\*|__).*(\*\*|__)\s*:?\s*$/.test(raw) || /:\s*$/.test(raw);
}

function stripDecoration(line) {
  let rest = line;
  for (let previous = null; previous !== rest; ) {
    previous = rest;
    rest = rest.replace(DECORATION, "");
  }
  return rest;
}

function emptyCounts() {
  return { P0: 0, P1: 0, P2: 0, P3: 0 };
}

function emptyLines() {
  return { P0: [], P1: [], P2: [], P3: [] };
}

function sumCounts(counts) {
  return SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0);
}

// ---------------------------------------------------------------- sidebar formatting

/**
 * Compact elapsed time for the sidebar's review row: "42s" under a minute,
 * "1m42" under an hour, "1h05" beyond that.
 */
export function formatCompactElapsed(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}`;
  return `${seconds}s`;
}

/**
 * Compact token count for a critic row's right edge: "12k" at or above a
 * thousand, the bare digits below it, null when there is nothing to show.
 */
export function formatTokenCount(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1000) return String(Math.round(n));
  return `${Math.round(n / 1000)}k`;
}

/**
 * One entry per severity, in a fixed P0-P3 order, for the sidebar's
 * constant-position severity run: a counted label ("2 P3") where the count
 * is positive, a zero marker ("\u00b7") the caller renders faint otherwise.
 */
export function severityTokens(counts) {
  return SEVERITIES.map((severity) => {
    const count = counts?.[severity] ?? 0;
    return { severity, count, label: count > 0 ? `${count} ${severity}` : "\u00b7" };
  });
}
