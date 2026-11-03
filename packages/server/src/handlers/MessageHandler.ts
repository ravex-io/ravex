import type {
  Message,
  SendMessagePayload,
  EditMessagePayload,
  DeleteMessagePayload,
  ReactPayload,
  ReadPayload,
  User,
  Room,
} from '@ravex/types'

import type {
  TypedSocket,
  TypedNamespace,
  PersistenceAdapter,
  MessageMiddleware,
  AckFn,
} from '../ChatEngine.js'
/** Internal: the error-only ack shape. Every AckFn<T> is structurally assignable to this. */
type ErrorAck = (response: { ok: false; error: { code: string; message: string } }) => void
import { randomUUID } from 'crypto'

import type { RoomManager } from '../core/RoomManager.js'
import type { ModerationAction, Moderator } from '../middleware/Moderation.js'
import type { RateLimiter } from '../middleware/RateLimiter.js'
import { ChatError, ErrorCodes } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

const DEFAULT_HISTORY_LIMIT = 50
const DEFAULT_MAX_MESSAGE_LENGTH = 10_000
/** How many recent messages are remembered in memory to check ownership when there is no persistence adapter. */
const MAX_TRACKED_MESSAGES = 10_000
/** Expected outcomes, already reported through onFlagged and moderation's own throttled logs. */
const QUIET_CODES: ReadonlySet<string> = new Set([
  ErrorCodes.MESSAGE_BLOCKED,
  ErrorCodes.MODERATION_UNAVAILABLE,
])

/** A user's place in the queue of their sends and edits, while moderation is on. */
interface Turn {
  /** Resolves once the user's earlier sends and edits are applied or rejected. */
  ready: Promise<void>
  /** Lets the user's next step go. Call it once this step is applied or abandoned. */
  done: () => void
}

interface FoundMessage {
  roomId: string
  senderId: string
  /** The full message, when it came from the persistence adapter. */
  message?: Message
}

const buildMessage = (user: User, room: Room, data: SendMessagePayload): Message => {
  const { roomId, content, type = 'text', replyTo, attachments, metadata } = data
  return {
    id: randomUUID(),
    roomId,
    senderId: user.id,
    senderName: user.displayName ?? user.username,
    content: content ?? '',
    type,
    chatType: room.type,
    replyTo,
    attachments: attachments ?? [],
    reactions: {},
    deliveryStatus: 'sent',
    metadata: metadata ?? {},
    createdAt: new Date(),
  }
}

/** The message as it will look after the edit (a partial Message when there is no persistence adapter). */
const toEdited = (found: FoundMessage, data: EditMessagePayload, editedAt: Date): Message => {
  const { messageId, roomId, content } = data
  return found.message
    ? { ...found.message, content, editedAt }
    : ({ id: messageId, roomId, senderId: found.senderId, content, editedAt } as Message)
}

export interface MessageHandlerConfig {
  maxMessageLength?: number
  allowEdits?: boolean
  allowDeletes?: boolean
}

export interface MessageHandlerDeps {
  ns: TypedNamespace
  roomManager: RoomManager
  rateLimiter: RateLimiter
  config: MessageHandlerConfig
  persistence: PersistenceAdapter | undefined
  middleware: MessageMiddleware[]
  /** Screens sent and edited text when `moderation` is configured. */
  moderator: Moderator | undefined
  /** Clears the sending tab's typing state once its message is about to be broadcast. */
  clearTyping: (socketId: string, userId: string, roomId: string) => void
  onMessage: (message: Message) => void
  onEdit: (message: Message, previousContent: string) => void
  onDelete: (message: Message) => void
  onRead: (userId: string, messageId: string, roomId: string) => void
  onReaction: (reaction: ReactPayload, message: Message) => void
}

