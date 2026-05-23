import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, createConnectedClient, type TestServer } from './helpers/setup.js'
import type { ChatClient } from '@ravex/client'
import type { User } from '@ravex/types'

describe('Typing Indicators', () => {
  let server: TestServer
  let clientA: ChatClient
  let clientB: ChatClient
  let roomId: string

  const userA: User = { id: 'user-a', username: 'usera', status: 'online', socketIds: [] }
  const userB: User = { id: 'user-b', username: 'userb', status: 'online', socketIds: [] }

  beforeEach(async () => {
    server = await createServer()
    clientA = await createConnectedClient(server.port, userA)
    clientB = await createConnectedClient(server.port, userB)

    const room = await clientA.createRoom({ type: 'group', name: 'Typing Room', members: [userB.id] })
    roomId = room.id
    await clientB.joinRoom(roomId)
  })

  afterEach(async () => {
    if (clientA) clientA.disconnect()
    if (clientB) clientB.disconnect()
    await server.close()
  })

  it('should notify others when user starts typing', async () => {
    const typingPromise = new Promise<any>((resolve) => {
      clientB.onTypingStart((data) => resolve(data))
    })

    clientA.startTyping(roomId)
    
    const typingData = await typingPromise
    expect(typingData.roomId).toBe(roomId)
    expect(typingData.userId).toBe(userA.id)
  })

  it('should notify others when user stops typing', async () => {
    const typingPromise = new Promise<any>((resolve) => {
      clientB.onTypingStop((data) => resolve(data))
    })

    clientA.stopTyping(roomId)
    
    const typingData = await typingPromise
    expect(typingData.roomId).toBe(roomId)
    expect(typingData.userId).toBe(userA.id)
  })
})
