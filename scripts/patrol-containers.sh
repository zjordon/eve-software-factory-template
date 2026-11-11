#!/usr/bin/env bash
# M2 ops: report (and optionally prune) orphaned eve sandbox containers.
#
# eve's Docker sessions keep their containers around on purpose (resumable
# session state), but a hard-killed runtime leaves them orphaned forever
# (M1 field note: Ctrl+C left 3 Up + 1 Exited(137) behind). This patrol
# never touches running containers; with --prune it removes eve-sbx-*
# containers that have been exited for over MIN_HOURS (default 24, past
# any plausible revision-cycle resume).
#
# Usage: patrol-containers.sh [--prune] [MIN_HOURS]
set -u

DOCKER="${DOCKER:-docker}"
PRUNE=0
MIN_HOURS=24
for arg in "$@"; do
  case "$arg" in
    --prune) PRUNE=1 ;;
    *) MIN_HOURS="$arg" ;;
  esac
done

if ! "$DOCKER" info >/dev/null 2>&1; then
  echo "docker daemon unreachable, nothing to do"
  exit 0
fi

NOW=$(date +%s)
MIN_AGE=$((MIN_HOURS * 3600))
found=0

# `--filter name=` is a substring match, not a regex; `eve-sbx` is the
# factory's container-name prefix and matches nothing else on the host.
for name in $("$DOCKER" ps -a --filter 'name=eve-sbx-' --format '{{.Names}}'); do
  found=1
  state=$("$DOCKER" inspect -f '{{.State.Status}}' "$name" 2>/dev/null) || continue
  case "$state" in
    running)
      echo "running   $name - left alone"
      ;;
    exited|dead|created)
      finished=$("$DOCKER" inspect -f '{{.State.FinishedAt}}' "$name" 2>/dev/null)
      # A container that never started (`created`) or died abnormally
      # (`dead`) reports FinishedAt as the zero timestamp 0001-01-01T00:00:00Z;
      # date(1) parses that to a huge negative epoch, which would satisfy any
      # MIN_AGE and prune a seconds-old container. No trustworthy exit time
      # means no pruning: report and move on. Same for a FinishedAt date(1)
      # cannot parse at all (the old fallback treated it as 1970 -> instant
      # prune).
      case "${finished:-}" in
        ""|0001-01-01T00:00:00*)
          echo "no-exit    $name ($state, FinishedAt '$finished') - left alone"
          continue
          ;;
      esac
      finished_epoch=$(date -d "$finished" +%s 2>/dev/null) || {
        echo "unparsed   $name ($state, FinishedAt '$finished') - left alone"
        continue
      }
      age=$(( NOW - finished_epoch ))
      if [ "$age" -ge "$MIN_AGE" ]; then
        if [ "$PRUNE" -eq 1 ]; then
          "$DOCKER" rm -f "$name" >/dev/null 2>&1 && echo "pruned    $name (exited $((age / 3600))h ago)" || echo "FAILED    $name"
        else
          echo "orphan    $name (exited $((age / 3600))h ago) - rerun with --prune to remove"
        fi
      else
        echo "recent    $name (exited $((age / 3600))h ago, under ${MIN_HOURS}h) - left alone"
      fi
      ;;
    *)
      echo "other     $name ($state) - left alone"
      ;;
  esac
done

[ "$found" -eq 0 ] && echo "no eve sandbox containers present"
# Template images (eve-sandbox-template:*) are build cache; never removed here.
exit 0
