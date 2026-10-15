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

interface TypingState {
  username: string
  /** When typing:start was last broadcast for this user (the throttle is per user, not per tab). */
  lastBroadcast: number
  /** socketId -> auto-clear timer. The user counts as typing while at least one tab is. */
  sockets: Map<string, ReturnType<typeof setTimeout>>
}

/** Per-user socket.io room every socket joins, so a user's own tabs can be excluded from broadcasts. */
export const userRoom = (userId: string): string => `ravex:user:${userId}`

export class TypingHandler {
  // roomId -> userId -> state. Nested maps instead of `${userId}:${roomId}` keys so IDs may contain ':'.
  private readonly typing = new Map<string, Map<string, TypingState>>()

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

    let roomTyping = this.typing.get(roomId)
    if (!roomTyping) {
      roomTyping = new Map()
      this.typing.set(roomId, roomTyping)
    }
    let state = roomTyping.get(user.id)
    const alreadyTyping = state !== undefined
    if (!state) {
      state = { username: user.username, lastBroadcast: 0, sockets: new Map() }
      roomTyping.set(user.id, state)
    }

    // (Re)arm this tab's own timer, so each tab times out independently.
    const timeout = this.config.typingTimeout ?? DEFAULT_TYPING_TIMEOUT_MS
    clearTimeout(state.sockets.get(socket.id))
    state.sockets.set(
      socket.id,
      setTimeout(() => {
        this.stopSocket(roomId, user.id, socket.id)
        logger.debug(`Typing auto-cleared: ${user.id} (socket ${socket.id}) in ${roomId}`)
      }, timeout),
    )

    const now = Date.now()
    const throttle = this.config.typingThrottle ?? DEFAULT_TYPING_THROTTLE_MS
    if (alreadyTyping && now - state.lastBroadcast < throttle) return
    state.lastBroadcast = now

    this.emit('typing:start', { userId: user.id, username: user.username, roomId })
    logger.debug(`Typing start: ${user.id} in ${roomId}`)
  }

  onStop(socket: TypedSocket, data: TypingPayload): void {
    const user = socket.data.user
    if (!user) return

    const { roomId } = data
    if (!roomId) return

    // Only tabs that are currently typing (and therefore passed the membership check) can stop.
    this.stopSocket(roomId, user.id, socket.id)
  }

  /** Clears a user's typing state in one room for every tab (e.g. they left or were kicked). */
  clearForRoom(userId: string, roomId: string): void {
    this.clear(roomId, userId)
  }

  /** Stops one tab's typing in one room (e.g. it sent a message). The user stops once no tab is typing. */
  clearForSocketInRoom(socketId: string, userId: string, roomId: string): void {
    this.stopSocket(roomId, userId, socketId)
  }

  /** Stops a tab's typing in every room (e.g. it disconnected). Other tabs of the same user keep typing. */
  clearForSocket(socketId: string): void {
    for (const [roomId, roomTyping] of this.typing) {
      for (const [userId, state] of roomTyping) {
        if (state.sockets.has(socketId)) this.stopSocket(roomId, userId, socketId)
      }
    }
  }

  /** Clears a user's typing state in every room. */
  clearAll(userId: string): void {
    for (const roomId of this.typing.keys()) this.clear(roomId, userId)
  }

  /** Drops all typing state for a deleted room without emitting. */
  clearRoomSilently(roomId: string): void {
    const roomTyping = this.typing.get(roomId)
    if (!roomTyping) return
    for (const state of roomTyping.values()) {
      for (const timer of state.sockets.values()) clearTimeout(timer)
    }
    this.typing.delete(roomId)
  }

  destroy(): void {
    for (const roomId of [...this.typing.keys()]) this.clearRoomSilently(roomId)
  }

  /** Removes one tab's typing state; emits the user-level typing:stop only when it was the last active tab. */
  private stopSocket(roomId: string, userId: string, socketId: string): void {
    const state = this.typing.get(roomId)?.get(userId)
    const timer = state?.sockets.get(socketId)
    if (!state || timer === undefined) return

    clearTimeout(timer)
    state.sockets.delete(socketId)
    if (state.sockets.size === 0) this.clear(roomId, userId)
  }

  /** Removes the user's typing state for every tab and notifies the room. No-op if they weren't typing. */
  private clear(roomId: string, userId: string): void {
    const roomTyping = this.typing.get(roomId)
    const state = roomTyping?.get(userId)
    if (!roomTyping || !state) return

    for (const timer of state.sockets.values()) clearTimeout(timer)
    roomTyping.delete(userId)
    if (roomTyping.size === 0) this.typing.delete(roomId)

    this.emit('typing:stop', { userId, username: state.username, roomId })
  }

  private emit(event: 'typing:start' | 'typing:stop', data: { userId: string; username: string; roomId: string }): void {
    // Exclude every socket of the typing user, not just the one that sent the event.
    this.ns.to(data.roomId).except(userRoom(data.userId)).emit(event, data)
  }
}
