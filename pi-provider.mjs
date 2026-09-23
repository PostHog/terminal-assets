import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

import { streamSimple } from './node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js'

async function terminalFetch(input, init) {
    const request = new Request(input, init)
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/messages') {
        throw new Error('The PostHog provider only supports model messages.')
    }
    const signal = request.signal
    const id = randomUUID()
    const body = JSON.parse(await request.text())
    signal.throwIfAborted()
    await writeFile('/posthog/.ai/request', JSON.stringify({ id, body }))

    const cleanup = async () => {
        await writeFile('/posthog/.ai/cancel', id).catch(() => {})
    }
    const next = async () => {
        signal.throwIfAborted()
        const frame = JSON.parse(await readFile('/posthog/.ai/response', 'utf8'))
        if (frame.id !== id) {
            throw new Error('Another pi request replaced this one. Run one pi session at a time.')
        }
        if (frame.error) {
            throw new Error(frame.error)
        }
        return frame
    }

    try {
        let frame = await next()
        while (!frame.status) {
            await setTimeout(100, undefined, { signal })
            frame = await next()
        }
        const encoder = new TextEncoder()
        const status = frame.status
        const stream = new ReadableStream({
            async pull(controller) {
                try {
                    while (!frame.body && !frame.done) {
                        await setTimeout(100, undefined, { signal })
                        frame = await next()
                    }
                    if (frame.body) {
                        controller.enqueue(encoder.encode(frame.body))
                    }
                    if (frame.done) {
                        await cleanup()
                        controller.close()
                    } else {
                        frame = { body: '', done: false }
                    }
                } catch (error) {
                    await cleanup()
                    controller.error(error)
                }
            },
            cancel: cleanup,
        })
        return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } })
    } catch (error) {
        await cleanup()
        throw error
    }
}

export default function posthogProvider(pi) {
    pi.registerProvider('posthog', {
        baseUrl: 'https://posthog.invalid',
        apiKey: 'posthog-session',
        api: 'anthropic-messages',
        models: [
            { id: 'claude-opus-5', name: 'Claude Opus 5', cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
            { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
            { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
            { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
        ].map(model => ({
            ...model,
            name: `${model.name} (PostHog)`,
            reasoning: false,
            input: ['text', 'image'],
            contextWindow: 200000,
            maxTokens: 8192,
        })),
        streamSimple: (model, context, options) => streamSimple(model, context, { ...options, fetch: terminalFetch }),
    })
    pi.on('before_agent_start', async (event) => ({
        systemPrompt: event.systemPrompt + '\n\nYou are running in the PostHog browser terminal. '
            + 'Read /posthog/README.txt for the filesystem and command interface. '
            + 'Use `ph tools` to discover PostHog commands and connected MCP tools, then `ph help <command>` for their arguments. '
            + 'These commands run as the signed-in user in the current project. Files under /posthog/files are live project data; '
            + 'saving, moving, or deleting them can change PostHog. Confirm consequential changes with the user. '
            + 'Use /tmp for scratch files. The VM has no external network. Its local files and pi sessions disappear when the terminal stops.',
    }))
}
