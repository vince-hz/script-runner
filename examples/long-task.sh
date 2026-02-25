#!/usr/bin/env bash
set -euo pipefail

seconds="${1:-10}"
if ! [[ "$seconds" =~ ^[0-9]+$ ]]; then
  echo "first arg must be integer seconds" >&2
  exit 2
fi

echo "long-task start, sleep ${seconds}s"
sleep "$seconds"
echo "long-task done"
