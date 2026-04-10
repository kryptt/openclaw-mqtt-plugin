import { Effect, Layer } from 'effect'
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { MqttClient, MqttClientLive } from './services/MqttClient.js'
import { GatewayDispatch, GatewayDispatchLive } from './services/GatewayDispatch.js'
import { AGENT_NAME } from './config.js'
import { BUS_TOPIC, makeBusMessage, type AgentBusMessage } from './types.js'

type AppServices = MqttClient | GatewayDispatch

// Noop MQTT layer for graceful degradation when broker is unavailable
const noopMqttLayer = Layer.succeed(MqttClient, {
  publish: () => Effect.void,
  subscribe: () => Effect.void,
  isConnected: () => false
})

let appLayer = Layer.mergeAll(noopMqttLayer, GatewayDispatchLive)
let mqttReady = false

const run = <A>(
  effect: Effect.Effect<A, unknown, AppServices>
): Promise<A | undefined> =>
    Effect.runPromise(effect.pipe(
      Effect.provide(appLayer),
      Effect.catchAll((err) => {
        console.error('[mqtt-plugin] effect failed:', err)
        return Effect.succeed(undefined as A | undefined)
      })
    ))

// Track correlation IDs for before_prompt_build → agent_end pairing
let currentMessageId: string | null = null
let taskStartedAt: number | null = null

function publishToBus (msg: AgentBusMessage): Promise<void | undefined> {
  return run(
    Effect.gen(function * () {
      const mqtt = yield * MqttClient
      yield * mqtt.publish(BUS_TOPIC, msg as unknown as Record<string, unknown>)
    })
  )
}

