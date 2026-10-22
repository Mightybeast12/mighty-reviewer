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

// ---------------------------------------------------------------- review sessions
//
// Shared by sidebar.js (the panel) and tui.js (the phase-toast watcher), so
// both read the review session's title the same way: the title index.js
// gives review sessions, with phase suffixes appended as
// "Adversarial review - <phase>" (setReviewTitle).

export const REVIEW_TITLE = "Adversarial review";

export function isReviewSession(info) {
  return typeof info?.title === "string" && info.title.startsWith(REVIEW_TITLE);
}

export function phaseOf(title) {
  const rest = title.slice(REVIEW_TITLE.length).replace(/^\s*-\s*/, "").trim();
  return rest || "starting";
}

export const TERMINAL_PHASES = new Set(["SHIP", "NO-SHIP", "done", "timed out"]);

// Final assistant text of a session, or null when there is none yet.
// `order` says whether `messages` is oldest-first or newest-first; either
// way the search walks newest-first so the latest assistant turn wins.
export function extractAssistantReport(messages, order) {
  const list = order === "asc" ? [...messages].reverse() : messages;
  for (const message of list) {
    if (message?.type !== "assistant" && message?.info?.role !== "assistant") continue;
    const parts = message.content ?? message.parts ?? [];
    const text = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

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

// A heading named one of these starts a section that is never counted as
// findings: what the adversarial-verification step in index.js's review
// prompt refuted or dropped, an aside about what is not a finding, a
// mechanical-gates summary, or a skip note. The review's final report is
// free-form (its prompt only mandates "the FULL findings report", not any
// particular heading), so these sections, when a model adds them for
// transparency, can list the very things that must NOT be counted again.
const VERIFIED_STOP_HEADING = /^(?:refuted|dropped|not\s+findings|verified\s+clean|skipped|mechanical\s+gates)\b/i;
// An explicit "Findings" heading marks where counting may start; without
// one (the common case, since it is not required), counting starts at the
// top of the report instead.
const VERIFIED_START_HEADING = /^findings\b/i;

/**
 * Counts the review session's own merged report (index.js's final SHIP /
 * NO-SHIP turn), which is shaped very differently from a single critic's
 * report: it is a flat, severity-ranked list of surviving findings,
 * sometimes followed by sections a model adds for transparency about what
 * it refuted, dropped, judged not a finding, found clean, or skipped
 * (VERIFIED_STOP_HEADING above). Those sections, and any sub-bullet detail
 * line under a finding (file/fix/evidence lines), must never be counted:
 * only a line that itself starts with a P0-P3 tag, at the top level
 * (a heading, a top-level list item, or a table row, never an indented
 * sub-bullet), counts as one finding. The result is capped at `rawTotal`
 * (the critics' combined raw count), since the review can only drop or
 * merge findings, never invent new ones out of thin air, so "verified N of
 * M" can never show N > M. Returns null when `report` is not a string, or
 * parsing throws, so the caller can omit the suffix instead of showing a
 * wrong number.
 */
export function countVerifiedFindings(report, rawTotal) {
  const detail = verifiedFindingsDetail(report);
  if (!detail) return null;
  const count = sumCounts(detail.counts);
  return Number.isFinite(rawTotal) ? Math.min(count, Math.max(0, rawTotal)) : count;
}

/**
 * Same scoping as countVerifiedFindings (the Findings section only, the
 * same refuted/dropped/mechanical-gates asides excluded, sub-bullets never
 * counted), but keeping the per-severity counts and the raw line behind
 * each counted finding instead of collapsing them into one total. Used by
 * the NO-SHIP summary line (formatNoShipSummary) and by the TUI's phase
 * toast (tui.js), both of which need "how many of each severity" rather
 * than just "how many".
 */
export function topVerifiedFinding(report) {
  const detail = verifiedFindingsDetail(report);
  if (!detail) return null;
  const topLine = detail.lines.P0[0] ?? detail.lines.P1[0] ?? null;
  return { counts: detail.counts, topLine };
}

// A finding line's own text, with its markdown decoration and leading
// severity tag stripped, clipped to `max` characters (ellipsis on the end,
// never the middle) so a toast or synthetic-message summary line stays
// short regardless of how verbose the model's finding title was.
export function clipFindingTitle(line, max = 80) {
  if (typeof line !== "string" || !line) return "";
  const stripped = stripDecoration(line).trim();
  const withoutTag = stripped.replace(/^\[?P[0-3]\]?[\s:*_.\u2013-]*/i, "").trim();
  const text = withoutTag || stripped;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text;
}

/**
 * The one-line NO-SHIP summary index.js leads its synthetic notice with:
 * the top finding (first P0, else first P1, from the Findings section)
 * plus the verified P0/P1/P2 counts. Null when `report` is not a usable
 * string, so the caller can fall back to a generic message instead of
 * showing "undefined".
 */
export function formatNoShipSummary(report) {
  const detail = topVerifiedFinding(report);
  if (!detail) return null;
  const { counts, topLine } = detail;
  const title = topLine ? clipFindingTitle(topLine) : "no finding details captured";
  return `NO-SHIP: ${title} (${counts.P0} P0, ${counts.P1} P1, ${counts.P2} P2) \u00b7 fixes requested`;
}

// Scans the review's own merged report for VERIFIED_START_HEADING /
// VERIFIED_STOP_HEADING scoping (see countVerifiedFindings' doc comment),
// then tags every top-level finding line in that range with its severity.
// Null when `report` is not a string, or parsing throws.
function verifiedFindingsDetail(report) {
  if (typeof report !== "string") return null;
  try {
    const lines = report.split("\n");
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      const label = headingLabel(lines[i]);
      if (label !== null && VERIFIED_START_HEADING.test(label)) {
        start = i + 1;
        break;
      }
    }
    let end = lines.length;
    for (let i = start; i < lines.length; i++) {
      const label = headingLabel(lines[i]);
      if (label !== null && VERIFIED_STOP_HEADING.test(label)) {
        end = i;
        break;
      }
    }
    let fenced = false;
    const counts = emptyCounts();
    const findingLines = emptyLines();
    for (let i = start; i < end; i++) {
      const raw = lines[i];
      if (FENCE.test(raw)) {
        fenced = !fenced;
        continue;
      }
      if (fenced || !raw.trim()) continue;
      const severity = topLevelFindingSeverity(raw);
      if (severity) {
        counts[severity] += 1;
        findingLines[severity].push(raw.trim());
      }
    }
    return { counts, lines: findingLines };
  } catch {
    return null;
  }
}

// A heading's bare text, whether written as an ATX heading ("### Refuted")
// or a whole bold line ("**Refuted**"), stripped of its markdown markers
// and trailing colon; null when the line is neither (including a bold
// SPAN inside a list item, e.g. "- **P2** ...", which TOP_LEVEL_ITEM
// already recognizes as an item, not a heading).
function headingLabel(raw) {
  const atx = /^\s*#{1,6}\s+(.*)$/.exec(raw);
  if (atx) return atx[1].trim();
  if (TOP_LEVEL_ITEM.test(raw)) return null;
  const bold = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/.exec(raw);
  return bold ? bold[1].trim() : null;
}

// A nested detail line (file/fix/evidence sub-bullets under a finding),
// indented two spaces or more, is never a finding of its own no matter
// what text it starts with.
function isSubBullet(raw) {
  return /^ {2,}(?:[-*+]|\d+[.)])\s/.test(raw);
}

