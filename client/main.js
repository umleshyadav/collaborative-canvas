/**
 * main.js — Application bootstrap
 *
 * Initialises all three managers and wires their event flows:
 *
 *   CanvasManager  ←→  WebSocketManager  ←→  Server
 *        ↕                    ↕
 *      UIManager         UIManager
 *
 * Dependency order:
 *   1. UIManager  (DOM, no network or canvas deps)
 *   2. CanvasManager  (canvas elements, no network deps)
 *   3. WebSocketManager  (depends on room/name from UIManager)
 *
 * All cross-cutting concerns (e.g. "remote stroke arrived → update canvas
 * AND enable undo button") are handled here rather than inside individual
 * managers, keeping each manager focused on its own domain.
 */

'use strict';

(function () {
  // ── State shared across managers ─────────────────────────────────
  /** @type {string|null} Our own socket.id, received in canvas:state */
  let selfId = null;

  /** @type {Map<string, UserRecord>} userId → user — kept in sync with server */
  const users = new Map();

  /** @type {boolean} Simple flag to enable/disable undo button */
  let hasUndo = false;

  // ── 1. Construct managers ─────────────────────────────────────────

  const ui = new UIManager();

  // Canvas elements
  const baseCanvas = document.getElementById('base-canvas');
  const liveCanvas = document.getElementById('live-canvas');

  // CanvasManager is constructed but stays dormant until join
  const canvasManager = new CanvasManager(baseCanvas, liveCanvas);

  // WebSocketManager is constructed but not connected until join
  const wsManager = new WebSocketManager(window.location.origin);

  // ── 2. Wire UI → actions ──────────────────────────────────────────

  ui.onJoin = ({ displayName, roomId }) => {
    wsManager.roomId      = roomId;
    wsManager.displayName = displayName;
    ui.showApp(roomId);
    ui.setConnecting();
    // Initial canvas resize
    canvasManager.resize();
    wsManager.connect();
  };

  ui.onToolChange  = (tool)  => {
    canvasManager.setTool(tool);
    liveCanvas.classList.toggle('canvas-eraser', tool === 'eraser');
  };
  ui.onColorChange = (color) => canvasManager.setColor(color);
  ui.onWidthChange = (w)     => canvasManager.setWidth(w);
  ui.onUndo  = () => wsManager.emitUndo();
  ui.onRedo  = () => wsManager.emitRedo();
  ui.onClear = () => wsManager.emitClear();

  // ── 3. Wire Canvas → WebSocket (local drawing events out) ─────────

  canvasManager.onStrokeStart = (data) => wsManager.emitStrokeStart(data);
  canvasManager.onStrokePoint = (data) => wsManager.emitStrokePoint(data);
  canvasManager.onStrokeEnd   = (data) => {
    wsManager.emitStrokeEnd(data);
    // Optimistically enable undo after committing a stroke
    hasUndo = true;
    ui.setUndoEnabled(true);
  };
  canvasManager.onCursorMove  = (pos)  => wsManager.emitCursorMove(pos);
  canvasManager.onFpsUpdate   = (fps)  => ui.setFps(fps);

  // ── 4. Wire WebSocket → Canvas + UI (incoming events) ─────────────

  // Connected to server
  wsManager.onConnected = () => {
    ui.setConnected();
  };

  // Disconnected
  wsManager.onDisconnected = (reason) => {
    ui.setDisconnected();
    ui.showToast(`Disconnected: ${reason}. Reconnecting…`, 'error', 5000);
  };

  // Latency updates
  wsManager.onLatencyUpdate = (ms) => ui.setLatency(ms);

  // Initial canvas state when joining
  wsManager.onCanvasState = ({ operations, users: serverUsers, self: selfUser }) => {
    selfId = selfUser.id;

    // Populate user list
    users.clear();
    for (const u of serverUsers) users.set(u.id, u);

    ui.renderUserList(serverUsers, selfId);

    // Replay all existing operations onto the base canvas
    canvasManager.resize();
    canvasManager.replayOperations(operations);

    // Update undo state based on whether we have any ops
    const myOps = operations.filter(op => op.userId === selfId);
    hasUndo = myOps.length > 0;
    ui.setUndoEnabled(hasUndo);
  };

  // Remote user joined
  wsManager.onUserJoined = (user) => {
    users.set(user.id, user);
    ui.addUser(user, user.id === selfId);
    ui.showToast(`${user.name} joined`, 'join');
  };

  // Remote user left
  wsManager.onUserLeft = (userId) => {
    const user = users.get(userId);
    const name = user ? user.name : 'Someone';
    users.delete(userId);
    ui.removeUser(userId);
    canvasManager.removeRemoteCursor(userId);
    ui.showToast(`${name} left`, 'leave');
  };

  // Remote stroke start
  wsManager.onStrokeStart = (data) => {
    canvasManager.handleRemoteStrokeStart(data);
  };

  // Remote stroke points (batched)
  wsManager.onStrokePoint = (data) => {
    canvasManager.handleRemoteStrokePoint(data);
  };

  // Remote stroke completed
  wsManager.onStrokeEnd = (data) => {
    canvasManager.handleRemoteStrokeEnd(data);
  };

  // Remote cursor movement
  wsManager.onCursorMoved = ({ userId, x, y }) => {
    const user = users.get(userId);
    if (!user) return;
    canvasManager.updateRemoteCursor(userId, x, y, user.color, user.name);
  };

  // Canvas replay (undo / redo / clear from any user)
  wsManager.onCanvasReplay = (operations) => {
    canvasManager.replayOperations(operations);
    // Re-evaluate undo state for the current user
    const myOps = operations.filter(op => op.userId === selfId);
    hasUndo = myOps.length > 0;
    ui.setUndoEnabled(hasUndo);
    ui.setRedoEnabled(true); // server handles actual stack; just enable tentatively
  };

  // Server errors
  wsManager.onError = (message) => {
    ui.showToast(message, 'error');
    // If "Nothing to undo" arrived, disable undo button
    if (message === 'Nothing to undo.') {
      hasUndo = false;
      ui.setUndoEnabled(false);
    }
    if (message === 'Nothing to redo.') {
      ui.setRedoEnabled(false);
    }
  };

  // ── 5. Window resize handling ──────────────────────────────────────
  // Debounced to avoid thrashing during resize drag
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Resizing clears canvas — we need to request replay from server
      // For simplicity, we trigger a re-join which will emit canvas:state
      const changed = canvasManager.resize();
      if (changed) {
        // Re-request state (server re-emits canvas:state on join)
        wsManager.socket && wsManager.socket.emit('join', {
          roomId:      wsManager.roomId,
          displayName: wsManager.displayName,
        });
      }
    }, 200);
  });

  // ── 6. Keyboard shortcut for eraser toggle ─────────────────────────
  // (B / E shortcuts already wired in UIManager, this is just a reminder)

  // ── Initial state ──────────────────────────────────────────────────
  ui.setUndoEnabled(false);
  ui.setRedoEnabled(false);
  ui.showOverlay();

})();
