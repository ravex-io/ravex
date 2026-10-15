import { io, type Socket } from 'socket.io-client'
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SendMessagePayload,
  EditMessagePayload,
  ReactPayload,
  ReadPayload,
  TypingPayload,
  JoinRoomPayload,
  LeaveRoomPayload,
  CreateRoomPayload,
  StatusPayload,
  Message,
  Room,
  User,
  AckResponse,
} from '@ravex/types'

const DEFAULT_HISTORY_LIMIT = 50
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

type AuthPayload = Record<string, unknown>
type AuthOption = AuthPayload | (() => AuthPayload | Promise<AuthPayload>)

export interface ChatClientOptions {
  url?: string
  namespace?: string
  /** Handshake payload, or a function returning it (called again on every reconnect, e.g. to refresh a token). */
  auth?: AuthOption
  transports?: string[]
  withCredentials?: boolean
  autoConnect?: boolean
  /** How long (ms) request methods wait for the server before rejecting. Default: 10000. 0 disables the timeout. */
  requestTimeout?: number
}

// Fields the server sends as Dates; JSON turns them into ISO strings on the wire.
const DATE_FIELDS = new Set(['createdAt', 'editedAt', 'deletedAt', 'readAt', 'reactedAt', 'lastSeen', 'connectedAt'])

/**
 * Turns the ISO date strings of known date fields back into `Date` objects, in place, so the
 * runtime values match the `Date` types in @ravex/types. `metadata` is left untouched.
 */
const reviveDates = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(reviveDates)
    return
  }
  if (typeof value !== 'object' || value === null || value instanceof Date) return
  const record = value as Record<string, unknown>
  for (const [key, field] of Object.entries(record)) {
    if (DATE_FIELDS.has(key) && typeof field === 'string') {
      const date = new Date(field)
      if (!Number.isNaN(date.getTime())) record[key] = date
    } else if (key !== 'metadata') {
      reviveDates(field)
    }
  }
}

/**
 * socket.io-client calls a function `auth` as `auth(cb)` and waits for `cb`; it ignores a returned
 * value or Promise. Adapt `() => payload | Promise<payload>` to that callback style.
 */
const toSocketAuth = (auth: AuthOption | undefined): AuthPayload | ((cb: (data: object) => void) => void) | undefined => {
  if (typeof auth !== 'function') return auth
  return (cb) => {
    Promise.resolve()
      .then(() => auth())
      // If the auth function fails, connect without credentials so the server rejects the handshake
      // and the app gets a normal connect_error, instead of hanging forever.
      .then((payload) => cb(payload ?? {}), () => cb({}))
  }
}

export class ChatClient {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents>
  private connected = false
  private readonly requestTimeout: number

  constructor(options: ChatClientOptions = {}) {
    const ns = options.namespace ?? '/'
    const url = options.url ?? ''
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS

    this.socket = io(url + ns, {
      transports: options.transports ?? ['websocket', 'polling'],
      withCredentials: options.withCredentials ?? true,
      auth: toSocketAuth(options.auth),
      autoConnect: options.autoConnect ?? true,
    }) as Socket<ServerToClientEvents, ClientToServerEvents>

    this.setupListeners()
  }

  private setupListeners(): void {
    this.socket.on('connect', () => {
      this.connected = true
    })
    this.socket.on('disconnect', () => {
      this.connected = false
    })
    // Registered first, so every event listener receives Date objects instead of ISO strings.
    this.socket.onAny((_event: string, ...args: unknown[]) => args.forEach(reviveDates))
  }

  get isConnected(): boolean {
    return this.connected && this.socket.connected
  }

