#!/usr/bin/env bash
set -euo pipefail

printf "quick-echo args (%s):\n" "$#"
for arg in "$@"; do
  printf "%s\n" "$arg"
done
