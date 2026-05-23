import { Server, type Namespace, type ServerOptions } from 'socket.io'
import type { Server as HttpServer } from 'http'
import type { Server as HttpsServer } from 'https'
import type { Http2SecureServer, Http2Server } from 'http2'
import type {
  User,
  Room,
  Message,
  UserStatus,
  ReactPayload,
  CreateRoomPayload,
  JoinRoomPayload,
  LeaveRoomPayload,
  ClientToServerEvents,
  ServerToClientEvents,
  AckResponse,
} from '@ravex/types'
import { RoomManager, type CreateRoomOptions } from './core/RoomManager.js'
import { UserManager } from './core/UserManager.js'
import { RateLimiter, type RateLimitConfig } from './middleware/RateLimiter.js'
import { MessageHandler, type MessageHandlerConfig } from './handlers/MessageHandler.js'
import { TypingHandler, type TypingConfig } from './handlers/TypingHandler.js'
import { PresenceHandler, type PresenceConfig } from './handlers/PresenceHandler.js'
import { ChatError, ErrorCodes } from './utils/errors.js'

export interface SocketData {
  user: User
}

export type TypedNamespace = Namespace<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>
export type TypedSocket = Parameters<Parameters<TypedNamespace['on']>[1]>[0]
export type AckFn<T> = (response: AckResponse<T>) => void
/** Internal: the error-only ack shape. Every AckFn<T> is structurally assignable to this. */
type ErrorAck = (response: { ok: false; error: { code: string; message: string } }) => void

export interface PersistenceAdapter {
  saveMessage(message: Message): Promise<void>
  getMessages(roomId: string, limit?: number, before?: Date): Promise<Message[]>
  updateMessage(messageId: string, updates: Partial<Message>): Promise<void>
  deleteMessage(messageId: string): Promise<void>
}

export type MessageMiddleware = (
  message: Message,
  user: User,
  next: (err?: Error) => void
) => void | Promise<void>

export type HttpServerInstance = HttpServer | HttpsServer | Http2SecureServer | Http2Server

export interface ChatEngineOptions {
  /** Socket.io namespace to bind to. Defaults to '/'. */
  namespace?: string
  /**
   * Socket.io Server options (CORS, transports, path, adapter, parser, etc.).
   * Forwarded directly to `new Server(httpServer, options.socket)`.
   * Ignored when an existing socket.io Server instance is passed as the first argument.
   */
  socket?: Partial<ServerOptions>
  persistence?: PersistenceAdapter
  messageMiddleware?: MessageMiddleware[]
  message?: MessageHandlerConfig
  typing?: TypingConfig
  presence?: PresenceConfig
  rateLimit?: RateLimitConfig
  onMessage?: (message: Message) => void
  onEdit?: (message: Message, previousContent: string) => void
  onDelete?: (message: Message) => void
  onRead?: (userId: string, messageId: string, roomId: string) => void
  onReaction?: (reaction: ReactPayload, message: Message) => void
  onStatusChange?: (userId: string, previousStatus: UserStatus) => void
}

export class ChatEngine {
  private readonly server: Server
  private readonly ns: TypedNamespace
  private readonly roomManager = new RoomManager()
  private readonly userManager = new UserManager()
  private readonly rateLimiter: RateLimiter
  private readonly messageHandler: MessageHandler
  private readonly typingHandler: TypingHandler
  private readonly presenceHandler: PresenceHandler
  private readonly persistence?: PersistenceAdapter
  private readonly middleware: MessageMiddleware[]

  /**
   * @param srv - An HTTP/HTTPS/HTTP2 server, a port number to listen on, or
   *              an existing socket.io `Server` instance.
   * @param options - ChatEngine configuration. Use `options.socket` to pass
   *                  socket.io ServerOptions (CORS, transports, etc.).
   */
  constructor(srv: HttpServerInstance | number | Server, options: ChatEngineOptions = {}) {
    this.server = srv instanceof Server ? srv : new Server(srv as HttpServerInstance, options.socket)
    const nsPath = options.namespace ?? '/'
    this.ns = this.server.of(nsPath) as TypedNamespace
    this.persistence = options.persistence
    this.middleware = options.messageMiddleware ?? []
    this.rateLimiter = new RateLimiter(options.rateLimit)
    this.messageHandler = new MessageHandler({
      ns: this.ns,
      roomManager: this.roomManager,
      rateLimiter: this.rateLimiter,
      config: options.message ?? {},
      persistence: this.persistence,
      middleware: this.middleware,
      onMessage: options.onMessage ?? (() => {}),
      onEdit: options.onEdit ?? (() => {}),
      onDelete: options.onDelete ?? (() => {}),
      onRead: options.onRead ?? (() => {}),
      onReaction: options.onReaction ?? (() => {}),
    })
    this.typingHandler = new TypingHandler(this.ns, this.roomManager, options.typing ?? {})
    this.presenceHandler = new PresenceHandler({
      ns: this.ns,
      userManager: this.userManager,
      config: options.presence ?? {},
      onStatusChange: options.onStatusChange ?? (() => {}),
    })
    this.setupConnection()
  }

