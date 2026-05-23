import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, createConnectedClient, type TestServer } from './helpers/setup.js'
import type { ChatClient } from '@ravex/client'
import type { User } from '@ravex/types'

describe('Rate Limiter', () => {
  let server: TestServer
  let clientA: ChatClient
  let roomId: string

  const userA: User = { id: 'user-a', username: 'usera', status: 'online', socketIds: [] }

  beforeEach(async () => {
    // Configure strict rate limits (2 messages per minute)
    server = await createServer({ rateLimit: { maxMessages: 2, windowMs: 60000 } })
    clientA = await createConnectedClient(server.port, userA)
    const room = await clientA.createRoom({ type: 'group', name: 'Rate Room' })
    roomId = room.id
  })

  afterEach(async () => {
    if (clientA) clientA.disconnect()
    await server.close()
  })

  it('should allow messages within the limit', async () => {
    const msg1 = await clientA.sendMessage({ roomId, content: 'Message 1' })
    const msg2 = await clientA.sendMessage({ roomId, content: 'Message 2' })
    
    expect(msg1.content).toBe('Message 1')
    expect(msg2.content).toBe('Message 2')
  })

  it('should reject messages exceeding the limit', async () => {
    await clientA.sendMessage({ roomId, content: 'Message 1' })
    await clientA.sendMessage({ roomId, content: 'Message 2' })
    
    await expect(clientA.sendMessage({ roomId, content: 'Message 3' }))
      .rejects.toThrow('Rate limit exceeded')
  })
})
