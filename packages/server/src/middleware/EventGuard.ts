import type { ClientToServerEvents } from '@ravex/types'
import type { ChatEngineOptions, TypedSocket } from '../ChatEngine.js'
import { ErrorCodes } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

type EventName = keyof ClientToServerEvents
type ErrorAck = (response: { ok: false; error: { code: string; message: string } }) => void

interface EventShape {
  /** First argument must be a plain object. */
  payload: boolean
  /** Last argument is an acknowledgement callback. */
  ack: boolean
}

// A Record over every event name, so adding a client event without describing it here fails to compile.
const SHAPES: Record<EventName, EventShape> = {
  'message:send': { payload: true, ack: true },
  'message:edit': { payload: true, ack: true },
  'message:delete': { payload: true, ack: true },
  'message:read': { payload: true, ack: false },
  'message:react': { payload: true, ack: true },
  'message:history': { payload: true, ack: true },
  'typing:start': { payload: true, ack: false },
  'typing:stop': { payload: true, ack: false },
  'room:join': { payload: true, ack: true },
  'room:leave': { payload: true, ack: true },
  'room:create': { payload: true, ack: true },
  'room:delete': { payload: true, ack: true },
  'room:members': { payload: true, ack: true },
  'room:list': { payload: false, ack: true },
  'presence:ping': { payload: false, ack: false },
  'presence:status': { payload: true, ack: false },
}
const EVENT_SHAPES = new Map(Object.entries(SHAPES))

const noop = (): void => {}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFunction = (value: unknown): value is (...args: unknown[]) => void => typeof value === 'function'

/**
 * Per-socket middleware that normalises incoming events before any handler runs:
 * - events whose payload is not an object are dropped and answered with VALIDATION_ERROR (if an ack was given)
 * - events that expect an ack but were sent without one get a no-op ack, so handlers can always call it
 * - unexpected extra arguments are stripped
 */
export const validateEvents = (socket: TypedSocket): void => {
  socket.use((packet: [string, ...unknown[]], next: (err?: Error) => void) => {
    const [event, ...args] = packet
    const shape = EVENT_SHAPES.get(event)
    if (!shape) return next()

    const last: unknown = args[args.length - 1]
    const ack = isFunction(last) ? last : undefined
    const payload: unknown = args[0]

    if (shape.payload && !isPlainObject(payload)) {
      logger.debug(`Rejected "${event}" from socket ${socket.id}: payload must be an object`)
      if (shape.ack && ack) {
        ack({ ok: false, error: { code: ErrorCodes.VALIDATION, message: `Invalid payload for "${event}": expected an object` } })
      }
      return
    }

    packet.length = 1
    if (shape.payload) packet.push(payload)
    if (shape.ack) packet.push(ack ?? noop)
    next()
  })
}

/**
 * Wraps an event listener so a synchronous throw or a rejected promise is logged (and acked as
 * INTERNAL_ERROR when the client is waiting for an ack) instead of crashing the process.
 */
export const safeListener = <A extends unknown[]>(
  event: string,
  listener: (...args: A) => unknown,
): ((...args: A) => void) => {
  const fail = (args: A, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`Unhandled error in "${event}" handler:`, err)
    const ack: unknown = args[args.length - 1]
    if (isFunction(ack)) {
      ;(ack as ErrorAck)({ ok: false, error: { code: ErrorCodes.INTERNAL, message } })
    }
  }

  return (...args: A) => {
    try {
      const result = listener(...args)
      if (result instanceof Promise) result.catch((err: unknown) => fail(args, err))
    } catch (err) {
      fail(args, err)
    }
  }
}

type AnyCallback = (...args: unknown[]) => unknown

/**
 * Wraps an application callback (onMessage, onRead, …) so a synchronous throw or a rejected promise
 * is logged instead of crashing the process. Callbacks are notifications: their errors never change
 * what the client receives.
 */
export const safeCallback = (name: string, callback: AnyCallback): ((...args: unknown[]) => void) => {
  const fail = (err: unknown): void => logger.error(`Error in "${name}" callback:`, err)
  return (...args) => {
    try {
      const result = callback(...args)
      if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
        Promise.resolve(result).catch(fail)
      }
    } catch (err) {
      fail(err)
    }
  }
}

const CALLBACKS = ['onMessage', 'onEdit', 'onDelete', 'onRead', 'onReaction', 'onStatusChange'] as const

/** Returns a copy of the options with every application callback wrapped in `safeCallback`. */
export const guardCallbacks = (options: ChatEngineOptions): ChatEngineOptions => {
  const guarded: Record<string, unknown> = { ...options }
  for (const name of CALLBACKS) {
    const callback = options[name] as AnyCallback | undefined
    if (callback) guarded[name] = safeCallback(name, callback)
  }
  return guarded as ChatEngineOptions
}
