#!/bin/sh
# Canonical local unit entry for deepseek-harness.
#
# Why this exists: `ecobuild` places TMPDIR on the external volume, whose path is
# longer than macOS's sun_path limit (104 bytes) and contains a space, so socket
# and generated-path suites fail on a correct checkout. `--short-tmp` maps TMPDIR
# to /tmp/ecb-<id>. The unit lane also gets an explicit 30s timeout; the default
# 5s is tighter than this external-volume host can reliably meet.
set -u

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
workspace=""
probe=$root
while [ "$probe" != "/" ]; do
  if [ -f "$probe/supporting/environment/external-build/env.sh" ]; then
    workspace=$probe
    break
  fi
  probe=$(dirname "$probe")
done
env_sh="$workspace/supporting/environment/external-build/env.sh"
if [ ! -f "$env_sh" ]; then
  echo "test-local: cannot locate $env_sh" >&2
  exit 2
fi
. "$env_sh"

commit=$(git -C "$root" rev-parse HEAD)
dirty=$(git -C "$root" status --porcelain | wc -l | tr -d ' ')
printf '{"entry":"test-local","project":"deepseek-harness","commit":"%s","dirty":%s}\n' \
  "$commit" "$dirty"

ecobuild --short-tmp --project "$root" -- pnpm run build:native-system
build_status=$?
if [ "$build_status" -ne 0 ]; then
  printf '{"exit":%s,"stage":"build:native-system","commit":"%s","dirty":%s}\n' \
    "$build_status" "$commit" "$dirty"
  exit "$build_status"
fi

if [ "$#" -eq 0 ]; then
  set -- pnpm exec vitest run --testTimeout=30000
fi

ecobuild --short-tmp --project "$root" -- "$@"
status=$?
printf '{"exit":%s,"commit":"%s","dirty":%s}\n' "$status" "$commit" "$dirty"
exit $status