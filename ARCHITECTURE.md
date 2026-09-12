# CollabCanvas — Architecture Document

## 1. Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         BROWSER (Tab A)                         │
│                                                                 │
│  Mouse/Touch event                                              │
│        │                                                        │
│        ▼                                                        │
│  CanvasManager._beginStroke / _extendStroke / _endStroke        │
│        │                                                        │
│        ├─── [INSTANT] Render to liveCanvas (RAF loop)          │
│        │                                                        │
│        ├─── [INSTANT on end] Commit to baseCanvas              │
│        │    (client-side prediction — no server round-trip)    │
│        │                                                        │
│        └─── WebSocketManager.emitStroke* ──────────────────┐   │
└────────────────────────────────────────────────────────────│───┘
                                                             │
                              WebSocket (Socket.io)          │
                                                             ▼
                             ┌───────────────────────────────────┐
                             │            SERVER                 │
                             │                                   │
                             │  server.js (Socket.io handler)    │
                             │       │                           │
                             │       ├─ stroke:start → re-emit   │
                             │       │    to room (no log)       │
                             │       │                           │
                             │       ├─ stroke:point → re-emit   │
                             │       │    to room (no log)       │
                             │       │                           │
                             │       └─ stroke:end →             │
                             │            DrawingState.           │
                             │            addOperation()         │
                             │            → emit stroke:end      │
                             │              + stroke:committed   │
                             │                                   │
                             │  RoomManager: users, colors       │
                             │  DrawingState: operation log      │
                             └───────────────────────────────────┘
                                              │
                              WebSocket broadcast to room
                                              │
                             ┌────────────────▼──────────────────┐
                             │         BROWSER (Tab B, C, …)     │
                             │                                   │
                             │  stroke:start → remoteStrokes.set │
                             │  stroke:point → remoteStrokes     │
                             │                 .get().push()     │
                             │  stroke:end  → baseCanvas commit  │
                             │               + remoteStrokes.del │
                             │                                   │
                             │  RAF loop renders live layer       │
                             │  (in-progress remote strokes      │
                             │   + remote cursors)               │
                             └───────────────────────────────────┘
```

---

## 2. WebSocket Protocol

All messages use Socket.io's event system over WebSocket transport.

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `join` | `{ roomId, displayName }` | Join or create a room |
| `stroke:start` | `{ strokeId, color, width, tool }` | Begin a new stroke |
| `stroke:point` | `{ strokeId, points: [{x,y}…] }` | Batched mid-stroke points (~60fps cap) |
| `stroke:end` | `{ strokeId, color, width, tool, points: [{x,y}…] }` | Finalize stroke with full points |
| `cursor:move` | `{ x, y }` | Cursor position (~30fps cap) |
| `undo` | `{}` | Request undo of own last operation |
| `redo` | `{}` | Request redo |
| `clear:canvas` | `{}` | Clear the entire canvas |

### Server → Client (broadcast)

| Event | Payload | Recipients | Description |
|---|---|---|---|
| `canvas:state` | `{ operations[], users[], self }` | Joining user only | Full state snapshot |
| `user:joined` | `{ user }` | Room (except joiner) | New user notification |
| `user:left` | `{ userId }` | Room | Disconnection notification |
| `stroke:start` | `{ strokeId, userId, color, width, tool }` | Room | Begin remote stroke |
| `stroke:point` | `{ strokeId, userId, points }` | Room | Remote stroke points |
| `stroke:end` | `{ operationId, strokeId, userId, color, width, tool, points }` | Room | Commit remote stroke |
| `stroke:committed` | `{ strokeId, operationId }` | Originator only | Server-assigned op ID |
| `cursor:moved` | `{ userId, x, y }` | Room | Remote cursor position |
| `canvas:replay` | `{ operations[] }` | Room (all) | Post-undo/redo full replay |
| `error` | `{ message }` | Originator only | Error notification |

---

## 3. Undo / Redo Strategy

### Design Choice: Server-authoritative operation log with per-user stacks

**Why not client-side undo?**
If each client maintained its own undo stack, undoing a stroke would only update that client's canvas. Other clients would still show the old stroke. This breaks consistency.

**How it works:**

```
Operation Log (server, ordered by commit time):
  [op1: UserA:stroke, op2: UserB:stroke, op3: UserA:stroke]

User A's undo stack: [op1.id, op3.id]
User B's undo stack: [op2.id]

UserA presses Undo:
  → Server marks op3.active = false
  → Server emits canvas:replay with [op1, op2] (active only)
  → ALL clients clear + replay → consistent state

UserA presses Undo again:
  → Server marks op1.active = false
  → Server emits canvas:replay with [op2] only

UserA presses Redo:
  → Server marks op1.active = true
  → Server emits canvas:replay with [op1, op2]
