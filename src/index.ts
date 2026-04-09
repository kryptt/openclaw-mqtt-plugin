import { Effect, Layer } from 'effect'
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { MqttClient, MqttClientLive } from './services/MqttClient.js'
import { GatewayDispatch, GatewayDispatchLive } from './services/GatewayDispatch.js'
import { EVENTS_PREFIX, TASKS_PREFIX } from './config.js'

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

// Track correlation IDs for task_started → agent_end pairing
let currentCorrelationId: string | null = null
let taskStartedAt: number | null = null

function makeEvent (fields: Record<string, unknown>): Record<string, unknown> {
  return {
    correlation_id: fields.correlation_id ?? crypto.randomUUID(),
    ts: new Date().toISOString(),
    ...fields
  }
}

export default definePluginEntry({
  id: 'openclaw-mqtt-plugin',
  name: 'MQTT Event Bridge',
  description: 'Publishes agent events to MQTT and subscribes to task requests for Claude Code peer bridge',
  kind: 'integration',

  register (api) {
    // Initialize MQTT connection (non-blocking, matches initDb pattern)
    const initMqtt = async (): Promise<void> => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function * () {
          const mqtt = yield * MqttClient
          // Verify connection works
          if (!mqtt.isConnected()) {
            throw new Error('Not connected after init')
          }
        }).pipe(Effect.provide(MqttClientLive))
      )

      if (exit._tag === 'Success') {
        const safeMqttLayer = Layer.catchAll(MqttClientLive, () => noopMqttLayer)
        appLayer = Layer.mergeAll(safeMqttLayer, GatewayDispatchLive)
        mqttReady = true
        console.log('[mqtt-plugin] MQTT connected, setting up task subscription')

        // Subscribe to incoming task requests
        await run(
          Effect.gen(function * () {
            const mqtt = yield * MqttClient
            yield * mqtt.subscribe(`${TASKS_PREFIX}#`, (topic, payload) => {
              handleIncomingTask(topic, payload).catch((err) =>
                console.error('[mqtt-plugin] Task dispatch error:', err)
              )
            })
          })
        )
      } else {
        console.error('[mqtt-plugin] MQTT unavailable, event publishing disabled')
      }
    }

    // Handle incoming task requests from Claude Code (via openclaw-bridge)
    async function handleIncomingTask (topic: string, payload: Buffer): Promise<void> {
      let parsed: { correlation_id?: string, prompt?: string }
      try {
        parsed = JSON.parse(payload.toString())
      } catch {
        console.error('[mqtt-plugin] Invalid task payload on', topic)
        return
      }

      const skill = topic.replace(TASKS_PREFIX, '')
      const correlationId = parsed.correlation_id ?? crypto.randomUUID()
      const prompt = parsed.prompt ?? ''

      if (!prompt) {
        console.error('[mqtt-plugin] Empty prompt in task for skill:', skill)
        return
      }

      console.log(`[mqtt-plugin] Dispatching task ${correlationId} to skill: ${skill}`)

      const result = await run(
        Effect.gen(function * () {
          const gateway = yield * GatewayDispatch
          const mqtt = yield * MqttClient

          try {
            const response = yield * gateway.chat(
              `[Task ${correlationId}] Use the ${skill} skill to: ${prompt}`
            )

            yield * mqtt.publish(`${EVENTS_PREFIX}task_completed`, makeEvent({
              correlation_id: correlationId,
              skill,
              result_summary: response.slice(0, 500)
            }))

            return response
          } catch (err) {
            yield * mqtt.publish(`${EVENTS_PREFIX}task_failed`, makeEvent({
              correlation_id: correlationId,
              skill,
              error: String(err).slice(0, 300)
            }))

            throw err
          }
        })
      )

      if (result) {
        console.log(`[mqtt-plugin] Task ${correlationId} completed for skill: ${skill}`)
      }
    }

    // Hook: before_prompt_build — publish task_started event
    api.on('before_prompt_build', async (event: any) => {
      if (!mqttReady) return {}

      try {
        let msg = ''
        const msgs: any[] = event?.messages ?? []
        const userMsgs = msgs.filter((m: any) => m.role === 'user')
        if (userMsgs.length) {
          const last = userMsgs[userMsgs.length - 1]
          const content = last.content
          if (typeof content === 'string') {
            msg = content
          } else if (Array.isArray(content)) {
            msg = content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join(' ')
          }
        }
        if (!msg || msg.length < 5) return {}

        currentCorrelationId = crypto.randomUUID()
        taskStartedAt = Date.now()

        await run(
          Effect.gen(function * () {
            const mqtt = yield * MqttClient
            yield * mqtt.publish(`${EVENTS_PREFIX}task_started`, makeEvent({
              correlation_id: currentCorrelationId,
              prompt_preview: msg.slice(0, 200)
            }))
          })
        )
      } catch {
        // Event publishing is best-effort
      }

      return {}
    })

    // Hook: agent_end — publish agent_end event with summary
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

        await run(
          Effect.gen(function * () {
            const mqtt = yield * MqttClient
            yield * mqtt.publish(`${EVENTS_PREFIX}agent_end`, makeEvent({
              correlation_id: currentCorrelationId ?? crypto.randomUUID(),
              summary: summary || 'No summary available',
              status: 'completed',
              duration_ms: durationMs
            }))
          })
        )

        currentCorrelationId = null
        taskStartedAt = null
      } catch {
        // Event publishing is best-effort
      }

      return {}
    })

    // Tool: mqtt_publish — let the agent publish custom events
    api.registerTool({
      name: 'mqtt_publish',
      label: 'Publish MQTT Event',
      description: 'Publish a custom event to the MQTT event bus at openclaw/events/custom/{topic}. ' +
        'Use this to share observations, alerts, or status updates that Claude Code or other agents can read.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Event topic name (appended to openclaw/events/custom/)'
          },
          data: {
            type: 'object',
            description: 'Event data payload (arbitrary JSON)'
          }
        },
        required: ['topic', 'data']
      },
      async execute (...rawArgs: any[]) {
        const args = (typeof rawArgs[0] === 'object' && rawArgs[0] !== null
          ? rawArgs[0]
          : rawArgs[1] ?? {}) as { topic: string, data: Record<string, unknown> }

        if (!mqttReady) {
          return { content: [{ type: 'text', text: 'MQTT not connected, event not published.' }] }
        }

        try {
          await run(
            Effect.gen(function * () {
              const mqtt = yield * MqttClient
              yield * mqtt.publish(
                `${EVENTS_PREFIX}custom/${args.topic}`,
                makeEvent({ data: args.data })
              )
            })
          )
          return { content: [{ type: 'text', text: `Published to ${EVENTS_PREFIX}custom/${args.topic}` }] }
        } catch (err) {
          return { content: [{ type: 'text', text: `Publish failed: ${err}` }] }
        }
      }
    })

    initMqtt().catch((err) => console.error('[mqtt-plugin] initMqtt failed:', err))

    console.log('[mqtt-plugin] MQTT Event Bridge registered: 1 tool + 2 hooks + task subscription')
  }
})
