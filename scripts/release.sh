#!/usr/bin/env bash
set -euo pipefail

# release.sh - Gate, version, tag, and push a release, then wait for CI and
# npm to catch up. Each step below is a gate: it aborts the release on
# failure.
# Usage: scripts/release.sh <version> ["commit message"]
#   <version>         semver to pass to `npm version` (no leading "v")
#   [commit message]  overrides the default "Release <version>" commit message

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TIMEOUT_CI_SECS=600
POLL_INTERVAL_CI_SECS=15
TIMEOUT_NPM_SECS=300
POLL_INTERVAL_NPM_SECS=10

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

function log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
function log_warn() { echo -e "${YELLOW}[WARN]${NC} $1" >&2; }
function log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

function usage() {
    echo "Usage: $0 <version> [commit-message]"
    echo ""
    echo "Gates, each aborting the release on failure:"
    echo "  1. git tree clean apart from package.json"
    echo "  2. node --check on every tracked .js file"
    echo "  3. node smoke-test.mjs"
    echo "  4. no em dash (U+2014) or en dash (U+2013) in tracked .js/.md/.json files"
    echo "     (excluding vendor/ and node_modules/)"
    echo "  5. npm version <version> --no-git-tag-version"
    echo "  6. commit, tag v<version>, push origin main --tags"
    echo "  7. poll gh run list until the latest run completes (10 min timeout)"
    echo "  8. poll npm view <name> version until it matches <version> (5 min timeout)"
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

function require_deps() {
    command -v git >/dev/null 2>&1 || { log_error "git is required"; exit 1; }
    command -v gh >/dev/null 2>&1 || { log_error "gh (GitHub CLI) is required"; exit 1; }

    NODE_BIN="$(resolve_bin node)" \
        || { log_error "node not found on PATH or at /opt/homebrew/bin/node"; exit 1; }
    NPM_BIN="$(resolve_bin npm)" \
        || { log_error "npm not found on PATH or at /opt/homebrew/bin/npm"; exit 1; }
}

# json_get <json> <field> - read a field off the first element of a gh --json
# array (or off a plain object) without depending on jq being installed.
function json_get() {
    "$NODE_BIN" -e '
        const data = JSON.parse(process.argv[1]);
        const item = Array.isArray(data) ? data[0] : data;
        const field = process.argv[2];
        const value = item ? item[field] : undefined;
        process.stdout.write(value === undefined || value === null ? "" : String(value));
    ' "$1" "$2"
}

function gate_clean_tree() {
    log_info "Checking the working tree is clean apart from package.json..."
    local dirty
    dirty="$(git -C "$REPO_DIR" status --porcelain=v1 | cut -c4- | grep -v -x 'package.json' || true)"
    if [[ -n "$dirty" ]]; then
        log_error "Working tree has changes outside package.json:"
        local line
        while IFS= read -r line; do
            echo "  $line" >&2
        done <<< "$dirty"
        exit 1
    fi
    log_info "Working tree is clean apart from package.json"
}

function gate_node_check() {
    log_info "Running node --check on every tracked .js file..."
    local file
    while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        "$NODE_BIN" --check "$REPO_DIR/$file"
    done < <(git -C "$REPO_DIR" ls-files -- '*.js')
    log_info "node --check passed on all tracked .js files"
}

function gate_smoke_test() {
    log_info "Running smoke-test.mjs..."
    (cd "$REPO_DIR" && "$NODE_BIN" smoke-test.mjs)
    log_info "smoke-test.mjs passed"
}

function gate_no_dashes() {
    log_info "Checking tracked .js/.md/.json files for em dashes (U+2014) or en dashes (U+2013)..."
    local files
    files="$(git -C "$REPO_DIR" ls-files -- '*.js' '*.md' '*.json' ':!:vendor/**' ':!:node_modules/**')"
    if [[ -z "$files" ]]; then
        log_info "No files to scan"
        return 0
    fi

    local offenders=""
    local file
    while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        if ! "$NODE_BIN" -e '
            const fs = require("fs");
            const text = fs.readFileSync(process.argv[1], "utf8");
            process.exit(/[\u2014\u2013]/.test(text) ? 1 : 0);
        ' "$REPO_DIR/$file"; then
            offenders+="$file"$'\n'
        fi
    done <<< "$files"

    if [[ -n "$offenders" ]]; then
        log_error "Em dash or en dash found in:"
        echo "$offenders" >&2
        exit 1
    fi
    log_info "No em or en dashes found"
}

function do_version_bump() {
    log_info "Bumping package.json to $VERSION..."
    (cd "$REPO_DIR" && "$NPM_BIN" version "$VERSION" --no-git-tag-version)
}

function do_commit() {
    log_info "Committing: $COMMIT_MESSAGE"
    git -C "$REPO_DIR" add package.json
    git -C "$REPO_DIR" commit -m "$COMMIT_MESSAGE"
}

function do_tag() {
    log_info "Tagging v$VERSION..."
    git -C "$REPO_DIR" tag "v$VERSION"
}

function do_push() {
    log_info "Pushing main and tags to origin..."
    git -C "$REPO_DIR" push origin main --tags
}

function gate_wait_for_ci() {
    local waited=0
    log_info "Waiting for the latest GitHub Actions run to complete (timeout ${TIMEOUT_CI_SECS}s)..."
    while true; do
        local run_json status conclusion url
        if ! run_json="$(cd "$REPO_DIR" && gh run list --limit 1 --json status,conclusion,url 2>&1)"; then
            log_error "gh run list failed: $run_json"
            exit 1
        fi
        status="$(json_get "$run_json" status)"
        if [[ "$status" == "completed" ]]; then
            conclusion="$(json_get "$run_json" conclusion)"
            url="$(json_get "$run_json" url)"
            log_info "Latest run completed: conclusion=$conclusion ($url)"
            if [[ "$conclusion" != "success" ]]; then
                log_error "Latest GitHub Actions run did not succeed (conclusion: $conclusion)"
                exit 1
            fi
            return 0
        fi
        if [[ "$waited" -ge "$TIMEOUT_CI_SECS" ]]; then
            log_error "Timed out after ${TIMEOUT_CI_SECS}s waiting for the GitHub Actions run to complete (last status: $status)"
            exit 1
        fi
        sleep "$POLL_INTERVAL_CI_SECS"
        waited=$((waited + POLL_INTERVAL_CI_SECS))
    done
}

function gate_wait_for_npm() {
    local waited=0
    log_info "Waiting for npm to report $PKG_NAME@$VERSION (timeout ${TIMEOUT_NPM_SECS}s)..."
    while true; do
        local published
        published="$("$NPM_BIN" view "$PKG_NAME" version 2>/dev/null || true)"
        if [[ "$published" == "$VERSION" ]]; then
            log_info "npm now reports $PKG_NAME@$published"
            return 0
        fi
        if [[ "$waited" -ge "$TIMEOUT_NPM_SECS" ]]; then
            log_error "Timed out after ${TIMEOUT_NPM_SECS}s waiting for npm to report $PKG_NAME@$VERSION (last seen: ${published:-none})"
            exit 1
        fi
        sleep "$POLL_INTERVAL_NPM_SECS"
        waited=$((waited + POLL_INTERVAL_NPM_SECS))
    done
}

function main() {
    if [[ $# -lt 1 ]]; then
        usage
        exit 1
    fi

    VERSION="$1"
    COMMIT_MESSAGE="${2:-Release $VERSION}"

    require_deps

    gate_clean_tree
    gate_node_check
    gate_smoke_test
    gate_no_dashes

    PKG_NAME="$("$NODE_BIN" -e "console.log(require(process.argv[1]).name)" "$REPO_DIR/package.json")"

    do_version_bump
    do_commit
    do_tag
    do_push

    gate_wait_for_ci
    gate_wait_for_npm

    log_info "Released $PKG_NAME@$VERSION (tag v$VERSION pushed to origin/main, CI succeeded, npm published)"
}

main "$@"
