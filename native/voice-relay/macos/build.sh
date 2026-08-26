#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUTPUT=${1:-"$SCRIPT_DIR/build/SemaFrameVoiceRelayHelper"}
OUTPUT_DIR=$(dirname -- "$OUTPUT")
mkdir -p "$OUTPUT_DIR"

swiftc \
  "$SCRIPT_DIR/SemaFrameVoiceRelayHelper.swift" \
  -O \
  -framework AppKit \
  -framework ApplicationServices \
  -o "$OUTPUT"

codesign --force --sign - "$OUTPUT" >/dev/null 2>&1 || true
