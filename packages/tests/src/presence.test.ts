import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, createConnectedClient, type TestServer } from './helpers/setup.js'
import type { ChatClient } from '@ravex/client'
import type { User } from '@ravex/types'

describe('Presence', () => {
  let server: TestServer
  let clientA: ChatClient
  let clientB: ChatClient

  const userA: User = { id: 'user-a', username: 'usera', status: 'online', socketIds: [] }
  const userB: User = { id: 'user-b', username: 'userb', status: 'online', socketIds: [] }

  beforeEach(async () => {
    // Configure server with very fast presence heartbeat for testing
    server = await createServer({ presence: { heartbeatInterval: 100 } })
    clientA = await createConnectedClient(server.port, userA)
  })

  afterEach(async () => {
    if (clientA) clientA.disconnect()
    if (clientB) clientB.disconnect()
    await server.close()
  })

  it('should broadcast status changes to other users', async () => {
    clientB = await createConnectedClient(server.port, userB)
    
    const statusPromise = new Promise<any>((resolve) => {
      clientB.onUserStatus((data) => {
        if (data.id === userA.id) resolve(data)
      })
    })

    clientA.setStatus('away')
    
    const statusData = await statusPromise
    expect(statusData.id).toBe(userA.id)
    expect(statusData.status).toBe('away')
  })

  it('should receive heartbeat pings', async () => {
    const heartbeatPromise = new Promise<any>((resolve) => {
      // The client responds to presence:heartbeat automatically by sending presence:ping
      // We'll just verify the client receives the server heartbeat
      clientA.socket.on('presence:heartbeat', (data) => resolve(data))
    })

    const heartbeatData = await heartbeatPromise
    expect(heartbeatData.ts).toBeDefined()
  })
})
