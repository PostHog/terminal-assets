#!/bin/sh
set -eu
export ARCH=i386 CROSS_COMPILE=i686-linux-gnu-
# Fixed build metadata keeps the kernel image reproducible.
export KBUILD_BUILD_TIMESTAMP='Thu Jan  1 00:00:00 UTC 1970' KBUILD_BUILD_USER=posthog KBUILD_BUILD_HOST=posthog

wget -q -O /build/stock-bzimage.bin https://raw.githubusercontent.com/PostHog/posthog/62d57d0831d/frontend/src/scenes/terminal/assets/buildroot-bzimage.bin
echo '7befbaea31e249d9a518c4b95fa42b2a193d0e3de46250d617cbdeb866ee28b0  /build/stock-bzimage.bin' | sha256sum -c >/dev/null
python3 /scripts/extract_initramfs.py /build/stock-bzimage.bin /build/initramfs.cpio

cd /build/linux-5.6.15
make tinyconfig >/dev/null
./scripts/kconfig/merge_config.sh -m .config /scripts/kernel.config >/dev/null
make olddefconfig >/dev/null
for option in $(grep -o '^CONFIG_[A-Z0-9_]*' /scripts/kernel.config); do
    grep -q "^$option=" .config || { echo "Kernel option not applied: $option" >&2; exit 1; }
done
make -j"$(nproc)" bzImage >/dev/null
cp arch/x86/boot/bzImage /out/linux-fb-bzimage.bin

sha256sum /out/linux-fb-bzimage.bin
