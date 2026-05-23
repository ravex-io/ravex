import type { User, UserStatus } from '@ravex/types'

export class UserManager {
  private readonly users = new Map<string, User>()

  get(userId: string): User | undefined {
    return this.users.get(userId)
  }

  set(userId: string, user: User): void {
    this.users.set(userId, user)
  }

  delete(userId: string): boolean {
    return this.users.delete(userId)
  }

  getAll(): User[] {
    return [...this.users.values()]
  }

  getOnline(): User[] {
    return this.getAll().filter(u => u.status === 'online')
  }

  isConnected(userId: string): boolean {
    const user = this.get(userId)
    return user ? user.socketIds.length > 0 : false
  }

  updateStatus(userId: string, status: UserStatus): { user: User; previousStatus: UserStatus } | null {
    const user = this.get(userId)
    if (!user) return null

    const previousStatus = user.status
    user.status = status
    user.lastSeen = new Date()
    this.set(userId, user)

    return { user, previousStatus }
  }

  addSocketId(userId: string, socketId: string): void {
    const user = this.get(userId)
    if (!user) return
    if (!user.socketIds.includes(socketId)) {
      user.socketIds.push(socketId)
    }
    this.set(userId, user)
  }

  removeSocketId(userId: string, socketId: string): void {
    const user = this.get(userId)
    if (!user) return
    user.socketIds = user.socketIds.filter(id => id !== socketId)
    this.set(userId, user)
  }
}