// The simpler rule the review's own report needs, versus the critic-report
// parser above: a finding is a top-level line (heading, item, or table row,
// never a sub-bullet) whose own text leads with a P0-P3 tag, same shape as
// the critic parser's "tagged" lines, but without its group-heading or
// Severity-field shapes, which the review's report does not use. Returns
// the severity ("P0".."P3") when `raw` is such a line, else null.
function topLevelFindingSeverity(raw) {
  if (isSubBullet(raw) || !STRUCTURAL.test(raw)) return null;
  const line = stripDecoration(raw);
  const lead = LEADING_TAG.exec(line);
  if (lead) return NOT_A_FINDING.test(line.slice(lead[0].length)) ? null : lead[1].toUpperCase();
  const bracket = BRACKET_TAG.exec(line);
  return bracket ? bracket[1].toUpperCase() : null;
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

// index.js AGENT_DEFINITIONS, "-critic" suffix already dropped by the
// caller, mapped to the short label the sidebar row shows.
const CRITIC_LABELS = {
  "adversarial-risk": "risk",
  "design-principles": "design",
  "security-checklist": "security",
  "ai-slop": "slop",
};

// Long enough that none of the four known critics above ever need it.
const CRITIC_LABEL_MAX = 12;

/**
 * Maps a critic's agent id to the sidebar row's short label. The four known
 * critics get fixed short names, so their row width never depends on their
 * (much longer) real id. Anything else, such as an ad hoc verification
 * subagent the review spawns outside the four critics, keeps its own id
 * unless that would not fit the row, in which case it is cut from the END
 * and marked with an ellipsis, never from the middle, so the start of the
 * name, the part most likely to say what it is, survives.
 */
export function criticLabel(name) {
  const mapped = CRITIC_LABELS[name];
  if (mapped) return mapped;
  const label = String(name ?? "");
  if (label.length <= CRITIC_LABEL_MAX) return label;
  return `${label.slice(0, CRITIC_LABEL_MAX - 1)}\u2026`;
}
