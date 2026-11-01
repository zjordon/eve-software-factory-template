#!/usr/bin/env bash
# Daily backup of the factory's durable data (M4-T3): the workflow state and
# the local Blob store (preferences / factory brain / handoff artifacts),
# tarballed to the /data volume (a separate device from the root volume) with
# a bounded retention. Best-effort snapshot semantics: the service stays up
# while this runs, so a backup taken mid-write can interleave turn events —
# acceptable at personal scale; the restore drill (docs/implement-plan/M4-加固.md)
# is what proves a backup is actually loadable.
set -euo pipefail

REPO="/home/jasonzhang/git/z_jordon/eve-software-factory-template"
DEST="/data/factory-backup"
KEEP=14

stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DEST"

# --ignore-failed-read: a file vanishing mid-read (turn rotated between tar's
# walk and read) must not void the whole archive.
tar -czf "$DEST/factory-data-$stamp.tar.gz" \
  --ignore-failed-read \
  -C "$REPO/.eve" .workflow-data blob-data 2>/dev/null

# Bounded retention: newest KEEP archives stay.
ls -1t "$DEST"/factory-data-*.tar.gz | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
done

# Integrity gate: the archive must list both roots and every entry must read.
tar -tzf "$DEST/factory-data-$stamp.tar.gz" >/dev/null
echo "backup ok: $DEST/factory-data-$stamp.tar.gz ($(du -h "$DEST/factory-data-$stamp.tar.gz" | cut -f1))"
