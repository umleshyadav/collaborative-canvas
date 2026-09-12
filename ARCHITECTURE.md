# CollabCanvas — Architecture Document

> This document explains every major architectural decision made in the CollabCanvas codebase.
> It is intended for code reviewers and interviewers who want to understand the *why* behind the implementation.

---

## 1. Data Flow Diagram

How a drawing event flows from a user's mouse to every connected canvas:

```
╔══════════════════════════════════════════════════════════════════════╗
║                      USER A — BROWSER (Tab 1)                       ║
║                                                                      ║
║  mousedown / mousemove / mouseup                                     ║
║         │                                                            ║
║         ▼                                                            ║
║  CanvasManager                                                       ║
║  ._beginStroke(x, y)  →  ._extendStroke(x, y)  →  ._endStroke()    ║
║         │                       │                        │           ║
║         │          [INSTANT]    │             [INSTANT]  │           ║
║         ▼                       ▼                        ▼           ║
║  liveCanvas renders    liveCanvas renders        baseCanvas commit   ║
║  (RAF loop, 60fps)     (in-progress path)        (client prediction) ║
║         │                       │                        │           ║
║         ▼                       ▼                        ▼           ║
║  WebSocketManager.emitStrokeStart()    emitStrokePoint()  emitStrokeEnd()
╚══════════════════════════════════════════════════════════════════════╝
                     │                    │                 │
                     ▼ WebSocket (Socket.io)                ▼
╔══════════════════════════════════════════════════════════════════════╗
║                            SERVER                                    ║
║                                                                      ║
║  server.js                                                           ║
║  ├─ stroke:start  → re-emit to room  (no state change)              ║
║  ├─ stroke:point  → re-emit to room  (no state change)              ║
║  └─ stroke:end    → DrawingState.addOperation()                      ║
║                     → emit stroke:end  to room (others)             ║
║                     → emit stroke:committed  to sender (op ID)      ║
║                                                                      ║
║  RoomManager          DrawingState                                   ║
║  ├─ users Map         ├─ operations[]  (ordered log)                 ║
║  ├─ colorAssignments  ├─ userUndoStack Map                           ║
║  └─ cursors           └─ userRedoStack Map                           ║
╚══════════════════════════════════════════════════════════════════════╝
                     │
                     ▼ broadcast to room
╔══════════════════════════════════════════════════════════════════════╗
║              USER B, C, D ... — BROWSER (other tabs)                ║
║                                                                      ║
║  stroke:start  →  remoteStrokes.set(strokeId, { points:[] })        ║
║  stroke:point  →  remoteStrokes.get(strokeId).points.push(...)      ║
║  stroke:end    →  baseCanvas.commit(points)                         ║
║                   remoteStrokes.delete(strokeId)                    ║
║                                                                      ║
║  RAF loop renders liveCanvas every frame:                            ║
║  ├─ all in-progress remote strokes (from remoteStrokes Map)          ║
║  ├─ all remote user cursors (lerp-animated toward target)            ║
║  └─ local in-progress stroke (if drawing)                           ║
╚══════════════════════════════════════════════════════════════════════╝
```

### New Joiner Flow

```
New user connects
      │
      ▼
socket.emit('join', { roomId, displayName })
      │
      ▼  SERVER
RoomManager.addUser() → assigns color from palette
DrawingState.getActiveOperations() → ordered list of all committed, active ops
      │
      ▼
socket.emit('canvas:state', { operations, users, self })   ← to joiner only
socket.to(room).emit('user:joined', { user })              ← to others
      │
      ▼  CLIENT
CanvasManager.replayOperations(operations)
→ draws every op onto off-screen canvas → atomic swap to baseCanvas
→ joiner sees the full existing drawing immediately
```

---

## 2. WebSocket Protocol

All communication uses Socket.io events over WebSocket transport (falls back to HTTP long-polling if WebSocket is unavailable).

### Client → Server

| Event | Payload | When sent |
|-------|---------|-----------|
| `join` | `{ roomId: string, displayName: string }` | On page load after name entry; again on reconnect |
| `stroke:start` | `{ strokeId: string, color: string, width: number, tool: 'brush'\|'eraser' }` | On mousedown / touchstart |
| `stroke:point` | `{ strokeId: string, points: [{x,y}…] }` | Every ~16ms while drawing (batched) |
| `stroke:end` | `{ strokeId, color, width, tool, points: [{x,y}…] }` | On mouseup / touchend |
| `cursor:move` | `{ x: number, y: number }` | On mousemove, throttled to ~30fps |
| `undo` | `{}` | On Ctrl+Z or undo button click |
| `redo` | `{}` | On Ctrl+Y or redo button click |
| `clear:canvas` | `{}` | On clear button (after confirmation) |

### Server → Client

