# CollabCanvas — Real-Time Collaborative Drawing Canvas

> **Live Demo → [https://web-production-07cbd.up.railway.app](https://web-production-07cbd.up.railway.app)**
>
> Open the link in **two browser tabs** — draw in one, watch it appear live in the other.

---

## 📋 Table of Contents

- [Setup Instructions](#-setup-instructions)
- [How to Test with Multiple Users](#-how-to-test-with-multiple-users)
- [Features](#-features)
- [Project Structure](#-project-structure)
- [Known Limitations & Bugs](#-known-limitations--bugs)
- [Time Spent](#-time-spent)

---

## ⚙️ Setup Instructions

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- npm v8 or higher

### Install & Run

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/collaborative-canvas.git

# 2. Go into the project folder
cd collaborative-canvas

# 3. Install dependencies
npm install

# 4. Start the server
npm start
```

The server starts on **http://localhost:3000**

Open that URL in your browser. The app loads immediately — no build step needed.

### Development Mode (auto-reload on file changes)

```bash
npm run dev
```

---

## 👥 How to Test with Multiple Users

### Option A — Local (two browser tabs)

```
1. Run: npm install && npm start
2. Open http://localhost:3000 in Tab 1
   → Enter name: "Alice"  |  Room: "main"  |  Click Join Canvas
3. Open http://localhost:3000 in Tab 2
   → Enter name: "Bob"    |  Room: "main"  |  Click Join Canvas
4. Draw in Tab 1 — you will see the stroke appear LIVE in Tab 2 as you draw
5. Move your mouse in Tab 1 — Bob sees Alice's cursor indicator in real-time
6. Press Ctrl+Z in Tab 1 — Alice's last stroke is undone on BOTH tabs
```

### Option B — Live Deployed Demo

```
1. Open https://web-production-07cbd.up.railway.app in Tab 1
2. Open https://web-production-07cbd.up.railway.app in Tab 2
   (Or share the link with a friend on a different device)
3. Both join the same room "main" with different names
4. Draw simultaneously — see each other's strokes in real-time
```

### Testing Rooms (isolated canvases)

```
Tab 1: join room "room-a"
Tab 2: join room "room-a"   ← shares canvas with Tab 1
Tab 3: join room "room-b"   ← completely separate canvas, no cross-talk
```

### Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Brush tool | `B` |
| Eraser tool | `E` |
| Undo | `Ctrl+Z` / `Cmd+Z` |
| Redo | `Ctrl+Y` / `Ctrl+Shift+Z` |

---

## ✨ Features

### Core (Required)

| Feature | Implementation |
|---------|---------------|
| **Brush tool** | Quadratic Bézier smoothing for natural strokes |
| **Eraser tool** | `destination-out` canvas compositing |
| **Color picker** | 12 preset colors + custom color input |
| **Stroke width** | Range slider (1px – 60px) with live preview |
| **Real-time sync (mid-stroke)** | `stroke:point` events batched every 16ms |
| **Live remote cursors** | Animated with username label, lerp-interpolated |
| **Global Undo** | Server op-log replay broadcasts to ALL users |
| **Global Redo** | Same broadcast mechanism |
| **Who's online** | Live user panel with auto-assigned unique colors |
| **Conflict resolution** | Per-user LIFO undo stacks; server timestamp ordering |
| **New joiner sync** | Full canvas state replayed from server operation log |

### Bonus (Optional — all implemented)

| Bonus Feature | Implementation |
|--------------|---------------|
| **Mobile touch support** | `touchstart / touchmove / touchend` in `canvas.js` |
| **Room system** | Isolated canvases via room ID in the join dialog |
| **Performance metrics** | Live FPS counter + round-trip latency in header |

---

## 📁 Project Structure

```
collaborative-canvas/
├── client/
│   ├── index.html        # App shell — two stacked canvas layers, toolbar, user panel
│   ├── style.css         # Dark glassmorphism design system, all animations
│   ├── canvas.js         # CanvasManager — all drawing & rendering logic
│   ├── websocket.js      # WebSocketManager — Socket.io client wrapper
│   ├── ui.js             # UIManager — toolbar, color swatches, user list, toasts
│   └── main.js           # Bootstrap — wires all three managers together
├── server/
│   ├── server.js         # Express + Socket.io entry point, all event handlers
│   ├── rooms.js          # RoomManager — room lifecycle, user tracking, color palette
│   └── drawing-state.js  # DrawingState — operation log, undo/redo stacks
├── package.json
├── Procfile              # For Railway / Heroku deployment
├── README.md
└── ARCHITECTURE.md
```

---

## ⚠️ Known Limitations & Bugs

### 1. Canvas Resize Clears Content (momentarily)
When you resize your browser window, the HTML5 Canvas element is reset by the browser (this is how the Canvas API works — resizing always clears it). The app handles this by re-requesting the canvas state from the server after a resize, so content is restored within ~200ms. Data is never lost from the server's operation log.

### 2. No Persistence Across Server Restarts
Canvas state is stored in server memory only. If the Railway server restarts (e.g. after a new deploy), all drawings are cleared. The operation log does not survive process restarts. Adding a database (PostgreSQL or Redis) would fix this — not implemented as the assignment stated "real-time sync is the priority."

### 3. Undo Scope is Per-User
Undo only undoes the requesting user's own strokes. There is no "undo another user's stroke" feature — this is intentional. True cross-user undo would require Operational Transform or CRDT, which adds significant complexity without meaningfully improving the UX (this is the same behavior as Google Docs).

### 4. Eraser on Replay Uses Background Fill
The eraser uses `destination-out` canvas compositing. On undo/redo replay (off-screen canvas), it is re-applied as `destination-out` so erased areas are correctly transparent. This means erased areas appear as the canvas background color (`#1a1d26`), which is correct but means erasing is not truly "transparent" — it's a paint fill.

### 5. Operation Log Cap (200 entries)
The server caps the operation log at 200 entries to prevent unbounded memory growth in long sessions. The oldest *inactive* (undone) operations are trimmed first. Active operations are preserved until the cap forces removal of the oldest committed strokes.

### 6. No User Authentication
Users choose any display name they want with no identity verification. This is acceptable per the assignment spec ("Not required — focus on the drawing functionality").

---

## ⏱️ Time Spent

| Phase | Description | Time |
|-------|-------------|------|
| **Architecture design** | Planning layer strategy, WebSocket protocol, undo/redo approach | 1.0 h |
| **Server** | `server.js`, `drawing-state.js`, `rooms.js` with full event handling | 2.0 h |
| **CanvasManager** | Two-layer system, Bézier smoothing, RAF loop, replay, touch support | 2.5 h |
| **WebSocketManager** | Socket.io wrapper, reconnection, latency measurement | 0.5 h |
| **main.js** | Cross-manager wiring, state sync, resize handling | 0.5 h |
| **UIManager + CSS** | Toolbar, color picker, user list, toasts, dark glassmorphism theme | 2.0 h |
| **Documentation** | README.md + ARCHITECTURE.md | 1.0 h |
| **Testing & deploy** | Multi-user testing, Railway deployment, bug fixes | 0.5 h |
| **Total** | | **~10 h** |

---

## 🛠️ Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Frontend** | Vanilla JavaScript (ES6+) | No framework — raw DOM/Canvas skills |
| **Rendering** | HTML5 Canvas API | Native browser API, no drawing libraries |
| **Backend** | Node.js + Express | Lightweight, non-blocking I/O |
| **Real-time** | Socket.io v4 | Automatic reconnection, room support, polling fallback |
| **Deployment** | Railway | Free tier, supports persistent WebSocket servers |

> **Why Socket.io over native WebSockets?**
> Socket.io adds: automatic reconnection with exponential backoff, built-in room/namespace support, graceful fallback to HTTP long-polling when WebSockets are blocked by corporate firewalls, and a cleaner event-based API. For a collaborative app where connection reliability is critical, these features are worth the ~80KB overhead.

---

## 🌐 Browser Compatibility

Tested and working on:
- ✅ Chrome 120+
- ✅ Firefox 121+
- ✅ Safari 17+
- ✅ Edge 120+
- ✅ Mobile Chrome (Android)
- ✅ Mobile Safari (iOS)
