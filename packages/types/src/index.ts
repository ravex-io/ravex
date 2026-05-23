// ─── Primitives ───────────────────────────────────────────────────────────────

export type MessageType = 'text' | 'image' | 'file' | 'audio' | 'video' | 'system'
export type ChatType = 'personal' | 'group'
export type UserStatus = 'online' | 'offline' | 'away' | 'busy'
export type DeliveryStatus = 'sent' | 'delivered' | 'read'

// ─── Entities ─────────────────────────────────────────────────────────────────

export interface User {
  id: string
  username: string
  displayName?: string
  avatar?: string
  status: UserStatus
  socketIds: string[]
  connectedAt?: Date
  lastSeen?: Date
  metadata?: Record<string, unknown>
}

export interface Room {
  id: string
  name: string
  type: ChatType
  members: string[]
  admins: string[]
  createdBy: string
  createdAt: Date
  maxMembers?: number
  isPrivate?: boolean
  metadata?: Record<string, unknown>
}

export interface Message {
  id: string
  roomId: string
  senderId: string
  senderName: string
  content: string
  type: MessageType
  chatType: ChatType
  replyTo?: string
  attachments?: Attachment[]
  reactions?: Record<string, string[]>
  deliveryStatus: DeliveryStatus
  editedAt?: Date
  deletedAt?: Date
  metadata?: Record<string, unknown>
  createdAt: Date
}

export interface Attachment {
  id: string
  name: string
  url: string
  mimeType: string
  size: number
}

// ─── Payloads (what the client sends) ────────────────────────────────────────

export interface SendMessagePayload {
  roomId: string
  content: string
  type?: MessageType
  replyTo?: string
  attachments?: Attachment[]
  metadata?: Record<string, unknown>
}

export interface EditMessagePayload {
  messageId: string
  roomId: string
  content: string
}

export interface DeleteMessagePayload {
  messageId: string
  roomId: string
}

export interface ReactPayload {
  messageId: string
  roomId: string
  emoji: string
}

export interface ReadPayload {
  messageId: string
  roomId: string
}

export interface JoinRoomPayload {
  roomId: string
}

export interface LeaveRoomPayload {
  roomId: string
}

export interface CreateRoomPayload {
  name?: string
  type: ChatType
  members?: string[]
  isPrivate?: boolean
  maxMembers?: number
  metadata?: Record<string, unknown>
}

export interface TypingPayload {
  roomId: string
}

export interface StatusPayload {
  status: Exclude<UserStatus, 'offline'>
}

// ─── Acknowledgement wrapper ──────────────────────────────────────────────────

export type Ack<T> = (response: AckResponse<T>) => void

export type AckResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

// ─── Socket Event Maps ────────────────────────────────────────────────────────

export interface ServerToClientEvents {
  'message:new': (message: Message) => void
  'message:edited': (data: { messageId: string; roomId: string; content: string; editedAt: Date; editedBy: string }) => void
  'message:deleted': (data: { messageId: string; roomId: string; deletedBy: string }) => void
  'message:read_receipt': (data: { messageId: string; roomId: string; readBy: string; readAt: Date }) => void
  'message:reaction': (data: { messageId: string; roomId: string; userId: string; username: string; emoji: string; reactedAt: Date }) => void

  'typing:start': (data: { userId: string; username: string; roomId: string }) => void
  'typing:stop': (data: { userId: string; username: string; roomId: string }) => void

  'room:user_joined': (data: { roomId: string; user: Pick<User, 'id' | 'username' | 'displayName'> }) => void
  'room:user_left': (data: { roomId: string; user: Pick<User, 'id' | 'username'> }) => void
  'room:user_kicked': (data: { roomId: string; userId: string; reason: string }) => void
  'room:kicked': (data: { roomId: string; reason: string }) => void
  'room:deleted': (data: { roomId: string }) => void

  'user:online': (data: Pick<User, 'id' | 'username'>) => void
  'user:offline': (data: Pick<User, 'id' | 'username'> & { lastSeen: Date }) => void
  'user:status': (data: Pick<User, 'id' | 'username' | 'status'> & { lastSeen: Date }) => void
  'user:muted': (data: { roomId: string; durationMs: number }) => void

  'presence:heartbeat': (data: { ts: number }) => void
  'chat:error': (data: { code: string; message: string }) => void
}

export interface ClientToServerEvents {
  'message:send': (payload: SendMessagePayload, ack: Ack<Message>) => void
  'message:edit': (payload: EditMessagePayload, ack: Ack<Message>) => void
  'message:delete': (payload: DeleteMessagePayload, ack: Ack<void>) => void
  'message:read': (payload: ReadPayload) => void
  'message:react': (payload: ReactPayload, ack: Ack<void>) => void
  'message:history': (payload: { roomId: string; limit?: number; before?: string }, ack: Ack<Message[]>) => void

  'typing:start': (payload: TypingPayload) => void
  'typing:stop': (payload: TypingPayload) => void

  'room:join': (payload: JoinRoomPayload, ack: Ack<Room>) => void
  'room:leave': (payload: LeaveRoomPayload, ack: Ack<void>) => void
  'room:create': (payload: CreateRoomPayload, ack: Ack<Room>) => void
  'room:delete': (payload: { roomId: string }, ack: Ack<void>) => void
  'room:members': (payload: { roomId: string }, ack: Ack<Pick<User, 'id' | 'username' | 'displayName' | 'status'>[]>) => void
  'room:list': (ack: Ack<Room[]>) => void

  'presence:ping': () => void
  'presence:status': (payload: StatusPayload) => void
}
