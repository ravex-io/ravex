import { describe, it, expect, afterEach } from 'vitest'
import { ChatClient, type ChatClientOptions } from '@ravex/client'
import type { ChatEngineOptions, PersistenceAdapter } from '@ravex/server'
import type { Message, User } from '@ravex/types'
import { createServer, createConnectedClient, type TestServer } from './helpers/setup.js'

const mkUser = (id: string): User => ({ id, username: id, status: 'online', socketIds: [] })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let server: TestServer
const clients: ChatClient[] = []

async function start(options: ChatEngineOptions = {}) {
  server = await createServer(options)
}
async function connect(id: string, options?: Partial<ChatClientOptions>) {
  const client = await createConnectedClient(server.port, mkUser(id), options)
  clients.push(client)
  return client
}
/** Creates a client with the given options; resolves on connect, rejects on connect_error or after 2s. */
function connectRaw(options: ChatClientOptions): Promise<ChatClient> {
  const client = new ChatClient({ url: `http://localhost:${server.port}`, ...options })
  clients.push(client)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('never connected')), 2000)
    client.on('connect', () => { clearTimeout(timer); resolve(client) })
    client.on('connect_error', (err) => { clearTimeout(timer); reject(err) })
  })
}

afterEach(async () => {
  clients.splice(0).forEach((c) => c.disconnect())
  await server.close()
})

describe('Client auth as a function', () => {
  it('connects with a sync auth function', async () => {
    await start()
    await expect(connectRaw({ auth: () => ({ user: mkUser('alice') }) })).resolves.toBeTruthy()
    expect(server.engine.getUser('alice')).toBeDefined()
  })

  it('connects with an async auth function', async () => {
    await start()
    const auth = async () => {
      await sleep(50)
      return { user: mkUser('bob') }
    }
    await expect(connectRaw({ auth })).resolves.toBeTruthy()
    expect(server.engine.getUser('bob')).toBeDefined()
  })

  it('fails with connect_error (instead of hanging) when the auth function throws', async () => {
    await start()
    const auth = () => {
      throw new Error('no token')
    }
    await expect(connectRaw({ auth })).rejects.toThrow('Authentication failed')
  })

  it('fails with connect_error when the auth function rejects', async () => {
    await start()
    await expect(connectRaw({ auth: () => Promise.reject(new Error('refresh failed')) })).rejects.toThrow('Authentication failed')
  })

  it('calls the auth function again on reconnect (e.g. to refresh a token)', async () => {
    await start()
    let calls = 0
    const client = await connectRaw({
      auth: () => {
        calls++
        return { user: mkUser('alice') }
      },
    })
    const reconnected = new Promise<void>((resolve) => client.rawSocket.io.once('reconnect', () => resolve()))
    client.rawSocket.io.engine.close() // simulate a dropped connection
    await reconnected
    expect(calls).toBe(2)
  })
})

describe('Client date fields', () => {
  function memoryStore(): PersistenceAdapter {
    const messages: Message[] = []
    return {
      async saveMessage(m) { messages.push(JSON.parse(JSON.stringify(m))) }, // stored like a real DB: as strings
      async getMessages(roomId) { return messages.filter((m) => m.roomId === roomId) },
      async updateMessage() {},
      async deleteMessage() {},
    }
  }

  it('turns date strings into Date objects in events', async () => {
    await start({ message: { allowEdits: true } })
    const alice = await connect('alice')
    const bob = await connect('bob')
    const room = await alice.createRoom({ type: 'group', members: ['bob'] })

    const received: Record<string, unknown> = {}
    bob.onMessage((m) => { received.createdAt = m.createdAt })
    bob.onMessageEdited((e) => { received.editedAt = e.editedAt })
    bob.onReaction((e) => { received.reactedAt = e.reactedAt })
    alice.onReadReceipt((e) => { received.readAt = e.readAt })
    alice.onUserStatus((e) => { received.statusLastSeen = e.lastSeen })
    alice.onUserOffline((e) => { received.offlineLastSeen = e.lastSeen })

    const msg = await alice.sendMessage({ roomId: room.id, content: 'hi' })
    await alice.editMessage({ messageId: msg.id, roomId: room.id, content: 'edited' })
    await alice.sendReaction(msg.id, room.id, '👍')
    bob.markAsRead(msg.id, room.id)
    bob.setStatus('busy')
    await sleep(100)
    bob.disconnect()
    await sleep(100)

    for (const key of ['createdAt', 'editedAt', 'reactedAt', 'readAt', 'statusLastSeen', 'offlineLastSeen']) {
      expect(received[key], key).toBeInstanceOf(Date)
    }
    expect((received.createdAt as Date).getTime()).toBe(new Date(msg.createdAt).getTime())
  })

  it('turns date strings into Date objects in request results', async () => {
    await start({ persistence: memoryStore() })
    const alice = await connect('alice')
    const room = await alice.createRoom({ type: 'group' })
    expect(room.createdAt).toBeInstanceOf(Date)
    expect((await alice.listRooms())[0].createdAt).toBeInstanceOf(Date)

    const msg = await alice.sendMessage({ roomId: room.id, content: 'hi' })
    expect(msg.createdAt).toBeInstanceOf(Date)
    expect(msg.createdAt.getTime()).not.toBeNaN()

    const history = await alice.getHistory(room.id)
    expect(history[0].createdAt).toBeInstanceOf(Date)
  })

  it('leaves metadata untouched', async () => {
    await start()
    const alice = await connect('alice')
    const room = await alice.createRoom({ type: 'group' })
    const msg = await alice.sendMessage({ roomId: room.id, content: 'hi', metadata: { createdAt: '2020-01-01T00:00:00.000Z' } })
    expect(msg.metadata?.createdAt).toBe('2020-01-01T00:00:00.000Z')
  })
})

describe('Client request timeout', () => {
  // A middleware that never calls next(), so message:send is never acknowledged.
  const neverAnswers: ChatEngineOptions = { messageMiddleware: [() => {}] }

  it('rejects a request the server never answers', async () => {
    await start(neverAnswers)
    const alice = await connect('alice', { requestTimeout: 200 })
    const room = await alice.createRoom({ type: 'group' })
    const started = Date.now()
    await expect(alice.sendMessage({ roomId: room.id, content: 'lost' })).rejects.toThrow('Request "message:send" timed out after 200ms')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('times out requests made while disconnected', async () => {
    await start()
    const alice = await connect('alice', { requestTimeout: 200 })
    alice.disconnect()
    await expect(alice.listRooms()).rejects.toThrow('timed out after 200ms')
  })

  it('can be disabled with requestTimeout: 0', async () => {
    await start(neverAnswers)
    const alice = await connect('alice', { requestTimeout: 0 })
    const room = await alice.createRoom({ type: 'group' })
    const result = await Promise.race([
      alice.sendMessage({ roomId: room.id, content: 'waits' }).then(() => 'answered', () => 'rejected'),
      sleep(400).then(() => 'still pending'),
    ])
    expect(result).toBe('still pending')
  })

  it('does not affect requests the server answers', async () => {
    await start()
    const alice = await connect('alice', { requestTimeout: 200 })
    const room = await alice.createRoom({ type: 'group' })
    await expect(alice.sendMessage({ roomId: room.id, content: 'fine' })).resolves.toMatchObject({ content: 'fine' })
    await expect(alice.joinRoom('missing')).rejects.toThrow('Room not found')
  })
})
