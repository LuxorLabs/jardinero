#!/usr/bin/env bash
# Renders every .puml under this directory to a .png beside it.
# Usage: ./render.sh [file.puml ...]
set -euo pipefail

cd "$(dirname "$0")"

# The public server by default so this needs nothing installed; point
# PLANTUML_SERVER at a local one to render offline.
SERVER="${PLANTUML_SERVER:-https://www.plantuml.com/plantuml}"

if [ $# -gt 0 ]; then
  sources=("$@")
else
  IFS=$'\n' read -r -d '' -a sources < <(find . -name '*.puml' | sort && printf '\0')
fi

failed=0
for source in "${sources[@]}"; do
  target="${source%.puml}.png"
  # ~h makes the server read plain hex, which skips the DEFLATE + base64
  # encoding it otherwise expects in the URL.
  hex=$(xxd -p "$source" | tr -d '\n')
  status=$(curl -sS -D "$target.headers" -o "$target.part" -w '%{http_code}' "$SERVER/png/~h$hex")

  # The server answers 200 with a picture of the error message, so the only
  # honest signal that the diagram compiled is this header.
  if [ "$status" = "200" ] && ! grep -qi '^x-plantuml-diagram-error' "$target.headers"; then
    mv "$target.part" "$target"
    echo "ok   $target"
  else
    echo "FAIL $source" >&2
    grep -i '^x-plantuml-diagram-error' "$target.headers" >&2 || echo "     http $status" >&2
    rm -f "$target.part"
    failed=1
  fi
  rm -f "$target.headers"
done

exit $failed
