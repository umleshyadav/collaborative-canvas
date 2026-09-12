/**
 * server.js — Express + Socket.io entry point.
 *
 * Serves the static client/ directory and handles all WebSocket events.
 *
 * Socket.io Event Protocol
 * ────────────────────────
 * Client → Server
 *   join            { roomId, displayName }
 *   stroke:start    { strokeId, color, width, tool }
 *   stroke:point    { strokeId, points: [{x,y}] }   ← batched
 *   stroke:end      { strokeId, color, width, tool, points: [{x,y}] }
 *   cursor:move     { x, y }
 *   undo            {}
 *   redo            {}
 *   clear:canvas    {}
 *
 * Server → Client (broadcast)
 *   canvas:state    { operations[], users[] }         ← on join
 *   user:joined     { user }
 *   user:left       { userId }
 *   stroke:start    { strokeId, userId, color, width, tool }
 *   stroke:point    { strokeId, userId, points }
 *   stroke:end      { strokeId, userId, color, width, tool, points }
 *   cursor:moved    { userId, x, y }
 *   canvas:replay   { operations[] }                  ← after undo/redo/clear
 *   error           { message }
 */

'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const RoomManager = require('./rooms');

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const DEFAULT_ROOM = 'main';

// ─── App bootstrap ─────────────────────────────────────────────────────────

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  // Increase ping timeout for slow networks
  pingTimeout: 60000,
});

const roomManager = new RoomManager();

// Serve client static files
app.use(express.static(path.join(__dirname, '..', 'client')));

// Health check endpoint (useful for deployment platforms)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: roomManager.getRoomSummaries(),
    uptime: process.uptime(),
  });
});

// ─── Socket.io handlers ───────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[connect] socket=${socket.id}`);

  /**
   * Track which room this socket is in so we can look it up on disconnect
   * without requiring the client to send roomId on every event.
   */
  let currentRoomId = null;

  // ── join ────────────────────────────────────────────────────────────────
  socket.on('join', ({ roomId = DEFAULT_ROOM, displayName } = {}) => {
    try {
      // Sanitize roomId — allow only alphanumeric + dash/underscore
      roomId = String(roomId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || DEFAULT_ROOM;
      currentRoomId = roomId;

      socket.join(roomId);

      const user = roomManager.addUser(roomId, socket.id, displayName);
      const drawingState = roomManager.getDrawingState(roomId);
      const users = roomManager.getUsers(roomId);

      console.log(`[join] socket=${socket.id} room=${roomId} name="${user.name}"`);

      // Send current canvas state only to the joining user
      socket.emit('canvas:state', {
        operations: drawingState.getActiveOperations(),
        users,
        self: user,
      });

      // Notify everyone else in the room
      socket.to(roomId).emit('user:joined', { user });
    } catch (err) {
      console.error('[join] error:', err);
      socket.emit('error', { message: 'Failed to join room.' });
    }
  });

  // ── stroke:start ────────────────────────────────────────────────────────
  socket.on('stroke:start', ({ strokeId, color, width, tool } = {}) => {
    if (!currentRoomId) return;
    // Broadcast immediately so other clients can start rendering the live path
    socket.to(currentRoomId).emit('stroke:start', {
      strokeId,
      userId: socket.id,
      color,
      width,
      tool,
    });
  });

  // ── stroke:point ────────────────────────────────────────────────────────
  // Clients send batched point arrays (every ~16ms). Server just re-emits.
  socket.on('stroke:point', ({ strokeId, points } = {}) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('stroke:point', {
      strokeId,
      userId: socket.id,
      points,
    });
  });

  // ── stroke:end ──────────────────────────────────────────────────────────
  // Stroke is complete — commit to the operation log.
  socket.on('stroke:end', ({ strokeId, color, width, tool, points } = {}) => {
    if (!currentRoomId) return;
    try {
      const drawingState = roomManager.getDrawingState(currentRoomId);
      if (!drawingState) return;

      const op = drawingState.addOperation(socket.id, 'stroke', {
        strokeId,
        color,
        width,
        tool,
        points,
      });

      // Broadcast the committed operation (includes server-assigned op.id)
      socket.to(currentRoomId).emit('stroke:end', {
        operationId: op.id,
        strokeId,
        userId: socket.id,
        color,
        width,
        tool,
        points,
      });

      // Also inform the originating client of its server-assigned operationId
      // (used for undo targeting)
      socket.emit('stroke:committed', { strokeId, operationId: op.id });
    } catch (err) {
      console.error('[stroke:end] error:', err);
    }
  });

  // ── cursor:move ─────────────────────────────────────────────────────────
  socket.on('cursor:move', ({ x, y } = {}) => {
    if (!currentRoomId) return;
    roomManager.updateCursor(currentRoomId, socket.id, x, y);
    socket.to(currentRoomId).emit('cursor:moved', { userId: socket.id, x, y });
  });

  // ── undo ────────────────────────────────────────────────────────────────
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

      // Send full active operation list so all clients replay identically
      const ops = drawingState.getActiveOperations();
      io.to(currentRoomId).emit('canvas:replay', { operations: ops });

      console.log(`[undo] socket=${socket.id} room=${currentRoomId} op=${result.operationId}`);
    } catch (err) {
      console.error('[undo] error:', err);
    }
  });

  // ── redo ────────────────────────────────────────────────────────────────
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

      const ops = drawingState.getActiveOperations();
      io.to(currentRoomId).emit('canvas:replay', { operations: ops });

      console.log(`[redo] socket=${socket.id} room=${currentRoomId} op=${result.operationId}`);
    } catch (err) {
      console.error('[redo] error:', err);
    }
  });

  // ── clear:canvas ─────────────────────────────────────────────────────────
  socket.on('clear:canvas', () => {
    if (!currentRoomId) return;
    try {
      const drawingState = roomManager.getDrawingState(currentRoomId);
      if (!drawingState) return;

      drawingState.clearCanvas(socket.id);

      // Empty operation list → clients clear their canvases
      io.to(currentRoomId).emit('canvas:replay', { operations: [] });

      console.log(`[clear] socket=${socket.id} room=${currentRoomId}`);
    } catch (err) {
      console.error('[clear:canvas] error:', err);
    }
  });

  // ── disconnect ──────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] socket=${socket.id} reason=${reason}`);
    if (!currentRoomId) return;

    const user = roomManager.removeUser(currentRoomId, socket.id);
    if (user) {
      socket.to(currentRoomId).emit('user:left', { userId: socket.id });
    }
  });
});

// ─── Start server ─────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n🎨  Collaborative Canvas server running`);
  console.log(`    Local:   http://localhost:${PORT}`);
  console.log(`    Health:  http://localhost:${PORT}/health\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  httpServer.close(() => process.exit(0));
});
