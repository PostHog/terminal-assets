#!/bin/sh
set -eu
scripts="$(cd "$(dirname "$0")" && pwd)"
root="$scripts/../.."
mkdir -p "$root/.build/display"
docker build -t posthog-terminal-display "$scripts"
docker run --rm -v "$scripts:/scripts:ro" -v "$root/.build/display:/out" posthog-terminal-display sh /scripts/build-in-container.sh
cp "$root/.build/display/linux-fb-bzimage.bin" "$root/images/"
docker build -f "$scripts/Dockerfile.doom" -t posthog-terminal-doom-mouse "$scripts"
docker run --rm posthog-terminal-doom-mouse cat /build/fbDOOM/fbdoom/fbdoom > "$root/binaries/fbdoom-linux-i386.bin"