  private setupConnection(): void {
    // Populate socket.data.user from auth payload
    this.ns.use((socket, next) => {
      const user = socket.handshake.auth.user as User | undefined
      if (user?.id) {
        socket.data.user = user
        next()
      } else {
        next(new Error('Authentication failed: Missing or invalid user in auth payload'))
      }
    })

    this.ns.on('connection', (socket) => {
      const user = socket.data.user
      if (!user?.id) {
        socket.disconnect(true)
        return
      }
      this.registerUser(user, socket.id)
      const rooms = this.roomManager.getRoomsForUser(user.id)
      rooms.forEach((r) => socket.join(r.id))
      socket.on('message:send', (p, a) => this.messageHandler.onSend(socket, p, a))
      socket.on('message:edit', (p, a) => this.messageHandler.onEdit(socket, p, a))
      socket.on('message:delete', (p, a) => this.messageHandler.onDelete(socket, p, a))
      socket.on('message:read', (p) => this.messageHandler.onRead(socket, p))
      socket.on('message:react', (p, a) => this.messageHandler.onReact(socket, p, a))
      socket.on('message:history', (p, a) => this.messageHandler.onHistory(socket, p, a))
      socket.on('typing:start', (p) => this.typingHandler.onStart(socket, p))
      socket.on('typing:stop', (p) => this.typingHandler.onStop(socket, p))
      socket.on('room:join', (p, a) => this.handleRoomJoin(socket, p, a))
      socket.on('room:leave', (p, a) => this.handleRoomLeave(socket, p, a))
      socket.on('room:create', (p, a) => this.handleRoomCreate(socket, p, a))
      socket.on('room:delete', (p, a) => this.handleRoomDelete(socket, p, a))
      socket.on('room:members', (p, a) => this.handleRoomMembers(socket, p, a))
      socket.on('room:list', (a) => this.handleRoomList(socket, a))
      socket.on('presence:ping', () => this.presenceHandler.onPing(socket))
      socket.on('presence:status', (p) => this.presenceHandler.onStatusChange(socket, p))
      socket.on('disconnect', () => this.handleDisconnect(user.id, user.username, socket.id))
    })
  }

  private registerUser(user: User, socketId: string): void {
    const existing = this.userManager.get(user.id)
    const wasOnline = existing ? this.userManager.isConnected(user.id) : false
    if (!existing) {
      this.userManager.set(user.id, {
        ...user,
        socketIds: [],
        status: user.status || 'online',
        connectedAt: new Date(),
      })
    }
    this.userManager.addSocketId(user.id, socketId)
    if (!wasOnline) {
      this.ns.emit('user:online', { id: user.id, username: user.username })
    }
  }

  private handleDisconnect(userId: string, username: string, socketId: string): void {
    this.userManager.removeSocketId(userId, socketId)
    if (!this.userManager.isConnected(userId)) {
      const user = this.userManager.get(userId)
      const lastSeen = new Date()
      if (user) {
        user.lastSeen = lastSeen
        this.userManager.set(userId, user)
      }
      this.ns.emit('user:offline', { id: userId, username, lastSeen })
      this.typingHandler.clearAll(userId, username)
      this.presenceHandler.clearAll(userId)
    }
  }

  private handleRoomJoin(socket: TypedSocket, data: JoinRoomPayload, ack: AckFn<Room>): void {
    try {
      const user = socket.data.user
      const { roomId } = data
      if (!roomId) throw new ChatError('roomId required', ErrorCodes.VALIDATION)
      const room = this.roomManager.get(roomId)
      if (!room) throw new ChatError('Room not found', ErrorCodes.ROOM_NOT_FOUND)
      const wasMember = this.roomManager.isMember(roomId, user.id)
      if (!wasMember) {
        this.roomManager.addMember(roomId, user.id)
      }
      socket.join(roomId)
      if (!wasMember) {
        this.ns.to(roomId).emit('room:user_joined', {
          roomId,
          user: { id: user.id, username: user.username, displayName: user.displayName },
        })
      }
      ack({ ok: true, data: room })
    } catch (err) {
      this.sendAckError(ack, err)
    }
  }

