import { Context, Effect, Layer } from 'effect'
import mqtt from 'mqtt'
import { MQTT_URL, MQTT_USER, MQTT_PASS, MQTT_CLIENT_ID, MQTT_RECONNECT_MS } from '../config.js'
import { MqttError } from '../errors.js'

export interface MqttClientShape {
  readonly publish: (
    topic: string,
    payload: Record<string, unknown>
  ) => Effect.Effect<void, MqttError>

  readonly subscribe: (
    topicFilter: string,
    handler: (topic: string, payload: Buffer) => void
  ) => Effect.Effect<void, MqttError>

  readonly isConnected: () => boolean
}

export class MqttClient extends Context.Tag('MqttClient')<
  MqttClient,
  MqttClientShape
>() {}

export const MqttClientLive = Layer.effect(
  MqttClient,
  Effect.tryPromise({
    try: () => new Promise<MqttClientShape>((resolve, reject) => {
      const client = mqtt.connect(MQTT_URL, {
        clientId: MQTT_CLIENT_ID,
        username: MQTT_USER || undefined,
        password: MQTT_PASS || undefined,
        reconnectPeriod: MQTT_RECONNECT_MS,
        clean: true
      })

      const handlers = new Map<string, (topic: string, payload: Buffer) => void>()

      client.on('connect', () => {
        console.log('[mqtt-plugin] Connected to MQTT broker')
        resolve({
          publish: (topic, payload) =>
            Effect.tryPromise({
              try: () => new Promise<void>((res, rej) => {
                client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
                  if (err) rej(err)
                  else res()
                })
              }),
              catch: (err) => new MqttError({ message: `Publish to ${topic} failed`, cause: err })
            }),

          subscribe: (topicFilter, handler) =>
            Effect.tryPromise({
              try: () => new Promise<void>((res, rej) => {
                client.subscribe(topicFilter, { qos: 1 }, (err) => {
                  if (err) rej(err)
                  else {
                    handlers.set(topicFilter, handler)
                    res()
                  }
                })
              }),
              catch: (err) => new MqttError({ message: `Subscribe to ${topicFilter} failed`, cause: err })
            }),

          isConnected: () => client.connected
        })
      })

      client.on('message', (topic, payload) => {
        for (const handler of handlers.values()) {
          try {
            handler(topic, payload)
          } catch (err) {
            console.error('[mqtt-plugin] Message handler error:', err)
          }
        }
      })

      client.on('error', (err) => {
        console.error('[mqtt-plugin] MQTT error:', err.message)
      })

      client.on('reconnect', () => {
        console.log('[mqtt-plugin] Reconnecting to MQTT broker...')
      })

      // If initial connection fails after 10s, resolve with a disconnected client
      // so the plugin can still load (graceful degradation)
      setTimeout(() => {
        reject(new Error('MQTT connection timeout after 10s'))
      }, 10_000)
    }),
    catch: (err) => new MqttError({ message: `MQTT init failed: ${err}` })
  })
)