```

**Conflict scenario:**
> User A undoes while User B is drawing

1. User B's current in-progress stroke is on B's live canvas (not yet committed).
2. Server receives User A's undo → marks A's last op inactive.
3. `canvas:replay` fires → base canvas is replayed without A's op.
4. User B's in-progress stroke exists only on B's live canvas; it is unaffected.
5. When B commits, the stroke is appended to the (now shorter) log.

**Result:** No data loss. Each user's history is independent; undo only affects the requesting user's own operations.

### Complexity trade-off

Full "collaborative undo" (where User A can undo User B's stroke) was intentionally not implemented. It would require:
- Operational transform or CRDT conflict resolution
- Much more complex replay logic
- Potential for infinite undo/redo loops between users

The per-user scope is the standard industry approach (e.g., Google Docs undo behavior).

---

## 4. Canvas Layer Architecture

```
┌────────────────────────────────────────┐
│  liveCanvas  (z-index: 2)              │  ← Redrawn every frame by RAF loop
│  - In-progress remote strokes          │
│  - In-progress local stroke            │
│  - Remote cursor indicators            │
├────────────────────────────────────────┤
│  baseCanvas  (z-index: 1)              │  ← Only redrawn on commit or replay
│  - All committed, permanent strokes    │
└────────────────────────────────────────┘
```

**Why two canvases?**

If we drew everything on one canvas, we would need to clear and redraw the entire canvas every frame (including all committed strokes) just to update cursor positions. This scales poorly.

With two layers, the base canvas is only touched when strokes are committed or undo/redo fires. The live canvas is cheap to clear/redraw every frame because it only contains ephemeral data.

---

## 5. Performance Decisions

### Bézier curve smoothing
Raw mouse events produce jagged polylines because they arrive at irregular intervals depending on OS/browser input processing. We apply **quadratic Bézier interpolation through midpoints**:

```
For points p[0], p[1], p[2], …, p[n]:
  midPoint[i] = average(p[i], p[i+1])
  draw quadraticCurveTo(p[i], midPoint[i])
```

This produces smooth, natural-looking brush strokes that look identical to professional drawing tools.

### RAF throttling (client-side)
All rendering is driven by `requestAnimationFrame` rather than direct event handlers. Mouse events only *queue* data; the RAF loop *consumes* it. This ensures:
- Never more than 1 render per screen refresh
- No partial-frame tears
- Smooth 60fps regardless of mouse event frequency

### Network batching (stroke:point)
A 16ms timer batches multiple `stroke:point` emissions into a single Socket.io event. At 60fps mouse tracking this reduces socket events by ~60% vs. emitting per-pixel.

### Cursor throttle (30fps)
Cursor events are throttled to ~30fps (32ms minimum interval). Cursor positions are visually interpolated on receiving clients via lerp, so 30fps input still looks smooth at 60fps display.

### Off-screen canvas for replay
On undo/redo, we render the full operation replay onto an **off-screen canvas** first, then `drawImage()` the result to the base canvas in a single operation. This prevents a visible flash/wipe during replay.

### Operation log cap
The server caps the operation log at 200 entries, removing the oldest *inactive* (undone) entries. This bounds server memory consumption for long sessions.

---

## 6. Conflict Resolution

| Scenario | Resolution |
|---|---|
| Two users draw in the same area simultaneously | Both strokes are committed independently; the later commit appears on top (standard painter's algorithm). No data loss. |
| User A undoes while User B is mid-stroke | A's undo fires as a canvas:replay, but B's in-progress stroke is on the live canvas only and is unaffected. B's stroke commits normally. |
| User A undoes User B's stroke | Not possible by design. Undo only targets the requesting user's own operations. |
| Network lag causes out-of-order points | Points are appended as they arrive; the stroke is only committed with the full authoritative point set from `stroke:end`. |
| Client disconnects mid-stroke | The in-progress stroke is abandoned on other clients (removed from remoteStrokes when the user leaves). The partial stroke is not committed to the operation log. |

---

## 7. Scaling Considerations

> "How would you handle 1000 concurrent users?"

The current single-process Node.js server would bottleneck at high concurrency. Key changes:

1. **Horizontal scaling**: Run multiple server instances behind a load balancer. Requires **sticky sessions** (or Socket.io's adapter) so all users in a room hit the same instance.

2. **Redis adapter**: Replace in-memory RoomManager with a Redis-backed Socket.io adapter so broadcasts work across instances:
   ```
   npm install @socket.io/redis-adapter
   ```

3. **Canvas state persistence**: Move `DrawingState` to Redis or PostgreSQL so canvas history survives server restarts and is accessible from any instance.

4. **Operation log sharding**: At 1000 users with active drawing, the operation log grows fast. Shard by room, and cap active operations at a lower threshold.

5. **Cursor events**: At 1000 users × 30fps = 30,000 cursor events/s. Consider using a separate high-frequency UDP/WebTransport channel, or reducing cursor emit rate on large rooms.

6. **CDN for static assets**: Serve `client/` from a CDN edge node to reduce first-load latency globally.
