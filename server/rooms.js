'use strict';

const DrawingState = require('./drawing-state');

const USER_PALETTE = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F0B27A', '#82E0AA',
];

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  getOrCreate(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        id: roomId,
        drawingState: new DrawingState(roomId),
        users: new Map(),
        colorAssignments: new Map(),
        usedColorIndices: new Set(),
      });
    }
    return this.rooms.get(roomId);
  }

  addUser(roomId, socketId, displayName) {
    const room = this.getOrCreate(roomId);

    let colorIndex = 0;
    for (let i = 0; i < USER_PALETTE.length; i++) {
      if (!room.usedColorIndices.has(i)) {
        colorIndex = i;
        break;
      }
    }
    if (room.usedColorIndices.size >= USER_PALETTE.length) {
      colorIndex = room.users.size % USER_PALETTE.length;
    }

    room.usedColorIndices.add(colorIndex);
    room.colorAssignments.set(socketId, colorIndex);

    const user = {
      id: socketId,
      name: displayName || `User ${room.users.size + 1}`,
      color: USER_PALETTE[colorIndex],
      joinedAt: Date.now(),
      cursor: { x: 0, y: 0 },
    };

    room.users.set(socketId, user);
    return user;
  }

  removeUser(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const user = room.users.get(socketId);
    if (!user) return null;

    const colorIndex = room.colorAssignments.get(socketId);
    if (colorIndex !== undefined) {
      room.usedColorIndices.delete(colorIndex);
      room.colorAssignments.delete(socketId);
    }

    room.users.delete(socketId);

    if (room.users.size === 0) {
      this.rooms.delete(roomId);
    }

    return user;
  }

  getUsers(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.users.values());
  }

  getUser(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return room.users.get(socketId) || null;
  }

  updateCursor(roomId, socketId, x, y) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const user = room.users.get(socketId);
    if (user) user.cursor = { x, y };
  }

  getDrawingState(roomId) {
    const room = this.rooms.get(roomId);
    return room ? room.drawingState : null;
  }

  getRoomSummaries() {
    return Array.from(this.rooms.entries()).map(([id, room]) => ({
      id,
      userCount: room.users.size,
      operationCount: room.drawingState.operations.length,
    }));
  }
}

module.exports = RoomManager;
