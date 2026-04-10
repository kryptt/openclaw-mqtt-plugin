import { describe, it, expect } from 'vitest'
import { BUS_TOPIC, makeBusMessage, type AgentBusMessage } from '../types.js'

describe('BUS_TOPIC', () => {
  it('is the single agent bus topic', () => {
    expect(BUS_TOPIC).toBe('openclaw/agents/bus')
  })
})

describe('makeBusMessage', () => {
  it('creates a task message with required fields', () => {
    const msg = makeBusMessage('task', 'claude', 'roci', {
      skill: 'home-auto',
      prompt: 'turn off lights'
    })
    expect(msg.type).toBe('task')
    expect(msg.from).toBe('claude')
    expect(msg.to).toBe('roci')
    expect(msg.skill).toBe('home-auto')
    expect(msg.prompt).toBe('turn off lights')
    expect(msg.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(msg.ts).toBeTruthy()
  })

  it('creates a chat message', () => {
    const msg = makeBusMessage('message', 'roci', 'claude', {
      body: 'Hello from Roci'
    })
    expect(msg.type).toBe('message')
    expect(msg.body).toBe('Hello from Roci')
  })

  it('creates a presence message', () => {
    const msg = makeBusMessage('presence', 'roci', '*', {
      user: 'rodolfo',
      channel: 'telegram'
    })
    expect(msg.type).toBe('presence')
    expect(msg.user).toBe('rodolfo')
    expect(msg.channel).toBe('telegram')
    expect(msg.to).toBe('*')
  })

  it('creates an event message', () => {
    const msg = makeBusMessage('event', 'roci', '*', {
      status: 'completed',
      summary: 'Task done'
    })
    expect(msg.type).toBe('event')
    expect(msg.status).toBe('completed')
    expect(msg.summary).toBe('Task done')
  })

  it('event message with data payload', () => {
    const msg = makeBusMessage('event', 'roci', 'claude', {
      status: 'error',
      summary: 'Failed',
      data: { code: 500, detail: 'timeout' }
    })
    expect(msg.data).toEqual({ code: 500, detail: 'timeout' })
  })
})

describe('discriminated union', () => {
  it('narrows task by type field', () => {
    const msg: AgentBusMessage = makeBusMessage('task', 'a', 'b', {
      skill: 'x',
      prompt: 'y'
    })
    if (msg.type === 'task') {
      expect(msg.skill).toBe('x')
      expect(msg.prompt).toBe('y')
    }
  })

  it('narrows message by type field', () => {
    const msg: AgentBusMessage = makeBusMessage('message', 'a', 'b', { body: 'hi' })
    if (msg.type === 'message') {
      expect(msg.body).toBe('hi')
    }
  })

  it('narrows presence by type field', () => {
    const msg: AgentBusMessage = makeBusMessage('presence', 'a', '*', { user: 'u', channel: 'c' })
    if (msg.type === 'presence') {
      expect(msg.user).toBe('u')
      expect(msg.channel).toBe('c')
    }
  })

  it('narrows event by type field', () => {
    const msg: AgentBusMessage = makeBusMessage('event', 'a', '*', { status: 'completed', summary: 's' })
    if (msg.type === 'event') {
      expect(msg.status).toBe('completed')
    }
  })
})

describe('payload serialization', () => {
  it('produces valid JSON', () => {
    const msg = makeBusMessage('message', 'claude', 'roci', {
      body: 'test with "quotes" and\nnewlines'
    })
    const json = JSON.stringify(msg)
    const parsed = JSON.parse(json)
    expect(parsed.type).toBe('message')
    expect(parsed.body).toContain('quotes')
  })
})
