import type { UserStatus } from '@ravex/types'
import type { TypedNamespace, TypedSocket } from '../ChatEngine.js'
import type { UserManager } from '../core/UserManager.js'
import { logger } from '../utils/logger.js'

const DEFAULT_AWAY_TIMEOUT_MS = 300_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000

export interface PresenceConfig {
  /** How long (ms) before an idle user is marked away. Default: 300000 (5 min) */
  awayTimeout?: number
  /** Enable heartbeat ping. Default: true */
  heartbeat?: boolean
  /** Heartbeat interval in ms. Default: 30000 */
  heartbeatInterval?: number
}

interface PresenceHandlerDeps {
  ns: TypedNamespace
  userManager: UserManager
  config: PresenceConfig
  onStatusChange: (userId: string, previousStatus: UserStatus) => void
}

export class PresenceHandler {
  private readonly ns: TypedNamespace
  private readonly userManager: UserManager
  private readonly config: PresenceConfig
  private readonly handleStatusChange: (userId: string, previousStatus: UserStatus) => void
  private readonly awayTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private heartbeatInterval?: ReturnType<typeof setInterval>

  constructor({ ns, userManager, config, onStatusChange }: PresenceHandlerDeps) {
    this.ns = ns
    this.userManager = userManager
    this.config = config
    this.handleStatusChange = onStatusChange
    if (config.heartbeat !== false) {
      this.startHeartbeat()
    }
  }

  onPing(socket: TypedSocket): void {
    const user = socket.data.user
    if (!user) return
    this.resetAwayTimer(user.id)
    this.setStatus(user.id, 'online')
  }

  onStatusChange(socket: TypedSocket, data: { status: Exclude<UserStatus, 'offline'> }): void {
    const user = socket.data.user
    if (!user) return
    const { status } = data

    if (!['online', 'away', 'busy'].includes(status)) return

    if (status === 'away') {
      this.clearAwayTimer(user.id)
    } else {
      this.resetAwayTimer(user.id)
    }

    this.setStatus(user.id, status)
  }

  resetAwayTimer(userId: string): void {
    this.clearAwayTimer(userId)
    const timeout = this.config.awayTimeout ?? DEFAULT_AWAY_TIMEOUT_MS
    const timer = setTimeout(() => {
      this.setStatus(userId, 'away')
    }, timeout)
    this.awayTimers.set(userId, timer)
  }

  clearAwayTimer(userId: string): void {
    const timer = this.awayTimers.get(userId)
    if (timer) {
      clearTimeout(timer)
      this.awayTimers.delete(userId)
    }
  }

  clearAll(userId: string): void {
    this.clearAwayTimer(userId)
  }

  private setStatus(userId: string, status: UserStatus): void {
    const result = this.userManager.updateStatus(userId, status)
    if (!result) return

    const { user, previousStatus } = result
    if (previousStatus === status) return

    this.ns.emit('user:status', {
      id: user.id,
      username: user.username,
      status,
      lastSeen: user.lastSeen ?? new Date(),
    })

    this.handleStatusChange(userId, previousStatus)
    logger.debug(`User ${userId} status: ${previousStatus} → ${status}`)
  }

  private startHeartbeat(): void {
    const interval = this.config.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatInterval = setInterval(() => {
      this.ns.emit('presence:heartbeat', { ts: Date.now() })
    }, interval)
    logger.debug(`Presence heartbeat started (${interval}ms)`)
  }

  destroy(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
    for (const timer of this.awayTimers.values()) clearTimeout(timer)
    this.awayTimers.clear()
  }
}
