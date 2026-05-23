import { createServer as createHttpServer, type Server as HttpServer } from 'http'
import { ChatEngine, type ChatEngineOptions } from '@ravex/server'
import { ChatClient, type ChatClientOptions } from '@ravex/client'
import type { User } from '@ravex/types'
import { AddressInfo } from 'net'

export interface TestServer {
  httpServer: HttpServer
  engine: ChatEngine
  port: number
  close: () => Promise<void>
}

export async function createServer(options?: ChatEngineOptions): Promise<TestServer> {
  const httpServer = createHttpServer()
  const engine = new ChatEngine(httpServer, options)

  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => resolve())
  })

  const address = httpServer.address() as AddressInfo
  const port = address.port

  const close = async () => {
    engine.destroy()
    engine.io.close()
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()))
    })
  }

  return { httpServer, engine, port, close }
}

export function createClient(port: number, user: User, options?: Partial<ChatClientOptions>): ChatClient {
  return new ChatClient({
    url: `http://localhost:${port}`,
    auth: { user },
    ...options
  })
}

export async function createConnectedClient(port: number, user: User, options?: Partial<ChatClientOptions>): Promise<ChatClient> {
  const client = createClient(port, user, options)
  client.connect()
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Client connection timeout')), 5000)
    client.on('connect', () => {
      clearTimeout(timeout)
      resolve()
    })
    client.on('connect_error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
  return client
}
