import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { ChatClient } from '@ravex/client'
import { ChatEngine, type Authenticate, type ChatEngineOptions } from '@ravex/server'
import { createServer as createHttpServer } from 'http'
import type { AddressInfo } from 'net'
import { createServer, type TestServer } from './helpers/setup.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The socket.io Server class, taken from a ChatEngine so this package doesn't need socket.io as a dependency. */
const IoServer = (() => {
  const engine = new ChatEngine(createHttpServer(), { authenticate: () => null })
  engine.destroy()
  return engine.io.constructor as new (
    srv: ReturnType<typeof createHttpServer>,
    opts?: ChatEngineOptions['socket'],
  ) => ChatEngine['io']
})()

const warningsFixture = fileURLToPath(new URL('./fixtures/auth-warnings.mjs', import.meta.url))

let server: TestServer
const clients: ChatClient[] = []

let running = false

async function start(options: ChatEngineOptions = {}) {
  server = await createServer(options)
  running = true
}

/** Connects with a raw `auth` payload. Resolves with the client, or rejects with the connect_error. */
function connectWith(auth: Record<string, unknown>): Promise<ChatClient> {
  const client = new ChatClient({ url: `http://localhost:${server.port}`, auth, autoConnect: false })
  clients.push(client)
  return new Promise((resolve, reject) => {
    client.rawSocket.on('connect', () => resolve(client))
    client.rawSocket.on('connect_error', (err) => reject(err))
    client.connect()
  })
}

afterEach(async () => {
  clients.splice(0).forEach((c) => c.disconnect())
  if (running) await server.close()
  running = false
})

/** Runs the warning fixture in a fresh process and returns its stderr. */
function startupWarnings(options: Record<string, unknown>): string {
  return spawnSync(process.execPath, [warningsFixture, JSON.stringify(options)], { encoding: 'utf8', timeout: 10000 }).stderr
}
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

describe('Without authenticate (secure default)', () => {
  it('rejects every connection, even with a well-formed auth.user', async () => {
    await start({ insecureTrustClientUser: false })
    await expect(connectWith({ user: { id: 'alice', username: 'alice' } })).rejects.toThrow('Authentication failed')
    expect(server.engine.getUser('alice')).toBeUndefined()
  })

  it('reproduces the issue scenario: the impersonator cannot connect at all', async () => {
    await start({ insecureTrustClientUser: false })
    await expect(connectWith({ user: { id: 'alice', username: 'alice' } })).rejects.toThrow('Authentication failed')
    await expect(connectWith({ user: { id: 'admin', username: 'admin' }, token: 'anything' })).rejects.toThrow('Authentication failed')
  })

  it('warns once at startup that all connections will be rejected', () => {
    const stderr = startupWarnings({})
    expect(count(stderr, 'No `authenticate` option set: every connection will be rejected')).toBe(1)
  })

  it('does not warn when authenticate is set', () => {
    const stderr = startupWarnings({ authenticate: true })
    expect(stderr).not.toContain('authenticate')
  })
})

describe('With insecureTrustClientUser: true (development only)', () => {
  it('warns once at startup that clients are trusted', () => {
    const stderr = startupWarnings({ insecureTrustClientUser: true })
    expect(count(stderr, '`insecureTrustClientUser` is enabled')).toBe(1)
  })

  it('accepts the user object from auth.user', async () => {
    await start({ insecureTrustClientUser: true })
    const client = await connectWith({ user: { id: 'alice', username: 'Alice' } })
    const msgRoom = await client.createRoom({ type: 'group' })
    const msg = await client.sendMessage({ roomId: msgRoom.id, content: 'hi' })
    expect(msg.senderId).toBe('alice')
    expect(server.engine.getUser('alice')?.username).toBe('Alice')
  })

  it.each([
    ['missing user', {}],
    ['no id', { user: { username: 'x' } }],
    ['empty id', { user: { id: '', username: 'x' } }],
    ['blank id', { user: { id: '   ', username: 'x' } }],
    ['numeric id', { user: { id: 42, username: 'x' } }],
    ['object id', { user: { id: { $ne: null }, username: 'x' } }],
    ['user is a string', { user: 'alice' }],
  ])('rejects %s', async (_label, auth) => {
    await start({ insecureTrustClientUser: true })
    await expect(connectWith(auth)).rejects.toThrow('Authentication failed')
  })

  it('ignores server-managed fields sent by the client', async () => {
    await start({ insecureTrustClientUser: true })
    await connectWith({
      user: { id: 'alice', username: 'alice', status: 'superadmin', socketIds: ['fake-socket'], lastSeen: 'never', extra: 'x' },
    })
    const stored = server.engine.getUser('alice')
    expect(stored?.status).toBe('online')
    expect(stored?.socketIds).toHaveLength(1)
    expect(stored?.socketIds).not.toContain('fake-socket')
    expect(stored).not.toHaveProperty('extra')
  })

  it('defaults username to the id', async () => {
    await start({ insecureTrustClientUser: true })
    await connectWith({ user: { id: 'alice' } })
    expect(server.engine.getUser('alice')?.username).toBe('alice')
  })
})

