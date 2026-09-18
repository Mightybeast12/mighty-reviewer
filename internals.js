/**
 * Internal helpers for mighty-reviewer, kept OUT of index.js on purpose:
 * opencode calls every export of a plugin module as a plugin factory and
 * registers the return value as a hooks object, so any helper exported from
 * the plugin entry point (returning null/objects that are not hooks) breaks
 * opencode's bootstrap. Test-only and shared helpers live here instead.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

export const PKG_NAME = "mighty-reviewer";

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
