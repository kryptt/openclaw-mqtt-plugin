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

// Singleton WebSocket connection to OpenClaw gateway
let ws: WebSocket | null = null
let wsReady: Promise<void> | null = null
let connected = false
const pending = new Map<string, { resolve: (v: string) => void, reject: (e: Error) => void, timeout: ReturnType<typeof setTimeout> }>()

// Track completed runs to resolve chat promises
const chatPromises = new Map<string, { resolve: (text: string) => void, reject: (e: Error) => void, timeout: ReturnType<typeof setTimeout>, text: string }>()

function uuid (): string {
  return crypto.randomUUID()
}

function getWsUrl (): string {
  return GATEWAY_URL.replace(/^http/, 'ws')
}

function handleMessage (data: string): void {
  try {
    const msg = JSON.parse(data)

    // Handle response to a request
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!
      pending.delete(msg.id)
      clearTimeout(p.timeout)
      if (msg.error) {
        p.reject(new Error(`Gateway error: ${JSON.stringify(msg.error)}`))
      } else {
        p.resolve(msg.result ? JSON.stringify(msg.result) : 'ok')
      }
      return
    }

    // Handle streamed agent events (run output)
    handleStreamEvent(msg)
  } catch (err) { console.error('[mqtt-plugin] WS parse error:', err) }
}

function handleStreamEvent (msg: any): void {
  // Gateway event frames: { type: "event", event: "chat", payload: { state, message, ... } }
  // Gateway response frames: { type: "res", id, ok, result }
  if (msg.type !== 'event' || msg.event !== 'chat') return
  if (chatPromises.size === 0) return

  const payload = msg.payload
  if (!payload) return

  const state = payload.state

  // Collect text from message content blocks
  const content = payload.message?.content
  if (content && Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        for (const [, cp] of chatPromises) {
          cp.text += block.text
        }
      }
    }
  }

  // Check if run is final or errored
  if (state === 'final' || state === 'error') {
    for (const [key, cp] of chatPromises) {
      clearTimeout(cp.timeout)
      chatPromises.delete(key)
      if (state === 'error') {
        cp.reject(new Error(`Agent run error: ${payload.errorMessage ?? 'unknown'}`))
      } else {
        cp.resolve(cp.text || 'Agent completed (no text output)')
      }
      break
    }
  }
}

function ensureConnected (): Promise<void> {
  if (wsReady && connected) return wsReady
  if (wsReady) return wsReady

  wsReady = new Promise<void>((resolve, reject) => {
    const url = getWsUrl()
    console.log(`[mqtt-plugin] Connecting WebSocket to ${url}`)

    const socket = new WebSocket(url)

    socket.addEventListener('open', () => {
      // Send connect handshake
      const connectId = uuid()
      const connectMsg = {
        type: 'req',
        id: connectId,
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: 'openclaw-tui',
            version: '0.1.0',
            platform: 'node',
            mode: 'cli',
            instanceId: uuid()
          },
          role: 'operator',
          scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'],
          caps: ['tool-events'],
          ...(GATEWAY_TOKEN ? { auth: { token: GATEWAY_TOKEN } } : {})
        }
      }
      socket.send(JSON.stringify(connectMsg))

      // Temporary listener for connect response
      const onConnectResponse = (event: MessageEvent): void => {
        try {
          const msg = JSON.parse(String(event.data))
          if (msg.id === connectId) {
            socket.removeEventListener('message', onConnectResponse)
            if (msg.error) {
              console.error('[mqtt-plugin] Gateway connect error:', msg.error)
              reject(new Error(`Gateway connect failed: ${JSON.stringify(msg.error)}`))
            } else {
              connected = true
              ws = socket
              console.log('[mqtt-plugin] Gateway WebSocket connected')
              resolve()
            }
          }
        } catch { /* ignore */ }
      }
      socket.addEventListener('message', onConnectResponse)

      // Timeout for connect handshake
      setTimeout(() => {
        if (!connected) {
          socket.removeEventListener('message', onConnectResponse)
          reject(new Error('Gateway WebSocket connect timeout'))
        }
      }, 10_000)
    })

    // Main message handler (installed after connect)
    socket.addEventListener('message', (event) => {
      if (connected) {
        handleMessage(String(event.data))
      }
    })

    socket.addEventListener('close', () => {
      console.log('[mqtt-plugin] Gateway WebSocket closed')
      connected = false
      wsReady = null
      ws = null
      for (const [id, p] of pending) {
        clearTimeout(p.timeout)
        p.reject(new Error('WebSocket closed'))
        pending.delete(id)
      }
      for (const [id, cp] of chatPromises) {
        clearTimeout(cp.timeout)
        cp.reject(new Error('WebSocket closed'))
        chatPromises.delete(id)
      }
    })

    socket.addEventListener('error', (event) => {
      console.error('[mqtt-plugin] Gateway WebSocket error:', (event as any).message ?? 'unknown')
    })

    // Global connection timeout
    setTimeout(() => {
      if (!connected) {
        socket.close()
        reject(new Error('Gateway WebSocket connection timeout'))
      }
    }, 15_000)
  })

  return wsReady
}

function sendRequest (method: string, params: Record<string, unknown>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('WebSocket not connected'))
      return
    }

    const id = uuid()
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Gateway request timeout: ${method}`))
    }, 120_000)

    pending.set(id, { resolve, reject, timeout })
    ws.send(JSON.stringify({ type: 'req', id, method, params }))
  })
}

export const GatewayDispatchLive = Layer.succeed(GatewayDispatch, {
  chat: (prompt) =>
    Effect.tryPromise({
      try: async () => {
        await ensureConnected()

        // Register a chat promise to collect streamed output
        const chatId = uuid()
        const chatResult = new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            chatPromises.delete(chatId)
            reject(new Error('Chat response timeout (300s)'))
          }, 300_000)
          chatPromises.set(chatId, { resolve, reject, timeout, text: '' })
        })

        // Send chat.send request — uses the main session which tracks
        // the user's most recent communication channel dynamically
        await sendRequest('chat.send', {
          sessionKey: 'main',
          message: prompt,
          deliver: true,
          idempotencyKey: uuid()
        })

        // Wait for the agent run to complete and collect output
        const raw = await chatResult
        // Strip LLM reasoning/thinking tags from output
        return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      },
      catch: (err) => new GatewayError({ message: `Gateway chat failed: ${err}`, cause: err })
    })
})
