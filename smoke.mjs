import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const posthog = path.resolve(process.argv[2] ?? '.')
const require = createRequire(path.join(posthog, 'frontend/package.json'))
const v86Path = require.resolve('v86')
const { V86 } = await import(pathToFileURL(v86Path).href)
const asset = name => Uint8Array.from(fs.readFileSync(path.join(posthog, 'frontend/src/scenes/terminal/assets', name))).buffer
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url)))
const vm = new V86({
    wasm_path: path.join(path.dirname(v86Path), 'v86.wasm'),
    bios: { buffer: asset('seabios.bin') }, vga_bios: { buffer: asset('vgabios.bin') },
    bzimage: { buffer: asset('buildroot-bzimage.bin') }, memory_size: 512 * 1024 * 1024,
    filesystem: {}, cmdline: 'tsc=reliable mitigations=off random.trust_cpu=on',
    autostart: true, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
})
const timeout = setTimeout(() => { console.error('VM smoke test timed out'); process.exit(1) }, 300_000)
let output = '', started = false
vm.add_listener('serial0-output-byte', byte => {
    const text = String.fromCharCode(byte)
    process.stdout.write(text)
    output = (output + text).slice(-4096)
    const result = output.match(/__TERMINAL_ASSET_RESULT_(\d+)__/)
    if (result) {
        clearTimeout(timeout)
        void vm.destroy().then(() => process.exit(Number(result[1])))
    }
    if (!started && output.endsWith('~% ')) {
        started = true
        void (async () => {
            for (const [id, pkg] of Object.entries(manifest.packages)) {
                const bytes = gunzipSync(fs.readFileSync(new URL(pkg.file, import.meta.url)))
                assert.equal(bytes.length, pkg.archiveSize)
                await vm.create_file(id + '.tar', bytes)
            }
            const node = '/opt/posthog-packages/node-' + manifest.packages.node.version
            const pi = '/opt/posthog-packages/pi-' + manifest.packages.pi.version
            await vm.create_file('smoke.sh', Buffer.from(`set -eu
mkdir -p /opt/posthog-packages
mount -t tmpfs -o size=256m tmpfs /opt/posthog-packages
mkdir '${node}' '${pi}'
tar -xf /mnt/node.tar -C '${node}'
tar -xf /mnt/pi.tar -C '${pi}'
ln -s '${node}/lib/ld-musl-i386.so.1' /lib/ld-musl-i386.so.1
ln -s '${node}/bin/node' /usr/bin/node
node -e 'const assert = require("assert"); assert.equal(process.version, "v${manifest.packages.node.version}"); assert(new RegExp("^\\\\p{RGI_Emoji}$", "v").test("😀")); assert.equal(require("child_process").execFileSync(process.execPath, ["-p", "6 * 7"], { encoding: "utf8" }).trim(), "42"); console.log("Node runtime, Unicode, and child process checks passed")'
export PI_OFFLINE=1
export PATH="${pi}/bin:$PATH"
fd --version
rg --version
printf "companion check\\n" > /tmp/companion.txt
rg -q "companion check" /tmp/companion.txt
fd --base-directory /tmp companion | grep -q companion.txt
[ "$(node '${pi}/dist/bundle/cli.js' --version)" = '${manifest.packages.pi.version}' ]
node '${pi}/dist/bundle/cli.js' --help > /tmp/pi-help
grep -q 'AI coding assistant' /tmp/pi-help
printf 'pi version and help checks passed\\n'
`))
            vm.serial0_send('stty -echo; sh /mnt/smoke.sh; printf "\\n__TERMINAL_ASSET_RESULT_%s__\\n" "$?"\n')
        })().catch(error => { console.error(error); process.exit(1) })
    }
})
