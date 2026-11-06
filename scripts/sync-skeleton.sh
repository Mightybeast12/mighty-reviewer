#!/usr/bin/env bash
set -euo pipefail

# sync-skeleton.sh - this repo and its sibling plugin share one
# release/check/hook skeleton. This script is itself one of the shared
# files: copy it into the sibling unmodified and it points straight
# back here, because the repo it is run *from*, not a hardcoded name,
# decides which side is "this repo" and which is "sibling". No package
# name is ever hardcoded in this file's own text (see guess_sibling_dir
# below): --apply's blind string swap runs over every skeleton file,
# including this one, so any literal package name written here would
# itself get silently rewritten the moment this file is copied.
#
# Usage:
#   scripts/sync-skeleton.sh --check [--sibling <dir>]
#   scripts/sync-skeleton.sh --apply [--sibling <dir>]
#
#   --check          diff this repo's skeleton files against the
#                     sibling's and exit 1 if any of them drifted (0 if
#                     none did)
#   --apply          copy this repo's skeleton files into the sibling,
#                     with this repo's package name swapped for the
#                     sibling's own; never commits anything, only
#                     writes files, and prints each one it wrote
#   --sibling <dir>  path to the sibling repo (default:
#                     $MIGHTY_SIBLING_DIR, then ../<sibling-name> next
#                     to this repo, then ~/dev/<sibling-name>)
#
# Exit codes: 0 ok / no drift, 1 drift found (--check) or a hard error,
# 2 (only from --check) the sibling directory could not be found at
# all, so scripts/check.sh's skeleton stage skips with a notice instead
# of failing outright, 3 more than one sibling candidate was found
# (ambiguous, from either --check or --apply): scripts/check.sh's
# skeleton stage FAILs on 3 rather than skipping.
#
# The skeleton set:
#   scripts/release.sh
#   scripts/check.sh
#   scripts/sync-skeleton.sh
#   .githooks/pre-commit
#   .github/workflows/publish.yml

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SKELETON_FILES=(
    "scripts/release.sh"
    "scripts/check.sh"
    "scripts/sync-skeleton.sh"
    ".githooks/pre-commit"
    ".github/workflows/publish.yml"
)

PLACEHOLDER="__SKELETON_PKG_NAME__"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

function log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
function log_warn() { echo -e "${YELLOW}[WARN]${NC} $1" >&2; }
function log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

function usage() {
    echo "Usage: $0 (--check|--apply) [--sibling <dir>]"
}

function resolve_bin() {
    local name="$1"
    if command -v "$name" >/dev/null 2>&1; then
        command -v "$name"
        return 0
    fi
    if [[ -x "/opt/homebrew/bin/$name" ]]; then
        echo "/opt/homebrew/bin/$name"
        return 0
    fi
    return 1
}

NODE_BIN="$(resolve_bin node)" || { log_error "node is required"; exit 1; }

function pkg_name_of() {
    "$NODE_BIN" -e 'console.log(require(process.argv[1]).name)' "$1/package.json"
}