  get rawSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
    return this.socket
  }

  connect(): void {
    this.socket.connect()
  }

  disconnect(): void {
    this.socket.disconnect()
  }

  private request<T>(
    event: keyof ClientToServerEvents,
    payload?: unknown,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null, res?: AckResponse<T>) => {
        if (err) return reject(new Error(`Request "${String(event)}" timed out after ${this.requestTimeout}ms`))
        reviveDates(res)
        if (res?.ok) resolve(res.data)
        else reject(res?.error ? new Error(res.error.message) : new Error('Request failed'))
      }
      // timeout() makes socket.io call the ack with an error first if the server doesn't answer in time.
      const sender = (this.requestTimeout > 0 ? this.socket.timeout(this.requestTimeout) : null) as {
        emit(e: string, ...args: unknown[]): void
      } | null
      const ack = sender ? cb : (res: AckResponse<T>) => cb(null, res)
      const emitter = sender ?? (this.socket as { emit(e: string, ...args: unknown[]): void })
      if (payload === undefined) emitter.emit(event as string, ack)
      else emitter.emit(event as string, payload, ack)
    })
  }

  sendMessage(payload: SendMessagePayload): Promise<Message> {
    return this.request<Message>('message:send', payload)
  }

  editMessage(payload: EditMessagePayload): Promise<Message> {
    return this.request<Message>('message:edit', payload)
  }

  deleteMessage(messageId: string, roomId: string): Promise<void> {
    return this.request<void>('message:delete', { messageId, roomId })
  }

  markAsRead(messageId: string, roomId: string): void {
    this.socket.emit('message:read', { messageId, roomId } as ReadPayload)
  }

  sendReaction(messageId: string, roomId: string, emoji: string): Promise<void> {
    return this.request<void>('message:react', { messageId, roomId, emoji } as ReactPayload)
  }

  getHistory(roomId: string, limit = DEFAULT_HISTORY_LIMIT, before?: string): Promise<Message[]> {
    return this.request<Message[]>('message:history', { roomId, limit, before })
  }

  startTyping(roomId: string): void {
    this.socket.emit('typing:start', { roomId } as TypingPayload)
  }

  stopTyping(roomId: string): void {
    this.socket.emit('typing:stop', { roomId } as TypingPayload)
  }

  joinRoom(roomId: string): Promise<Room> {
    return this.request<Room>('room:join', { roomId } as JoinRoomPayload)
  }

  leaveRoom(roomId: string): Promise<void> {
    return this.request<void>('room:leave', { roomId } as LeaveRoomPayload)
  }

  createRoom(payload: CreateRoomPayload): Promise<Room> {
    return this.request<Room>('room:create', payload)
  }

  deleteRoom(roomId: string): Promise<void> {
    return this.request<void>('room:delete', { roomId })
  }

  getRoomMembers(roomId: string): Promise<Pick<User, 'id' | 'username' | 'displayName' | 'status'>[]> {
    return this.request<Pick<User, 'id' | 'username' | 'displayName' | 'status'>[]>('room:members', { roomId })
  }

  listRooms(): Promise<Room[]> {
    return this.request<Room[]>('room:list')
  }

  ping(): void {
    this.socket.emit('presence:ping')
  }

  setStatus(status: StatusPayload['status']): void {
    this.socket.emit('presence:status', { status } as StatusPayload)
  }

  // ── High-level Event Listeners (clean client API) ─────────────────────────────

  onMessage(listener: (message: Message) => void): () => void {
    this.socket.on('message:new', listener)
    return () => this.socket.off('message:new', listener)
  }

  onMessageEdited(
    listener: (data: { messageId: string; roomId: string; content: string; editedAt: Date; editedBy: string }) => void,
  ): () => void {
    this.socket.on('message:edited', listener)
    return () => this.socket.off('message:edited', listener)
  }

  onMessageDeleted(
    listener: (data: { messageId: string; roomId: string; deletedBy: string }) => void,
  ): () => void {
    this.socket.on('message:deleted', listener)
    return () => this.socket.off('message:deleted', listener)
  }

  onReaction(
    listener: (data: { messageId: string; roomId: string; userId: string; username: string; emoji: string; reactedAt: Date }) => void,
  ): () => void {
    this.socket.on('message:reaction', listener)
    return () => this.socket.off('message:reaction', listener)
  }

  onReadReceipt(
    listener: (data: { messageId: string; roomId: string; readBy: string; readAt: Date }) => void,
  ): () => void {
    this.socket.on('message:read_receipt', listener)
    return () => this.socket.off('message:read_receipt', listener)
  }

  onTypingStart(
    listener: (data: { userId: string; username: string; roomId: string }) => void,
  ): () => void {
    this.socket.on('typing:start', listener)
    return () => this.socket.off('typing:start', listener)
  }

  onTypingStop(
    listener: (data: { userId: string; username: string; roomId: string }) => void,
  ): () => void {
    this.socket.on('typing:stop', listener)
    return () => this.socket.off('typing:stop', listener)
  }

  onUserOnline(
    listener: (data: Pick<User, 'id' | 'username'>) => void,
  ): () => void {
    this.socket.on('user:online', listener)
    return () => this.socket.off('user:online', listener)
  }

  onUserOffline(
    listener: (data: Pick<User, 'id' | 'username'> & { lastSeen: Date }) => void,
  ): () => void {
    this.socket.on('user:offline', listener)
    return () => this.socket.off('user:offline', listener)
  }

  onUserStatus(
    listener: (data: Pick<User, 'id' | 'username' | 'status'> & { lastSeen: Date }) => void,
  ): () => void {
    this.socket.on('user:status', listener)
    return () => this.socket.off('user:status', listener)
  }

  onRoomUserJoined(
    listener: (data: { roomId: string; user: Pick<User, 'id' | 'username' | 'displayName'> }) => void,
  ): () => void {
    this.socket.on('room:user_joined', listener)
    return () => this.socket.off('room:user_joined', listener)
  }

  onRoomUserLeft(
    listener: (data: { roomId: string; user: Pick<User, 'id' | 'username'> }) => void,
  ): () => void {
    this.socket.on('room:user_left', listener)
    return () => this.socket.off('room:user_left', listener)
  }

  onRoomDeleted(listener: (data: { roomId: string }) => void): () => void {
    this.socket.on('room:deleted', listener)
    return () => this.socket.off('room:deleted', listener)
  }

  onKickedFromRoom(listener: (data: { roomId: string; reason: string }) => void): () => void {
    this.socket.on('room:kicked', listener)
    return () => this.socket.off('room:kicked', listener)
  }

  onError(listener: (data: { code: string; message: string }) => void): () => void {
    this.socket.on('chat:error', listener)
    return () => this.socket.off('chat:error', listener)
  }

  // Generic listener API (for any event)
  on<K extends keyof ServerToClientEvents>(
    event: K,
    listener: ServerToClientEvents[K]
  ): this {
    // Double cast needed: the socket's overloaded on() expects a specific union member,
    // but we have the correct type via the K constraint at call-site.
    ;(this.socket as { on(e: string, l: ServerToClientEvents[K]): void }).on(event, listener)
    return this
  }

  off<K extends keyof ServerToClientEvents>(
    event: K,
    listener?: ServerToClientEvents[K]
  ): this {
    ;(this.socket as { off(e: string, l?: ServerToClientEvents[K]): void }).off(event, listener)
    return this
  }

  once<K extends keyof ServerToClientEvents>(
    event: K,
    listener: ServerToClientEvents[K]
  ): this {
    ;(this.socket as { once(e: string, l: ServerToClientEvents[K]): void }).once(event, listener)
    return this
  }
}
