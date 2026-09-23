# PostHog terminal assets

Optional software for the browser terminal in [PostHog/posthog](https://github.com/PostHog/posthog).
These archives are downloaded on first use and are separate from the terminal's boot image and bundled Unix tools.

| Tool | Version | Runtime |
| --- | --- | --- |
| Node.js | 22.23.2 | Alpine Linux 3.22 x86, musl |
| Doom (Freedoom) | 0.13.0-1 | Static fbDOOM, Linux framebuffer and PS/2 input |
| pi | 0.87.1 | Node.js 22.19 or later |

The terminal runs 32-bit Linux in v86.
The archives include runtime dependencies, so installation needs no package manager or network connection inside the VM.
pi includes Alpine x86 builds of fd and ripgrep for local file discovery and search.
pi runs with `PI_OFFLINE=1`; model calls and login require a separate network bridge.

## Build

Use Python 3.13 or later:

```sh
python3 build.py
```

The builder checks every upstream download against the pinned integrity value in `recipes/`.
It never runs npm lifecycle scripts.
Node.js and its shared libraries come from Alpine's official x86 packages.
pi comes from the published npm package and its dependency lockfile, with missing upstream lockfile integrity values pinned from the npm registry.
Type declarations, type-only packages, and source maps are omitted from the pi archive.
All executable code and runtime resources remain upstream code.

The Node launcher configures its own library and ICU data paths.
The guest must provide `/lib/ld-musl-i386.so.1`; the PostHog terminal links its bundled musl loader there.
This lets Node execute directly and preserves `process.execPath` for child processes.

`manifest.json` records compressed and expanded sizes, SHA-256 hashes, commands, and tool dependencies.
Tar entries have fixed modes, timestamps, and ownership, and gzip has a fixed timestamp.

## Validate

From a prepared PostHog checkout, run:

```sh
.codex/with-flox node /path/to/terminal-assets/smoke.mjs "$PWD"
```

The smoke test uses the checkout's v86 package and existing kernel and firmware.
It checks Node execution, Unicode regex data, child Node processes, and pi's version and help output in a 512 MiB VM.
The terminal's live Storybook story exercises browser downloads, verification, caching, and installation.

## Publish and add tools

Commit archives as ordinary Git files, not Git LFS pointers.
GitHub raw serves them with browser-compatible CORS headers; GitHub release downloads do not provide the same browser access.
Keep each compressed archive below GitHub's 100 MiB file limit.

After testing a new archive, push a commit here, then update `frontend/src/scenes/terminal/terminal-packages.json` in PostHog/posthog.
Use the full commit hash in its `baseUrl` and copy the matching package metadata.
The frontend must pin both the URL and checksum; it must never download an executable manifest from a mutable branch.
A package archive extracts into `/opt/posthog-packages/<id>-<version>/` and must not contain paths outside that directory.

For another tool, add a pinned recipe and builder here, then register its commands and dependencies in the frontend manifest.
The browser fetches and verifies archives; the guest installer serializes installs and only publishes a completed directory.

## Licensing and sources

Upstream packages retain their licenses.
`licenses/` contains the Node.js dependency notices, pi's MIT license, musl's copyright notice, SQLite's public-domain notice, and the GCC runtime exception and GPL text for libgcc and libstdc++.
The builder includes these notices in each archive; npm dependency license files are also preserved.
`recipes/licenses.json` records notice source URLs and hashes.

Node and bundled dependency sources: [Node.js v22.23.2](https://github.com/nodejs/node/tree/v22.23.2).
Alpine build recipes and corresponding source URLs: [Alpine aports 3.22](https://gitlab.alpinelinux.org/alpine/aports/-/tree/3.22-stable/main).
GCC runtime sources: [GCC 14.2.0](https://github.com/gcc-mirror/gcc/tree/releases/gcc-14.2.0).
pi sources: [pi v0.87.1](https://github.com/earendil-works/pi/tree/v0.87.1).
The exact binary packages, versions, and hashes are in `recipes/node-packages.json` and `recipes/pi-lock.json`; companion tool sources and hashes are in `recipes/pi-tools.json`.

## Doom and framebuffer

`python3 build.py --only doom` builds the standalone Doom archive from checksum-pinned binaries in `binaries/`.
It includes fbDOOM, Freedoom phase 1, the launcher, and license notices.
The launcher uses virtual console 5 and sends `display on` and `display off` to the host.
The guest must provide that display command and framebuffer and input drivers.
Closing the host display sends Ctrl+C to the serial foreground process group; the launcher restores the console when interrupted.

`images/linux-fb-bzimage.bin` is the Linux 5.6.15 framebuffer kernel, with SHA-256 `33ca60bd4832f0cf202845fa7ac1a60776c0215e8a20d21a3f07d3722f99e415`.
It retains the stock terminal initramfs and adds Bochs framebuffer and PS/2 drivers.
`sh recipes/display/build.sh` rebuilds the kernel and static fbDOOM binary with Docker.
The checked-in binaries originate from [PostHog/posthog#103893](https://github.com/PostHog/posthog/pull/103893), commit `0b3b63d8c4e5f5e3703a558fd87b5353556ca95d`.
The build pins fbDOOM to `17280163bc95e5d954d2efaa0633489b763b4cd1` and musl to 1.2.5.
`binaries/freedoom1.wad.gz` contains the unmodified phase 1 WAD from the [Freedoom 0.13.0 release](https://github.com/freedoom/freedoom/releases/tag/v0.13.0).
See `licenses/display-NOTICE.txt` for source and license details.