# guess_sibling_dir <this-pkg-name> - finds a default sibling directory
# when neither --sibling nor $MIGHTY_SIBLING_DIR says otherwise. Never
# hardcode either repo's package name here: --apply's blind find/replace
# runs over every skeleton file, including this one, so a literal name
# written here would be corrupted the moment this file is copied.
#
# Returns 0 and echoes the directory on exactly one match, 1 when none
# is found, or 3 when more than one distinct candidate matches (after
# printing every candidate to stderr): never guess among several.
function guess_sibling_dir() {
    local this_pkg_name="$1"
    local parent_dirs=("$REPO_DIR/.." "$HOME/dev")
    local -a candidates=()
    local parent candidate_glob candidate name already c
    for parent in "${parent_dirs[@]}"; do
        [[ -d "$parent" ]] || continue
        for candidate_glob in "$parent"/mighty-*; do
            [[ -d "$candidate_glob" ]] || continue
            [[ -f "$candidate_glob/package.json" ]] || continue
            [[ -f "$candidate_glob/scripts/release.sh" ]] || continue
            candidate="$(cd "$candidate_glob" && pwd)"
            [[ "$candidate" == "$REPO_DIR" ]] && continue
            name="$(pkg_name_of "$candidate" 2>/dev/null)" || continue
            [[ -n "$name" && "$name" != "$this_pkg_name" ]] || continue
            already=0
            for c in "${candidates[@]:-}"; do
                [[ "$c" == "$candidate" ]] && already=1
            done
            [[ "$already" -eq 1 ]] && continue
            candidates+=("$candidate")
        done
    done

    if [[ "${#candidates[@]}" -eq 0 ]]; then
        return 1
    fi
    if [[ "${#candidates[@]}" -gt 1 ]]; then
        log_error "sync-skeleton: ambiguous sibling, more than one mighty-* candidate found:"
        for c in "${candidates[@]}"; do
            echo "  $c" >&2
        done
        return 3
    fi
    echo "${candidates[0]}"
}

MODE=""
SIBLING_ARG=""

function parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --check)
                MODE="check"
                shift
                ;;
            --apply)
                MODE="apply"
                shift
                ;;
            --sibling)
                [[ $# -ge 2 ]] || { log_error "--sibling requires an argument"; exit 1; }
                SIBLING_ARG="$2"
                shift 2
                ;;
            --sibling=*)
                SIBLING_ARG="${1#--sibling=}"
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                log_error "Unknown argument: $1"
                usage
                exit 1
                ;;
        esac
    done
    if [[ -z "$MODE" ]]; then
        usage
        exit 1
    fi
}

# resolve_sibling_dir - echoes the sibling directory's absolute path if
# one can be found, otherwise returns non-zero. --sibling, when given,
# is authoritative: it is never silently overridden by falling through
# to the other candidates.
function resolve_sibling_dir() {
    if [[ -n "$SIBLING_ARG" ]]; then
        if [[ -d "$SIBLING_ARG" && -f "$SIBLING_ARG/package.json" ]]; then
            (cd "$SIBLING_ARG" && pwd)
            return 0
        fi
        return 1
    fi

    if [[ -n "${MIGHTY_SIBLING_DIR:-}" ]]; then
        if [[ -d "$MIGHTY_SIBLING_DIR" && -f "$MIGHTY_SIBLING_DIR/package.json" ]]; then
            (cd "$MIGHTY_SIBLING_DIR" && pwd)
            return 0
        fi
    fi

    local this_pkg_name
    this_pkg_name="$(pkg_name_of "$REPO_DIR")"
    guess_sibling_dir "$this_pkg_name"
}

# normalise <file> <this-pkg-name> <sibling-pkg-name> - prints the
# file's content with both repos' own package names swapped for one
# shared placeholder, so a literal package name is never mistaken for
# drift between the two repos.
function normalise() {
    local file="$1" this_name="$2" sib_name="$3"
    "$NODE_BIN" -e '
        const fs = require("fs");
        const file = process.argv[1];
        const a = process.argv[2];
        const b = process.argv[3];
        const placeholder = process.argv[4];
        let text = fs.readFileSync(file, "utf8");
        for (const name of [a, b]) {
            if (!name) continue;
            text = text.split(name).join(placeholder);
        }
        process.stdout.write(text);
    ' "$file" "$this_name" "$sib_name" "$PLACEHOLDER"
}

# write_with_name_swap <src> <this-pkg-name> <sibling-pkg-name> <dest> -
# copies src to dest with this repo's own package name literally
# swapped for the sibling's.
function write_with_name_swap() {
    local src="$1" this_name="$2" sib_name="$3" dest="$4"
    "$NODE_BIN" -e '
        const fs = require("fs");
        const src = process.argv[1];
        const a = process.argv[2];
        const b = process.argv[3];
        const dest = process.argv[4];
        let text = fs.readFileSync(src, "utf8");
        if (a && b && a !== b) text = text.split(a).join(b);
        fs.writeFileSync(dest, text);
    ' "$src" "$this_name" "$sib_name" "$dest"
}

