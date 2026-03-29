#!/usr/bin/env bash
# NanoClaw Restore — pull stateful data from the private backup repo.
#
# Usage:
#   ./scripts/restore.sh                     # uses existing "backup" git remote
#   ./scripts/restore.sh <backup-repo-url>   # fetches from the given URL
#
# This restores message history, group memories, session data, and IPC state.
# Secrets (WhatsApp auth, OAuth tokens, certs) are NOT in the backup and must
# be re-provisioned manually after restore.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_REMOTE="backup"
BACKUP_BRANCH="latest"

echo "=== NanoClaw Restore ==="
echo ""

# If a URL was passed, ensure the remote exists
if [ "${1:-}" != "" ]; then
  if git -C "$PROJECT_ROOT" remote get-url "$BACKUP_REMOTE" &>/dev/null; then
    git -C "$PROJECT_ROOT" remote set-url "$BACKUP_REMOTE" "$1"
  else
    git -C "$PROJECT_ROOT" remote add "$BACKUP_REMOTE" "$1"
  fi
  echo "Using backup repo: $1"
else
  BACKUP_URL=$(git -C "$PROJECT_ROOT" remote get-url "$BACKUP_REMOTE" 2>/dev/null) || {
    echo "ERROR: No git remote named '$BACKUP_REMOTE' and no URL argument provided."
    echo "Usage: $0 <backup-repo-url>"
    exit 1
  }
  echo "Using backup repo: $BACKUP_URL"
fi

echo "Fetching backup branch..."
git -C "$PROJECT_ROOT" fetch "$BACKUP_REMOTE" "$BACKUP_BRANCH"

# Use a temp dir to extract files from the backup branch
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

cd "$TMPDIR"
git init -q
git remote add origin "$(git -C "$PROJECT_ROOT" remote get-url "$BACKUP_REMOTE")"
git fetch origin "$BACKUP_BRANCH"
git checkout "$BACKUP_BRANCH"

# --- Restore message database ---
if [ -f store/messages.db ]; then
  mkdir -p "$PROJECT_ROOT/store"
  cp store/messages.db "$PROJECT_ROOT/store/messages.db"
  echo "  Restored store/messages.db"
fi

# --- Restore group memories and logs ---
if [ -d groups ]; then
  for dir in groups/*/; do
    [ -d "$dir" ] || continue
    group=$(basename "$dir")
    mkdir -p "$PROJECT_ROOT/groups/$group/logs"
    cp -r "$dir"* "$PROJECT_ROOT/groups/$group/" 2>/dev/null || true
    echo "  Restored groups/$group/"
  done
fi

# --- Restore session data ---
if [ -d data/sessions ]; then
  mkdir -p "$PROJECT_ROOT/data"
  cp -r data/sessions "$PROJECT_ROOT/data/sessions"
  echo "  Restored data/sessions/"
fi

# --- Restore IPC state ---
if [ -d data/ipc ]; then
  mkdir -p "$PROJECT_ROOT/data"
  cp -r data/ipc "$PROJECT_ROOT/data/ipc"
  echo "  Restored data/ipc/"
fi

# Show backup info
echo ""
if [ -f BACKUP_INFO.txt ]; then
  echo "Backup info:"
  cat BACKUP_INFO.txt
fi

echo ""
echo "=== Restore complete ==="
echo ""
echo "Manual steps required:"
echo "  1. Create .env with ASSISTANT_NAME, TZ, CLAUDE_CODE_OAUTH_TOKEN"
echo "  2. Run: npm run setup   (to re-authenticate WhatsApp if needed)"
echo "  3. Run: npm run build && npm start"
