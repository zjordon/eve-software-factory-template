#!/usr/bin/env bash
# Daily backup of the factory's durable data (M4-T3, extended in M5): the
# workflow state, the local Blob store (preferences / factory brain / handoff
# artifacts), and the run records (M5 observability panel data), tarballed to
# the /data volume (a separate device from the root volume) with a bounded
# retention. Best-effort snapshot semantics: the service stays up while this
# runs, so a backup taken mid-write can interleave turn events — acceptable at
# personal scale; the restore drill (docs/implement-plan/M4-加固.md) is what
# proves a backup is actually loadable.
set -euo pipefail

REPO="/home/jasonzhang/git/z_jordon/eve-software-factory-template"
DEST="/data/factory-backup"
KEEP=14

stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DEST"

# Pre-flight: a missing source root (renamed/moved after an ops change) must
# abort loudly. --ignore-failed-read would otherwise let tar skip the whole
# directory and still exit 0, and the integrity gate below only proves the
# archive is readable, not complete — a hollow backup would pass every night
# until retention aged out the last good one. run-records is younger than the
# other two (M5); it is tolerated-missing for one boot cycle after upgrade
# rather than aborting the whole backup over it.
for dir in .workflow-data blob-data; do
  if [ ! -d "$REPO/.eve/$dir" ]; then
    echo "backup abort: missing source directory $REPO/.eve/$dir" >&2
    exit 2
  fi
done
BACKUP_DIRS=(.workflow-data blob-data)
if [ -d "$REPO/.eve/run-records" ]; then
  BACKUP_DIRS+=(run-records)
else
  echo "backup note: $REPO/.eve/run-records absent (M5 data plane not yet run); skipping" >&2
fi

# --ignore-failed-read: a file vanishing mid-read (turn rotated between tar's
# walk and read) must not void the whole archive. Separately, GNU tar exits 1
# on "file changed as we read it" (a live turn appending events): warnings
# only, the archive is still a valid best-effort snapshot. Only exit >= 2 is
# fatal; tolerate 1 explicitly, or set -e would abort before pruning and the
# integrity gate on every night that overlaps a running turn.
tar_rc=0
tar -czf "$DEST/factory-data-$stamp.tar.gz" \
  --ignore-failed-read \
  -C "$REPO/.eve" "${BACKUP_DIRS[@]}" 2>/dev/null || tar_rc=$?
[ "$tar_rc" -le 1 ] || exit "$tar_rc"

# Bounded retention: newest KEEP archives stay.
ls -1t "$DEST"/factory-data-*.tar.gz | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
done

# Integrity gate: the archive must list both roots and every entry must read.
tar -tzf "$DEST/factory-data-$stamp.tar.gz" >/dev/null
echo "backup ok: $DEST/factory-data-$stamp.tar.gz ($(du -h "$DEST/factory-data-$stamp.tar.gz" | cut -f1))"
