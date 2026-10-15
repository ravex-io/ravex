// Starts a ChatEngine whose application callback `argv[2]` fails (`argv[3]`: "sync" throws,
// "async" rejects), triggers it, and checks the server still answers afterwards.
// Prints "CALLED" when the callback actually ran and "ALIVE" when the server survived.
//
//   node callback-errors.mjs <onMessage|onEdit|onDelete|onRead|onReaction|onStatusChange|onStatusChange:away> <sync|async>
import { createServer } from 'http'
import { ChatEngine } from '@ravex/server'
import { ChatClient } from '@ravex/client'

const [target, mode] = process.argv.slice(2)
const callbackName = target.split(':')[0]

const failing = (...args) => {
  console.log('CALLED')
  if (mode === 'sync') throw new Error(`sync failure in ${target}`)
  return (async () => {
    // Same shape as the review report: a TypeError inside an async callback.
    if (callbackName === 'onRead') args[1].toUpperCase()
    throw new Error(`async failure in ${target}`)
  })()
}

// Small persistence adapter, so onDelete has a stored message to report.
const messages = []
const persistence = {
  async saveMessage(m) { messages.push(m) },
  async getMessages(roomId) { return messages.filter((m) => m.roomId === roomId) },
  async getMessage(id) { return messages.find((m) => m.id === id) },
  async updateMessage(id, updates) { Object.assign(messages.find((m) => m.id === id) ?? {}, updates) },
  async deleteMessage(id) { const i = messages.findIndex((m) => m.id === id); if (i >= 0) messages.splice(i, 1) },
}

const http = createServer()
new ChatEngine(http, {
  // insecureTrustClientUser lets this test client connect with a plain auth.user
  // (servers reject unauthenticated connections by default once the authenticate option lands).
  insecureTrustClientUser: true,
  persistence,
  presence: { heartbeat: false, awayTimeout: target === 'onStatusChange:away' ? 50 : 300_000 },
  message: { allowEdits: true, allowDeletes: true },
  [callbackName]: failing,
})
await new Promise((resolve) => http.listen(0, resolve))

const client = new ChatClient({
  url: `http://localhost:${http.address().port}`,
  auth: { user: { id: 'u1', username: 'u1', status: 'online', socketIds: [] } },
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const quietly = (promise) => promise.catch(() => {})

client.on('connect', async () => {
  const room = await client.createRoom({ type: 'group' })
  const msg = callbackName === 'onMessage'
    ? await quietly(client.sendMessage({ roomId: room.id, content: 'trigger' }))
    : await client.sendMessage({ roomId: room.id, content: 'setup' })

  if (target === 'onEdit') await quietly(client.editMessage({ messageId: msg.id, roomId: room.id, content: 'edited' }))
  if (target === 'onDelete') await quietly(client.deleteMessage(msg.id, room.id))
  if (target === 'onReaction') await quietly(client.sendReaction(msg.id, room.id, '👍'))
  // The exact payload from the review report: an object where a string id is expected.
  if (target === 'onRead') client.rawSocket.emit('message:read', { messageId: {}, roomId: room.id })
  if (target === 'onStatusChange') client.setStatus('busy')
  if (target === 'onStatusChange:away') client.ping() // starts the away timer, which fires outside any event handler

  await sleep(300)
  // The server must still answer normal requests.
  await client.sendMessage({ roomId: room.id, content: 'still alive' })
  console.log('ALIVE')
  process.exit(0)
})
