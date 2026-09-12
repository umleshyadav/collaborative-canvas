/**
 * RoomManager — manages isolated canvas rooms and user sessions.
 *
 * Each room has:
 *   - A DrawingState instance (operation log, undo/redo)
 *   - A map of connected users { socketId → UserRecord }
 *
 * User colors are assigned from a curated palette and recycled when users
 * leave, so the palette never runs out for reasonable concurrency.
 */

'use strict';

const DrawingState = require('./drawing-state');

/**
 * Curated HSL color palette — visually distinct, works on dark canvas.
 * 12 colors gives enough variety for simultaneous users before cycling.
 */
const USER_PALETTE = [
  '#FF6B6B', // coral red
  '#4ECDC4', // teal
  '#45B7D1', // sky blue
  '#96CEB4', // sage green
  '#FFEAA7', // warm yellow
  '#DDA0DD', // plum
  '#98D8C8', // mint
  '#F7DC6F', // golden
  '#BB8FCE', // lavender
  '#85C1E9', // light blue
  '#F0B27A', // peach
  '#82E0AA', // spring green
];

class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} roomId → Room */
    this.rooms = new Map();
  }

  /**
   * Retrieve an existing room or create a new one.
   *
   * @param {string} roomId
   * @returns {Room}
   */
  getOrCreate(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        id: roomId,
        drawingState: new DrawingState(roomId),
        users: new Map(),          // socketId → UserRecord
        colorAssignments: new Map(), // socketId → paletteIndex
        usedColorIndices: new Set(),
      });
    }
    return this.rooms.get(roomId);
  }

  /**
   * Add a user to a room, assigning them a unique color.
   *
   * @param {string} roomId
   * @param {string} socketId
   * @param {string} displayName
   * @returns {UserRecord}
   */
  addUser(roomId, socketId, displayName) {
    const room = this.getOrCreate(roomId);

    // Pick the first unused palette index; wrap around if all taken
    let colorIndex = 0;
    for (let i = 0; i < USER_PALETTE.length; i++) {
      if (!room.usedColorIndices.has(i)) {
        colorIndex = i;
        break;
      }
    }
    // If all indices used, just cycle modulo palette length
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

  /**
   * Remove a user from a room and free their color slot.
   * Destroys the room if it becomes empty.
   *
   * @param {string} roomId
   * @param {string} socketId
   * @returns {UserRecord|null} The removed user, or null if not found
   */
  removeUser(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const user = room.users.get(socketId);
    if (!user) return null;

    // Free color slot
    const colorIndex = room.colorAssignments.get(socketId);
    if (colorIndex !== undefined) {
      room.usedColorIndices.delete(colorIndex);
      room.colorAssignments.delete(socketId);
    }

    room.users.delete(socketId);

    // Clean up empty rooms to avoid memory leaks
    if (room.users.size === 0) {
      this.rooms.delete(roomId);
    }

    return user;
  }

  /**
   * Get all users currently in a room.
   *
   * @param {string} roomId
   * @returns {UserRecord[]}
   */
  getUsers(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.users.values());
  }

  /**
   * Get a specific user record.
   *
   * @param {string} roomId
   * @param {string} socketId
   * @returns {UserRecord|null}
   */
  getUser(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return room.users.get(socketId) || null;
  }

  /**
   * Update a user's cursor position (in-place mutation is fine here —
   * cursor positions are ephemeral and not part of drawing history).
   *
   * @param {string} roomId
   * @param {string} socketId
   * @param {number} x
   * @param {number} y
   */
  updateCursor(roomId, socketId, x, y) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const user = room.users.get(socketId);
    if (user) {
      user.cursor = { x, y };
    }
  }

  /**
   * Get the DrawingState for a room.
   *
   * @param {string} roomId
   * @returns {DrawingState|null}
   */
  getDrawingState(roomId) {
    const room = this.rooms.get(roomId);
    return room ? room.drawingState : null;
  }

  /**
   * Returns a snapshot of all active rooms (for diagnostics/admin).
   *
   * @returns {Array<{id, userCount, operationCount}>}
   */
  getRoomSummaries() {
    return Array.from(this.rooms.entries()).map(([id, room]) => ({
      id,
      userCount: room.users.size,
      operationCount: room.drawingState.operations.length,
    }));
  }
}

module.exports = RoomManager;
