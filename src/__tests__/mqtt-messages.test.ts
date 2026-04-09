import { describe, it, expect } from 'vitest'
import { EVENTS_PREFIX, TASKS_PREFIX } from '../config.js'

// Test topic construction and payload validation patterns
// These are extracted helpers that mirror the logic in index.ts

function makeEvent (fields: Record<string, unknown>): Record<string, unknown> {
  return {
    correlation_id: fields.correlation_id ?? 'test-uuid',
    ts: fields.ts ?? '2026-04-09T12:00:00.000Z',
    ...fields
  }
}

function extractSkillFromTopic (topic: string): string {
  return topic.replace(TASKS_PREFIX, '')
}

function buildCustomEventTopic (name: string): string {
  return `${EVENTS_PREFIX}custom/${name}`
}

describe('MQTT message construction', () => {
  it('makeEvent includes correlation_id and ts by default', () => {
    const event = makeEvent({ summary: 'test' })
    expect(event).toHaveProperty('correlation_id')
    expect(event).toHaveProperty('ts')
    expect(event.summary).toBe('test')
  })

  it('makeEvent allows overriding correlation_id', () => {
    const event = makeEvent({ correlation_id: 'custom-id', data: {} })
    expect(event.correlation_id).toBe('custom-id')
  })

  it('makeEvent preserves all fields', () => {
    const event = makeEvent({
      skill: 'cluster-ops',
      result_summary: 'all pods healthy',
      duration_ms: 5000
    })
    expect(event.skill).toBe('cluster-ops')
    expect(event.result_summary).toBe('all pods healthy')
    expect(event.duration_ms).toBe(5000)
  })
})

describe('topic parsing', () => {
  it('extracts skill name from task topic', () => {
    expect(extractSkillFromTopic('openclaw/tasks/cluster-ops')).toBe('cluster-ops')
    expect(extractSkillFromTopic('openclaw/tasks/home-auto')).toBe('home-auto')
    expect(extractSkillFromTopic('openclaw/tasks/knowledge-curator')).toBe('knowledge-curator')
  })

  it('handles nested task topics', () => {
    expect(extractSkillFromTopic('openclaw/tasks/custom/sub')).toBe('custom/sub')
  })
})

describe('custom event topic construction', () => {
  it('builds correct topic path', () => {
    expect(buildCustomEventTopic('sensor_anomaly')).toBe('openclaw/events/custom/sensor_anomaly')
    expect(buildCustomEventTopic('alert')).toBe('openclaw/events/custom/alert')
  })
})

describe('topic prefixes', () => {
  it('events prefix ends with /', () => {
    expect(EVENTS_PREFIX).toBe('openclaw/events/')
  })

  it('tasks prefix ends with /', () => {
    expect(TASKS_PREFIX).toBe('openclaw/tasks/')
  })
})

describe('payload serialization', () => {
  it('makeEvent produces valid JSON-serializable output', () => {
    const event = makeEvent({
      skill: 'cluster-ops',
      data: { pods: [{ name: 'test', status: 'Running' }] }
    })
    const json = JSON.stringify(event)
    const parsed = JSON.parse(json)
    expect(parsed.skill).toBe('cluster-ops')
    expect(parsed.data.pods).toHaveLength(1)
  })

  it('handles empty data gracefully', () => {
    const event = makeEvent({})
    expect(event).toHaveProperty('correlation_id')
    expect(event).toHaveProperty('ts')
  })
})
