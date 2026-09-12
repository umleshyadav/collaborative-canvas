/**
 * canvas.js — CanvasManager
 *
 * Owns all HTML5 Canvas rendering for the collaborative drawing app.
 *
 * Layer strategy
 * ──────────────
 * Two stacked <canvas> elements share the same pixel dimensions:
 *
 *   baseCanvas  (z-index 1) — committed, permanent strokes.
 *                              Only changes on stroke:end or canvas:replay.
 *   liveCanvas  (z-index 2) — ephemeral, in-progress strokes (local + remote)
 *                              plus remote user cursor indicators.
 *                              Redrawn every animation frame.
 *
 * Live canvas rendering loop
 * ──────────────────────────
 * A single requestAnimationFrame loop runs continuously while the app is
 * active. Each frame it:
 *   1. Clears the live canvas.
 *   2. Draws each remote user's active in-progress stroke.
 *   3. Draws each remote user's cursor indicator.
 *   4. Draws the local user's in-progress stroke (if drawing).
 *
 * This avoids tearing between the local and remote layers.
 *
 * Bézier smoothing
 * ────────────────
 * Raw mouse events produce jagged polylines. We smooth them by drawing
 * quadratic Bézier curves through midpoints of consecutive input points.
 * The formula is: mid = average(p[i], p[i+1]); draw bezierTo(p[i], mid).
 * This is the standard "chaikin-like" canvas smoothing technique.
 *
 * Performance decisions
 * ─────────────────────
 * - Mouse events queued into a points array; RAF drains the queue.
 * - Remote stroke points arrive batched; appended to per-stroke buffers.
 * - Replay (undo/redo) uses an off-screen canvas for atomic swap.
 * - Remote cursor positions are interpolated toward target each frame
 *   for a smooth lerp animation instead of teleporting.
 */

'use strict';

