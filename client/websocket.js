'use strict';

class WebSocketManager {
  constructor(serverUrl, opts = {}) {
    this.serverUrl   = serverUrl;
    this.roomId      = opts.roomId      || 'main';
    this.displayName = opts.displayName || 'Anonymous';

    this.socket    = null;
    this.connected = false;
    this.latencyMs = 0;

    this.onCanvasState   = null;
    this.onUserJoined    = null;
    this.onUserLeft      = null;
    this.onStrokeStart   = null;
    this.onStrokePoint   = null;
    this.onStrokeEnd     = null;
    this.onCursorMoved   = null;
    this.onCanvasReplay  = null;
    this.onConnected     = null;
    this.onDisconnected  = null;
    this.onError         = null;
    this.onLatencyUpdate = null;
  }

  connect() {
    if (this.socket) return;

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
      this.socket    = null;
      this.connected = false;
    }
  }

  _attachHandlers() {
    const s = this.socket;

    s.on('connect', () => {
      console.log('[ws] connected, joining room:', this.roomId);
      this.connected = true;
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

    // Measure round-trip latency via Socket.io ping/pong
    s.io.on('ping', () => { this._pingStart = performance.now(); });
    s.on('pong', () => {
      if (this._pingStart) {
        this.latencyMs = Math.round(performance.now() - this._pingStart);
        if (this.onLatencyUpdate) this.onLatencyUpdate(this.latencyMs);
      }
    });

    s.on('canvas:state',  (data)           => { if (this.onCanvasState)  this.onCanvasState(data);           });
    s.on('canvas:replay', (data)           => { if (this.onCanvasReplay) this.onCanvasReplay(data.operations); });
    s.on('user:joined',   ({ user })       => { if (this.onUserJoined)   this.onUserJoined(user);            });
    s.on('user:left',     ({ userId })     => { if (this.onUserLeft)     this.onUserLeft(userId);             });
    s.on('stroke:start',  (data)           => { if (this.onStrokeStart)  this.onStrokeStart(data);           });
    s.on('stroke:point',  (data)           => { if (this.onStrokePoint)  this.onStrokePoint(data);           });
    s.on('stroke:end',    (data)           => { if (this.onStrokeEnd)    this.onStrokeEnd(data);             });
    s.on('cursor:moved',  (data)           => { if (this.onCursorMoved)  this.onCursorMoved(data);           });
    s.on('error',         ({ message })    => { if (this.onError)        this.onError(message);              });

    s.on('stroke:committed', ({ strokeId, operationId }) => {
      console.log(`[ws] stroke committed: ${strokeId} → op ${operationId}`);
    });
  }

  emitStrokeStart(data) { if (this.connected) this.socket.emit('stroke:start', data); }
  emitStrokePoint(data) { if (this.connected) this.socket.emit('stroke:point', data); }
  emitStrokeEnd(data)   { if (this.connected) this.socket.emit('stroke:end',   data); }
  emitCursorMove(pos)   { if (this.connected) this.socket.emit('cursor:move',  pos);  }
  emitUndo()            { if (this.connected) this.socket.emit('undo');               }
  emitRedo()            { if (this.connected) this.socket.emit('redo');               }
  emitClear()           { if (this.connected) this.socket.emit('clear:canvas');       }
}
