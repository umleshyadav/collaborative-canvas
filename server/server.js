'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const RoomManager = require('./rooms');

const PORT = process.env.PORT || 3000;
const DEFAULT_ROOM = 'main';

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingTimeout: 60000,
});

const roomManager = new RoomManager();

app.use(express.static(path.join(__dirname, '..', 'client')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: roomManager.getRoomSummaries(),
    uptime: process.uptime(),
  });
});

io.on('connection', (socket) => {
  console.log(`[connect] socket=${socket.id}`);

  let currentRoomId = null;

  socket.on('join', ({ roomId = DEFAULT_ROOM, displayName } = {}) => {
    try {
      roomId = String(roomId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || DEFAULT_ROOM;
      currentRoomId = roomId;

      socket.join(roomId);

      const user = roomManager.addUser(roomId, socket.id, displayName);
      const drawingState = roomManager.getDrawingState(roomId);
      const users = roomManager.getUsers(roomId);

      console.log(`[join] socket=${socket.id} room=${roomId} name="${user.name}"`);

      socket.emit('canvas:state', {
        operations: drawingState.getActiveOperations(),
        users,
        self: user,
      });

      socket.to(roomId).emit('user:joined', { user });
    } catch (err) {
      console.error('[join] error:', err);
      socket.emit('error', { message: 'Failed to join room.' });
    }
  });

  socket.on('stroke:start', ({ strokeId, color, width, tool } = {}) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('stroke:start', { strokeId, userId: socket.id, color, width, tool });
  });

  socket.on('stroke:point', ({ strokeId, points } = {}) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('stroke:point', { strokeId, userId: socket.id, points });
  });

  socket.on('stroke:end', ({ strokeId, color, width, tool, points } = {}) => {
    if (!currentRoomId) return;
    try {
      const drawingState = roomManager.getDrawingState(currentRoomId);
      if (!drawingState) return;

      const op = drawingState.addOperation(socket.id, 'stroke', { strokeId, color, width, tool, points });

      socket.to(currentRoomId).emit('stroke:end', {
        operationId: op.id, strokeId, userId: socket.id, color, width, tool, points,
      });
      socket.emit('stroke:committed', { strokeId, operationId: op.id });
    } catch (err) {
      console.error('[stroke:end] error:', err);
    }
  });

  socket.on('cursor:move', ({ x, y } = {}) => {
    if (!currentRoomId) return;
    roomManager.updateCursor(currentRoomId, socket.id, x, y);
    socket.to(currentRoomId).emit('cursor:moved', { userId: socket.id, x, y });
  });

  socket.on('undo', () => {
    if (!currentRoomId) return;
    try {
      const drawingState = roomManager.getDrawingState(currentRoomId);
      if (!drawingState) return;

      const result = drawingState.undo(socket.id);
      if (!result.success) {
        socket.emit('error', { message: 'Nothing to undo.' });
        return;
      }

      io.to(currentRoomId).emit('canvas:replay', { operations: drawingState.getActiveOperations() });
      console.log(`[undo] socket=${socket.id} room=${currentRoomId}`);
    } catch (err) {
      console.error('[undo] error:', err);
    }
  });

  socket.on('redo', () => {
    if (!currentRoomId) return;
    try {
      const drawingState = roomManager.getDrawingState(currentRoomId);
      if (!drawingState) return;

      const result = drawingState.redo(socket.id);
      if (!result.success) {
        socket.emit('error', { message: 'Nothing to redo.' });
        return;
      }

      io.to(currentRoomId).emit('canvas:replay', { operations: drawingState.getActiveOperations() });
      console.log(`[redo] socket=${socket.id} room=${currentRoomId}`);
    } catch (err) {
      console.error('[redo] error:', err);
    }
  });

  socket.on('clear:canvas', () => {
    if (!currentRoomId) return;
    try {
      const drawingState = roomManager.getDrawingState(currentRoomId);
      if (!drawingState) return;

      drawingState.clearCanvas(socket.id);
      io.to(currentRoomId).emit('canvas:replay', { operations: [] });
      console.log(`[clear] socket=${socket.id} room=${currentRoomId}`);
    } catch (err) {
      console.error('[clear:canvas] error:', err);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] socket=${socket.id} reason=${reason}`);
    if (!currentRoomId) return;

    const user = roomManager.removeUser(currentRoomId, socket.id);
    if (user) {
      socket.to(currentRoomId).emit('user:left', { userId: socket.id });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n🎨  Collaborative Canvas server running`);
  console.log(`    Local:   http://localhost:${PORT}`);
  console.log(`    Health:  http://localhost:${PORT}/health\n`);
});

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0));
});
