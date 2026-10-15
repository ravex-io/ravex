import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import type { ChatClient } from '@ravex/client'
import type { AckResponse, User } from '@ravex/types'
import type { ChatEngineOptions } from '@ravex/server'
import { createServer, createConnectedClient, type TestServer } from './helpers/setup.js'

const probe = fileURLToPath(new URL('./fixtures/malformed-events.mjs', import.meta.url))

/** Runs the probe in a child process, because a crash would kill the whole process. */
function runProbe(arg: string): { alive: boolean; crash: string } {
  const res = spawnSync(process.execPath, [probe, arg], { encoding: 'utf8', timeout: 15000 })
  const crash = res.stderr.split('\n').find((line) => /^\w*Error/u.test(line)) ?? ''
  return { alive: res.stdout.includes('ALIVE'), crash }
}

describe('Robustness: malformed events', () => {
  const events = [
    'message:send', 'message:edit', 'message:delete', 'message:read', 'message:react', 'message:history',
    'typing:start', 'typing:stop',
    'room:join', 'room:leave', 'room:create', 'room:delete', 'room:members', 'room:list',
    'presence:ping', 'presence:status',
  ]

  it.each(events)('does not crash when "%s" is emitted with no payload and no ack', (event) => {
    const { alive, crash } = runProbe(event)
    expect(alive, `server crashed: ${crash}`).toBe(true)
  })

  it('does not crash when every event is fuzzed with invalid arguments', () => {
    const { alive, crash } = runProbe('fuzz')
    expect(alive, `server crashed: ${crash}`).toBe(true)
  })
})

const callbackProbe = fileURLToPath(new URL('./fixtures/callback-errors.mjs', import.meta.url))

describe('Robustness: failing application callbacks', () => {
  const targets = ['onMessage', 'onEdit', 'onDelete', 'onRead', 'onReaction', 'onStatusChange', 'onStatusChange:away']
  const cases = targets.flatMap((target) => [[target, 'async'], [target, 'sync']])

  it.each(cases)('does not crash when %s fails (%s)', (target, mode) => {
    const res = spawnSync(process.execPath, [callbackProbe, target, mode], { encoding: 'utf8', timeout: 15000 })
    const crash = res.stderr.split('\n').find((line) => /^\w*Error/u.test(line)) ?? ''
    expect(res.stdout, 'callback was never called').toContain('CALLED')
    expect(res.stdout, `server crashed: ${crash}`).toContain('ALIVE')
  })
})

describe('Robustness: validation responses', () => {
  let server: TestServer
  let client: ChatClient
  const user: User = { id: 'user-a', username: 'usera', status: 'online', socketIds: [] }

  async function setup(options?: ChatEngineOptions) {
    server = await createServer(options)
    client = await createConnectedClient(server.port, user)
  }

  /** Emits a raw event with an ack and resolves with the server's response. */
  function emitRaw(event: string, ...args: unknown[]): Promise<AckResponse<unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 2000)
      ;(client.rawSocket as unknown as { emit(e: string, ...a: unknown[]): void }).emit(event, ...args, (res: AckResponse<unknown>) => {
        clearTimeout(timer)
        resolve(res)
      })
    })
  }

  beforeEach(async () => {
    await setup()
  })

  afterEach(async () => {
    client.disconnect()
    await server.close()
  })

  it.each([
    ['nothing', []],
    ['null', [null]],
    ['a number', [42]],
    ['a string', ['room-1']],
    ['an array', [['room-1']]],
  ])('answers VALIDATION_ERROR when the payload is %s', async (_label, args) => {
    const res = await emitRaw('room:join', ...args)
    expect(res).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid payload for "room:join": expected an object' },
    })
  })

  it('validates every event that takes a payload and an ack', async () => {
    const ackEvents = [
      'message:send', 'message:edit', 'message:delete', 'message:react', 'message:history',
      'room:join', 'room:leave', 'room:create', 'room:delete', 'room:members',
    ]
    for (const event of ackEvents) {
      const res = await emitRaw(event, null)
      expect(res.ok, event).toBe(false)
      if (!res.ok) expect(res.error.code, event).toBe('VALIDATION_ERROR')
    }
  })

  it('still answers valid requests and ignores extra arguments', async () => {
    const created = await emitRaw('room:create', { type: 'group', name: 'Ok' }, 'extra', 123)
    expect(created.ok).toBe(true)
    const list = await emitRaw('room:list', 'junk')
    expect(list.ok).toBe(true)
  })

  it('keeps errors inside handlers as normal error responses', async () => {
    const res = await emitRaw('room:create', { type: 'group', members: 5 })
    expect(res.ok).toBe(false)
    expect(server.engine.getUser(user.id)).toBeDefined()
  })

  it('survives a user callback that throws', async () => {
    client.disconnect()
    await server.close()
    await setup({
      onRead: () => {
        throw new Error('boom from onRead')
      },
      onStatusChange: () => {
        throw new Error('boom from onStatusChange')
      },
    })
    const room = await client.createRoom({ type: 'group' })
    client.markAsRead('some-message', room.id)
    client.setStatus('busy')
    // The server must still answer afterwards.
    await expect(client.listRooms()).resolves.toHaveLength(1)
  })
})
