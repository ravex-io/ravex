import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, createClient, type TestServer } from './helpers/setup.js'
import type { ChatClient } from '@ravex/client'
import type { User } from '@ravex/types'

describe('Connection', () => {
  let server: TestServer
  let client: ChatClient

  const mockUser: User = {
    id: 'user-1',
    username: 'testuser',
    displayName: 'Test User',
    status: 'online',
    socketIds: []
  }

  beforeEach(async () => {
    server = await createServer()
  })

  afterEach(async () => {
    if (client) client.disconnect()
    await server.close()
  })

  it('should connect successfully with valid auth', async () => {
    client = createClient(server.port, mockUser)
    
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve())
      client.on('connect_error', (err) => reject(err))
      client.connect()
    })

    expect(client.isConnected).toBe(true)
  })

  it('should fail connection with missing auth', async () => {
    // @ts-expect-error - testing invalid auth
    client = createClient(server.port, undefined)
    
    await expect(new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve())
      client.on('connect_error', (err) => reject(err))
      client.connect()
    })).rejects.toThrow('Authentication failed')
  })

  it('should disconnect cleanly', async () => {
    client = createClient(server.port, mockUser)
    
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve())
      client.on('connect_error', (err) => reject(err))
      client.connect()
    })

    expect(client.isConnected).toBe(true)

    const disconnectPromise = new Promise<void>((resolve) => {
      client.on('disconnect', () => resolve())
    })

    client.disconnect()
    await disconnectPromise

    expect(client.isConnected).toBe(false)
  })
})