  private handleRoomLeave(socket: TypedSocket, data: LeaveRoomPayload, ack: AckFn<void>): void {
    try {
      const user = socket.data.user
      const { roomId } = data
      if (!roomId) throw new ChatError('roomId required', ErrorCodes.VALIDATION)
      socket.leave(roomId)
      if (this.roomManager.isMember(roomId, user.id)) {
        this.roomManager.removeMember(roomId, user.id)
        this.ns.to(roomId).emit('room:user_left', {
          roomId,
          user: { id: user.id, username: user.username },
        })
        this.typingHandler.clearForRoom(user.id, user.username, roomId)
      }
      ack({ ok: true, data: undefined })
    } catch (err) {
      this.sendAckError(ack, err)
    }
  }

  private handleRoomCreate(socket: TypedSocket, data: CreateRoomPayload, ack: AckFn<Room>): void {
    try {
      const user = socket.data.user
      const room = this.createRoom({ ...data, createdBy: user.id })
      socket.join(room.id)
      this.ns.to(room.id).emit('room:user_joined', {
        roomId: room.id,
        user: { id: user.id, username: user.username, displayName: user.displayName },
      })
      ack({ ok: true, data: room })
    } catch (err) {
      this.sendAckError(ack, err)
    }
  }

  private handleRoomDelete(socket: TypedSocket, data: { roomId: string }, ack: AckFn<void>): void {
    try {
      const user = socket.data.user
      const { roomId } = data
      if (!roomId) throw new ChatError('roomId required', ErrorCodes.VALIDATION)
      if (!this.roomManager.isAdmin(roomId, user.id)) {
        throw new ChatError('Admin only', ErrorCodes.UNAUTHORIZED)
      }
      if (!this.roomManager.get(roomId)) {
        throw new ChatError('Room not found', ErrorCodes.ROOM_NOT_FOUND)
      }
      this.roomManager.delete(roomId)
      this.ns.to(roomId).emit('room:deleted', { roomId })
      ack({ ok: true, data: undefined })
    } catch (err) {
      this.sendAckError(ack, err)
    }
  }

  private handleRoomMembers(socket: TypedSocket, data: { roomId: string }, ack: AckFn<Pick<User, 'id' | 'username' | 'displayName' | 'status'>[]>): void {
    try {
      const user = socket.data.user
      const { roomId } = data
      const room = this.roomManager.get(roomId)
      if (!room) throw new ChatError('Room not found', ErrorCodes.ROOM_NOT_FOUND)
      if (!room.members.includes(user.id)) throw new ChatError('Not a member', ErrorCodes.UNAUTHORIZED)
      const list = room.members.map((id) => {
        const u = this.userManager.get(id)
        return u
          ? { id: u.id, username: u.username, displayName: u.displayName, status: u.status }
          : { id, username: id, displayName: undefined, status: 'offline' as const }
      })
      ack({ ok: true, data: list })
    } catch (err) {
      this.sendAckError(ack, err)
    }
  }

  private handleRoomList(socket: TypedSocket, ack: AckFn<Room[]>): void {
    const user = socket.data.user
    const rooms = this.roomManager.getRoomsForUser(user.id)
    ack({ ok: true, data: rooms })
  }

  private sendAckError(ack: ErrorAck, err: unknown): void {
    const chatErr = err instanceof ChatError ? err : new ChatError(String(err), ErrorCodes.INTERNAL)
    ack({ ok: false, error: { code: chatErr.code, message: chatErr.message } })
  }

  public createRoom(options: CreateRoomOptions): Room {
    const room = this.roomManager.create(options)
    for (const uid of room.members) {
      const u = this.userManager.get(uid)
      if (u) {
        for (const sid of u.socketIds) {
          this.ns.sockets.get(sid)?.join(room.id)
        }
      }
    }
    return room
  }

  /** The underlying socket.io Server instance. */
  get io(): Server {
    return this.server
  }

  public getRoom(roomId: string): Room | undefined {
    return this.roomManager.get(roomId)
  }

  public getUser(userId: string): User | undefined {
    return this.userManager.get(userId)
  }

  public kickUser(roomId: string, userId: string, reason = 'Removed from room'): void {
    const room = this.roomManager.get(roomId)
    if (!room) return
    this.roomManager.removeMember(roomId, userId)
    const user = this.userManager.get(userId)
    if (user) {
      for (const sid of [...user.socketIds]) {
        const sock = this.ns.sockets.get(sid)
        if (sock) {
          sock.leave(roomId)
          sock.emit('room:kicked', { roomId, reason })
        }
      }
    }
    this.ns.to(roomId).emit('room:user_kicked', { roomId, userId, reason })
  }

  public destroy(): void {
    this.rateLimiter.destroy()
    this.presenceHandler.destroy()
  }
}
