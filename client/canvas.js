'use strict';

class CanvasManager {
  constructor(baseCanvas, liveCanvas) {
    this.baseCanvas = baseCanvas;
    this.liveCanvas = liveCanvas;
    this.baseCtx = baseCanvas.getContext('2d');
    this.liveCtx = liveCanvas.getContext('2d');

    this.activeTool  = 'brush';
    this.activeColor = '#ffffff';
    this.activeWidth = 8;

    this.isDrawing     = false;
    this.localPoints   = [];
    this.localStrokeId = null;

    this.remoteStrokes  = new Map();
    this.remoteCursors  = new Map();

    this._animFrameId  = null;
    this._lastFrameTime = performance.now();
    this._fpsBuffer    = [];
    this.fps = 0;

    this.onFpsUpdate   = null;
    this.onStrokeStart = null;
    this.onStrokePoint = null;
    this.onStrokeEnd   = null;
    this.onCursorMove  = null;

    this._pointBatch      = [];
    this._batchTimer      = null;
    this._BATCH_MS        = 16;
    this._lastCursorEmit  = 0;
    this._CURSOR_THROTTLE = 32;

    this._bindEvents();
    this._startLoop();
  }

  resize() {
    const container = this.liveCanvas.parentElement;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const changed = this.baseCanvas.width !== w || this.baseCanvas.height !== h;
    if (changed) {
      this.baseCanvas.width  = w;
      this.baseCanvas.height = h;
      this.liveCanvas.width  = w;
      this.liveCanvas.height = h;
    }
    return changed;
  }

  setTool(tool)   { this.activeTool  = tool;  }
  setColor(color) { this.activeColor = color; }
  setWidth(w)     { this.activeWidth = w;     }

  _bindEvents() {
    const canvas = this.liveCanvas;

    canvas.addEventListener('mousedown',  this._onPointerDown.bind(this));
    canvas.addEventListener('mousemove',  this._onPointerMove.bind(this));
    canvas.addEventListener('mouseup',    this._onPointerUp.bind(this));
    canvas.addEventListener('mouseleave', this._onPointerLeave.bind(this));

    canvas.addEventListener('touchstart',  this._onTouchStart.bind(this), { passive: false });
    canvas.addEventListener('touchmove',   this._onTouchMove.bind(this),  { passive: false });
    canvas.addEventListener('touchend',    this._onTouchEnd.bind(this),   { passive: false });
    canvas.addEventListener('touchcancel', this._onTouchEnd.bind(this),   { passive: false });
  }

