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
    echo "  1. current branch is main, and HEAD matches origin/main after a fetch"
    echo "  2. git tree clean apart from package.json"
    echo "  3. scripts/check.sh (syntax under node --check, smoke test under"
    echo "     node and bun, no em/en dash scan, skeleton drift against the"
    echo "     sibling repo)"
    echo "  4. npm version <version> --no-git-tag-version"
    echo "  5. commit, tag v<version>, push origin main and v<version> explicitly"
    echo "     (not --tags, so no other local tag or branch state can leak into"
    echo "     the push)"
    echo "  6. poll gh run list until the pushed commit's run completes (10 min timeout)"
    echo "  7. poll npm view <name> version until it matches <version> (5 min timeout)"
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

function gate_branch_and_sync() {
    log_info "Checking the current branch is main and HEAD matches origin/main..."
    local branch
    branch="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
    if [[ "$branch" != "main" ]]; then
        log_error "Current branch is '$branch', not main; releases must run from main"
        exit 1
    fi

    log_info "Fetching origin main..."
    git -C "$REPO_DIR" fetch origin main

    local head_sha remote_sha
    head_sha="$(git -C "$REPO_DIR" rev-parse HEAD)"
    remote_sha="$(git -C "$REPO_DIR" rev-parse origin/main)"
    if [[ "$head_sha" != "$remote_sha" ]]; then
        log_error "HEAD ($head_sha) does not match origin/main ($remote_sha) after fetch; pull or push to sync main before releasing"
        exit 1
    fi
    log_info "On main, HEAD matches origin/main ($head_sha)"
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

function gate_checks() {
    log_info "Running scripts/check.sh (syntax, smoke, dashes, skeleton)..."
    bash "$SCRIPT_DIR/check.sh"
    log_info "scripts/check.sh passed"
}

function do_version_bump() {
    local old_version
    old_version="$("$NODE_BIN" -e "console.log(require(process.argv[1]).version)" "$REPO_DIR/package.json")"
    log_info "Bumping package.json to $VERSION..."
    (cd "$REPO_DIR" && "$NPM_BIN" version "$VERSION" --no-git-tag-version)
    # A repo that names its version outside package.json (a README
    # example, a CHANGELOG heading) keeps those in scripts/bump-version.sh;
    # the skeleton only calls it when it exists.
    if [[ -f "$SCRIPT_DIR/bump-version.sh" ]]; then
        log_info "Running scripts/bump-version.sh $old_version $VERSION..."
        bash "$SCRIPT_DIR/bump-version.sh" "$old_version" "$VERSION"
    fi
}

function do_commit() {
    log_info "Committing: $COMMIT_MESSAGE"
    git -C "$REPO_DIR" add -u
    git -C "$REPO_DIR" commit -m "$COMMIT_MESSAGE"
}

function do_tag() {
    log_info "Tagging v$VERSION..."
    git -C "$REPO_DIR" tag "v$VERSION"
}

function do_push() {
    log_info "Pushing main and v$VERSION to origin (not --tags, so only this release's tag and the main branch move)..."
    git -C "$REPO_DIR" push origin main "v$VERSION"
}

# gate_wait_for_ci <sha> - waits for the run of the pushed commit itself:
# right after a push, an unfiltered `gh run list --limit 1` still returns
# the previous commit's run.
function gate_wait_for_ci() {
    local sha="$1"
    local waited=0
    log_info "Waiting for the GitHub Actions run of $sha to complete (timeout ${TIMEOUT_CI_SECS}s)..."
    while true; do
        local run_json status conclusion url
        if ! run_json="$(cd "$REPO_DIR" && gh run list --commit "$sha" --limit 1 --json status,conclusion,url 2>&1)"; then
            log_error "gh run list failed: $run_json"
            exit 1
        fi
        status="$(json_get "$run_json" status)"
        if [[ "$status" == "completed" ]]; then
            conclusion="$(json_get "$run_json" conclusion)"
            url="$(json_get "$run_json" url)"
            log_info "Run for $sha completed: conclusion=$conclusion ($url)"
            if [[ "$conclusion" != "success" ]]; then
                log_error "The GitHub Actions run for $sha did not succeed (conclusion: $conclusion, $url)"
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

    gate_branch_and_sync
    gate_clean_tree
    gate_checks

    PKG_NAME="$("$NODE_BIN" -e "console.log(require(process.argv[1]).name)" "$REPO_DIR/package.json")"

    do_version_bump
    do_commit
    do_tag
    do_push
    PUSHED_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"

    gate_wait_for_ci "$PUSHED_SHA"
    gate_wait_for_npm

    log_info "Released $PKG_NAME@$VERSION (tag v$VERSION pushed to origin/main, CI succeeded, npm published)"
}

main "$@"
