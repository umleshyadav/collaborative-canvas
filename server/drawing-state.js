/**
 * DrawingState — Server-side operation log for a single canvas room.
 *
 * Uses an event-sourcing pattern: every drawing action is an immutable
 * "operation" appended to a log. Undo/redo mark operations as inactive
 * without deleting them, so the full history is always preserved.
 *
 * Each operation object:
 *   {
 *     id:        string   — unique operation ID (uuid)
 *     userId:    string   — socket ID of the originating user
 *     type:      string   — 'stroke' | 'clear'
 *     data:      object   — tool-specific payload (see below)
 *     timestamp: number   — server ms timestamp
 *     active:    boolean  — false if undone
 *   }
 *
 * Stroke data shape:
 *   {
 *     color:   string   — CSS color
 *     width:   number   — stroke width in px
 *     tool:    string   — 'brush' | 'eraser'
 *     points:  {x,y}[]  — array of canvas coordinates
 *   }
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

const MAX_HISTORY = 200; // cap operation log to prevent unbounded memory growth

class DrawingState {
  constructor(roomId) {
    this.roomId = roomId;
    /** @type {Array<Operation>} Full ordered log — never mutated in place */
    this.operations = [];
    /**
     * Per-user undo stacks: Map<userId, operationId[]>
     * Tracks the order in which a user's ops were committed so we know
     * which one to undo next (LIFO per user).
     */
    this.userUndoStack = new Map();
    /**
     * Per-user redo stacks: Map<userId, operationId[]>
     * Populated when an op is undone; cleared when a new op is committed.
     */
    this.userRedoStack = new Map();
  }

  // ─── Operation helpers ────────────────────────────────────────────────────

  /**
   * Append a new operation to the log and update the user's undo stack.
   * Clears the user's redo stack (new action invalidates redo history).
   *
   * @param {string} userId
   * @param {'stroke'|'clear'} type
   * @param {object} data
   * @returns {Operation} The created operation
   */
  addOperation(userId, type, data) {
    const op = {
      id: uuidv4(),
      userId,
      type,
      data,
      timestamp: Date.now(),
      active: true,
    };

    this.operations.push(op);

    // Trim log if it exceeds the cap (remove oldest *active* ops)
    if (this.operations.length > MAX_HISTORY) {
      this._trimLog();
    }

    // Maintain per-user undo stack
    if (!this.userUndoStack.has(userId)) {
      this.userUndoStack.set(userId, []);
    }
    this.userUndoStack.get(userId).push(op.id);

    // New commit invalidates redo history for this user
    this.userRedoStack.set(userId, []);

    return op;
  }

  /**
   * Undo the most recent active operation by a given user.
   * Marks the op as inactive and pushes to the redo stack.
   *
   * @param {string} userId
   * @returns {{ success: boolean, operationId?: string }}
   */
  undo(userId) {
    const undoStack = this.userUndoStack.get(userId) || [];

    // Walk back from top of stack to find the most recent *active* op
    let targetId = null;
    for (let i = undoStack.length - 1; i >= 0; i--) {
      const opId = undoStack[i];
      const op = this._findOp(opId);
      if (op && op.active) {
        targetId = opId;
        break;
      }
    }

    if (!targetId) return { success: false };

    const op = this._findOp(targetId);
    op.active = false;

    if (!this.userRedoStack.has(userId)) {
      this.userRedoStack.set(userId, []);
    }
    this.userRedoStack.get(userId).push(targetId);

    return { success: true, operationId: targetId };
  }

  /**
   * Redo the most recently undone operation by a given user.
   *
   * @param {string} userId
   * @returns {{ success: boolean, operationId?: string }}
   */
  redo(userId) {
    const redoStack = this.userRedoStack.get(userId) || [];
    if (redoStack.length === 0) return { success: false };

    const targetId = redoStack.pop();
    const op = this._findOp(targetId);
    if (!op) return { success: false };

    op.active = true;

    // Push back onto undo stack
    if (!this.userUndoStack.has(userId)) {
      this.userUndoStack.set(userId, []);
    }
    this.userUndoStack.get(userId).push(targetId);

    return { success: true, operationId: targetId };
  }

  /**
   * Returns only the active operations — used to send canvas state to new
   * joiners and to instruct clients to replay after an undo/redo.
   *
   * @returns {Operation[]}
   */
  getActiveOperations() {
    return this.operations.filter(op => op.active);
  }

  /**
   * Removes all operations (global clear). Clears all undo/redo stacks.
   *
   * @param {string} userId  The user who triggered the clear
   * @returns {Operation}    The clear operation itself
   */
  clearCanvas(userId) {
    // Mark all existing ops inactive
    this.operations.forEach(op => { op.active = false; });
    // Clear all user stacks
    this.userUndoStack.clear();
    this.userRedoStack.clear();

    // Add a 'clear' operation to the log so it can be synced
    return this.addOperation(userId, 'clear', {});
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /** @private */
  _findOp(id) {
    return this.operations.find(op => op.id === id) || null;
  }

  /**
   * Remove oldest inactive operations when the log exceeds MAX_HISTORY.
   * @private
   */
  _trimLog() {
    const excess = this.operations.length - MAX_HISTORY;
    let removed = 0;
    this.operations = this.operations.filter(op => {
      if (!op.active && removed < excess) {
        removed++;
        return false;
      }
      return true;
    });
  }
}

module.exports = DrawingState;
