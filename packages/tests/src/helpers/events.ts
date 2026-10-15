import type { ChatClient } from '@ravex/client'
import type { ServerToClientEvents, User } from '@ravex/types'

export const mkUser = (id: string): User => ({ id, username: id, status: 'online', socketIds: [] })

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Collects every payload of `event` received by `client` from now on. */
export function record<K extends keyof ServerToClientEvents>(client: ChatClient, event: K) {
  const events: Parameters<ServerToClientEvents[K]>[0][] = []
  const listener = ((data: Parameters<ServerToClientEvents[K]>[0]) => events.push(data)) as ServerToClientEvents[K]
  client.on(event, listener)
  return events
}

/** Resolves with the first payload of `event`, rejects after `ms`. */
export function waitFor<K extends keyof ServerToClientEvents>(client: ChatClient, event: K, ms = 1000) {
  return new Promise<Parameters<ServerToClientEvents[K]>[0]>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms)
    client.once(event, ((data: Parameters<ServerToClientEvents[K]>[0]) => {
      clearTimeout(t)
      resolve(data)
    }) as ServerToClientEvents[K])
  })
}