| Event | Payload | Recipients | Purpose |
|-------|---------|-----------|---------|
| `canvas:state` | `{ operations[], users[], self }` | Joining user only | Full state on join |
| `user:joined` | `{ user: UserRecord }` | Room (others) | Show new user in panel |
| `user:left` | `{ userId: string }` | Room | Remove user from panel, clear cursor |
| `stroke:start` | `{ strokeId, userId, color, width, tool }` | Room | Begin remote live stroke |
| `stroke:point` | `{ strokeId, userId, points[] }` | Room | Extend remote live stroke |
| `stroke:end` | `{ operationId, strokeId, userId, color, width, tool, points[] }` | Room (others) | Commit remote stroke to base canvas |
| `stroke:committed` | `{ strokeId, operationId }` | Originator only | Server-assigned operation ID for undo tracking |
| `cursor:moved` | `{ userId, x, y }` | Room (others) | Remote cursor position |
| `canvas:replay` | `{ operations[] }` | Entire room | Full re-render after undo/redo/clear |
| `error` | `{ message: string }` | Originator only | Nothing to undo, nothing to redo, etc. |

### Why `stroke:end` includes all points

The server stores the `points[]` array from `stroke:end` (not the batched `stroke:point` events) as the canonical, authoritative record. This ensures:
1. New joiners get complete stroke data — they never received the mid-stroke `stroke:point` events
2. Undo replay uses the full, complete path (not a partial batch)
3. The server doesn't need to maintain in-progress stroke buffers

---

## 3. Canvas Layer Architecture

### Two Stacked `<canvas>` Elements

```
┌──────────────────────────────────────────────────┐
│  liveCanvas  (z-index: 2)  — redrawn every RAF  │
│  ┌────────────────────────────────────────────┐  │
│  │  Remote user A's in-progress stroke        │  │
│  │  Remote user B's in-progress stroke        │  │
│  │  Local user's in-progress stroke            │  │
│  │  Remote cursor indicators (with labels)    │  │
│  └────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────┤
│  baseCanvas  (z-index: 1)  — redrawn on commit  │
│  ┌────────────────────────────────────────────┐  │
│  │  All committed, permanent strokes           │  │
│  │  (from all users, all sessions)             │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

**Why two layers instead of one?**

With a single canvas, every frame would require:
1. `clearRect()` the entire canvas
2. Redraw ALL committed strokes (could be hundreds)
3. Draw live strokes and cursors

For a canvas with many committed strokes, this is extremely expensive (O(n) per frame where n = committed stroke count).

With two layers:
- **baseCanvas** is only redrawn when a stroke is committed or undo/redo fires (rare)
- **liveCanvas** is cleared and redrawn every frame, but only has ephemeral data (cheap)
- Total per-frame work is O(1) for most frames

---

## 4. Undo / Redo Strategy

### Design: Server-Authoritative Event-Sourcing with Per-User LIFO Stacks

**Core idea**: Every committed drawing action is an *immutable operation* appended to an ordered log on the server. Undo/redo do not delete operations — they *toggle their `active` flag*. After any toggle, the server replays the full active operation list to all clients.

### Operation object structure

```javascript
{
  id:        "550e8400-e29b-...",  // UUID assigned by server on commit
  userId:    "socket-id-abc123",   // who drew it
  type:      "stroke",             // 'stroke' | 'clear'
  data: {
    color:   "#FF6B6B",
    width:   8,
    tool:    "brush",
    points:  [{ x: 100, y: 200 }, ...]
  },
  timestamp: 1726167000000,        // server Date.now()
  active:    true                  // false = undone
}
```

### Undo walkthrough

```
Operation Log (server):
  [op1: Alice:stroke, op2: Bob:stroke, op3: Alice:stroke]

Alice's undoStack: [op1.id, op3.id]
Bob's undoStack:   [op2.id]

─── Alice presses Ctrl+Z ───────────────────────────────────────────

1. Client emits: socket.emit('undo')

2. Server: DrawingState.undo(alice.socketId)
   → finds top of Alice's undoStack with active=true → op3
   → marks op3.active = false
   → pushes op3.id to Alice's redoStack

3. Server: getActiveOperations()
   → returns [op1, op2]  (op3 is now inactive)

4. Server: io.to(room).emit('canvas:replay', { operations: [op1, op2] })
   ← broadcasts to ALL clients in the room

5. Every client (Alice, Bob, ...):
   CanvasManager.replayOperations([op1, op2])
   → draws to off-screen canvas → atomic swap to baseCanvas
   → Alice's second stroke (op3) is gone on ALL screens

─── Alice presses Ctrl+Z again ─────────────────────────────────────

