/**
 * ui.js — UIManager
 *
 * Owns all DOM interactions outside of the canvas itself:
 *   - Toolbar: tool selection, color swatches, stroke width
 *   - Undo / Redo / Clear buttons
 *   - User list panel
 *   - Toast notifications
 *   - Header: connection status, room ID, FPS, latency
 *   - Size preview mini-canvas
 *
 * All callbacks that link UI events to application logic are set by
 * main.js after construction.
 */

'use strict';

// Preset color palette (matches server USER_PALETTE for harmony)
const PRESET_COLORS = [
  '#ffffff', // white
  '#000000', // black
  '#FF6B6B', // coral
  '#4ECDC4', // teal
  '#45B7D1', // sky
  '#FFEAA7', // yellow
  '#DDA0DD', // plum
  '#96CEB4', // sage
  '#F7DC6F', // gold
  '#BB8FCE', // lavender
  '#F0B27A', // peach
  '#82E0AA', // spring
];

class UIManager {
  constructor() {
    // ── DOM refs ─────────────────────────────────────────────────
    this.overlay        = document.getElementById('connection-overlay');
    this.app            = document.getElementById('app');
    this.displayNameInput = document.getElementById('display-name-input');
    this.roomIdInput    = document.getElementById('room-id-input');
    this.joinBtn        = document.getElementById('join-btn');

    this.toolBrush      = document.getElementById('tool-brush');
    this.toolEraser     = document.getElementById('tool-eraser');
    this.colorSwatches  = document.getElementById('color-swatches');
    this.colorCustom    = document.getElementById('color-custom');
    this.strokeWidth    = document.getElementById('stroke-width');
    this.widthValue     = document.getElementById('width-value');
    this.sizePreview    = document.getElementById('size-preview');

    this.btnUndo        = document.getElementById('btn-undo');
    this.btnRedo        = document.getElementById('btn-redo');
    this.btnClear       = document.getElementById('btn-clear');

    this.statusDot      = document.getElementById('connection-status');
    this.fpsCounter     = document.getElementById('fps-counter');
    this.latencyDisplay = document.getElementById('latency-display');
    this.headerRoomId   = document.getElementById('header-room-id');
    this.userList       = document.getElementById('user-list');
    this.userCount      = document.getElementById('user-count');
    this.toastContainer = document.getElementById('toast-container');

    // ── Callbacks (set by main.js) ─────────────────────────────
    this.onJoin        = null; // ({ displayName, roomId }) => void
    this.onToolChange  = null; // (tool) => void
    this.onColorChange = null; // (color) => void
    this.onWidthChange = null; // (width) => void
    this.onUndo        = null;
    this.onRedo        = null;
    this.onClear       = null;

    // ── State ──────────────────────────────────────────────────
    this._activeColor  = '#ffffff';
    this._activeSwatch = null;

    this._buildColorSwatches();
    this._bindToolbarEvents();
    this._updateSizePreview(8);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Join flow
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Show the join overlay and hide the main app.
   */
  showOverlay() {
    this.overlay.classList.remove('hidden');
    this.app.classList.add('hidden');
    this.displayNameInput.focus();
  }

  /**
   * Hide the overlay and show the main app.
   * @param {string} roomId
   */
  showApp(roomId) {
    this.overlay.classList.add('hidden');
    this.app.classList.remove('hidden');
    this.headerRoomId.textContent = roomId || 'main';
  }

  /** @private */
  _bindToolbarEvents() {
    // Join button
    this.joinBtn.addEventListener('click', () => this._handleJoin());
    this.displayNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._handleJoin();
    });
    this.roomIdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._handleJoin();
    });

    // Tools
    this.toolBrush.addEventListener('click',  () => this._selectTool('brush'));
    this.toolEraser.addEventListener('click', () => this._selectTool('eraser'));

    // Custom color picker
    this.colorCustom.addEventListener('input', (e) => {
      this._selectColor(e.target.value, null);
    });

    // Stroke width
    this.strokeWidth.addEventListener('input', (e) => {
      const w = parseInt(e.target.value, 10);
      this.widthValue.textContent = w;
      this.strokeWidth.setAttribute('aria-valuenow', w);
      this._updateSizePreview(w);
      if (this.onWidthChange) this.onWidthChange(w);
    });

    // Undo / Redo / Clear
    this.btnUndo.addEventListener('click',  () => { if (this.onUndo)  this.onUndo();  });
    this.btnRedo.addEventListener('click',  () => { if (this.onRedo)  this.onRedo();  });
    this.btnClear.addEventListener('click', () => {
      if (!confirm('Clear the entire canvas for all users?')) return;
      if (this.onClear) this.onClear();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return; // don't intercept text input
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (this.onUndo) this.onUndo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        if (this.onRedo) this.onRedo();
      }
      if (e.key === 'b' || e.key === 'B') this._selectTool('brush');
      if (e.key === 'e' || e.key === 'E') this._selectTool('eraser');
    });
  }

  /** @private */
  _handleJoin() {
    const name   = this.displayNameInput.value.trim() || `User_${Math.floor(Math.random() * 9999)}`;
    const roomId = this.roomIdInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'main';
    if (this.onJoin) this.onJoin({ displayName: name, roomId });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Tool & color
  // ═══════════════════════════════════════════════════════════════════

  /** @private */
  _selectTool(tool) {
    this.toolBrush.classList.toggle('active',  tool === 'brush');
    this.toolEraser.classList.toggle('active', tool === 'eraser');
    this.toolBrush.setAttribute('aria-pressed',  tool === 'brush');
    this.toolEraser.setAttribute('aria-pressed', tool === 'eraser');
    if (this.onToolChange) this.onToolChange(tool);
  }

  /**
   * Build preset color swatches and wire click handlers.
   * @private
   */
  _buildColorSwatches() {
    this.colorSwatches.innerHTML = '';
    PRESET_COLORS.forEach((color, i) => {
      const btn = document.createElement('button');
      btn.className   = 'swatch';
      btn.style.background = color;
      btn.title       = color;
      btn.setAttribute('aria-label', `Color: ${color}`);
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', i === 0 ? 'true' : 'false');
      btn.dataset.color = color;

      if (i === 0) {
        btn.classList.add('active');
        this._activeSwatch = btn;
        this._activeColor  = color;
      }

      btn.addEventListener('click', () => this._selectColor(color, btn));
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._selectColor(color, btn);
        }
      });

      this.colorSwatches.appendChild(btn);
    });
  }

  /** @private */
  _selectColor(color, swatchBtn) {
    this._activeColor = color;

    // Deactivate previous swatch
    if (this._activeSwatch) {
      this._activeSwatch.classList.remove('active');
      this._activeSwatch.setAttribute('aria-checked', 'false');
    }

    // Activate new swatch (if it's a preset)
    if (swatchBtn) {
      swatchBtn.classList.add('active');
      swatchBtn.setAttribute('aria-checked', 'true');
      this._activeSwatch = swatchBtn;
    } else {
      this._activeSwatch = null;
    }

    // Sync custom picker
    this.colorCustom.value = color;
    this._updateSizePreview(parseInt(this.strokeWidth.value, 10));

    if (this.onColorChange) this.onColorChange(color);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Size preview mini-canvas
  // ═══════════════════════════════════════════════════════════════════

  /** @private */
  _updateSizePreview(width) {
    const canvas = this.sizePreview;
    const ctx    = canvas.getContext('2d');
    const w      = canvas.width;
    const h      = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, Math.min(width / 2, w / 2 - 2), 0, Math.PI * 2);
    ctx.fillStyle = this._activeColor || '#ffffff';
    ctx.fill();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Connection status
  // ═══════════════════════════════════════════════════════════════════

  setConnected() {
    this.statusDot.className = 'status-dot status-connected';
    this.statusDot.title = 'Connected';
    this.statusDot.setAttribute('aria-label', 'Connection status: connected');
  }

  setConnecting() {
    this.statusDot.className = 'status-dot status-connecting';
    this.statusDot.title = 'Connecting…';
    this.statusDot.setAttribute('aria-label', 'Connection status: connecting');
  }

  setDisconnected() {
    this.statusDot.className = 'status-dot status-disconnected';
    this.statusDot.title = 'Disconnected';
    this.statusDot.setAttribute('aria-label', 'Connection status: disconnected');
  }

  setFps(fps) {
    this.fpsCounter.textContent = `${fps} FPS`;
  }

  setLatency(ms) {
    this.latencyDisplay.textContent = `${ms} ms`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Undo / Redo button state
  // ═══════════════════════════════════════════════════════════════════

  setUndoEnabled(enabled)  { this.btnUndo.disabled = !enabled; }
  setRedoEnabled(enabled)  { this.btnRedo.disabled = !enabled; }

  // ═══════════════════════════════════════════════════════════════════
  // User list
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Populate user list from an array of user objects.
   * Marks the current user's entry with "You".
   *
   * @param {UserRecord[]} users
   * @param {string}       selfId  socket.id of the current user
   */
  renderUserList(users, selfId) {
    this.userList.innerHTML = '';
    this.userCount.textContent = users.length;

    users.forEach(user => {
      this.userList.appendChild(this._buildUserItem(user, user.id === selfId));
    });
  }

  /**
   * Add a single user to the user list.
   * @param {UserRecord} user
   * @param {boolean}    isSelf
   */
  addUser(user, isSelf = false) {
    // Avoid duplicates
    const existing = document.getElementById(`user-${user.id}`);
    if (existing) return;

    this.userList.appendChild(this._buildUserItem(user, isSelf));
    this.userCount.textContent = this.userList.children.length;
  }

  /**
   * Remove a user from the user list with slide-out animation.
   * @param {string} userId
   */
  removeUser(userId) {
    const item = document.getElementById(`user-${userId}`);
    if (!item) return;

    item.style.animation = 'userSlideOut 220ms ease both';
    item.addEventListener('animationend', () => {
      item.remove();
      this.userCount.textContent = this.userList.children.length;
    }, { once: true });
  }

  /** @private */
  _buildUserItem(user, isSelf) {
    const li = document.createElement('li');
    li.className = `user-item${isSelf ? ' self' : ''}`;
    li.id = `user-${user.id}`;
    li.setAttribute('role', 'listitem');

    const initials = (user.name || '?').slice(0, 2).toUpperCase();

    li.innerHTML = `
      <div class="user-avatar" style="background: ${user.color}" aria-hidden="true">${initials}</div>
      <div class="user-info">
        <div class="user-name">${_escapeHtml(user.name)}${isSelf ? ' <span style="color:var(--text-muted);font-weight:400;font-size:0.65rem">(you)</span>' : ''}</div>
        <div class="user-status">drawing</div>
      </div>
      <div class="user-online-dot" title="Online"></div>
    `;
    return li;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Toast notifications
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Show a toast notification that auto-dismisses.
   *
   * @param {string} message
   * @param {'join'|'leave'|'info'|'error'} type
   * @param {number} [duration=3500]  ms before auto-dismiss
   */
  showToast(message, type = 'info', duration = 3500) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <div class="toast-dot"></div>
      <div class="toast-text">${_escapeHtml(message)}</div>
    `;

    this.toastContainer.appendChild(toast);

    // Auto-dismiss
    setTimeout(() => {
      toast.style.animation = 'toastOut 220ms ease both';
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
    }, duration);
  }
}

// ── Utility ──────────────────────────────────────────────────────────
function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