  _getCanvasPos(clientX, clientY) {
    const rect = this.liveCanvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  _onPointerDown(e) {
    if (e.button !== 0) return;
    const pos = this._getCanvasPos(e.clientX, e.clientY);
    this._beginStroke(pos.x, pos.y);
  }

  _onPointerMove(e) {
    const pos = this._getCanvasPos(e.clientX, e.clientY);
    const now = Date.now();
    if (now - this._lastCursorEmit >= this._CURSOR_THROTTLE) {
      this._lastCursorEmit = now;
      if (this.onCursorMove) this.onCursorMove(pos);
    }
    if (!this.isDrawing) return;
    this._extendStroke(pos.x, pos.y);
  }

  _onPointerUp(e) {
    if (!this.isDrawing) return;
    const pos = this._getCanvasPos(e.clientX, e.clientY);
    this._extendStroke(pos.x, pos.y);
    this._endStroke();
  }

  _onPointerLeave() {
    if (this.isDrawing) this._endStroke();
  }

  _onTouchStart(e) {
    e.preventDefault();
    const t = e.touches[0];
    const pos = this._getCanvasPos(t.clientX, t.clientY);
    this._beginStroke(pos.x, pos.y);
  }

  _onTouchMove(e) {
    e.preventDefault();
    const t = e.touches[0];
    const pos = this._getCanvasPos(t.clientX, t.clientY);
    this._extendStroke(pos.x, pos.y);
    const now = Date.now();
    if (now - this._lastCursorEmit >= this._CURSOR_THROTTLE) {
      this._lastCursorEmit = now;
      if (this.onCursorMove) this.onCursorMove(pos);
    }
  }

  _onTouchEnd(e) {
    e.preventDefault();
    if (this.isDrawing) this._endStroke();
  }

  _beginStroke(x, y) {
    this.isDrawing     = true;
    this.localPoints   = [{ x, y }];
    this.localStrokeId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (this.onStrokeStart) {
      this.onStrokeStart({
        strokeId: this.localStrokeId,
        color:    this.activeTool === 'eraser' ? '#1a1d26' : this.activeColor,
        width:    this.activeWidth,
        tool:     this.activeTool,
      });
    }
  }

  _extendStroke(x, y) {
    if (!this.isDrawing) return;
    this.localPoints.push({ x, y });
    this._pointBatch.push({ x, y });

    if (!this._batchTimer) {
      this._batchTimer = setTimeout(() => {
        this._batchTimer = null;
        if (this._pointBatch.length > 0 && this.onStrokePoint) {
          this.onStrokePoint({ strokeId: this.localStrokeId, points: this._pointBatch.splice(0) });
        }
      }, this._BATCH_MS);
    }
  }

  _endStroke() {
    if (!this.isDrawing) return;
    this.isDrawing = false;

    clearTimeout(this._batchTimer);
    this._batchTimer = null;

    const strokeColor = this.activeTool === 'eraser' ? '#1a1d26' : this.activeColor;
    this._renderStrokeToBase(this.localPoints, strokeColor, this.activeWidth, this.activeTool);

    if (this.onStrokeEnd) {
      this.onStrokeEnd({
        strokeId: this.localStrokeId,
        color:    strokeColor,
        width:    this.activeWidth,
        tool:     this.activeTool,
        points:   [...this.localPoints],
      });
    }

    this.localPoints   = [];
    this.localStrokeId = null;
  }

  // Quadratic Bézier through midpoints — produces smooth natural strokes
  _drawSmooth(ctx, points, color, width, tool) {
    if (!points || points.length < 2) return;

    ctx.save();

    if (tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = color;
    }

    ctx.lineWidth  = width;
    ctx.lineCap    = 'round';
    ctx.lineJoin   = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    if (points.length === 2) {
      ctx.lineTo(points[1].x, points[1].y);
    } else {
      for (let i = 1; i < points.length - 1; i++) {
        const midX = (points[i].x + points[i + 1].x) / 2;
        const midY = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
      }
      const last = points[points.length - 1];
      ctx.lineTo(last.x, last.y);
    }

    ctx.stroke();
    ctx.restore();
  }

  _renderStrokeToBase(points, color, width, tool) {
    this._drawSmooth(this.baseCtx, points, color, width, tool);
  }

  handleRemoteStrokeStart({ strokeId, userId, color, width, tool }) {
    this.remoteStrokes.set(strokeId, { userId, color, width, tool, points: [] });
  }

  handleRemoteStrokePoint({ strokeId, points }) {
    const stroke = this.remoteStrokes.get(strokeId);
    if (!stroke) return;
    stroke.points.push(...points);
  }

  handleRemoteStrokeEnd({ strokeId, color, width, tool, points }) {
    this._renderStrokeToBase(points, color, width, tool);
    this.remoteStrokes.delete(strokeId);
  }

  // Replay all active operations — used for undo/redo/clear
  // Uses off-screen canvas for atomic swap to avoid visible flash
  replayOperations(operations) {
    const offscreen = document.createElement('canvas');
    offscreen.width  = this.baseCanvas.width;
    offscreen.height = this.baseCanvas.height;
    const octx = offscreen.getContext('2d');

    octx.fillStyle = '#1a1d26';
    octx.fillRect(0, 0, offscreen.width, offscreen.height);

    for (const op of operations) {
      if (op.type === 'stroke') {
        this._drawSmooth(octx, op.data.points, op.data.color, op.data.width, op.data.tool);
      }
    }

    this.baseCtx.clearRect(0, 0, this.baseCanvas.width, this.baseCanvas.height);
    this.baseCtx.drawImage(offscreen, 0, 0);
    this.remoteStrokes.clear();
  }

  updateRemoteCursor(userId, x, y, color, name) {
    const existing = this.remoteCursors.get(userId);
    if (existing) {
      existing.targetX = x;
      existing.targetY = y;
      existing.color   = color;
      existing.name    = name;
    } else {
      this.remoteCursors.set(userId, { x, y, targetX: x, targetY: y, color, name });
    }
  }

  removeRemoteCursor(userId) {
    this.remoteCursors.delete(userId);
  }

  _startLoop() {
    const loop = (now) => {
      this._animFrameId = requestAnimationFrame(loop);
      this._renderLive(now);
    };
    this._animFrameId = requestAnimationFrame(loop);
  }

  stopLoop() {
    if (this._animFrameId) cancelAnimationFrame(this._animFrameId);
  }

  _renderLive(now) {
    const ctx = this.liveCtx;
    const W   = this.liveCanvas.width;
    const H   = this.liveCanvas.height;

    // FPS tracking
    const dt = now - this._lastFrameTime;
    this._lastFrameTime = now;
    this._fpsBuffer.push(1000 / dt);
    if (this._fpsBuffer.length > 30) this._fpsBuffer.shift();
    const fps = Math.round(this._fpsBuffer.reduce((a, b) => a + b, 0) / this._fpsBuffer.length);
    if (fps !== this.fps) {
      this.fps = fps;
      if (this.onFpsUpdate) this.onFpsUpdate(fps);
    }

    ctx.clearRect(0, 0, W, H);

    for (const stroke of this.remoteStrokes.values()) {
      if (stroke.points.length >= 2) {
        this._drawSmooth(ctx, stroke.points, stroke.color, stroke.width, stroke.tool);
      }
    }

    if (this.isDrawing && this.localPoints.length >= 2) {
      const strokeColor = this.activeTool === 'eraser' ? 'rgba(200,200,200,0.5)' : this.activeColor;
      this._drawSmooth(ctx, this.localPoints, strokeColor, this.activeWidth, 'brush');
    }

    // Lerp cursors toward target position for smooth animation
    const LERP = 0.25;
    for (const cursor of this.remoteCursors.values()) {
      cursor.x += (cursor.targetX - cursor.x) * LERP;
      cursor.y += (cursor.targetY - cursor.y) * LERP;
      this._drawRemoteCursor(ctx, cursor);
    }
  }

  _drawRemoteCursor(ctx, cursor) {
    const { x, y, color, name } = cursor;
    ctx.save();
    ctx.translate(x, y);

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 16);
    ctx.lineTo(4, 12);
    ctx.lineTo(7, 18);
    ctx.lineTo(9, 17);
    ctx.lineTo(6, 11);
    ctx.lineTo(11, 11);
    ctx.closePath();
    ctx.fillStyle   = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth   = 1.5;
    ctx.fill();
    ctx.stroke();

    if (name) {
      const PADDING = 4;
      ctx.font = '600 10px Inter, system-ui, sans-serif';
      const textW = ctx.measureText(name).width;
      const boxW  = textW + PADDING * 2;
      const boxH  = 16;
      const bx = 12, by = 18;

      ctx.fillStyle = color;
      _roundRect(ctx, bx, by, boxW, boxH, 4);
      ctx.fill();

      ctx.fillStyle = '#fff';
      ctx.fillText(name, bx + PADDING, by + boxH - PADDING - 1);
    }

    ctx.restore();
  }
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
