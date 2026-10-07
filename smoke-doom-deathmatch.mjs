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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const timeout = setTimeout(() => {
    console.error('Doom deathmatch timed out')
    process.exit(1)
}, 300_000)

// The browser relays SLIP frames from the guest's third serial port. The first byte names the peer.
const CONTROL = 255
function encode(peer, payload) {
    const bytes = [0xc0]
    for (const byte of [peer, ...payload]) {
        bytes.push(...(byte === 0xc0 ? [0xdb, 0xdc] : byte === 0xdb ? [0xdb, 0xdd] : [byte]))
    }
    bytes.push(0xc0)
    return Uint8Array.from(bytes)
}
function decoder(onFrame) {
    let frame = []
    let escaped = false
    return (byte) => {
        if (byte === 0xc0) {
            if (frame.length) {
                onFrame(frame[0], Uint8Array.from(frame.slice(1)))
            }
            frame = []
        } else if (escaped) {
            frame.push(byte === 0xdc ? 0xc0 : byte === 0xdd ? 0xdb : byte)
            escaped = false
        } else if (byte === 0xdb) {
            escaped = true
        } else {
            frame.push(byte)
        }
    }
}

function boot(name, command, onPrompt) {
    const vm = new V86({
        wasm_path: path.join(path.dirname(v86Path), 'v86.wasm'),
        bios: { buffer: asset('seabios.bin') },
        vga_bios: { buffer: asset('vgabios.bin') },
        bzimage: { buffer: buffer(new URL('./images/linux-fb-bzimage.bin', import.meta.url)) },
        memory_size: 512 * 1024 * 1024,
        filesystem: {},
        uart1: true,
        uart2: true,
        cmdline: 'tsc=reliable mitigations=off random.trust_cpu=on video=640x480',
        autostart: true,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
    })
    let output = ''
    let started = false
    vm.output = () => output
    vm.add_listener('serial0-output-byte', (byte) => {
        output = (output + String.fromCharCode(byte)).slice(-16384)
        if (!started && output.endsWith('~% ')) {
            started = true
            void (async () => {
                await vm.create_file('doom.tar', archive)
                await vm.create_file('controls.cfg', new TextEncoder().encode('key_up 17\nkey_fire 57\n'))
                await vm.create_file(
                    'run.sh',
                    new TextEncoder().encode(`set -eu
root=/opt/posthog-packages/doom-${pkg.version}
mkdir -p "$root"
tar -xf /mnt/doom.tar -C "$root"
printf '#!/bin/sh\\ncase "$1" in on) printf "\\\\021";; off) printf "\\\\022";; esac > /dev/ttyS1\\n' > /usr/bin/display
chmod +x /usr/bin/display
"$root/bin/doom" -config /mnt/controls.cfg ${command}
`)
                )
                await onPrompt()
                vm.serial0_send(
                    'stty -echo; umount /mnt; mount -t 9p -o trans=virtio,version=9p2000.L,cache=none host9p /mnt; sh /mnt/run.sh; printf "\\n__RESULT_%s__\\n" "$?"\n'
                )
            })().catch((error) => {
                console.error(error)
                process.exit(1)
            })
        }
    })
    vm.add_listener('serial0-output-byte', (byte) =>
        process.stdout.write(byte === 10 ? `\n[${name}] ` : String.fromCharCode(byte))
    )
    return vm
}

let hostWaiting
const hostReady = new Promise((resolve) => (hostWaiting = resolve))
const host = boot('host', '-server -deathmatch -nodes 2 -warp 1 1 -skill 1 -record /mnt/match', async () => {})
const client = boot('client', '-connect SMOKE1', () => hostReady)
const send = (vm, peer, payload) => vm.serial_send_bytes(2, encode(peer, payload))
const controls = []
host.add_listener(
    'serial2-output-byte',
    decoder((peer, payload) => {
        if (peer === CONTROL) {
            const message = new TextDecoder().decode(payload)
            controls.push(`host: ${message}`)
            if (message === 'host') {
                send(host, CONTROL, new TextEncoder().encode('room SMOKE1'))
                hostWaiting()
            }
        } else {
            assert.equal(peer, 1, 'The host must address the only client as peer 1')
            send(client, 0, payload)
        }
    })
)
client.add_listener(
    'serial2-output-byte',
    decoder((peer, payload) => {
        if (peer === CONTROL) {
            const message = new TextDecoder().decode(payload)
            controls.push(`client: ${message}`)
            if (message === 'join SMOKE1') {
                send(client, CONTROL, new TextEncoder().encode('joined'))
            }
        } else {
            assert.equal(peer, 0, 'The client must address the host as peer 0')
            send(host, 1, payload)
        }
    })
)

while (!/player 2 of 2/.test(client.output()) || !/player 1 of 2/.test(host.output())) {
    await wait(500)
}
await wait(10_000)
client.keyboard_send_scancodes([17])
await wait(3000)
client.keyboard_send_scancodes([17 | 128])
await wait(1000)
host.keyboard_send_scancodes([16])
while (!host.output().includes('Demo /mnt/match.lmp recorded')) {
    await wait(500)
}

const demo = await host.read_file('match.lmp')
assert.equal(demo[0], 109)
assert.equal(demo[4], 1, 'The game must be a deathmatch')
assert.deepEqual([...demo.slice(9, 13)], [1, 1, 0, 0], 'Both players must be in the game')
const clientForward = []
for (let index = 13; index + 7 < demo.length && demo[index] !== 128; index += 8) {
    clientForward.push(demo[index + 4] > 127 ? demo[index + 4] - 256 : demo[index + 4])
}
assert(clientForward.some((forward) => forward > 0), "The host must receive the client's movement")
assert.deepEqual(controls.sort(), ['client: join SMOKE1', 'client: launched', 'host: host', 'host: launched'])
console.log(`\nPASS: ${clientForward.length} deathmatch tics recorded on the host with the client's movement`)
clearTimeout(timeout)
await Promise.all([host.destroy(), client.destroy()])
process.exit(0)
