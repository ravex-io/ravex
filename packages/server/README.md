# @ravex/server

![Ravex Server](../../assets/ravex-server.webp)

The core engine for the Ravex real-time chat system. Built on `socket.io`, it handles bidirectional messaging, presence tracking, typing indicators, room management, and robust rate limiting.

## Installation

```bash
npm install @ravex/server
# or
pnpm add @ravex/server
# or
yarn add @ravex/server
```

## Quick Start

You can attach the `ChatEngine` to any standard Node.js `http` server.

```typescript
import { createServer } from 'http'
import { ChatEngine } from '@ravex/server'

// 1. Create an HTTP Server
const httpServer = createServer()

// 2. Initialize the ChatEngine
const engine = new ChatEngine(httpServer, {
  // CORS configuration for Socket.IO
  socket: {
    cors: { origin: '*' }
  },
  // Customize built-in handlers
  message: {
    allowEdits: true,
    allowDeletes: true,
    maxMessageLength: 5000
  },
  rateLimit: {
    maxMessages: 60,
    windowMs: 60000
  }
})

// 3. Listen on a port
httpServer.listen(3000, () => {
  console.log('Chat server running on port 3000')
})
```

## Framework Integrations

`ChatEngine` can be seamlessly attached to the underlying HTTP server of any popular Node.js framework.

### Express
```typescript
import express from 'express'
import { createServer } from 'http'
import { ChatEngine } from '@ravex/server'

const app = express()
const httpServer = createServer(app)

const engine = new ChatEngine(httpServer)

httpServer.listen(3000, () => {
  console.log('Express + Ravex running on port 3000')
})
```

### Koa
```typescript
import Koa from 'koa'
import { createServer } from 'http'
import { ChatEngine } from '@ravex/server'

const app = new Koa()
const httpServer = createServer(app.callback())

const engine = new ChatEngine(httpServer)

httpServer.listen(3000, () => {
  console.log('Koa + Ravex running on port 3000')
})
```

### Fastify
```typescript
import Fastify from 'fastify'
import { ChatEngine } from '@ravex/server'

const fastify = Fastify()

// Fastify exposes its underlying Node.js HTTP server natively
const engine = new ChatEngine(fastify.server)

fastify.listen({ port: 3000 }, () => {
  console.log('Fastify + Ravex running on port 3000')
})
```

### Hono (Node.js Adapter)
```typescript
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { ChatEngine } from '@ravex/server'
import type { Server } from 'http'

const app = new Hono()

const server = serve({
  fetch: app.fetch,
  port: 3000
}, (info) => {
  console.log(`Hono + Ravex running on port ${info.port}`)
})

// Pass the returned server instance to ChatEngine
const engine = new ChatEngine(server as Server)
```

### NestJS
```typescript
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { ChatEngine } from '@ravex/server'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  
  // Extract the underlying HTTP server from the Nest application
  const httpServer = app.getHttpServer()
  
  const engine = new ChatEngine(httpServer)
  
  await app.listen(3000)
  console.log('NestJS + Ravex running on port 3000')
}
bootstrap()
```

## API Reference

### `new ChatEngine(server, options?)`

Initializes the chat backend.

**Parameters:**
- `server` (`http.Server` | `https.Server` | `http2.server` | `number` | `socket.io.Server`): The HTTP server instance to bind to, a port number, or a pre-existing Socket.IO instance.
- `options` (`ChatEngineOptions`): Configuration options.

#### `ChatEngineOptions`

All properties are optional.

- **`namespace`**: The Socket.IO namespace to bind to (default: `'/'`).
- **`socket`**: Socket.IO server options (e.g., `cors`, `transports`).
- **`persistence`**: A custom adapter implementing `PersistenceAdapter` to save/load messages from a database.
- **`messageMiddleware`**: Array of middleware functions to run before sending a message.
- **`message`**: Configuration for messaging behavior:
  - `allowEdits` (boolean)
  - `allowDeletes` (boolean)
  - `maxMessageLength` (number)
- **`typing`**: Configuration for typing indicators:
  - `typingTimeout` (number)
  - `typingThrottle` (number)
- **`presence`**: Configuration for presence/heartbeat:
  - `awayTimeout` (number)
  - `heartbeat` (boolean)
  - `heartbeatInterval` (number)
- **`rateLimit`**: Configuration for message rate limiting:
  - `maxMessages` (number)
  - `windowMs` (number)
- **Event Hooks**:
  - `onMessage`: `(message: Message) => void`
  - `onEdit`: `(message: Message, previousContent: string) => void`
  - `onDelete`: `(message: Message) => void`
  - `onRead`: `(userId: string, messageId: string, roomId: string) => void`
  - `onReaction`: `(reaction: ReactPayload, message: Message) => void`
  - `onStatusChange`: `(userId: string, previousStatus: UserStatus) => void`

### Engine Methods

You can programmatically interact with the engine from the server-side:

- **`engine.createRoom(options: CreateRoomOptions): Room`**
  Creates a room and automatically connects active members' sockets.
- **`engine.getRoom(roomId: string): Room | undefined`**
  Gets room data.
- **`engine.getUser(userId: string): User | undefined`**
  Gets user data and connection state.
- **`engine.kickUser(roomId: string, userId: string, reason?: string): void`**
  Forces a user out of a room and disconnects their sockets from that room.
- **`engine.io: Server`**
  Provides direct access to the underlying Socket.IO server instance.
- **`engine.destroy(): void`**
  Cleans up rate limiters and presence handlers.

## Implementing Persistence

By default, the engine holds state in memory but **does not persist messages**. To store chat history in a database (e.g., PostgreSQL, MongoDB), pass a `persistence` adapter:

```typescript
const myDbAdapter = {
  async saveMessage(message) { /* db insert */ },
  async getMessages(roomId, limit, before) { /* db select */ return [] },
  async updateMessage(messageId, updates) { /* db update */ },
  async deleteMessage(messageId) { /* db delete */ }
}

const engine = new ChatEngine(httpServer, { persistence: myDbAdapter })
```

## Authentication

Authentication is handled natively by the engine via handshake. Clients must pass their `User` object during connection:

```typescript
// On the client
const client = new ChatClient({ auth: { user: { id: '1', username: 'john' } } })
```

If the `auth.user` payload is missing or invalid, the server will immediately reject the socket connection.
