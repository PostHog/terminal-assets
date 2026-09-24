import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const posthog = path.resolve(process.argv[2] ?? '.')
const require = createRequire(path.join(posthog, 'frontend/package.json'))
const v86Path = require.resolve('v86')
const { V86 } = await import(pathToFileURL(v86Path).href)
const buffer = (file) => Uint8Array.from(fs.readFileSync(file)).buffer
const asset = (name) => buffer(path.join(posthog, 'frontend/src/scenes/terminal/assets', name))
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url)))
const pkg = manifest.packages.doom
const archive = gunzipSync(fs.readFileSync(new URL(pkg.file, import.meta.url)))
assert.equal(archive.length, pkg.archiveSize)
const vm = new V86({
    wasm_path: path.join(path.dirname(v86Path), 'v86.wasm'),
    bios: { buffer: asset('seabios.bin') },
    vga_bios: { buffer: asset('vgabios.bin') },
    bzimage: { buffer: buffer(new URL('./images/linux-fb-bzimage.bin', import.meta.url)) },
    memory_size: 512 * 1024 * 1024,
    filesystem: {},
    uart1: true,
    cmdline: 'tsc=reliable mitigations=off random.trust_cpu=on video=640x480',
    autostart: true,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
})
const timeout = setTimeout(() => {
    console.error('Doom controls timed out', output)
    process.exit(1)
}, 120_000)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let output = '',
    started = false,
    playing = false,
    checked = false
const config = `key_up 17\nkey_down 31\nkey_strafeleft 30\nkey_straferight 32\nkey_fire 57\nkey_use 18\nmouseb_fire 0\nmouseb_strafe -1\nmouseb_forward -1\n`
async function checkRecording() {
    const demo = await vm.read_file('controls.lmp')
    assert(demo, 'Doom must write a recording')
    assert.equal(demo[0], 109)
    const commands = []
    for (let index = 13; index + 3 < demo.length && demo[index] !== 128; index += 4) {
        const signed = (value) => (value > 127 ? value - 256 : value)
        commands.push({
            forward: signed(demo[index]),
            side: signed(demo[index + 1]),
            turn: signed(demo[index + 2]),
            buttons: demo[index + 3],
        })
    }
    console.log('Recorded commands:', [...new Set(commands.map((command) => JSON.stringify(command)))])
    console.log('Saved config:', new TextDecoder().decode(await vm.read_file('controls.cfg')).slice(0, 1800))
    for (const [name, predicate] of [
        ['W moves forward', (c) => c.forward > 0],
        ['S moves backward', (c) => c.forward < 0],
        ['A strafes left', (c) => c.side < 0],
        ['D strafes right', (c) => c.side > 0],
        ['arrows turn', (c) => c.turn !== 0],
        [
            'mouse turns independently while strafing without moving forward',
            (c) => c.side > 0 && c.turn !== 0 && c.forward === 0,
        ],
        ['Space fires', (c) => c.buttons & 1],
        ['E uses', (c) => c.buttons & 2],
    ])
        assert(commands.some(predicate), name)
    console.log(
        'PASS: recorded Doom commands confirm WASD movement, strafing, keyboard and mouse turning, fire, and use'
    )
    clearTimeout(timeout)
    await vm.destroy()
}
vm.add_listener('serial0-output-byte', (byte) => {
    process.stdout.write(String.fromCharCode(byte))
    output = (output + String.fromCharCode(byte)).slice(-8192)
    if (!started && output.endsWith('~% ')) {
        started = true
        void (async () => {
            await vm.create_file('doom.tar', archive)
            await vm.create_file('controls.cfg', new TextEncoder().encode(config))
            await vm.create_file(
                'run-controls.sh',
                new TextEncoder().encode(`set -eu
root=/opt/posthog-packages/doom-${pkg.version}
mkdir -p "$root"
tar -xf /mnt/doom.tar -C "$root"
printf '#!/bin/sh\\ncase "$1" in on) printf "\\\\021";; off) printf "\\\\022";; esac > /dev/ttyS1\\n' > /usr/bin/display
chmod +x /usr/bin/display
"$root/bin/doom" -config /mnt/controls.cfg -nomonsters -warp 1 1 -skill 1 -record /mnt/controls
`)
            )
            vm.serial0_send(
                'stty -echo; umount /mnt; mount -t 9p -o trans=virtio,version=9p2000.L,cache=none host9p /mnt; sh /mnt/run-controls.sh; printf "\\n__CONTROLS_RESULT_%s__\\n" "$?"\n'
            )
        })().catch((error) => {
            console.error(error)
            process.exit(1)
        })
    }
    if (!playing && output.includes('Mouse input ready')) {
        playing = true
        void (async () => {
            await wait(5000)
            for (const scan of [17, 31, 30, 32, 0xe04d, 57, 18]) {
                vm.keyboard_send_scancodes([...(scan > 255 ? [0xe0] : []), scan & 255])
                await wait(1000)
                vm.keyboard_send_scancodes([...(scan > 255 ? [0xe0] : []), (scan & 255) | 128])
                await wait(120)
            }
            vm.keyboard_send_scancodes([32])
            for (let move = 0; move < 5; move++) {
                vm.bus.send('mouse-delta', [20, 20])
                await wait(100)
            }
            vm.keyboard_send_scancodes([32 | 128])
            vm.keyboard_send_scancodes([16])
        })().catch((error) => {
            console.error(error)
            process.exit(1)
        })
    }
    if (output.includes('Demo /mnt/controls.lmp recorded') && !checked) {
        checked = true
        void checkRecording().catch((error) => {
            console.error(error)
            process.exit(1)
        })
    }
})
