import type { TypingPayload } from '@ravex/types'
import type { TypedNamespace, TypedSocket } from '../ChatEngine.js'
import type { RoomManager } from '../core/RoomManager.js'
import { logger } from '../utils/logger.js'

const DEFAULT_TYPING_THROTTLE_MS = 300
const DEFAULT_TYPING_TIMEOUT_MS = 3_000

export interface TypingConfig {
  typingTimeout?: number
  typingThrottle?: number
}

interface TypingContext {
  key: string
  userId: string
  username: string
  roomId: string
}

export class TypingHandler {
  // key: `${userId}:${roomId}`
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastEvent = new Map<string, number>()

  constructor(
    private readonly ns: TypedNamespace,
    private readonly roomManager: RoomManager,
    private readonly config: TypingConfig,
  ) {}

  onStart(socket: TypedSocket, data: TypingPayload): void {
    const user = socket.data.user
    if (!user) return

    const { roomId } = data
    if (!roomId) return

    const room = this.roomManager.get(roomId)
    if (!room || !room.members.includes(user.id)) return

    const key = `${user.id}:${roomId}`
    const now = Date.now()

    const throttle = this.config.typingThrottle ?? DEFAULT_TYPING_THROTTLE_MS
    const last = this.lastEvent.get(key) ?? 0
    if (now - last < throttle) return
    this.lastEvent.set(key, now)

    socket.to(roomId).emit('typing:start', {
      userId: user.id,
      username: user.username,
      roomId,
    })

    this.resetTimer({ key, userId: user.id, username: user.username, roomId }, socket)
    logger.debug(`Typing start: ${user.id} in ${roomId}`)
  }

  onStop(socket: TypedSocket, data: TypingPayload): void {
    const user = socket.data.user
    if (!user) return

    const { roomId } = data
    if (!roomId) return

    this.clearTyping({ key: `${user.id}:${roomId}`, userId: user.id, username: user.username, roomId }, socket)
  }

  clearForRoom(userId: string, username: string, roomId: string): void {
    const key = `${userId}:${roomId}`
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key))
      this.timers.delete(key)
      this.lastEvent.delete(key)
      this.ns.to(roomId).emit('typing:stop', { userId, username, roomId })
    }
  }

  clearAll(userId: string, username: string): void {
    for (const [key] of this.timers) {
      if (key.startsWith(`${userId}:`)) {
        const roomId = key.split(':')[1]
        clearTimeout(this.timers.get(key))
        this.timers.delete(key)
        this.lastEvent.delete(key)
        this.ns.to(roomId).emit('typing:stop', { userId, username, roomId })
      }
    }
  }

  private clearTyping(ctx: TypingContext, socket: TypedSocket): void {
    const { key, userId, username, roomId } = ctx
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key))
      this.timers.delete(key)
      this.lastEvent.delete(key)
    }
    socket.to(roomId).emit('typing:stop', { userId, username, roomId })
  }

  private resetTimer(ctx: TypingContext, socket: TypedSocket): void {
    const { key, userId, username, roomId } = ctx
    if (this.timers.has(key)) clearTimeout(this.timers.get(key))

    const timeout = this.config.typingTimeout ?? DEFAULT_TYPING_TIMEOUT_MS
    const timer = setTimeout(() => {
      this.timers.delete(key)
      this.lastEvent.delete(key)
      socket.to(roomId).emit('typing:stop', { userId, username, roomId })
      logger.debug(`Typing auto-cleared: ${userId} in ${roomId}`)
    }, timeout)

    this.timers.set(key, timer)
  }
}
