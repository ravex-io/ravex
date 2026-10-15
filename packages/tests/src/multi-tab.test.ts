import { describe, it, expect, afterEach } from 'vitest'
import type { ChatClient } from '@ravex/client'
import type { ChatEngineOptions } from '@ravex/server'
import type { Message, User } from '@ravex/types'
import { createServer, createConnectedClient, type TestServer } from './helpers/setup.js'

const mkUser = (id: string): User => ({ id, username: id, status: 'online', socketIds: [] })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let server: TestServer
const clients: ChatClient[] = []

async function start(options: ChatEngineOptions = {}) {
  server = await createServer(options)
}
async function connect(id: string) {
  const client = await createConnectedClient(server.port, mkUser(id))
  clients.push(client)
  return client
}
function messagesIn(client: ChatClient, roomId: string) {
  const got: Message[] = []
  client.onMessage((m) => m.roomId === roomId && got.push(m))
  return got
}

afterEach(async () => {
  clients.splice(0).forEach((c) => c.disconnect())
  await server.close()
})

describe('Multi-tab room membership', () => {
  it('joining from one tab subscribes all of the user\'s tabs', async () => {
    await start()
    const alice = await connect('alice')
    const bobTab1 = await connect('bob')
    const bobTab2 = await connect('bob')
    const room = await alice.createRoom({ type: 'group' })
    await bobTab1.joinRoom(room.id)
    const tab1 = messagesIn(bobTab1, room.id)
    const tab2 = messagesIn(bobTab2, room.id)
    await alice.sendMessage({ roomId: room.id, content: 'hi bob' })
    await sleep(100)
    expect(tab1).toHaveLength(1)
    expect(tab2).toHaveLength(1)
  })

  it('leaving from one tab unsubscribes all of the user\'s tabs', async () => {
    await start()
    const alice = await connect('alice')
    const bobTab1 = await connect('bob')
    const room = await alice.createRoom({ type: 'group', members: ['bob'] })
    const bobTab2 = await connect('bob')
    await bobTab1.leaveRoom(room.id)
    const tab2 = messagesIn(bobTab2, room.id)
    await alice.sendMessage({ roomId: room.id, content: 'bob left' })
    await sleep(100)
    expect(tab2).toHaveLength(0)
    await expect(bobTab2.sendMessage({ roomId: room.id, content: 'still here?' })).rejects.toThrow()
  })

  it('does not subscribe or unsubscribe other users', async () => {
    await start()
    const alice = await connect('alice')
    const bob = await connect('bob')
    const carol = await connect('carol')
    const room = await alice.createRoom({ type: 'group', members: ['carol'] })
    await bob.joinRoom(room.id)
    await bob.leaveRoom(room.id)
    const carolGot = messagesIn(carol, room.id)
    const bobGot = messagesIn(bob, room.id)
    await alice.sendMessage({ roomId: room.id, content: 'for carol' })
    await sleep(100)
    expect(carolGot).toHaveLength(1)
    expect(bobGot).toHaveLength(0)
  })

  it('a tab opened later is subscribed to the user\'s rooms', async () => {
    await start()
    const alice = await connect('alice')
    const bob = await connect('bob')
    const room = await alice.createRoom({ type: 'group' })
    await bob.joinRoom(room.id)
    const bobLater = await connect('bob')
    const got = messagesIn(bobLater, room.id)
    await alice.sendMessage({ roomId: room.id, content: 'new tab' })
    await sleep(100)
    expect(got).toHaveLength(1)
  })
})

describe('Presence status on disconnect', () => {
  it('marks a user offline when their last tab disconnects', async () => {
    await start()
    const alice = await connect('alice')
    const bob = await connect('bob')
    const room = await alice.createRoom({ type: 'group', members: ['bob'] })
    bob.disconnect()
    await sleep(100)
    const members = await alice.getRoomMembers(room.id)
    expect(members.find((m) => m.id === 'bob')?.status).toBe('offline')
    expect(server.engine.getUser('bob')?.status).toBe('offline')
    expect(server.engine.getUser('bob')?.lastSeen).toBeInstanceOf(Date)
  })

  it('keeps a user online while another tab is still open', async () => {
    await start()
    await connect('alice')
    const bobTab1 = await connect('bob')
    await connect('bob')
    bobTab1.disconnect()
    await sleep(100)
    expect(server.engine.getUser('bob')?.status).toBe('online')
  })

  it('marks a user online again when they reconnect', async () => {
    await start()
    const alice = await connect('alice')
    const bob = await connect('bob')
    const room = await alice.createRoom({ type: 'group', members: ['bob'] })
    bob.disconnect()
    await sleep(100)
    const online: string[] = []
    alice.onUserOnline((u) => online.push(u.id))
    await connect('bob')
    await sleep(50)
    const members = await alice.getRoomMembers(room.id)
    expect(members.find((m) => m.id === 'bob')?.status).toBe('online')
    expect(online).toContain('bob')
  })
})

