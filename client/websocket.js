/**
 * websocket.js — WebSocketManager
 *
 * Wraps the Socket.io client, providing a clean event-based API to the
 * rest of the application. All raw Socket.io usage is isolated here.
 *
 * Connection lifecycle
 * ────────────────────
 * 1. connect()  → open socket & join room
 * 2. Socket.io handles automatic reconnection (exponential back-off built-in)
 * 3. On reconnect, re-join the room to re-receive canvas state
 *
 * Client-side prediction
 * ──────────────────────
 * The local user's strokes are drawn immediately to the base canvas without
 * waiting for server acknowledgement. When `stroke:committed` arrives from
 * the server we simply record the server-assigned operationId for undo
 * purposes — we do NOT re-draw (that would cause a double render).
 *
 * Latency measurement
 * ───────────────────
 * Socket.io has a built-in socket.io.engine.pingInterval / pingTimeout.
 * We measure round-trip latency ourselves by timestamping each cursor:move
 * emission and correlating with the echo — but since cursors are not echoed
 * back, we use the Socket.io `ping` event timing instead.
 */

'use strict';

class WebSocketManager {
  /**
   * @param {string} serverUrl  e.g. 'http://localhost:3000'
   * @param {object} opts
   * @param {string} opts.roomId
   * @param {string} opts.displayName
   */
  constructor(serverUrl, opts = {}) {
    this.serverUrl   = serverUrl;
    this.roomId      = opts.roomId      || 'main';
    this.displayName = opts.displayName || 'Anonymous';

    /** @type {import('socket.io-client').Socket|null} */
    this.socket = null;

    /** @type {boolean} */
    this.connected = false;

    /** operationId of our own last committed stroke (server-assigned) */
    this.latestOperationId = null;

    /** Latency in ms (updated via ping events) */
    this.latencyMs = 0;

    // ── Event callbacks (wired by main.js) ────────────────────────
    /** @type {function(data)|null} */
    this.onCanvasState  = null;
    this.onUserJoined   = null;
    this.onUserLeft     = null;
    this.onStrokeStart  = null;
    this.onStrokePoint  = null;
    this.onStrokeEnd    = null;
    this.onCursorMoved  = null;
    this.onCanvasReplay = null;
    this.onConnected    = null;
    this.onDisconnected = null;
    this.onError        = null;
    this.onLatencyUpdate = null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Connection management
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Open the WebSocket connection and attach all event handlers.
   * Safe to call multiple times — won't open duplicate connections.
   */
  connect() {
    if (this.socket) return;

    // io() is loaded from /socket.io/socket.io.js served by the server
    this.socket = io(this.serverUrl, {
      transports: ['websocket', 'polling'],
      reconnectionDelay:    1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
    });

    this._attachHandlers();
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.connected = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Event handlers
  // ═══════════════════════════════════════════════════════════════════

  /** @private */
  _attachHandlers() {
    const s = this.socket;

    // ── Transport lifecycle ───────────────────────────────────────

    s.on('connect', () => {
      console.log('[ws] connected, joining room:', this.roomId);
      this.connected = true;

      // Join (or re-join after reconnect)
      s.emit('join', { roomId: this.roomId, displayName: this.displayName });

      if (this.onConnected) this.onConnected();
    });

    s.on('disconnect', (reason) => {
      console.log('[ws] disconnected:', reason);
      this.connected = false;
      if (this.onDisconnected) this.onDisconnected(reason);
    });

    s.on('connect_error', (err) => {
      console.warn('[ws] connect_error:', err.message);
    });

    // Latency via Socket.io ping
    s.io.on('ping', () => {
      this._pingStart = performance.now();
    });
    s.on('pong', () => {
      if (this._pingStart) {
        this.latencyMs = Math.round(performance.now() - this._pingStart);
        if (this.onLatencyUpdate) this.onLatencyUpdate(this.latencyMs);
      }
    });

    // ── Canvas state (received on join) ──────────────────────────

    s.on('canvas:state', (data) => {
      console.log(`[ws] canvas:state — ${data.operations.length} ops, ${data.users.length} users`);
      if (this.onCanvasState) this.onCanvasState(data);
    });

    // ── Canvas replay (undo / redo / clear) ──────────────────────

    s.on('canvas:replay', (data) => {
      console.log(`[ws] canvas:replay — ${data.operations.length} active ops`);
      if (this.onCanvasReplay) this.onCanvasReplay(data.operations);
    });

    // ── User events ───────────────────────────────────────────────

    s.on('user:joined', ({ user }) => {
      console.log('[ws] user:joined:', user.name);
      if (this.onUserJoined) this.onUserJoined(user);
    });

    s.on('user:left', ({ userId }) => {
      console.log('[ws] user:left:', userId);
      if (this.onUserLeft) this.onUserLeft(userId);
    });

    // ── Remote stroke events ──────────────────────────────────────

    s.on('stroke:start', (data) => {
      if (this.onStrokeStart) this.onStrokeStart(data);
    });

    s.on('stroke:point', (data) => {
      if (this.onStrokePoint) this.onStrokePoint(data);
    });

    s.on('stroke:end', (data) => {
      if (this.onStrokeEnd) this.onStrokeEnd(data);
    });

    // ── Stroke committed (local echo with server op ID) ───────────

    s.on('stroke:committed', ({ strokeId, operationId }) => {
      // Record mapping so undo can reference the correct server op
      this.latestOperationId = operationId;
      console.log(`[ws] stroke committed: ${strokeId} → op ${operationId}`);
    });

    // ── Cursor events ─────────────────────────────────────────────

    s.on('cursor:moved', (data) => {
      if (this.onCursorMoved) this.onCursorMoved(data);
    });

    // ── Server errors ─────────────────────────────────────────────

    s.on('error', ({ message }) => {
      console.warn('[ws] server error:', message);
      if (this.onError) this.onError(message);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Emission methods
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Emit a stroke:start event.
   * @param {{ strokeId, color, width, tool }} data
   */
  emitStrokeStart(data) {
    if (!this.connected) return;
    this.socket.emit('stroke:start', data);
  }

  /**
   * Emit batched stroke:point event.
   * The points array is already batched by CanvasManager.
   * @param {{ strokeId, points }} data
   */
  emitStrokePoint(data) {
    if (!this.connected) return;
    this.socket.emit('stroke:point', data);
  }

  /**
   * Emit stroke:end with full point data for authoritative server commit.
   * @param {{ strokeId, color, width, tool, points }} data
   */
  emitStrokeEnd(data) {
    if (!this.connected) return;
    this.socket.emit('stroke:end', data);
  }

  /**
   * Emit cursor position. Already throttled upstream by CanvasManager.
   * @param {{ x, y }} pos
   */
  emitCursorMove(pos) {
    if (!this.connected) return;
    this.socket.emit('cursor:move', pos);
  }

  /** Emit undo request for the current user's last action. */
  emitUndo() {
    if (!this.connected) return;
    this.socket.emit('undo');
  }

  /** Emit redo request. */
  emitRedo() {
    if (!this.connected) return;
    this.socket.emit('redo');
  }

  /** Emit clear:canvas (broadcasts to all users). */
  emitClear() {
    if (!this.connected) return;
    this.socket.emit('clear:canvas');
  }
}
