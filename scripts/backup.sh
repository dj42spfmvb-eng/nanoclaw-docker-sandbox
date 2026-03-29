#!/usr/bin/env bash
# NanoClaw Backup — pushes stateful (non-secret) data to a private GitHub repo.
#
# Setup:
#   1. Create a private repo (e.g. qwibitai/nanoclaw-backup)
#   2. Add the remote:  git remote add backup https://github.com/qwibitai/nanoclaw-backup.git
#   3. Run:  npm run backup
#
# The script pushes to the "backup" git remote on an orphan branch named "latest".
# It NEVER touches the source-code origin remote.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_REMOTE="backup"
BACKUP_BRANCH="latest"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Resolve backup repo URL from the "backup" git remote
BACKUP_URL=$(git -C "$PROJECT_ROOT" remote get-url "$BACKUP_REMOTE" 2>/dev/null) || {
  echo "ERROR: No git remote named '$BACKUP_REMOTE' found."
  echo "Add one with:  git remote add backup <private-repo-url>"
  exit 1
}

# Inject gh token into URL so the temp repo can authenticate
GH_TOKEN=$(gh auth token 2>/dev/null) || true
if [ -n "$GH_TOKEN" ]; then
  AUTH_URL=$(echo "$BACKUP_URL" | sed "s|https://github.com|https://$GH_TOKEN@github.com|")
else
  AUTH_URL="$BACKUP_URL"
fi

# Create temp dir for backup staging
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

cd "$TMPDIR"
git init -q
git remote add origin "$AUTH_URL"

# Try to fetch existing backup branch (may not exist yet)
if git fetch origin "$BACKUP_BRANCH" 2>/dev/null; then
  git checkout "$BACKUP_BRANCH"
else
  git checkout --orphan "$BACKUP_BRANCH"
fi

# Clean working tree
git rm -rf . 2>/dev/null || true

# --- Copy non-secret stateful data ---

# Message database
if [ -f "$PROJECT_ROOT/store/messages.db" ]; then
  mkdir -p store
  cp "$PROJECT_ROOT/store/messages.db" store/
fi

# Group memories and user files (all groups)
for dir in "$PROJECT_ROOT"/groups/*/; do
  [ -d "$dir" ] || continue
  group=$(basename "$dir")
  mkdir -p "groups/$group"

  # Copy top-level files (CLAUDE.md, etc.) — skip .DS_Store
  find "$dir" -maxdepth 1 -type f ! -name '.DS_Store' -exec cp {} "groups/$group/" \;

  # Copy logs subdirectory if present
  if [ -d "$dir/logs" ]; then
    cp -r "$dir/logs" "groups/$group/logs"
  fi
done

# Session data (settings, project state — no secrets)
if [ -d "$PROJECT_ROOT/data/sessions" ]; then
  mkdir -p data
  cp -r "$PROJECT_ROOT/data/sessions" data/sessions
  # Remove env dirs that may contain tokens
  find data/sessions -name 'session-env' -type d -exec rm -rf {} + 2>/dev/null || true
fi

# IPC state
if [ -d "$PROJECT_ROOT/data/ipc" ]; then
  mkdir -p data
  cp -r "$PROJECT_ROOT/data/ipc" data/ipc
fi

# Metadata
cat > BACKUP_INFO.txt <<EOF
Backup taken at: $TIMESTAMP
Source commit: $(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")
EOF

# Commit and push
git add -A
if git diff --cached --quiet; then
  echo "No changes to back up."
  exit 0
fi

git commit -q -m "backup: $TIMESTAMP"
git push origin "$BACKUP_BRANCH" --force -q
echo "Backup pushed to $BACKUP_REMOTE ($BACKUP_BRANCH) at $TIMESTAMP"
