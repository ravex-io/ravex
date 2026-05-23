import type { Room, ChatType } from '@ravex/types'
import { ChatError, ErrorCodes } from '../utils/errors.js'
import { randomUUID } from 'crypto'

const ROOM_ID_DISPLAY_LENGTH = 6

export interface CreateRoomOptions {
  name?: string
  type: ChatType
  members?: string[]
  admins?: string[]
  createdBy: string
  maxMembers?: number
  isPrivate?: boolean
  metadata?: Record<string, unknown>
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>()

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId)
  }

  set(roomId: string, room: Room): void {
    this.rooms.set(roomId, room)
  }

  delete(roomId: string): boolean {
    return this.rooms.delete(roomId)
  }

  getAll(): Room[] {
    return [...this.rooms.values()]
  }

  create(options: CreateRoomOptions): Room {
    const {
      name,
      type,
      members = [],
      admins = [],
      createdBy,
      maxMembers,
      isPrivate = false,
      metadata = {},
    } = options

    if (!createdBy) {
      throw new ChatError('createdBy is required', ErrorCodes.VALIDATION)
    }

    const id = randomUUID()
    const memberList = [...new Set([createdBy, ...members])]
    const adminList = [...new Set([createdBy, ...admins])]

    const room: Room = {
      id,
      name: name ?? (type === 'personal' ? 'Direct Message' : `Room ${id.slice(0, ROOM_ID_DISPLAY_LENGTH)}`),
      type,
      members: memberList,
      admins: adminList,
      createdBy,
      createdAt: new Date(),
      maxMembers,
      isPrivate,
      metadata,
    }

    this.rooms.set(id, room)
    return room
  }

  isMember(roomId: string, userId: string): boolean {
    return this.get(roomId)?.members.includes(userId) ?? false
  }

  isAdmin(roomId: string, userId: string): boolean {
    return this.get(roomId)?.admins.includes(userId) ?? false
  }

  addMember(roomId: string, userId: string): void {
    const room = this.get(roomId)
    if (!room) throw new ChatError('Room not found', ErrorCodes.ROOM_NOT_FOUND)
    if (!room.members.includes(userId)) {
      room.members.push(userId)
      this.set(roomId, room)
    }
  }

  removeMember(roomId: string, userId: string): void {
    const room = this.get(roomId)
    if (!room) return
    room.members = room.members.filter(id => id !== userId)
    this.set(roomId, room)
  }

  getRoomsForUser(userId: string): Room[] {
    return this.getAll().filter(r => r.members.includes(userId))
  }
}