describe('With authenticate', () => {
  const tokens: Record<string, { id: string; username: string }> = {
    'token-alice': { id: 'alice', username: 'Alice' },
    'token-bob': { id: 'bob', username: 'Bob' },
  }
  const byToken: Authenticate = (handshake) => tokens[String((handshake.auth as { token?: unknown }).token)]

  it('connects as the user the server resolves from the token', async () => {
    await start({ authenticate: byToken })
    const alice = await connectWith({ token: 'token-alice' })
    const room = await alice.createRoom({ type: 'group' })
    const msg = await alice.sendMessage({ roomId: room.id, content: 'hi' })
    expect(msg).toMatchObject({ senderId: 'alice', senderName: 'Alice' })
  })

  it('rejects an invalid or missing token', async () => {
    await start({ authenticate: byToken })
    await expect(connectWith({ token: 'forged' })).rejects.toThrow('Authentication failed')
    await expect(connectWith({})).rejects.toThrow('Authentication failed')
  })

  it('ignores a client-provided auth.user, even with insecureTrustClientUser set', async () => {
    await start({ authenticate: byToken, insecureTrustClientUser: true })
    await expect(connectWith({ user: { id: 'alice', username: 'alice' } })).rejects.toThrow('Authentication failed')
  })

  it('stops the impersonation from the issue: claiming to be alice with bob\'s token', async () => {
    await start({ authenticate: byToken })
    const alice = await connectWith({ token: 'token-alice' })
    const room = await alice.createRoom({ type: 'group' })

    const fake = await connectWith({ token: 'token-bob', user: { id: 'alice', username: 'alice' } })
    expect(await fake.listRooms()).toEqual([])
    await expect(fake.deleteRoom(room.id)).rejects.toThrow('Admin only')
    expect(server.engine.getRoom(room.id)).toBeDefined()
    const created = await fake.createRoom({ type: 'group' })
    expect(created.createdBy).toBe('bob')
  })

  it('supports an async authenticate', async () => {
    await start({
      authenticate: async (handshake) => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return byToken(handshake)
      },
    })
    await expect(connectWith({ token: 'token-bob' })).resolves.toBeTruthy()
    expect(server.engine.getUser('bob')).toBeDefined()
  })

  it('rejects without leaking the error when authenticate throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await start({
      authenticate: () => {
        throw new Error('db password is hunter2')
      },
    })
    const err = await connectWith({ token: 'token-alice' }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('Authentication failed')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('rejects when an async authenticate rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await start({ authenticate: () => Promise.reject(new Error('token service down')) })
    await expect(connectWith({ token: 'token-alice' })).rejects.toThrow('Authentication failed')
    warn.mockRestore()
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['no id', { username: 'x' }],
    ['empty id', { id: '' }],
  ])('rejects when authenticate returns %s', async (_label, result) => {
    await start({ authenticate: () => result as never })
    await expect(connectWith({ token: 'token-alice' })).rejects.toThrow('Authentication failed')
  })

  it('receives the full handshake (auth, headers, address)', async () => {
    let seen: { auth: unknown; hasHeaders: boolean; address: string } | undefined
    await start({
      authenticate: (handshake) => {
        seen = { auth: handshake.auth, hasHeaders: typeof handshake.headers === 'object', address: handshake.address }
        return { id: 'alice' }
      },
    })
    await connectWith({ token: 'abc' })
    expect(seen).toMatchObject({ auth: { token: 'abc' }, hasHeaders: true })
    expect(seen?.address).toBeTruthy()
  })

  it('does not run any event handler for a rejected connection', async () => {
    await start({ authenticate: byToken })
    await connectWith({ token: 'nope' }).catch(() => {})
    expect(server.engine.getUser('nope')).toBeUndefined()
    expect(server.engine.getUser('undefined')).toBeUndefined()
  })
})