function do_check() {
    local sibling_dir rc=0
    sibling_dir="$(resolve_sibling_dir)" || rc=$?
    if [[ "$rc" -eq 3 ]]; then
        log_error "sync-skeleton: refusing to guess which is the sibling; pass --sibling <dir> or set \$MIGHTY_SIBLING_DIR"
        exit 3
    fi
    if [[ "$rc" -ne 0 ]]; then
        log_warn "sync-skeleton: sibling repo directory not found (tried --sibling, \$MIGHTY_SIBLING_DIR, ../<sibling>, ~/dev/<sibling>)"
        exit 2
    fi
    log_info "sync-skeleton: comparing against sibling at $sibling_dir"

    local this_pkg_name sib_pkg_name
    this_pkg_name="$(pkg_name_of "$REPO_DIR")"
    sib_pkg_name="$(pkg_name_of "$sibling_dir")"

    local drift=0
    local file
    for file in "${SKELETON_FILES[@]}"; do
        local this_path="$REPO_DIR/$file"
        local sib_path="$sibling_dir/$file"

        if [[ ! -f "$this_path" ]]; then
            log_error "sync-skeleton: $file is missing from this repo's own skeleton set"
            drift=1
            continue
        fi
        if [[ ! -f "$sib_path" ]]; then
            log_error "sync-skeleton: $file is missing from the sibling"
            drift=1
            continue
        fi

        local this_norm sib_norm
        this_norm="$(normalise "$this_path" "$this_pkg_name" "$sib_pkg_name")"
        sib_norm="$(normalise "$sib_path" "$this_pkg_name" "$sib_pkg_name")"
        if [[ "$this_norm" != "$sib_norm" ]]; then
            log_error "sync-skeleton: $file drifted"
            diff -u -L "sibling/$file" -L "this-repo/$file" <(echo "$sib_norm") <(echo "$this_norm") >&2 || true
            drift=1
        fi
    done

    if [[ "$drift" -ne 0 ]]; then
        log_error "sync-skeleton: drift found; run --apply from whichever side is current to sync the other"
        exit 1
    fi
    log_info "sync-skeleton: no drift"
}

function do_apply() {
    local sibling_dir rc=0
    sibling_dir="$(resolve_sibling_dir)" || rc=$?
    if [[ "$rc" -eq 3 ]]; then
        log_error "sync-skeleton: refusing to guess which is the sibling; pass --sibling <dir> or set \$MIGHTY_SIBLING_DIR"
        exit 3
    fi
    if [[ "$rc" -ne 0 ]]; then
        log_error "sync-skeleton: sibling repo directory not found (tried --sibling, \$MIGHTY_SIBLING_DIR, ../<sibling>, ~/dev/<sibling>)"
        exit 1
    fi
    log_info "sync-skeleton: applying this repo's skeleton onto $sibling_dir"

    local this_pkg_name sib_pkg_name
    this_pkg_name="$(pkg_name_of "$REPO_DIR")"
    sib_pkg_name="$(pkg_name_of "$sibling_dir")"

    local file
    for file in "${SKELETON_FILES[@]}"; do
        local this_path="$REPO_DIR/$file"
        if [[ ! -f "$this_path" ]]; then
            log_warn "sync-skeleton: $file is missing from this repo, skipping"
            continue
        fi
        local dest="$sibling_dir/$file"
        mkdir -p "$(dirname "$dest")"
        write_with_name_swap "$this_path" "$this_pkg_name" "$sib_pkg_name" "$dest"
        if [[ -x "$this_path" ]]; then
            chmod +x "$dest"
        fi
        echo "wrote: $dest"
    done
    log_info "sync-skeleton: applied (nothing committed)"
}

function main() {
    parse_args "$@"
    case "$MODE" in
        check) do_check ;;
        apply) do_apply ;;
    esac
}

main "$@"
