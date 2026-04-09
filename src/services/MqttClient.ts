import { Context, Effect, Layer } from 'effect'
import mqtt, { type MqttClient as MqttClientType } from 'mqtt'
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

// Singleton MQTT connection shared across all plugin workers in the same process
let singletonClient: MqttClientType | null = null
let singletonReady: Promise<MqttClientType> | null = null
const handlers = new Map<string, (topic: string, payload: Buffer) => void>()

function getSingletonClient (): Promise<MqttClientType> {
  if (singletonReady) return singletonReady

  singletonReady = new Promise<MqttClientType>((resolve, reject) => {
    const client = mqtt.connect(MQTT_URL, {
      clientId: MQTT_CLIENT_ID,
      username: MQTT_USER || undefined,
      password: MQTT_PASS || undefined,
      reconnectPeriod: MQTT_RECONNECT_MS,
      clean: true
    })

    client.on('connect', () => {
      if (!singletonClient) {
        console.log('[mqtt-plugin] Connected to MQTT broker')
      }
      singletonClient = client
      resolve(client)
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
      if (!singletonClient) {
        console.log('[mqtt-plugin] Reconnecting to MQTT broker...')
      }
    })

    setTimeout(() => {
      if (!singletonClient) {
        reject(new Error('MQTT connection timeout after 10s'))
      }
    }, 10_000)
  })

  return singletonReady
}

function makeMqttShape (client: MqttClientType): MqttClientShape {
  return {
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
  }
}

export const MqttClientLive = Layer.effect(
  MqttClient,
  Effect.tryPromise({
    try: async () => makeMqttShape(await getSingletonClient()),
    catch: (err) => new MqttError({ message: `MQTT init failed: ${err}` })
  })
)