describe('Connection state recovery', () => {
  // Token -> user. Tests revoke or remap tokens while a client is disconnected.
  let tokens: Record<string, { id: string; username: string }>
  let authCalls: number
  const authenticate: Authenticate = (handshake) => {
    authCalls++
    return tokens[String((handshake.auth as { token?: unknown }).token)]
  }
  const recoveryOptions = (): ChatEngineOptions => ({
    authenticate,
    socket: { connectionStateRecovery: { maxDisconnectionDuration: 60_000 } },
  })

  /** Event names of every EVENT packet the client receives on the wire, even before it is connected. */
  function wireEvents(client: ChatClient): string[] {
    const seen: string[] = []
    client.rawSocket.io.on('packet', (packet: { type: number; data?: unknown[] }) => {
      if (packet.type === 2 && Array.isArray(packet.data)) seen.push(String(packet.data[0]))
    })
    return seen
  }

  /** Drops alice's transport (no auto-reconnect) and waits until the server has noticed. */
  async function dropConnection(client: ChatClient, userId: string) {
    client.rawSocket.io.reconnection(false)
    client.rawSocket.io.engine.close()
    for (let i = 0; i < 50 && server.engine.getUser(userId)?.socketIds.length; i++) await sleep(10)
  }

  /** Reconnects with the same session; resolves 'connected' or the connect_error message. */
  function reconnect(client: ChatClient): Promise<string> {
    return new Promise((resolve) => {
      client.rawSocket.once('connect', () => resolve('connected'))
      client.rawSocket.once('connect_error', (err) => resolve(err.message))
      client.connect()
    })
  }

  async function setup(options: ChatEngineOptions = recoveryOptions()) {
    tokens = {
      'token-alice': { id: 'alice', username: 'alice' },
      'token-bob': { id: 'bob', username: 'bob' },
    }
    authCalls = 0
    await start(options)
    const alice = await connectWith({ token: 'token-alice' })
    const bob = await connectWith({ token: 'token-bob' })
    const room = await alice.createRoom({ type: 'group', members: ['bob'] })
    return { alice, bob, roomId: room.id }
  }

  it('re-authenticates a recovered connection and rejects a revoked token', async () => {
    const { alice, bob, roomId } = await setup()
    const onWire = wireEvents(alice)
    await dropConnection(alice, 'alice')
    await bob.sendMessage({ roomId, content: 'sent while alice was away' })
    delete tokens['token-alice']

    expect(await reconnect(alice)).toBe('Authentication failed')
    expect(authCalls).toBe(3) // alice, bob, alice again
    expect(onWire).not.toContain('message:new') // missed messages are not replayed to a rejected client
    expect(server.engine.getRoom(roomId)).toBeDefined()
  })

  it('recovers a still-valid session and replays the messages it missed', async () => {
    const { alice, bob, roomId } = await setup()
    await dropConnection(alice, 'alice')
    await bob.sendMessage({ roomId, content: 'missed' })
    const received: string[] = []
    alice.onMessage((m) => received.push(m.content))

    expect(await reconnect(alice)).toBe('connected')
    expect(alice.rawSocket.recovered).toBe(true)
    expect(authCalls).toBe(3)
    await sleep(100)
    expect(received).toEqual(['missed'])
    await expect(alice.deleteRoom(roomId)).resolves.toBeUndefined()
  })

  it('does not restore rooms the user was removed from while disconnected', async () => {
    const { alice, bob, roomId } = await setup()
    const room2 = await bob.createRoom({ type: 'group', members: ['alice'] })
    await dropConnection(alice, 'alice')
    server.engine.kickUser(room2.id, 'alice')
    await bob.sendMessage({ roomId: room2.id, content: 'after the kick' })
    await bob.sendMessage({ roomId, content: 'still a member here' })
    const received: string[] = []
    alice.onMessage((m) => received.push(m.content))

    expect(await reconnect(alice)).toBe('connected')
    await bob.sendMessage({ roomId: room2.id, content: 'after recovery' })
    await sleep(100)
    expect(received).toEqual(['still a member here'])
  })

  it('treats a recovered session whose token now belongs to another user as a fresh connection', async () => {
    const { alice, bob, roomId } = await setup()
    await dropConnection(alice, 'alice')
    await bob.sendMessage({ roomId, content: 'missed by alice' })
    tokens['token-alice'] = { id: 'mallory', username: 'mallory' }
    const onWire = wireEvents(alice)

    expect(await reconnect(alice)).toBe('connected')
    await bob.sendMessage({ roomId, content: 'after recovery' })
    await sleep(100)
    expect(onWire).not.toContain('message:new') // neither alice's missed messages nor her rooms carry over
    expect(await alice.listRooms()).toEqual([])
    await expect(alice.deleteRoom(roomId)).rejects.toThrow('Admin only')
  })

  it('also re-authenticates when an existing socket.io Server with recovery is supplied', async () => {
    // An app-provided Server keeps socket.io's default skipMiddlewares: true.
    const http = createHttpServer()
    const io = new IoServer(http, { connectionStateRecovery: {} })
    tokens = { 'token-alice': { id: 'alice', username: 'alice' } }
    authCalls = 0
    const engine = new ChatEngine(io, { authenticate })
    await new Promise<void>((resolve) => http.listen(0, () => resolve()))
    const alice = new ChatClient({ url: `http://localhost:${(http.address() as AddressInfo).port}`, auth: { token: 'token-alice' } })
    clients.push(alice)
    await new Promise<void>((resolve) => alice.rawSocket.on('connect', () => resolve()))
    const room = await alice.createRoom({ type: 'group' })

    alice.rawSocket.io.reconnection(false)
    alice.rawSocket.io.engine.close()
    for (let i = 0; i < 50 && engine.getUser('alice')?.socketIds.length; i++) await sleep(10)
    delete tokens['token-alice']

    expect(await reconnect(alice)).toBe('Authentication failed')
    expect(authCalls).toBe(2)
    expect(engine.getRoom(room.id)).toBeDefined()
    engine.destroy()
    io.close()
  })
})