export class MessageHandler {
  private readonly ns: TypedNamespace
  private readonly roomManager: RoomManager
  private readonly rateLimiter: RateLimiter
  private readonly config: MessageHandlerConfig
  private readonly persistence: PersistenceAdapter | undefined
  private readonly middleware: MessageMiddleware[]
  private readonly moderator: Moderator | undefined
  private readonly clearTyping: (socketId: string, userId: string, roomId: string) => void
  private readonly handleMessage: (message: Message) => void
  private readonly handleEdit: (message: Message, previousContent: string) => void
  private readonly handleDelete: (message: Message) => void
  private readonly handleRead: (userId: string, messageId: string, roomId: string) => void
  private readonly handleReaction: (reaction: ReactPayload, message: Message) => void
  // messageId -> owner; insertion-ordered so the oldest entry is evicted first.
  private readonly recentMessages = new Map<string, { roomId: string; senderId: string }>()
  // Moderation waits on a network call whose latency varies, so Jev can answer a user's second message (or
  // a message's second edit) first. With moderation on, each user's sends and edits queue here and are
  // applied in the order they arrived. userId -> the end of that user's queue.
  private readonly turns = new Map<string, Promise<void>>()

  constructor(deps: MessageHandlerDeps) {
    this.ns = deps.ns
    this.roomManager = deps.roomManager
    this.rateLimiter = deps.rateLimiter
    this.config = deps.config
    this.persistence = deps.persistence
    this.middleware = deps.middleware
    this.moderator = deps.moderator
    this.clearTyping = deps.clearTyping
    this.handleMessage = deps.onMessage
    this.handleEdit = deps.onEdit
    this.handleDelete = deps.onDelete
    this.handleRead = deps.onRead
    this.handleReaction = deps.onReaction
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  private validateSendRequest(user: User, data: SendMessagePayload): Room {
    const { roomId, content, attachments } = data

    if (!roomId) throw new ChatError('roomId is required', ErrorCodes.VALIDATION)
    if (!content && (!attachments || attachments.length === 0)) {
      throw new ChatError('content or attachments required', ErrorCodes.VALIDATION)
    }

    this.checkLength(content)

    const room = this.roomManager.get(roomId)
    if (!room) throw new ChatError('Room not found', ErrorCodes.ROOM_NOT_FOUND)
    if (!room.members.includes(user.id))
      throw new ChatError('Not a member of this room', ErrorCodes.UNAUTHORIZED)

    // Mute first, so messages from a muted user don't use up their rate-limit quota.
    if (this.rateLimiter.isMuted(user.id, roomId)) {
      throw new ChatError('You are muted in this room', ErrorCodes.MUTED)
    }
    if (!this.rateLimiter.checkMessage(user.id)) {
      throw new ChatError('Rate limit exceeded', ErrorCodes.RATE_LIMIT)
    }

    return room
  }

  private checkLength(content: string | undefined): void {
    const maxLength = this.config.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH
    if (content && content.length > maxLength) {
      throw new ChatError(`Message too long (max ${maxLength} chars)`, ErrorCodes.MESSAGE_TOO_LONG)
    }
  }

  async onSend(socket: TypedSocket, data: SendMessagePayload, ack: AckFn<Message>): Promise<void> {
    try {
      const user = socket.data.user
      const room = this.validateSendRequest(user, data)
      const { roomId } = data
      const message = buildMessage(user, room, data)

      const turn = this.takeTurn(user.id)
      try {
        await this.runMiddleware(message, socket)
        // After middleware, so the text that is screened is the text that gets delivered.
        if (turn) await this.screenInTurn(turn, 'send', message)
        // The sender may have been removed from the room while async middleware or moderation ran.
        this.requireMember(user, roomId)
        this.moderator?.assertRunning()

        this.clearTyping(socket.id, user.id, roomId)
        this.ns.to(roomId).emit('message:new', message)
        this.trackMessage(message)

        if (this.persistence) {
          await this.persistence
            .saveMessage(message)
            .catch((e) => logger.error('persist saveMessage:', e))
        }

        this.handleMessage(message)
        logger.debug(`Message ${message.id} sent to room ${roomId}`)
        ack({ ok: true, data: message })
      } finally {
        // Later sends must not overtake this message's save or callback.
        turn?.done()
      }
    } catch (err) {
      this.handleError(err, ack)
    }
  }

  // ── Edit ──────────────────────────────────────────────────────────────────

  async onEdit(socket: TypedSocket, data: EditMessagePayload, ack: AckFn<Message>): Promise<void> {
    try {
      if (!this.config.allowEdits) throw new ChatError('Editing is disabled', ErrorCodes.FORBIDDEN)

      const user = socket.data.user
      const { messageId, roomId, content } = data

      if (!messageId || !roomId || !content) {
        throw new ChatError('messageId, roomId and content are required', ErrorCodes.VALIDATION)
      }

      // An edit publishes new text: with moderation on it must be screenable text within the length limit.
      if (this.moderator) {
        if (typeof content !== 'string')
          throw new ChatError('content must be a string', ErrorCodes.VALIDATION)
        this.checkLength(content)
      }

      const turn = this.takeTurn(user.id)
      try {
        const stored = await this.requireEditMessage(user, data, turn)
        if (stored.senderId !== user.id) {
          throw new ChatError("Cannot edit another user's message", ErrorCodes.UNAUTHORIZED)
        }
        const found = turn
          ? await this.screenEdit(turn, user, toEdited(stored, data, new Date()))
          : stored

        const { edited, previousContent } = await this.applyEdit(user, found, data)
        this.handleEdit(edited, previousContent)
        ack({ ok: true, data: edited })
      } finally {
        turn?.done()
      }
    } catch (err) {
      this.handleError(err, ack)
    }
  }

  private async applyEdit(
    user: User,
    found: FoundMessage,
    data: EditMessagePayload,
  ): Promise<{ edited: Message; previousContent: string }> {
    this.moderator?.assertRunning()
    const { messageId, roomId, content } = data
    // Read everything from the stored message before updating it: adapters may return the stored
    // object itself, which updateMessage then mutates.
    const editedAt = new Date()
    const previousContent = found.message?.content ?? ''
    const edited = toEdited(found, data, editedAt)
    if (this.persistence) {
      await this.persistence.updateMessage(messageId, { content, editedAt })
    }

    // Shutdown may have happened while the adapter was writing. It cannot cancel that write,
    // but the edit must not be broadcast, reported through onEdit or acknowledged as successful.
    this.moderator?.assertRunning()
    this.ns.to(roomId).emit('message:edited', {
      messageId,
      roomId,
      content,
      editedAt,
      editedBy: user.id,
    })
    return { edited, previousContent }
  }

  private async requireEditMessage(
    user: User,
    data: EditMessagePayload,
    turn: Turn | undefined,
  ): Promise<FoundMessage> {
    const { roomId, messageId } = data
    try {
      return await this.requireMemberMessage(user, roomId, messageId)
    } catch (error) {
      if (!turn || !(error instanceof ChatError) || error.code !== ErrorCodes.MESSAGE_NOT_FOUND) {
        throw error
      }
      // Another tab can edit a broadcast message before its initial save finishes. Retry only
      // after earlier operations complete; ordinary edits can still be screened in parallel.
      await turn.ready
      this.moderator?.assertRunning()
      return this.requireMemberMessage(user, roomId, messageId)
    }
  }

  /**
   * With moderation on, every edit is a billed Jev call, so it passes the same mute and rate-limit gates
   * as a send before `edited` is screened. Returns the message looked up again once it is this edit's turn: it,
   * the room or the user's membership may have gone while moderation ran, and an earlier edit may have
   * been applied meanwhile.
   */
  private async screenEdit(turn: Turn, user: User, edited: Message): Promise<FoundMessage> {
    const { id, roomId } = edited
    if (this.rateLimiter.isMuted(user.id, roomId))
      throw new ChatError('You are muted in this room', ErrorCodes.MUTED)
    if (!this.rateLimiter.checkMessage(user.id))
      throw new ChatError('Rate limit exceeded', ErrorCodes.RATE_LIMIT)
    await this.moderator?.screen('edit', edited)
    await turn.ready
    const current = await this.requireMemberMessage(user, roomId, id)
    // Do not start a write for an edit that was queued when the engine was destroyed.
    this.moderator?.assertRunning()
    return current
  }

  // ── Moderation order ──────────────────────────────────────────────────────

  /**
   * Queues a send or an edit behind the user's earlier ones; undefined without moderation. It must be
   * taken before any async work (middleware, lookups, Jev), so steps are applied in the order they
   * arrived however long that work takes for each; the work itself still runs in parallel. The caller
   * must call `done` once the step is applied or abandoned.
   */
  private takeTurn(userId: string): Turn | undefined {
    if (!this.moderator) return undefined
    const ready = this.turns.get(userId) ?? Promise.resolve()
    let done = (): void => {}
    const finished = new Promise<void>((resolve) => {
      done = resolve
    })
    const tail = ready.then(() => finished)
    this.turns.set(userId, tail)
    void tail.then(() => {
      if (this.turns.get(userId) === tail) this.turns.delete(userId)
    })
    return { ready, done }
  }

  /** Screens `message`, then waits for the user's earlier steps. Throws if it may not be delivered. */
  private async screenInTurn(
    turn: Turn,
    action: ModerationAction,
    message: Message,
  ): Promise<void> {
    await this.moderator?.screen(action, message)
    await turn.ready
    // Checked last: a message screened before the engine was destroyed must not go out after it.
    this.moderator?.assertRunning()
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async onDelete(socket: TypedSocket, data: DeleteMessagePayload, ack: AckFn<void>): Promise<void> {
    try {
      if (!this.config.allowDeletes)
        throw new ChatError('Deleting is disabled', ErrorCodes.FORBIDDEN)

      const user = socket.data.user
      const { messageId, roomId } = data

      if (!messageId || !roomId) {
        throw new ChatError('messageId and roomId are required', ErrorCodes.VALIDATION)
      }

      const found = await this.requireMemberMessage(user, roomId, messageId)
      if (found.senderId !== user.id && !this.roomManager.isAdmin(roomId, user.id)) {
        throw new ChatError("Cannot delete another user's message", ErrorCodes.UNAUTHORIZED)
      }

      if (this.persistence) {
        await this.persistence.deleteMessage(messageId)
      }
      this.recentMessages.delete(messageId)

      this.ns.to(roomId).emit('message:deleted', { messageId, roomId, deletedBy: user.id })

      if (found.message) this.handleDelete(found.message)
      ack({ ok: true, data: undefined })
    } catch (err) {
      this.handleError(err, ack)
    }
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  onRead(socket: TypedSocket, data: ReadPayload): void {
    const user = socket.data.user
    const { messageId, roomId } = data
    if (!messageId || !roomId) return
    // No ack for read receipts, so invalid ones are dropped silently.
    if (!this.roomManager.isMember(roomId, user.id)) return

    socket.to(roomId).emit('message:read_receipt', {
      messageId,
      roomId,
      readBy: user.id,
      readAt: new Date(),
    })

    if (this.persistence) {
      this.persistence
        .updateMessage(messageId, { deliveryStatus: 'read' })
        .catch((e) => logger.error('persist updateMessage:', e))
    }

    this.handleRead(user.id, messageId, roomId)
  }

  // ── React ─────────────────────────────────────────────────────────────────

  async onReact(socket: TypedSocket, data: ReactPayload, ack: AckFn<void>): Promise<void> {
    try {
      const user = socket.data.user
      const { messageId, roomId, emoji } = data

      if (!messageId || !roomId || !emoji) {
        throw new ChatError('messageId, roomId and emoji are required', ErrorCodes.VALIDATION)
      }

      const found = await this.requireMemberMessage(user, roomId, messageId)

      this.ns.to(roomId).emit('message:reaction', {
        messageId,
        roomId,
        userId: user.id,
        username: user.username,
        emoji,
        reactedAt: new Date(),
      })

      const message = found.message
      if (this.persistence && message) {
        if (!message.reactions) message.reactions = {}
        if (!message.reactions[emoji]) message.reactions[emoji] = []
        const idx = message.reactions[emoji].indexOf(user.id)
        if (idx === -1) message.reactions[emoji].push(user.id)
        else message.reactions[emoji].splice(idx, 1)
        await this.persistence.updateMessage(messageId, { reactions: message.reactions })
      }

      this.handleReaction(data, message ?? ({ id: messageId } as Message))
      ack({ ok: true, data: undefined })
    } catch (err) {
      this.handleError(err, ack)
    }
  }

  // ── History ───────────────────────────────────────────────────────────────

  async onHistory(
    socket: TypedSocket,
    data: { roomId: string; limit?: number; before?: string },
    ack: AckFn<Message[]>,
  ): Promise<void> {
    try {
      const user = socket.data.user
      const { roomId, limit = DEFAULT_HISTORY_LIMIT, before } = data

      if (!roomId) throw new ChatError('roomId is required', ErrorCodes.VALIDATION)

      const room = this.roomManager.get(roomId)
      if (!room) throw new ChatError('Room not found', ErrorCodes.ROOM_NOT_FOUND)
      if (!room.members.includes(user.id))
        throw new ChatError('Not a member', ErrorCodes.UNAUTHORIZED)

      const messages = this.persistence
        ? await this.persistence.getMessages(roomId, limit, before ? new Date(before) : undefined)
        : []

      ack({ ok: true, data: messages })
    } catch (err) {
      this.handleError(err, ack)
    }
  }

  // ── Permissions ───────────────────────────────────────────────────────────

  private requireMember(user: User, roomId: string): Room {
    const room = this.roomManager.get(roomId)
    if (!room) throw new ChatError('Room not found', ErrorCodes.ROOM_NOT_FOUND)
    if (!room.members.includes(user.id))
      throw new ChatError('Not a member of this room', ErrorCodes.UNAUTHORIZED)
    return room
  }

  /**
   * Checks membership, finds the message, then checks membership again: the lookup is async, and the
   * user may have been kicked (or the room deleted) while it was pending.
   */
  private async requireMemberMessage(
    user: User,
    roomId: string,
    messageId: string,
  ): Promise<FoundMessage> {
    this.requireMember(user, roomId)
    const found = await this.requireMessage(roomId, messageId)
    this.requireMember(user, roomId)
    return found
  }

  /**
   * Finds a message in `roomId`. With a persistence adapter that implements `getMessage`, the adapter's
   * answer is final. Otherwise the in-memory record of recently sent messages is used, also as a
   * fallback for adapters that only offer `getMessages` (which only returns a window of messages).
   */
  private async requireMessage(roomId: string, messageId: string): Promise<FoundMessage> {
    if (this.persistence) {
      const message = this.persistence.getMessage
        ? await this.persistence.getMessage(messageId)
        : (await this.persistence.getMessages(roomId)).find((m) => m.id === messageId)
      if (message) {
        if (message.roomId !== roomId || message.deletedAt) {
          throw new ChatError('Message not found', ErrorCodes.MESSAGE_NOT_FOUND)
        }
        return { roomId, senderId: message.senderId, message }
      }
      // A miss from getMessage is definitive (e.g. deleted directly in the database): don't trust the cache.
      if (this.persistence.getMessage)
        throw new ChatError('Message not found', ErrorCodes.MESSAGE_NOT_FOUND)
    }
    const recent = this.recentMessages.get(messageId)
    if (recent && recent.roomId === roomId) return recent
    throw new ChatError('Message not found', ErrorCodes.MESSAGE_NOT_FOUND)
  }

  private trackMessage(message: Message): void {
    this.recentMessages.set(message.id, { roomId: message.roomId, senderId: message.senderId })
    if (this.recentMessages.size > MAX_TRACKED_MESSAGES) {
      const oldest = this.recentMessages.keys().next().value
      if (oldest !== undefined) this.recentMessages.delete(oldest)
    }
  }

  // ── Middleware ────────────────────────────────────────────────────────────

  private async runMiddleware(message: Message, socket: TypedSocket): Promise<void> {
    for (const mw of this.middleware) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve, reject) => {
        try {
          const result = mw(message, socket.data.user, (err) => (err ? reject(err) : resolve()))
          if (result instanceof Promise) result.then(resolve).catch(reject)
        } catch (e) {
          reject(e)
        }
      })
    }
  }

  // ── Error ─────────────────────────────────────────────────────────────────

  private handleError(err: unknown, ack: ErrorAck): void {
    const chatErr = err instanceof ChatError ? err : new ChatError(String(err), ErrorCodes.INTERNAL)
    const log = QUIET_CODES.has(chatErr.code) ? logger.debug : logger.error
    log(`MessageHandler error [${chatErr.code}]:`, chatErr.message)
    ack({ ok: false, error: { code: chatErr.code, message: chatErr.message } })
  }
}
