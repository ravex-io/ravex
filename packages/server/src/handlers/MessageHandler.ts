import type { Message, SendMessagePayload, EditMessagePayload, DeleteMessagePayload, ReactPayload, ReadPayload, User, Room } from '@ravex/types'
import type { TypedSocket, TypedNamespace, PersistenceAdapter, MessageMiddleware, AckFn } from '../ChatEngine.js'
/** Internal: the error-only ack shape. Every AckFn<T> is structurally assignable to this. */
type ErrorAck = (response: { ok: false; error: { code: string; message: string } }) => void
import type { RoomManager } from '../core/RoomManager.js'
import type { RateLimiter } from '../middleware/RateLimiter.js'
import { ChatError, ErrorCodes } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import { randomUUID } from 'crypto'

const DEFAULT_HISTORY_LIMIT = 50
const DEFAULT_MAX_MESSAGE_LENGTH = 10_000

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
  private readonly handleMessage: (message: Message) => void
  private readonly handleEdit: (message: Message, previousContent: string) => void
  private readonly handleDelete: (message: Message) => void
  private readonly handleRead: (userId: string, messageId: string, roomId: string) => void
  private readonly handleReaction: (reaction: ReactPayload, message: Message) => void

  constructor(deps: MessageHandlerDeps) {
    this.ns = deps.ns
    this.roomManager = deps.roomManager
    this.rateLimiter = deps.rateLimiter
    this.config = deps.config
    this.persistence = deps.persistence
    this.middleware = deps.middleware
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

    const maxLength = this.config.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH
    if (content && content.length > maxLength) {
      throw new ChatError(`Message too long (max ${maxLength} chars)`, ErrorCodes.MESSAGE_TOO_LONG)
    }

    const room = this.roomManager.get(roomId)
    if (!room) throw new ChatError('Room not found', ErrorCodes.ROOM_NOT_FOUND)
    if (!room.members.includes(user.id)) throw new ChatError('Not a member of this room', ErrorCodes.UNAUTHORIZED)

    if (!this.rateLimiter.checkMessage(user.id)) {
      throw new ChatError('Rate limit exceeded', ErrorCodes.RATE_LIMIT)
    }
    if (this.rateLimiter.isMuted(user.id, roomId)) {
      throw new ChatError('You are muted in this room', ErrorCodes.MUTED)
    }

    return room
  }

  async onSend(
    socket: TypedSocket,
    data: SendMessagePayload,
    ack: AckFn<Message>,
  ): Promise<void> {
    try {
      const user = socket.data.user
      const room = this.validateSendRequest(user, data)
      const { roomId, content, type = 'text', replyTo, attachments, metadata } = data

      const message: Message = {
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

      await this.runMiddleware(message, socket)

      this.ns.to(roomId).emit('message:new', message)

      if (this.persistence) {
        await this.persistence.saveMessage(message).catch(e => logger.error('persist saveMessage:', e))
      }

      this.handleMessage(message)
      logger.debug(`Message ${message.id} sent to room ${roomId}`)
      ack({ ok: true, data: message })
    } catch (err) {
      this.handleError(err, ack)
    }
  }

  // ── Edit ──────────────────────────────────────────────────────────────────

  async onEdit(
    socket: TypedSocket,
    data: EditMessagePayload,
    ack: AckFn<Message>,
  ): Promise<void> {
    try {
      if (!this.config.allowEdits) throw new ChatError('Editing is disabled', ErrorCodes.FORBIDDEN)

      const user = socket.data.user
      const { messageId, roomId, content } = data

      if (!messageId || !roomId || !content) {
        throw new ChatError('messageId, roomId and content are required', ErrorCodes.VALIDATION)
      }

      const room = this.roomManager.get(roomId)
      if (!room) throw new ChatError('Room not found', ErrorCodes.ROOM_NOT_FOUND)

      let previousContent = ''

      if (this.persistence) {
        const messages = await this.persistence.getMessages(roomId)
        const message = messages.find(m => m.id === messageId)
        if (message && message.senderId !== user.id) {
          throw new ChatError("Cannot edit another user's message", ErrorCodes.UNAUTHORIZED)
        }
        previousContent = message?.content ?? ''
        await this.persistence.updateMessage(messageId, { content, editedAt: new Date() })
      }

      this.ns.to(roomId).emit('message:edited', {
        messageId,
        roomId,
        content,
        editedAt: new Date(),
        editedBy: user.id,
      })

      this.handleEdit({ id: messageId, roomId, content } as Message, previousContent)
      ack({ ok: true, data: { id: messageId, roomId, content } as Message })
    } catch (err) {
      this.handleError(err, ack)
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async onDelete(
    socket: TypedSocket,
    data: DeleteMessagePayload,
    ack: AckFn<void>,
  ): Promise<void> {
    try {
      if (!this.config.allowDeletes) throw new ChatError('Deleting is disabled', ErrorCodes.FORBIDDEN)

      const user = socket.data.user
      const { messageId, roomId } = data

      if (!messageId || !roomId) {
        throw new ChatError('messageId and roomId are required', ErrorCodes.VALIDATION)
      }

      const room = this.roomManager.get(roomId)
      if (!room) throw new ChatError('Room not found', ErrorCodes.ROOM_NOT_FOUND)

      const isAdmin = this.roomManager.isAdmin(roomId, user.id)
      let message: Message | undefined = undefined

      if (this.persistence) {
        const messages = await this.persistence.getMessages(roomId)
        message = messages.find(m => m.id === messageId)
        if (message && message.senderId !== user.id && !isAdmin) {
          throw new ChatError("Cannot delete another user's message", ErrorCodes.UNAUTHORIZED)
        }
        await this.persistence.deleteMessage(messageId)
      }

      this.ns.to(roomId).emit('message:deleted', { messageId, roomId, deletedBy: user.id })

      if (message) this.handleDelete(message)
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

    socket.to(roomId).emit('message:read_receipt', {
      messageId,
      roomId,
      readBy: user.id,
      readAt: new Date(),
    })

    if (this.persistence) {
      this.persistence
        .updateMessage(messageId, { deliveryStatus: 'read' })
        .catch(e => logger.error('persist updateMessage:', e))
    }

    this.handleRead(user.id, messageId, roomId)
  }

  // ── React ─────────────────────────────────────────────────────────────────

  async onReact(
    socket: TypedSocket,
    data: ReactPayload,
    ack: AckFn<void>,
  ): Promise<void> {
    try {
      const user = socket.data.user
      const { messageId, roomId, emoji } = data

      if (!messageId || !roomId || !emoji) {
        throw new ChatError('messageId, roomId and emoji are required', ErrorCodes.VALIDATION)
      }

      this.ns.to(roomId).emit('message:reaction', {
        messageId,
        roomId,
        userId: user.id,
        username: user.username,
        emoji,
        reactedAt: new Date(),
      })

      let message: Message | undefined = undefined

      if (this.persistence) {
        const messages = await this.persistence.getMessages(roomId)
        message = messages.find(m => m.id === messageId)
        if (message) {
          if (!message.reactions) message.reactions = {}
          if (!message.reactions[emoji]) message.reactions[emoji] = []
          const idx = message.reactions[emoji].indexOf(user.id)
          if (idx === -1) message.reactions[emoji].push(user.id)
          else message.reactions[emoji].splice(idx, 1)
          await this.persistence.updateMessage(messageId, { reactions: message.reactions })
        }
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
      if (!room.members.includes(user.id)) throw new ChatError('Not a member', ErrorCodes.UNAUTHORIZED)

      const messages = this.persistence
        ? await this.persistence.getMessages(roomId, limit, before ? new Date(before) : undefined)
        : []

      ack({ ok: true, data: messages })
    } catch (err) {
      this.handleError(err, ack)
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
    logger.error(`MessageHandler error [${chatErr.code}]:`, chatErr.message)
    ack({ ok: false, error: { code: chatErr.code, message: chatErr.message } })
  }
}
