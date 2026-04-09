export const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://mosquitto.home:1883'
export const MQTT_USER = process.env.MQTT_USER ?? ''
export const MQTT_PASS = process.env.MQTT_PASS ?? ''
export const MQTT_CLIENT_ID = `openclaw-mqtt-plugin-${crypto.randomUUID().slice(0, 8)}`
export const MQTT_RECONNECT_MS = 5000

export const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? 'http://localhost:18789'
export const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? ''

export const EVENTS_PREFIX = 'openclaw/events/'
export const TASKS_PREFIX = 'openclaw/tasks/'
