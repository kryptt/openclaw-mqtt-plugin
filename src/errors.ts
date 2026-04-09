import { Data } from 'effect'

export class MqttError extends Data.TaggedError('MqttError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class GatewayError extends Data.TaggedError('GatewayError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
