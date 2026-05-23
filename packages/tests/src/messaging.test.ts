import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, createConnectedClient, type TestServer } from './helpers/setup.js'
import type { ChatClient } from '@ravex/client'
import type { User, Message } from '@ravex/types'

describe('Messaging', () => {
  let server: TestServer
  let clientA: ChatClient
  let clientB: ChatClient
  let roomId: string

  const userA: User = { id: 'user-a', username: 'usera', status: 'online', socketIds: [] }
  const userB: User = { id: 'user-b', username: 'userb', status: 'online', socketIds: [] }

  beforeEach(async () => {
    server = await createServer({
      message: { allowEdits: true, allowDeletes: true }
    })
    clientA = await createConnectedClient(server.port, userA)
    clientB = await createConnectedClient(server.port, userB)

    // Create a room and join both
    const room = await clientA.createRoom({ type: 'group', name: 'Test Room', members: [userB.id] })
    roomId = room.id
    
    // Client B must explicitly join to receive messages
    await clientB.joinRoom(roomId)
  })

  afterEach(async () => {
    if (clientA) clientA.disconnect()
    if (clientB) clientB.disconnect()
    await server.close()
  })

  it('should send and receive a message', async () => {
    const messagePromise = new Promise<Message>((resolve) => {
      clientB.onMessage((msg) => {
        if (msg.roomId === roomId && msg.senderId === userA.id) {
          resolve(msg)
        }
      })
    })

    const sentMessage = await clientA.sendMessage({ roomId, content: 'Hello World' })
    expect(sentMessage.content).toBe('Hello World')
    expect(sentMessage.senderId).toBe(userA.id)

    const receivedMessage = await messagePromise
    expect(receivedMessage.id).toBe(sentMessage.id)
    expect(receivedMessage.content).toBe('Hello World')
  })

  it('should edit a message', async () => {
    const sentMessage = await clientA.sendMessage({ roomId, content: 'Original' })
    
    const editPromise = new Promise<any>((resolve) => {
      clientB.onMessageEdited((data) => resolve(data))
    })

    await clientA.editMessage({ messageId: sentMessage.id, roomId, content: 'Edited' })
    
    const editData = await editPromise
    expect(editData.messageId).toBe(sentMessage.id)
    expect(editData.content).toBe('Edited')
  })

  it('should delete a message', async () => {
    const sentMessage = await clientA.sendMessage({ roomId, content: 'To be deleted' })
    
    const deletePromise = new Promise<any>((resolve) => {
      clientB.onMessageDeleted((data) => resolve(data))
    })

    await clientA.deleteMessage(sentMessage.id, roomId)
    
    const deleteData = await deletePromise
    expect(deleteData.messageId).toBe(sentMessage.id)
  })

  it('should send a read receipt', async () => {
    const sentMessage = await clientA.sendMessage({ roomId, content: 'Read me' })

    const readPromise = new Promise<any>((resolve) => {
      clientA.onReadReceipt((data) => resolve(data))
    })

    clientB.markAsRead(sentMessage.id, roomId)

    const readData = await readPromise
    expect(readData.messageId).toBe(sentMessage.id)
    expect(readData.readBy).toBe(userB.id)
  })

  it('should send a reaction', async () => {
    const sentMessage = await clientA.sendMessage({ roomId, content: 'React to me' })

    const reactPromise = new Promise<any>((resolve) => {
      clientA.onReaction((data) => resolve(data))
    })

    await clientB.sendReaction(sentMessage.id, roomId, '👍')

    const reactData = await reactPromise
    expect(reactData.messageId).toBe(sentMessage.id)
    expect(reactData.emoji).toBe('👍')
    expect(reactData.userId).toBe(userB.id)
  })
})