describe('Presence status hook on disconnect/reconnect', () => {
  /** Records every onStatusChange call as [userId, previous status, status now stored]. */
  function startWithHook() {
    const calls: [string, string, string | undefined][] = []
    return start({
      onStatusChange: (userId, previous) => {
        calls.push([userId, previous, server.engine.getUser(userId)?.status])
      },
    }).then(() => calls)
  }

  it('invokes onStatusChange for busy → offline → online', async () => {
    const calls = await startWithHook()
    const alice = await connect('alice')
    const bob = await connect('bob')
    bob.setStatus('busy')
    await sleep(50)
    bob.disconnect()
    await sleep(100)
    await connect('bob')
    await sleep(50)
    expect(calls.filter(([id]) => id === 'bob')).toEqual([
      ['bob', 'online', 'busy'],
      ['bob', 'busy', 'offline'],
      ['bob', 'offline', 'online'],
    ])
    expect(alice.isConnected).toBe(true)
  })

  it('broadcasts user:status for the offline and online transitions too', async () => {
    await startWithHook()
    const alice = await connect('alice')
    const bob = await connect('bob')
    const statuses: string[] = []
    alice.onUserStatus((s) => s.id === 'bob' && statuses.push(s.status))
    bob.setStatus('busy')
    await sleep(50)
    bob.disconnect()
    await sleep(100)
    await connect('bob')
    await sleep(50)
    expect(statuses).toEqual(['busy', 'offline', 'online'])
  })

  it('does not invoke onStatusChange when a tab closes but another stays open', async () => {
    const calls = await startWithHook()
    const bobTab1 = await connect('bob')
    await connect('bob')
    bobTab1.disconnect()
    await sleep(100)
    expect(calls).toEqual([])
  })

  it('does not invoke onStatusChange for a user\'s first connection', async () => {
    const calls = await startWithHook()
    await connect('bob')
    await sleep(50)
    expect(calls).toEqual([])
  })
})

describe('Rate limiter quota', () => {
  it('does not count rejected attempts, so a user is unblocked after the window', async () => {
    await start({ rateLimit: { maxMessages: 2, windowMs: 400 } })
    const alice = await connect('alice')
    const room = await alice.createRoom({ type: 'group' })
    await alice.sendMessage({ roomId: room.id, content: '1' })
    await alice.sendMessage({ roomId: room.id, content: '2' })
    await sleep(200)
    for (let i = 0; i < 5; i++) {
      await expect(alice.sendMessage({ roomId: room.id, content: 'spam' })).rejects.toThrow('Rate limit exceeded')
    }
    await sleep(250) // the two accepted messages are now outside the window
    await expect(alice.sendMessage({ roomId: room.id, content: 'ok again' })).resolves.toBeTruthy()
  })

  it('still allows exactly maxMessages per window', async () => {
    await start({ rateLimit: { maxMessages: 3, windowMs: 60_000 } })
    const alice = await connect('alice')
    const room = await alice.createRoom({ type: 'group' })
    for (let i = 0; i < 3; i++) await alice.sendMessage({ roomId: room.id, content: `${i}` })
    await expect(alice.sendMessage({ roomId: room.id, content: '4th' })).rejects.toThrow('Rate limit exceeded')
  })

  it('does not use up quota while the user is muted', async () => {
    await start({ rateLimit: { maxMessages: 2, windowMs: 60_000 } })
    const alice = await connect('alice')
    const room = await alice.createRoom({ type: 'group' })
    // There is no public mute API yet, so reach the engine's rate limiter directly.
    const limiter = (server.engine as unknown as { rateLimiter: { mute(u: string, r: string, ms: number): void } }).rateLimiter
    limiter.mute('alice', room.id, 150)
    for (let i = 0; i < 3; i++) {
      await expect(alice.sendMessage({ roomId: room.id, content: 'muted' })).rejects.toThrow('You are muted in this room')
    }
    await sleep(200)
    await expect(alice.sendMessage({ roomId: room.id, content: '1' })).resolves.toBeTruthy()
    await expect(alice.sendMessage({ roomId: room.id, content: '2' })).resolves.toBeTruthy()
  })
})
