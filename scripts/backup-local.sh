#!/usr/bin/env bash
# NanoClaw Local Backup — copies user-specific and stateful data to ~/nanoclaw-backup/
#
# Usage:  npm run backup:local
#         bash scripts/backup-local.sh [target-dir]
#
# This backs up data that should NOT be pushed to the shared repo:
# groups, store, data, logs, .env files, and icloud folders.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${1:-$HOME/nanoclaw-backup}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "Backing up to $BACKUP_DIR ..."

mkdir -p "$BACKUP_DIR"

# Groups (all group folders — memories, conversations, CLAUDE.md overrides)
[ -d "$PROJECT_ROOT/groups" ] && rsync -a --delete "$PROJECT_ROOT/groups/" "$BACKUP_DIR/groups/"

# WhatsApp auth and message database
[ -d "$PROJECT_ROOT/store" ] && rsync -a --delete "$PROJECT_ROOT/store/" "$BACKUP_DIR/store/"

# Session data, IPC state, registered groups
[ -d "$PROJECT_ROOT/data" ] && rsync -a --delete "$PROJECT_ROOT/data/" "$BACKUP_DIR/data/"

# Operational logs
[ -d "$PROJECT_ROOT/logs" ] && rsync -a --delete "$PROJECT_ROOT/logs/" "$BACKUP_DIR/logs/"

# Environment files
[ -f "$PROJECT_ROOT/.env" ] && cp "$PROJECT_ROOT/.env" "$BACKUP_DIR/.env"
if [ -f "$PROJECT_ROOT/container/.env" ]; then
  mkdir -p "$BACKUP_DIR/container"
  cp "$PROJECT_ROOT/container/.env" "$BACKUP_DIR/container/.env"
fi

# iCloud sync folders (if present)
[ -d "$PROJECT_ROOT/icloud-inbox" ] && rsync -a --delete "$PROJECT_ROOT/icloud-inbox/" "$BACKUP_DIR/icloud-inbox/"
[ -d "$PROJECT_ROOT/icloud-outbox" ] && rsync -a --delete "$PROJECT_ROOT/icloud-outbox/" "$BACKUP_DIR/icloud-outbox/"

# User library (if present)
[ -d "$PROJECT_ROOT/User_Library" ] && rsync -a --delete "$PROJECT_ROOT/User_Library/" "$BACKUP_DIR/User_Library/"

# Metadata
cat > "$BACKUP_DIR/BACKUP_INFO.txt" <<EOF
Backup taken at: $TIMESTAMP
Source commit: $(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")
Source branch: $(git -C "$PROJECT_ROOT" branch --show-current 2>/dev/null || echo "unknown")
EOF

echo "Local backup complete at $TIMESTAMP"
echo "Location: $BACKUP_DIR"
du -sh "$BACKUP_DIR"