export default definePluginEntry({
  id: 'openclaw-mqtt-plugin',
  name: 'Agent Bus Bridge',
  description: 'Bridges OpenClaw agent to the shared agent bus (openclaw/agents/bus) for inter-agent communication',
  kind: 'integration',

  register (api) {
    // Initialize MQTT connection (non-blocking, matches initDb pattern)
    const initMqtt = async (): Promise<void> => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function * () {
          const mqtt = yield * MqttClient
          if (!mqtt.isConnected()) {
            throw new Error('Not connected after init')
          }
        }).pipe(Effect.provide(MqttClientLive))
      )

      if (exit._tag === 'Success') {
        const safeMqttLayer = Layer.catchAll(MqttClientLive, () => noopMqttLayer)
        appLayer = Layer.mergeAll(safeMqttLayer, GatewayDispatchLive)
        mqttReady = true
        console.log('[mqtt-plugin] MQTT connected, subscribing to agent bus')

        // Subscribe to the single agent bus topic
        await run(
          Effect.gen(function * () {
            const mqtt = yield * MqttClient
            yield * mqtt.subscribe(BUS_TOPIC, (topic, payload) => {
              handleBusMessage(payload).catch((err) =>
                console.error('[mqtt-plugin] Bus message error:', err)
              )
            })
          })
        )
      } else {
        console.error('[mqtt-plugin] MQTT unavailable, agent bus disabled. Exit:', JSON.stringify(exit))
      }
    }

    // Handle incoming messages from the agent bus
    async function handleBusMessage (payload: Buffer): Promise<void> {
      let msg: AgentBusMessage
      try {
        msg = JSON.parse(payload.toString())
      } catch {
        console.error('[mqtt-plugin] Invalid bus message payload')
        return
      }

      // Only process messages addressed to this agent
      if (msg.to !== AGENT_NAME && msg.to !== '*') return
      // Ignore our own messages
      if (msg.from === AGENT_NAME) return

      switch (msg.type) {
        case 'task':
          await handleTask(msg)
          break
        case 'message':
          await handleIncomingMessage(msg)
          break
        // presence and event from other agents — ignore for now
      }
    }

    // Dispatch a task to the OpenClaw agent via gateway
    async function handleTask (msg: AgentBusMessage & { type: 'task' }): Promise<void> {
      console.log(`[mqtt-plugin] Task ${msg.id} from ${msg.from}: skill=${msg.skill}`)

      await run(
        Effect.gen(function * () {
          const gateway = yield * GatewayDispatch
          const mqtt = yield * MqttClient

          yield * gateway.chat(
            `[Task ${msg.id}] Use the ${msg.skill} skill to: ${msg.prompt}`
          ).pipe(
            Effect.flatMap((response) =>
              mqtt.publish(BUS_TOPIC, makeBusMessage('event', AGENT_NAME, msg.from, {
                status: 'completed',
                summary: response.slice(0, 500),
                data: { taskId: msg.id, skill: msg.skill }
              }) as unknown as Record<string, unknown>).pipe(Effect.map(() => {
                console.log(`[mqtt-plugin] Task ${msg.id} completed`)
              }))
            ),
            Effect.catchAll((err) =>
              Effect.gen(function * () {
                console.error(`[mqtt-plugin] Task ${msg.id} failed: ${err}`)
                yield * mqtt.publish(BUS_TOPIC, makeBusMessage('event', AGENT_NAME, msg.from, {
                  status: 'error',
                  summary: `Task failed: ${err}`,
                  data: { taskId: msg.id, skill: msg.skill }
                }) as unknown as Record<string, unknown>)
              })
            )
          )
        })
      )
    }

    // Handle a direct message from another agent
    async function handleIncomingMessage (msg: AgentBusMessage & { type: 'message' }): Promise<void> {
      console.log(`[mqtt-plugin] Message from ${msg.from}: ${msg.body.slice(0, 100)}`)
      // Forward to the agent as a chat prompt so it can respond
      await run(
        Effect.gen(function * () {
          const gateway = yield * GatewayDispatch
          yield * gateway.chat(
            `[Message from ${msg.from}] ${msg.body}`
          )
        })
      )
    }

    // Hook: before_prompt_build — publish event:started
    api.on('before_prompt_build', async (event: any) => {
      if (!mqttReady) return {}

      try {
        let prompt = ''
        const msgs: any[] = event?.messages ?? []
        const userMsgs = msgs.filter((m: any) => m.role === 'user')
        if (userMsgs.length) {
          const last = userMsgs[userMsgs.length - 1]
          const content = last.content
          if (typeof content === 'string') {
            prompt = content
          } else if (Array.isArray(content)) {
            prompt = content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join(' ')
          }
        }
        if (!prompt || prompt.length < 5) return {}

        const msg = makeBusMessage('event', AGENT_NAME, '*', {
          status: 'started',
          summary: prompt.slice(0, 200)
        })
        currentMessageId = msg.id
        taskStartedAt = Date.now()

        await publishToBus(msg)
      } catch {
        // Event publishing is best-effort
      }

      return {}
    })

    // Hook: agent_end — publish event:completed
    api.on('agent_end', async (event: any) => {
      if (!mqttReady) return {}

      try {
        const msgs: any[] = event?.messages ?? []
        const assistantMsgs = msgs.filter((m: any) => m.role === 'assistant')
        let summary = ''
        if (assistantMsgs.length) {
          const last = assistantMsgs[assistantMsgs.length - 1]
          const content = last.content
          if (typeof content === 'string') {
            summary = content.slice(0, 300)
          } else if (Array.isArray(content)) {
            summary = content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join(' ')
              .slice(0, 300)
          }
        }

        const durationMs = taskStartedAt ? Date.now() - taskStartedAt : 0

        await publishToBus(makeBusMessage('event', AGENT_NAME, '*', {
          status: 'completed',
          summary: summary || 'No summary available',
          data: {
            replyTo: currentMessageId,
            duration_ms: durationMs
          }
        }))

        currentMessageId = null
        taskStartedAt = null
      } catch {
        // Event publishing is best-effort
      }

      return {}
    })

    // Tool: agent_comms — send messages to the agent bus
    api.registerTool({
      name: 'agent_comms',
      label: 'Agent Communications',
      description: 'Send a message on the shared agent bus (openclaw/agents/bus).\n\n' +
        'Message types:\n' +
        '  message — send text to another agent or user\n' +
        '  task    — request another agent to execute a skill\n' +
        '  presence — announce interaction with a human user\n\n' +
        'Addressing:\n' +
        '  to: "claude"        — direct to Claude Code agent\n' +
        '  to: "roci"          — direct to this agent (self)\n' +
        '  to: "user:rodolfo"  — route to human via most-recent agent\n' +
        '  to: "*"             — broadcast to all agents\n\n' +
        'Fields by type:\n' +
        '  message: { body: string }\n' +
        '  task:    { skill: string, prompt: string }\n' +
        '  presence: { user: string, channel: string }',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['message', 'task', 'presence'],
            description: 'Message type'
          },
          to: {
            type: 'string',
            description: 'Recipient: agent name, "user:canonical-id", or "*" for broadcast'
          },
          body: { type: 'string', description: 'Text content (type: message)' },
          skill: { type: 'string', description: 'Skill to invoke (type: task)' },
          prompt: { type: 'string', description: 'Task prompt (type: task)' },
          user: { type: 'string', description: 'Human canonical id (type: presence)' },
          channel: { type: 'string', description: 'Communication channel (type: presence)' },
          replyTo: { type: 'string', description: 'Message id being replied to (optional)' }
        },
        required: ['type', 'to']
      },
      async execute (...rawArgs: any[]) {
        const args = (typeof rawArgs[0] === 'object' && rawArgs[0] !== null
          ? rawArgs[0]
          : rawArgs[1] ?? {}) as Record<string, string>

        if (!mqttReady) {
          return { content: [{ type: 'text', text: 'MQTT not connected.' }] }
        }

        try {
          let msg: AgentBusMessage
          switch (args.type) {
            case 'message':
              msg = makeBusMessage('message', AGENT_NAME, args.to, {
                body: args.body ?? '',
                ...(args.replyTo ? { replyTo: args.replyTo } : {})
              })
              break
            case 'task':
              msg = makeBusMessage('task', AGENT_NAME, args.to, {
                skill: args.skill ?? 'general',
                prompt: args.prompt ?? '',
                ...(args.replyTo ? { replyTo: args.replyTo } : {})
              })
              break
            case 'presence':
              msg = makeBusMessage('presence', AGENT_NAME, '*', {
                user: args.user ?? '',
                channel: args.channel ?? ''
              })
              break
            default:
              return { content: [{ type: 'text', text: `Unknown type: ${args.type}` }] }
          }

          await publishToBus(msg)
          return { content: [{ type: 'text', text: `Sent ${msg.type} to ${msg.to} (id: ${msg.id})` }] }
        } catch (err) {
          return { content: [{ type: 'text', text: `Send failed: ${err}` }] }
        }
      }
    })

    console.log('[mqtt-plugin] Starting MQTT init...')
    initMqtt().catch((err) => console.error('[mqtt-plugin] initMqtt failed:', err))

    console.log('[mqtt-plugin] Agent Bus Bridge registered: 1 tool (agent_comms) + 2 hooks')
  }
})
