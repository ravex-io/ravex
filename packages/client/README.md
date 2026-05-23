# @ravex/client

![Ravex Client](../../assets/ravex-client.webp)

A robust, fully-typed WebSocket client for the Ravex real-time chat system. Built on top of `socket.io-client`, it provides a clean, promise-based API with comprehensive TypeScript support for all chat operations.

## Installation

```bash
npm install @ravex/client
# or
pnpm add @ravex/client
# or
yarn add @ravex/client
```

## Quick Start

```typescript
import { ChatClient } from '@ravex/client'
import type { User } from '@ravex/types'

const currentUser: User = {
  id: 'user-123',
  username: 'johndoe',
  status: 'online',
  socketIds: []
}

// 1. Initialize the client
const client = new ChatClient({
  url: 'http://localhost:3000',
  auth: { user: currentUser }
})

// 2. Setup event listeners
client.onMessage((message) => {
  console.log('New message received:', message)
})

// 3. Send a message to a room
await client.sendMessage({
  roomId: 'room-abc',
  content: 'Hello everyone!'
})
```

## API Reference

### Initialization

#### `new ChatClient(options?: ChatClientOptions)`
Creates a new chat client instance. Automatically connects on instantiation. Call disconnect() to close the connection, or pass autoConnect: false via socket.io-client options if you want manual control.

**`ChatClientOptions` properties:**
- `url` (string): The base URL of the socket.io server. Defaults to `''`.
- `namespace` (string): The namespace to connect to. Defaults to `'/'`.
- `auth` (Object | Function): Authentication payload sent during connection handshake. Usually contains the `{ user: User }` object.
- `transports` (string[]): Socket.io transports. Defaults to `['websocket', 'polling']`.
- `withCredentials` (boolean): Whether to send cross-origin credentials. Defaults to `true`.
- `autoConnect` (boolean): Whether to auto connect on startup. Defaults to `true`.

### Connection Management

- `client.connect(): void` - Initiates the connection to the server.
- `client.disconnect(): void` - Disconnects from the server.
- `client.isConnected: boolean` - Returns `true` if fully connected.
- `client.rawSocket: Socket` - Access the underlying `socket.io-client` instance.

### Messaging (Promise-based)

All messaging actions return a Promise that resolves when the server acknowledges the operation.

- **`sendMessage(payload: SendMessagePayload): Promise<Message>`**
  Sends a new message to a room.
- **`editMessage(payload: EditMessagePayload): Promise<Message>`**
  Edits an existing message (if permitted by server configuration).
- **`deleteMessage(messageId: string, roomId: string): Promise<void>`**
  Deletes a message.
- **`markAsRead(messageId: string, roomId: string): void`**
  Marks a specific message as read.
- **`sendReaction(messageId: string, roomId: string, emoji: string): Promise<void>`**
  Adds or toggles an emoji reaction on a message.
- **`getHistory(roomId: string, limit?: number, before?: string): Promise<Message[]>`**
  Fetches historical messages for a room (requires a persistence adapter on the server).

### Rooms (Promise-based)

- **`createRoom(payload: CreateRoomPayload): Promise<Room>`**
  Creates a new room and automatically joins the creator.
- **`joinRoom(roomId: string): Promise<Room>`**
  Joins an existing room.
- **`leaveRoom(roomId: string): Promise<void>`**
  Leaves a room.
- **`deleteRoom(roomId: string): Promise<void>`**
  Deletes a room (admin only).
- **`getRoomMembers(roomId: string): Promise<Partial<User>[]>`**
  Gets the list of active members in a room.
- **`listRooms(): Promise<Room[]>`**
  Lists all rooms the current user is a member of.

### Presence & Typing

- **`setStatus(status: 'online' | 'away' | 'busy'): void`**
  Manually sets the user's presence status.
- **`ping(): void`**
  Sends a manual heartbeat ping to the server to prevent being marked as 'away'.
- **`startTyping(roomId: string): void`**
  Broadcasts a typing indicator to the room.
- **`stopTyping(roomId: string): void`**
  Clears the typing indicator.

### Event Listeners

Use these methods to subscribe to real-time events. Each method returns an **unsubscribe function**.

```typescript
const unsubscribe = client.onMessage((msg) => console.log(msg))
// Later...
unsubscribe()
```

#### Message Events
- `onMessage(listener: (message: Message) => void)`
- `onMessageEdited(listener: (data: { messageId, roomId, content, editedAt, editedBy }) => void)`
- `onMessageDeleted(listener: (data: { messageId, roomId, deletedBy }) => void)`
- `onReaction(listener: (data: { messageId, roomId, userId, username, emoji, reactedAt }) => void)`
- `onReadReceipt(listener: (data: { messageId, roomId, readBy, readAt }) => void)`

#### Typing Events
- `onTypingStart(listener: (data: { userId, username, roomId }) => void)`
- `onTypingStop(listener: (data: { userId, username, roomId }) => void)`

#### Presence Events
- `onUserOnline(listener: (data: { id, username }) => void)`
- `onUserOffline(listener: (data: { id, username, lastSeen }) => void)`
- `onUserStatus(listener: (data: { id, username, status, lastSeen }) => void)`

#### Room Events
- `onRoomUserJoined(listener: (data: { roomId, user }) => void)`
- `onRoomUserLeft(listener: (data: { roomId, user }) => void)`
- `onRoomDeleted(listener: (data: { roomId }) => void)`
- `onKickedFromRoom(listener: (data: { roomId, reason }) => void)`

#### Error Events
- `onError(listener: (data: { code: string, message: string }) => void)`

*(Advanced: You can also use `client.on()`, `client.off()`, and `client.once()` for fully-typed generic socket event bindings).*
