import type { Server } from 'socket.io'
import type { TypedNamespace, TypedSocket } from '../ChatEngine.js'
import { logger } from '../utils/logger.js'

type Adapter = TypedNamespace['adapter']
type MissedPacket = unknown[]

/** socket.io-parser's PacketType.EVENT. */
const EVENT_PACKET = 2

/** socket.io's internal packet writer, used by its own recovery code to send missed packets. */
interface PacketWriter {
  packet(packet: { type: number; data: MissedPacket }): void
}

/**
 * Makes socket.io connection state recovery safe for an authenticated chat namespace.
 *
 * socket.io's recovery would otherwise:
 * 1. skip namespace middleware for recovered sockets (`skipMiddlewares` defaults to true), so a revoked
 *    token could reconnect with its old identity;
 * 2. send the missed packets as soon as the session is restored, before any middleware has run;
 * 3. restore the rooms the socket was in when it disconnected, even ones the user has since been removed from.
 *
 * This guard forces middleware to run, holds missed packets back until the socket is re-authenticated,
 * and resets restored rooms so the connection handler re-joins only the user's current rooms.
 */
export class RecoveryGuard {
  /** sid -> missed packets held back until the socket passes authentication. */
  private readonly held = new Map<string, MissedPacket[]>()
  /** Sockets that passed this engine's authentication middleware. */
  private readonly authenticated = new WeakSet<TypedSocket>()

  constructor(io: Server, ns: TypedNamespace) {
    // eslint-disable-next-line no-underscore-dangle -- socket.io's public getter for the live server options
    const recovery = io._opts.connectionStateRecovery
    if (recovery && recovery.skipMiddlewares !== false) {
      logger.warn(
        'connectionStateRecovery.skipMiddlewares has been set to false: recovered connections must be ' +
          're-authenticated. This applies to every namespace of this socket.io server.',
      )
      recovery.skipMiddlewares = false
    }

    const adapter: Adapter = ns.adapter
    const restoreSession = adapter.restoreSession.bind(adapter)
    adapter.restoreSession = async (pid, offset) => {
      const session = await restoreSession(pid, offset)
      if (session) {
        this.held.set(session.sid, session.missedPackets)
        session.missedPackets = []
      }
      return session
    }
  }

  isAuthenticated(socket: TypedSocket): boolean {
    return this.authenticated.has(socket)
  }

  /** Authentication failed: drop anything held for this socket. */
  reject(socket: TypedSocket): void {
    this.held.delete(socket.id)
  }

  /**
   * Authentication succeeded. For a recovered socket, resets its restored rooms and, if it is still the
   * same user, replays the missed packets for rooms the user is still a member of.
   */
  accept(socket: TypedSocket, sameUser: boolean, isMember: (roomId: string) => boolean): void {
    this.authenticated.add(socket)
    const missed = this.held.get(socket.id)
    this.held.delete(socket.id)
    if (!socket.recovered) return

    // Restored rooms reflect membership at disconnect time; the connection handler re-joins current ones.
    for (const room of [...socket.rooms]) {
      if (room !== socket.id) socket.leave(room)
    }

    if (!sameUser || !missed) return
    // Write the packets exactly like socket.io's own recovery does (they keep their original offsets).
    // socket.emit() can't be used: with recovery enabled it broadcasts to the socket's room, which a
    // socket still in middleware hasn't joined yet.
    const writer = socket as unknown as PacketWriter
    for (const packet of missed) {
      const payload = packet[1]
      const roomId = typeof payload === 'object' && payload !== null ? (payload as { roomId?: unknown }).roomId : undefined
      // Drop packets for rooms the user has left or been removed from since disconnecting.
      if (typeof roomId !== 'string' || isMember(roomId)) writer.packet({ type: EVENT_PACKET, data: packet })
    }
  }
}
