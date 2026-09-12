'use strict';

const { v4: uuidv4 } = require('uuid');

const MAX_HISTORY = 200;

class DrawingState {
  constructor(roomId) {
    this.roomId = roomId;
    this.operations = [];
    this.userUndoStack = new Map();
    this.userRedoStack = new Map();
  }

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

    if (this.operations.length > MAX_HISTORY) {
      this._trimLog();
    }

    if (!this.userUndoStack.has(userId)) {
      this.userUndoStack.set(userId, []);
    }
    this.userUndoStack.get(userId).push(op.id);
    this.userRedoStack.set(userId, []);

    return op;
  }

  undo(userId) {
    const undoStack = this.userUndoStack.get(userId) || [];
    let targetId = null;

    for (let i = undoStack.length - 1; i >= 0; i--) {
      const op = this._findOp(undoStack[i]);
      if (op && op.active) {
        targetId = undoStack[i];
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

  redo(userId) {
    const redoStack = this.userRedoStack.get(userId) || [];
    if (redoStack.length === 0) return { success: false };

    const targetId = redoStack.pop();
    const op = this._findOp(targetId);
    if (!op) return { success: false };

    op.active = true;

    if (!this.userUndoStack.has(userId)) {
      this.userUndoStack.set(userId, []);
    }
    this.userUndoStack.get(userId).push(targetId);

    return { success: true, operationId: targetId };
  }

  getActiveOperations() {
    return this.operations.filter(op => op.active);
  }

  clearCanvas(userId) {
    this.operations.forEach(op => { op.active = false; });
    this.userUndoStack.clear();
    this.userRedoStack.clear();
    return this.addOperation(userId, 'clear', {});
  }

  _findOp(id) {
    return this.operations.find(op => op.id === id) || null;
  }

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
