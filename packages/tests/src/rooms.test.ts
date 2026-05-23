import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, createConnectedClient, type TestServer } from './helpers/setup.js'
import type { ChatClient } from '@ravex/client'
import type { User, Room } from '@ravex/types'

describe('Rooms', () => {
  let server: TestServer
  let clientA: ChatClient
  let clientB: ChatClient
  let clientC: ChatClient

  const userA: User = { id: 'user-a', username: 'usera', status: 'online', socketIds: [] }
  const userB: User = { id: 'user-b', username: 'userb', status: 'online', socketIds: [] }
  const userC: User = { id: 'user-c', username: 'userc', status: 'online', socketIds: [] }

  beforeEach(async () => {
    server = await createServer()
    clientA = await createConnectedClient(server.port, userA)
    clientB = await createConnectedClient(server.port, userB)
    clientC = await createConnectedClient(server.port, userC)
  })

  afterEach(async () => {
    if (clientA) clientA.disconnect()
    if (clientB) clientB.disconnect()
    if (clientC) clientC.disconnect()
    await server.close()
  })

  it('should create a room and automatically join the creator', async () => {
    const room = await clientA.createRoom({ type: 'group', name: 'A Room' })
    expect(room.id).toBeDefined()
    expect(room.createdBy).toBe(userA.id)
    expect(room.members).toContain(userA.id)

    const rooms = await clientA.listRooms()
    expect(rooms.some(r => r.id === room.id)).toBe(true)
  })

  it('should notify others when joining a room', async () => {
    const room = await clientA.createRoom({ type: 'group', name: 'Shared Room' })
    
    const joinPromise = new Promise<any>((resolve) => {
      clientA.onRoomUserJoined((data) => resolve(data))
    })

    await clientB.joinRoom(room.id)
    
    const joinData = await joinPromise
    expect(joinData.roomId).toBe(room.id)
    expect(joinData.user.id).toBe(userB.id)
  })

  it('should notify others when leaving a room', async () => {
    const room = await clientA.createRoom({ type: 'group', name: 'Shared Room', members: [userB.id] })
    await clientB.joinRoom(room.id)
    
    const leavePromise = new Promise<any>((resolve) => {
      clientA.onRoomUserLeft((data) => resolve(data))
    })

    await clientB.leaveRoom(room.id)
    
    const leaveData = await leavePromise
    expect(leaveData.roomId).toBe(room.id)
    expect(leaveData.user.id).toBe(userB.id)
  })

  it('should isolate messages to room members only', async () => {
    const roomAB = await clientA.createRoom({ type: 'group', name: 'Room AB', members: [userB.id] })
    await clientB.joinRoom(roomAB.id)
    
    let clientCReceivedMessage = false
    clientC.onMessage(() => {
      clientCReceivedMessage = true
    })

    const messagePromise = new Promise<any>((resolve) => {
      clientB.onMessage((msg) => resolve(msg))
    })

    await clientA.sendMessage({ roomId: roomAB.id, content: 'Secret message' })
    await messagePromise

    // Wait a short time to ensure C didn't get it
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(clientCReceivedMessage).toBe(false)
  })
})
