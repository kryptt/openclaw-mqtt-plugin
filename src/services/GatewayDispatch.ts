import { Context, Effect, Layer } from 'effect'
import { GATEWAY_URL, GATEWAY_TOKEN } from '../config.js'
import { GatewayError } from '../errors.js'

export interface GatewayDispatchShape {
  readonly chat: (prompt: string) => Effect.Effect<string, GatewayError>
}

export class GatewayDispatch extends Context.Tag('GatewayDispatch')<
  GatewayDispatch,
  GatewayDispatchShape
>() {}

export const GatewayDispatchLive = Layer.succeed(GatewayDispatch, {
  chat: (prompt) =>
    Effect.tryPromise({
      try: async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 120_000)

        try {
          const res = await fetch(`${GATEWAY_URL}/api/chat`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {})
            },
            body: JSON.stringify({
              messages: [{ role: 'user', content: prompt }]
            }),
            signal: controller.signal
          })

          if (!res.ok) {
            throw new Error(`Gateway returned ${res.status}: ${await res.text().catch(() => 'no body')}`)
          }

          const data = await res.json() as { message?: { content?: string }, choices?: { message?: { content?: string } }[] }
          // Handle both OpenClaw-native and OpenAI-compatible response shapes
          return data.message?.content
            ?? data.choices?.[0]?.message?.content
            ?? JSON.stringify(data)
        } finally {
          clearTimeout(timeout)
        }
      },
      catch: (err) => new GatewayError({ message: `Gateway chat failed: ${err}`, cause: err })
    })
})
