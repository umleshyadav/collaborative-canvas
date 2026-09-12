'use strict';

(function () {
  let selfId = null;
  const users = new Map();

  const ui = new UIManager();
  const baseCanvas = document.getElementById('base-canvas');
  const liveCanvas = document.getElementById('live-canvas');
  const canvasManager = new CanvasManager(baseCanvas, liveCanvas);
  const wsManager = new WebSocketManager(window.location.origin);

  ui.onJoin = ({ displayName, roomId }) => {
    wsManager.roomId      = roomId;
    wsManager.displayName = displayName;
    ui.showApp(roomId);
    ui.setConnecting();
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

  canvasManager.onStrokeStart = (data) => wsManager.emitStrokeStart(data);
  canvasManager.onStrokePoint = (data) => wsManager.emitStrokePoint(data);
  canvasManager.onStrokeEnd   = (data) => {
    wsManager.emitStrokeEnd(data);
    ui.setUndoEnabled(true);
  };
  canvasManager.onCursorMove = (pos) => wsManager.emitCursorMove(pos);
  canvasManager.onFpsUpdate  = (fps) => ui.setFps(fps);

  wsManager.onConnected    = () => ui.setConnected();
  wsManager.onDisconnected = (reason) => {
    ui.setDisconnected();
    ui.showToast(`Disconnected: ${reason}. Reconnecting…`, 'error', 5000);
  };
  wsManager.onLatencyUpdate = (ms) => ui.setLatency(ms);

  wsManager.onCanvasState = ({ operations, users: serverUsers, self: selfUser }) => {
    selfId = selfUser.id;
    users.clear();
    for (const u of serverUsers) users.set(u.id, u);

    ui.renderUserList(serverUsers, selfId);
    canvasManager.resize();
    canvasManager.replayOperations(operations);

    const myOps = operations.filter(op => op.userId === selfId);
    ui.setUndoEnabled(myOps.length > 0);
  };

  wsManager.onUserJoined = (user) => {
    users.set(user.id, user);
    ui.addUser(user, user.id === selfId);
    ui.showToast(`${user.name} joined`, 'join');
  };

  wsManager.onUserLeft = (userId) => {
    const user = users.get(userId);
    users.delete(userId);
    ui.removeUser(userId);
    canvasManager.removeRemoteCursor(userId);
    ui.showToast(`${user ? user.name : 'Someone'} left`, 'leave');
  };

  wsManager.onStrokeStart = (data) => canvasManager.handleRemoteStrokeStart(data);
  wsManager.onStrokePoint = (data) => canvasManager.handleRemoteStrokePoint(data);
  wsManager.onStrokeEnd   = (data) => canvasManager.handleRemoteStrokeEnd(data);

  wsManager.onCursorMoved = ({ userId, x, y }) => {
    const user = users.get(userId);
    if (!user) return;
    canvasManager.updateRemoteCursor(userId, x, y, user.color, user.name);
  };

  wsManager.onCanvasReplay = (operations) => {
    canvasManager.replayOperations(operations);
    const myOps = operations.filter(op => op.userId === selfId);
    ui.setUndoEnabled(myOps.length > 0);
    ui.setRedoEnabled(true);
  };

  wsManager.onError = (message) => {
    ui.showToast(message, 'error');
    if (message === 'Nothing to undo.') ui.setUndoEnabled(false);
    if (message === 'Nothing to redo.') ui.setRedoEnabled(false);
  };

  // Re-request canvas state after resize since resizing clears the canvas
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const changed = canvasManager.resize();
      if (changed && wsManager.socket) {
        wsManager.socket.emit('join', { roomId: wsManager.roomId, displayName: wsManager.displayName });
      }
    }, 200);
  });

  ui.setUndoEnabled(false);
  ui.setRedoEnabled(false);
  ui.showOverlay();

})();