→ op1 (Alice's first stroke) is marked inactive
→ canvas:replay with [op2] → only Bob's stroke remains

─── Alice presses Ctrl+Y (Redo) ───────────────────────────────────

→ op1 is marked active again
→ canvas:replay with [op1, op2] → Alice's first stroke reappears
```

### Why per-user undo (not global undo)?

True "global undo" (where User A can undo User B's stroke) would require:
- **Operational Transform (OT)** or **CRDT** — complex algorithms used by Google Docs
- Handling cycles: A undoes B's stroke → B undoes A's undo → infinite loop
- Order ambiguity: if A draws at t=1000ms and B draws at t=1001ms, whose "last action" is it?

Per-user undo is the standard industry approach (Google Docs, Figma, Notion all work this way). It is simpler, predictable, and conflict-free.

---

## 5. Performance Decisions

### 5.1 Bézier Curve Smoothing

Raw mouse/touch events produce jagged polylines because:
- Events fire at irregular intervals (OS input processing, browser throttling)
- Each event is a discrete point, not a curve

**Solution: Quadratic Bézier through midpoints (standard canvas smoothing technique)**

```javascript
// For points p[0], p[1], ..., p[n]:
ctx.moveTo(p[0].x, p[0].y);
for (let i = 1; i < points.length - 1; i++) {
  const midX = (p[i].x + p[i+1].x) / 2;
  const midY = (p[i].y + p[i+1].y) / 2;
  // p[i] = control point, mid = end point
  ctx.quadraticCurveTo(p[i].x, p[i].y, midX, midY);
}
ctx.lineTo(p[n].x, p[n].y);
```

This produces smooth, natural brush strokes identical to professional drawing apps at zero extra memory cost.

### 5.2 requestAnimationFrame Throttling

Mouse events can fire at 200–1000 Hz on modern hardware. Rendering at that rate would waste GPU cycles.

**Solution**: Mouse handlers only *queue* data. The RAF loop *consumes* data at exactly the screen refresh rate (60fps on most displays).

```
mousemove at 500Hz  →  points[] array (queue)
                              │
                    RAF fires at 60fps
                              │
                    Drain queue → render frame
```

This ensures:
- Never more than 1 render per screen refresh (no tearing)
- No partial-frame updates
- Smooth animation regardless of input device speed

### 5.3 Network Batching for `stroke:point`

Emitting one Socket.io event per mouse point at 60fps = 60 events/second per user. With 10 users = 600 events/second on the server.

**Solution**: Batch points into arrays and emit every 16ms:

```javascript
// Points accumulate during the batch window
this._pointBatch.push({ x, y });

// Emit batch every ~16ms (60fps cap)
if (!this._batchTimer) {
  this._batchTimer = setTimeout(() => {
    socket.emit('stroke:point', { strokeId, points: this._pointBatch.splice(0) });
    this._batchTimer = null;
  }, 16);
}
```

At 60fps input with batching at 16ms, this reduces Socket.io events by **~60%** compared to per-point emission, while maintaining visually identical smoothness on the receiving end.

### 5.4 Cursor Event Throttle

Cursor positions are throttled to 30fps (every 32ms) — humans can't perceive the difference between 30fps and 60fps cursor movement, and it halves the cursor event load.

On the receiving side, cursors are **lerp-interpolated** each frame:
```javascript
cursor.x += (cursor.targetX - cursor.x) * 0.25;
cursor.y += (cursor.targetY - cursor.y) * 0.25;
```
This means even 30fps cursor updates look smooth at 60fps display because each frame moves the cursor 25% of the remaining distance to its target.

### 5.5 Off-Screen Canvas for Undo/Redo Replay

Replaying operations directly onto the baseCanvas produces a visible wipe/flash as each stroke is drawn sequentially.

**Solution**: Replay onto an invisible off-screen canvas first, then `drawImage()` the result atomically:

```javascript
const offscreen = document.createElement('canvas');
offscreen.width = this.baseCanvas.width;
offscreen.height = this.baseCanvas.height;
// ... draw all operations onto offscreen ...
// Atomic swap — one operation, no flash
this.baseCtx.drawImage(offscreen, 0, 0);
```

### 5.6 Client-Side Prediction

Local strokes are rendered immediately without waiting for server acknowledgement:
```
mousedown → render to liveCanvas → mouseup → commit to baseCanvas → emit stroke:end
```
The server's `stroke:committed` response only delivers the server-assigned operation ID. It does NOT trigger a re-render. This keeps local drawing latency at ~0ms regardless of network conditions.

### 5.7 Operation Log Cap

The server caps the operation log at 200 entries. When exceeded, the oldest *inactive* (undone) entries are trimmed first. Active entries are only removed when all inactive entries are gone and the log is still over the cap.

This bounds server memory at approximately:
```
200 ops × avg 50 points × 8 bytes/point ≈ 80KB per room
```

---

## 6. Conflict Resolution

### Scenario 1: Two users draw simultaneously in the same area

**What happens**: Both strokes are committed independently. The one committed later (by server timestamp) renders on top — standard painter's algorithm. No data is lost.

**Why acceptable**: This is identical to how pen and paper works. No "merge" of strokes is possible or desirable.

### Scenario 2: User A undoes while User B is mid-stroke

```
Timeline:
  t=0   A commits op1
  t=1   B starts drawing (stroke on B's liveCanvas only)
  t=2   A presses Ctrl+Z → server marks op1 inactive → canvas:replay fires
  t=3   B's mouseup → B's stroke:end → B's stroke added to log

Result:
  - A's undo removes op1 from all clients ✅
  - B's in-progress stroke is on B's liveCanvas, not the operation log
  - canvas:replay only touches baseCanvas, not liveCanvas → B's live stroke unaffected ✅
  - B's stroke:end commits normally as a new op ✅
```

### Scenario 3: Out-of-order network packets for `stroke:point`

Socket.io over WebSocket is an ordered protocol (TCP guarantees order). Points always arrive in the order they were sent.

If a client falls back to HTTP long-polling (unreliable networks), Socket.io's internal sequencing re-orders packets before delivering them to event handlers.

### Scenario 4: User disconnects mid-stroke

```
B is drawing → B's network drops → server receives 'disconnect' event
→ server removes B from room.users
→ server emits 'user:left' to remaining clients
→ clients remove B's entry from remoteStrokes Map
→ B's partial in-progress stroke disappears from liveCanvas ✅
→ No partial stroke is committed to the operation log ✅
```

The incomplete stroke is silently discarded — this is correct behavior. Committing a partial stroke would produce an unexpected, unremovable artifact.

### Scenario 5: Reconnection

Socket.io automatically reconnects with exponential backoff. On reconnect, the client re-emits `join`, and the server sends a fresh `canvas:state` with the full current operation log. The canvas is replayed from scratch, ensuring the rejoining user has a consistent view.

---

## 7. Error Handling

### Server-side

Every Socket.io event handler is wrapped in `try/catch`:
```javascript
socket.on('stroke:end', (data) => {
  try {
    // ...
  } catch (err) {
    console.error('[stroke:end] error:', err);
    // Server continues serving other clients
  }
});
```

Errors do not crash the server or affect other users' sessions.

### Client-side

- **Socket.io transport errors**: Logged to console; UI shows orange connecting status dot
- **Server-emitted errors** (e.g. "Nothing to undo"): Shown as a toast notification; undo button is disabled
- **Canvas resize**: Handled via debounced resize observer; state is re-requested from server
- **Reconnection**: Automatic with Socket.io; canvas state is re-synced on rejoin

---

## 8. Scaling to 1000 Concurrent Users

The current architecture is single-process. To scale horizontally:

### Problem: Multiple server instances can't share room state

If User A connects to Server 1 and User B connects to Server 2, broadcasts from Server 1 don't reach Server 2's clients.

### Solution 1: Redis Socket.io Adapter

```javascript
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');

const pubClient = createClient({ url: 'redis://...' });
const subClient = pubClient.duplicate();
io.adapter(createAdapter(pubClient, subClient));
```

Now all Socket.io instances share a pub/sub channel through Redis. `io.to(room).emit()` works across instances.

### Solution 2: Persistent Canvas State

Move `DrawingState` from server memory to Redis or PostgreSQL:
```
addOperation()  →  INSERT INTO operations (id, room_id, user_id, data, active)
undo()          →  UPDATE operations SET active=false WHERE ...
getActive()     →  SELECT * FROM operations WHERE room_id=? AND active=true ORDER BY created_at
```

### Solution 3: Sticky Sessions (Load Balancer)

Require the load balancer to route all connections from the same client to the same server instance (session affinity). This reduces cross-instance traffic but limits horizontal scaling to room-level.

### Solution 4: Separate Cursor Event Channel

At 1000 users × 30fps = 30,000 cursor events/second, cursor events become the bottleneck. Options:
- **WebTransport (QUIC)** for cursor events — lower overhead than TCP for ephemeral, lossy data
- **Reduce emit rate** on large rooms (e.g. 10fps when > 50 users)
- **Region-only cursor visibility** — only emit cursors to users whose viewport overlaps

### Rough capacity estimate

| Metric | Single Node.js Process |
|--------|----------------------|
| Concurrent WebSocket connections | ~10,000 |
| Active drawing users (high event rate) | ~500 |
| Rooms | Unlimited (memory-bound) |
| Events/second (500 users, drawing) | ~15,000 stroke:point events |
| Memory per room (200 ops) | ~80KB |

For 1000 active drawing users: 2 Node.js instances behind an nginx load balancer + Redis adapter is sufficient.
