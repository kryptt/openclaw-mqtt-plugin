// Agent Bus Message Contract — discriminated union over `type`
// Single MQTT topic: openclaw/agents/bus

export interface MessageBase {
  readonly id: string          // UUIDv4
  readonly ts: string          // ISO 8601
  readonly from: string        // sender agent name: "claude", "roci", "claude-1"
  readonly to: string          // "roci" | "claude" | "user:rodolfo" | "*"
  readonly replyTo?: string    // id of the message being replied to
}

/** Request an agent to execute a skill */
export interface TaskMessage extends MessageBase {
  readonly type: 'task'
  readonly skill: string       // e.g. "home-auto", "cluster-ops"
  readonly prompt: string
}

/** Free-form text between agents or to a user */
export interface ChatMessage extends MessageBase {
  readonly type: 'message'
  readonly body: string
}

/** Agent heartbeat — "I last interacted with this user on this channel" */
export interface PresenceMessage extends MessageBase {
  readonly type: 'presence'
  readonly user: string        // canonical human id from identity map
  readonly channel: string     // "telegram", "mcp", "discord", etc.
}

/** Agent lifecycle event (started, completed, error) */
export interface EventMessage extends MessageBase {
  readonly type: 'event'
  readonly status: 'started' | 'completed' | 'error'
  readonly summary: string
  readonly data?: Record<string, unknown>
}

export type AgentBusMessage = TaskMessage | ChatMessage | PresenceMessage | EventMessage

export const BUS_TOPIC = 'openclaw/agents/bus'

export function makeBusMessage<T extends AgentBusMessage['type']> (
  type: T,
  from: string,
  to: string,
  fields: Omit<Extract<AgentBusMessage, { type: T }>, 'id' | 'ts' | 'type' | 'from' | 'to'>
): Extract<AgentBusMessage, { type: T }> {
  return {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    type,
    from,
    to,
    ...fields
  } as Extract<AgentBusMessage, { type: T }>
}
