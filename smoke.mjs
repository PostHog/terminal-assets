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
const classics = ['sl', 'cmatrix', 'figlet', 'nyancat']
const classicsOnly = process.argv.includes('--classics')
const neovimOnly = process.argv.includes('--neovim')
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
                if (classicsOnly && !classics.includes(id)) continue
                if (neovimOnly && id !== 'neovim') continue
                const bytes = gunzipSync(fs.readFileSync(new URL(pkg.file, import.meta.url)))
                assert.equal(bytes.length, pkg.archiveSize)
                await vm.create_file(id + '.tar', bytes)
            }
            const node = '/opt/posthog-packages/node-' + manifest.packages.node.version
            const pi = '/opt/posthog-packages/pi-' + manifest.packages.pi.version
            const classicSetup = classics.map(id => {
                const prefix = '/opt/posthog-packages/' + id + '-' + manifest.packages[id].version
                return `mkdir -p '${prefix}'; tar -xf /mnt/${id}.tar -C '${prefix}'; ln -s '${prefix}/bin/${id}' /usr/bin/${id}`
            }).join('\n')
            const classicChecks = `set -eu
mkdir -p /opt/posthog-packages
mount -t tmpfs -o size=64m tmpfs /opt/posthog-packages
${classicSetup}
export TERM=xterm-256color
stty rows 24 cols 80
figlet PostHog > /tmp/banner
grep -q '_' /tmp/banner
figlet -f small PostHog > /tmp/small-banner
test -s /tmp/small-banner
printf 'PostHog' | figlet > /tmp/piped-banner
cmp /tmp/banner /tmp/piped-banner
nyancat -f 2 > /tmp/cat
test -s /tmp/cat
cmatrix -V 2>&1 | grep -q '2.0'
printf q | cmatrix -b > /tmp/matrix
sl -l > /tmp/train
test -s /tmp/matrix
test -s /tmp/train
printf 'Classic commands, fonts, pipes, animation, and Matrix quit checks passed\\n'
`
            const neovim = '/opt/posthog-packages/neovim-' + manifest.packages.neovim.version
            const neovimChecks = `set -eu
mkdir -p '${neovim}'
tar -xf /mnt/neovim.tar -C '${neovim}'
ln -s '${neovim}/lib/ld-musl-i386.so.1' /lib/ld-musl-i386.so.1
ln -s '${neovim}/bin/nvim' /usr/bin/nvim
export TERM=xterm-256color
stty rows 24 cols 80
nvim --version | grep 'NVIM v0.11.1'
cat > /tmp/check.lua <<'LUA'
assert(require('lpeg').match(require('lpeg').P('hello'), 'hello') == 6)
assert(require('re').match('hello', "'hello'") == 6)
assert(vim.uv.fs_stat('/tmp').type == 'directory')
vim.cmd('edit /tmp/neovim-smoke.lua')
vim.api.nvim_buf_set_lines(0, 0, -1, false, {'print("Neovim in PostHog")'})
vim.cmd('set filetype=lua')
vim.cmd('syntax on')
assert(vim.bo.filetype == 'lua')
for _, language in ipairs({'c', 'lua', 'markdown', 'markdown_inline', 'query', 'vim', 'vimdoc'}) do
    assert(vim.treesitter.language.add(language))
end
assert(#vim.treesitter.get_string_parser('return 42', 'lua'):parse() == 1)
vim.cmd('write')
assert(vim.fn.readfile('/tmp/neovim-smoke.lua')[1] == 'print("Neovim in PostHog")')
vim.cmd('help nvim')
assert(vim.bo.buftype == 'help')
local child = vim.fn.system({vim.v.progpath, '--clean', '--headless', '+q'})
assert(vim.v.shell_error == 0, child)
vim.cmd('qa!')
LUA
nvim --clean --headless -l /tmp/check.lua
printf 'Neovim file save, syntax, Lua modules, help, and child process checks passed\\n'
`
            await vm.create_file('smoke.sh', Buffer.from(neovimOnly ? neovimChecks : classicsOnly ? classicChecks : `set -eu
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