class CanvasManager {
  /**
   * @param {HTMLCanvasElement} baseCanvas
   * @param {HTMLCanvasElement} liveCanvas
   */
  constructor(baseCanvas, liveCanvas) {
    this.baseCanvas = baseCanvas;
    this.liveCanvas = liveCanvas;
    this.baseCtx = baseCanvas.getContext('2d');
    this.liveCtx = liveCanvas.getContext('2d');

    // ── Tool state ─────────────────────────────────────────────────
    this.activeTool  = 'brush'; // 'brush' | 'eraser'
    this.activeColor = '#ffffff';
    this.activeWidth = 8;

    // ── Local drawing state ────────────────────────────────────────
    /** @type {boolean} Is the local user currently drawing? */
    this.isDrawing = false;
    /** @type {{x:number, y:number}[]} Points collected this stroke */
    this.localPoints = [];
    /** @type {string|null} strokeId of the current local stroke */
    this.localStrokeId = null;

    // ── Remote drawing state ───────────────────────────────────────
    /**
     * Active in-progress strokes from remote users.
     * Map<strokeId, { userId, color, width, tool, points[] }>
     */
    this.remoteStrokes = new Map();

    // ── Remote cursors ─────────────────────────────────────────────
    /**
     * Map<userId, { x, y, targetX, targetY, color, name }>
     * We lerp toward target for smooth cursor movement.
     */
    this.remoteCursors = new Map();

    // ── RAF loop ───────────────────────────────────────────────────
    this._animFrameId = null;
    this._lastFrameTime = performance.now();
    this._fpsBuffer = [];  // rolling window for FPS calc
    this.fps = 0;

    // ── FPS callback ───────────────────────────────────────────────
    /** @type {function(number)|null} Called each frame with current FPS */
    this.onFpsUpdate = null;

    // ── Event callbacks (wired by main.js) ─────────────────────────
    /** @type {function({strokeId, color, width, tool})|null} */
    this.onStrokeStart = null;
    /** @type {function({strokeId, points[]})|null} */
    this.onStrokePoint = null;
    /** @type {function({strokeId, color, width, tool, points[]})|null} */
    this.onStrokeEnd   = null;
    /** @type {function({x, y})|null} */
    this.onCursorMove  = null;

    // Point batching (16ms ≈ 60fps cap for network events)
    this._pointBatch = [];
    this._batchTimer = null;
    this._BATCH_MS   = 16;

    // Cursor move throttle
    this._lastCursorEmit = 0;
    this._CURSOR_THROTTLE_MS = 32; // ~30fps for cursor

    this._bindEvents();
    this._startLoop();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Resize
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Resize both canvases to match their CSS-rendered size.
   * Must be called on window resize AND on initial mount.
   * Returns true if dimensions changed.
   *
   * NOTE: Resizing a canvas clears it — after resize we replay the
   * operation log to restore the base layer.
   */
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

  // ═══════════════════════════════════════════════════════════════════
  // Tool configuration
  // ═══════════════════════════════════════════════════════════════════

  setTool(tool)   { this.activeTool  = tool;  }
  setColor(color) { this.activeColor = color; }
  setWidth(w)     { this.activeWidth = w;     }

  // ═══════════════════════════════════════════════════════════════════
  // Local drawing — input handlers
  // ═══════════════════════════════════════════════════════════════════

  /** @private */
  _bindEvents() {
    const canvas = this.liveCanvas;

    // Mouse events
    canvas.addEventListener('mousedown',  this._onPointerDown.bind(this));
    canvas.addEventListener('mousemove',  this._onPointerMove.bind(this));
    canvas.addEventListener('mouseup',    this._onPointerUp.bind(this));
    canvas.addEventListener('mouseleave', this._onPointerLeave.bind(this));

    // Touch events (mobile support)
    canvas.addEventListener('touchstart',  this._onTouchStart.bind(this), { passive: false });
    canvas.addEventListener('touchmove',   this._onTouchMove.bind(this),  { passive: false });
    canvas.addEventListener('touchend',    this._onTouchEnd.bind(this),   { passive: false });
    canvas.addEventListener('touchcancel', this._onTouchEnd.bind(this),   { passive: false });
  }

  /** @private */
  _getCanvasPos(clientX, clientY) {
    const rect = this.liveCanvas.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  /** @private */
  _onPointerDown(e) {
    if (e.button !== 0) return; // left button only
    const pos = this._getCanvasPos(e.clientX, e.clientY);
    this._beginStroke(pos.x, pos.y);
  }

  /** @private */
  _onPointerMove(e) {
    const pos = this._getCanvasPos(e.clientX, e.clientY);

    // Emit cursor position to server (throttled)
    const now = Date.now();
    if (now - this._lastCursorEmit >= this._CURSOR_THROTTLE_MS) {
      this._lastCursorEmit = now;
      if (this.onCursorMove) this.onCursorMove(pos);
    }

    if (!this.isDrawing) return;
    this._extendStroke(pos.x, pos.y);
  }

  /** @private */
  _onPointerUp(e) {
    if (!this.isDrawing) return;
    const pos = this._getCanvasPos(e.clientX, e.clientY);
    this._extendStroke(pos.x, pos.y);
    this._endStroke();
  }

  /** @private */
  _onPointerLeave() {
    if (this.isDrawing) this._endStroke();
  }

  // Touch adapters
  /** @private */
  _onTouchStart(e) {
    e.preventDefault();
    const t = e.touches[0];
    const pos = this._getCanvasPos(t.clientX, t.clientY);
    this._beginStroke(pos.x, pos.y);
  }

  /** @private */
  _onTouchMove(e) {
    e.preventDefault();
    const t = e.touches[0];
    const pos = this._getCanvasPos(t.clientX, t.clientY);
    this._extendStroke(pos.x, pos.y);
    // Also emit cursor
    const now = Date.now();
    if (now - this._lastCursorEmit >= this._CURSOR_THROTTLE_MS) {
      this._lastCursorEmit = now;
      if (this.onCursorMove) this.onCursorMove(pos);
    }
  }

  /** @private */
  _onTouchEnd(e) {
    e.preventDefault();
    if (this.isDrawing) this._endStroke();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Stroke lifecycle
  // ═══════════════════════════════════════════════════════════════════

  /** @private */
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

  /** @private */
  _extendStroke(x, y) {
    if (!this.isDrawing) return;
    this.localPoints.push({ x, y });

    // Batch for network emission
    this._pointBatch.push({ x, y });
    if (!this._batchTimer) {
      this._batchTimer = setTimeout(() => {
        this._batchTimer = null;
        if (this._pointBatch.length > 0 && this.onStrokePoint) {
          this.onStrokePoint({
            strokeId: this.localStrokeId,
            points:   this._pointBatch.splice(0),
          });
        }
      }, this._BATCH_MS);
    }
  }

  /** @private */
  _endStroke() {
    if (!this.isDrawing) return;
    this.isDrawing = false;

    // Flush any remaining batched points
    clearTimeout(this._batchTimer);
    this._batchTimer = null;

    // Commit the stroke to the base canvas immediately (client-side prediction)
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

  // ═══════════════════════════════════════════════════════════════════
  // Core drawing primitives
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Draw a smooth stroke using quadratic Bézier curves on a given context.
   * Uses midpoint technique for smoothness: draws bezier from p[i] to
   * mid(p[i], p[i+1]) using p[i] as the control point.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {{x:number, y:number}[]} points
   * @param {string} color
   * @param {number} width
   * @param {string} tool  'brush' | 'eraser'
   */
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

    ctx.lineWidth   = width;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

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
      // Connect to the last point
      const last = points[points.length - 1];
      ctx.lineTo(last.x, last.y);
    }

    ctx.stroke();
    ctx.restore();
  }

  /**
   * Render a completed stroke onto the base (permanent) canvas.
   * @private
   */
  _renderStrokeToBase(points, color, width, tool) {
    this._drawSmooth(this.baseCtx, points, color, width, tool);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Remote stroke handling
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Called when a remote user starts a new stroke.
   *
   * @param {{ strokeId, userId, color, width, tool }} data
   */
  handleRemoteStrokeStart({ strokeId, userId, color, width, tool }) {
    this.remoteStrokes.set(strokeId, { userId, color, width, tool, points: [] });
  }

  /**
   * Called when batched points arrive for a remote in-progress stroke.
   * Points are accumulated for live-layer rendering.
   *
   * @param {{ strokeId, userId, points }} data
   */
  handleRemoteStrokePoint({ strokeId, points }) {
    const stroke = this.remoteStrokes.get(strokeId);
    if (!stroke) return;
    stroke.points.push(...points);
  }

  /**
   * Called when a remote stroke is completed.
   * The final stroke (with all points) is committed to the base canvas
   * and removed from the live remote-stroke map.
   *
   * @param {{ strokeId, color, width, tool, points }} data
   */
  handleRemoteStrokeEnd({ strokeId, color, width, tool, points }) {
    // Commit to base canvas using authoritative server data
    this._renderStrokeToBase(points, color, width, tool);
    // Remove from live layer
    this.remoteStrokes.delete(strokeId);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Canvas replay (undo / redo / clear)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Replay a full ordered list of active operations onto the base canvas.
   * Uses an off-screen canvas for atomic swap to avoid flash.
   *
   * @param {Operation[]} operations
   */
  replayOperations(operations) {
    // Create off-screen canvas at same dimensions
    const offscreen = document.createElement('canvas');
    offscreen.width  = this.baseCanvas.width;
    offscreen.height = this.baseCanvas.height;
    const octx = offscreen.getContext('2d');

    // Clear with canvas background color
    octx.fillStyle = '#1a1d26';
    octx.fillRect(0, 0, offscreen.width, offscreen.height);

    // Replay each operation in order
    for (const op of operations) {
      if (op.type === 'stroke') {
        this._drawSmooth(octx, op.data.points, op.data.color, op.data.width, op.data.tool);
      }
      // 'clear' ops are handled implicitly by the blank fill above
    }

    // Atomic swap: copy off-screen canvas to base canvas
    this.baseCtx.clearRect(0, 0, this.baseCanvas.width, this.baseCanvas.height);
    this.baseCtx.drawImage(offscreen, 0, 0);

    // Clear any in-progress remote strokes (they'll re-arrive if needed)
    this.remoteStrokes.clear();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Remote cursors
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Update a remote user's cursor target position.
   * We lerp toward it each frame for smooth animation.
   *
   * @param {string} userId
   * @param {number} x
   * @param {number} y
   * @param {string} color
   * @param {string} name
   */
  updateRemoteCursor(userId, x, y, color, name) {
    const existing = this.remoteCursors.get(userId);
    if (existing) {
      existing.targetX = x;
      existing.targetY = y;
      existing.color   = color;
      existing.name    = name;
    } else {
      this.remoteCursors.set(userId, {
        x, y,           // current interpolated position
        targetX: x,
        targetY: y,
        color,
        name,
      });
    }
  }

  /**
   * Remove a remote user's cursor (they disconnected).
   *
   * @param {string} userId
   */
  removeRemoteCursor(userId) {
    this.remoteCursors.delete(userId);
  }

  // ═══════════════════════════════════════════════════════════════════
  // RAF rendering loop
  // ═══════════════════════════════════════════════════════════════════

  /** @private */
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

  /**
   * Render the live canvas: in-progress strokes + remote cursors.
   * @private
   */
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

    // Draw remote in-progress strokes
    for (const stroke of this.remoteStrokes.values()) {
      if (stroke.points.length >= 2) {
        this._drawSmooth(ctx, stroke.points, stroke.color, stroke.width, stroke.tool);
      }
    }

    // Draw local in-progress stroke
    if (this.isDrawing && this.localPoints.length >= 2) {
      const strokeColor = this.activeTool === 'eraser' ? 'rgba(200,200,200,0.5)' : this.activeColor;
      this._drawSmooth(ctx, this.localPoints, strokeColor, this.activeWidth, 'brush');
    }

    // Draw remote cursors (lerp toward target)
    const LERP = 0.25; // interpolation factor per frame
    for (const [userId, cursor] of this.remoteCursors) {
      cursor.x += (cursor.targetX - cursor.x) * LERP;
      cursor.y += (cursor.targetY - cursor.y) * LERP;
      this._drawRemoteCursor(ctx, cursor);
    }
  }

  /**
   * Draw a single remote cursor indicator (arrow + label).
   * @private
   */
  _drawRemoteCursor(ctx, cursor) {
    const { x, y, color, name } = cursor;

    ctx.save();
    ctx.translate(x, y);

    // Custom arrow cursor path
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 16);
    ctx.lineTo(4, 12);
    ctx.lineTo(7, 18);
    ctx.lineTo(9, 17);
    ctx.lineTo(6, 11);
    ctx.lineTo(11, 11);
    ctx.closePath();
    ctx.fillStyle    = color;
    ctx.strokeStyle  = 'rgba(0,0,0,0.5)';
    ctx.lineWidth    = 1.5;
    ctx.fill();
    ctx.stroke();

    // Name label
    if (name) {
      const PADDING = 4;
      ctx.font = '600 10px Inter, system-ui, sans-serif';
      const textW = ctx.measureText(name).width;
      const boxW  = textW + PADDING * 2;
      const boxH  = 16;
      const bx    = 12;
      const by    = 18;

      ctx.fillStyle = color;
      _roundRect(ctx, bx, by, boxW, boxH, 4);
      ctx.fill();

      ctx.fillStyle = '#fff';
      ctx.fillText(name, bx + PADDING, by + boxH - PADDING - 1);
    }

    ctx.restore();
  }
}

// ── Helper: rounded rect (no built-in in older browsers) ─────────────
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
