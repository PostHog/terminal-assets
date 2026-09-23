#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# tty1 has a shell reading keys, so the game needs its own virtual console.
trap "printf '\\033[?25h' > /dev/tty5; display off; chvt 1" EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
chvt 5
printf '\033[?25l' > /dev/tty5
display on
mkdir -p /tmp/doom
cd /tmp/doom
"$root/bin/fbdoom" -iwad "$root/share/freedoom1.wad" "$@"
