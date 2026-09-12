# CollabCanvas — Real-Time Collaborative Drawing

A multi-user collaborative drawing application where multiple people can draw simultaneously on the same canvas with real-time synchronization.

## ✨ Features

- **Real-time drawing sync** — see other users' strokes as they draw (not after they finish)
- **Live remote cursors** — animated cursor indicators with username labels
- **Global undo/redo** — per-user undo history that propagates to all clients
- **Brush & eraser** — configurable stroke width and full color palette
- **User panel** — live list of who's online with their assigned color
- **Room system** — isolated canvases via URL room IDs
- **Mobile touch support** — draw on phones and tablets
- **Performance metrics** — live FPS counter and round-trip latency display
- **New joiner state sync** — joining users receive the full canvas history
- **Client-side prediction** — local strokes render instantly, no waiting for server echo

## 🚀 Setup

### Prerequisites
- Node.js 16+
- npm 7+

### Install & run

```bash
# From the project root
npm install
npm start
```

The server starts on **http://localhost:3000**

### Testing with multiple users

Open the URL in **two or more separate browser tabs** (or on different devices on the same network):

```
Tab 1: http://localhost:3000  →  Enter name "Alice", room "main"
Tab 2: http://localhost:3000  →  Enter name "Bob",   room "main"
```

Draw in one tab and watch it appear in the other in real-time.

To test isolated rooms:
```
Tab 1: enter room "room-a"
Tab 2: enter room "room-a"   ← shares canvas with Tab 1
Tab 3: enter room "room-b"   ← completely separate canvas
```

### Development mode (auto-reload)

```bash
npm run dev
```

Requires [nodemon](https://nodemon.io/) (installed as a dev dependency).

## ⌨️ Controls

| Action | Shortcut |
|--------|---------|
| Select brush | `B` |
| Select eraser | `E` |
| Undo | `Ctrl+Z` / `Cmd+Z` |
| Redo | `Ctrl+Y` / `Ctrl+Shift+Z` |

## 🗂️ Project Structure

```
collaborative-canvas/
├── client/
│   ├── index.html        # App shell — two canvas layers, toolbar, user panel
│   ├── style.css         # Dark glassmorphism design system
│   ├── canvas.js         # CanvasManager — all drawing & rendering logic
│   ├── websocket.js      # WebSocketManager — Socket.io client wrapper
│   ├── ui.js             # UIManager — toolbar, user list, toasts
│   └── main.js           # Bootstrap — wires all managers together
├── server/
│   ├── server.js         # Express + Socket.io entry point
│   ├── rooms.js          # RoomManager — room & user lifecycle
│   └── drawing-state.js  # DrawingState — operation log, undo/redo stack
├── package.json
├── README.md
└── ARCHITECTURE.md
```

## ⚠️ Known Limitations / Bugs

1. **Canvas resize** — resizing the browser window clears the canvas momentarily (a re-join is triggered to restore state). The operation log is preserved so data is not lost.
2. **No persistence** — canvas state lives only in server memory. Restarting the server clears all drawings.
3. **Undo scope** — undo only affects the requesting user's own strokes. There is no "undo another user's stroke" capability (by design — see ARCHITECTURE.md).
4. **Eraser compositing** — the eraser uses `destination-out` compositing on the base canvas. On canvas replay it is simulated by drawing with the background color, which means erased areas may reappear if the canvas background color changes.
5. **Large canvases** — replay of very long sessions (>200 operations) may cause a brief redraw flash. The 200-operation cap in `DrawingState` mitigates this.
6. **No authentication** — users choose their own display names; there is no identity verification.

## ⏱️ Time Spent

| Phase | Time |
|-------|------|
| Architecture design & planning | ~1 h |
| Server (Socket.io, DrawingState, RoomManager) | ~2 h |
| CanvasManager (two-layer, Bézier, replay) | ~2.5 h |
| WebSocketManager + main.js wiring | ~1 h |
| UIManager + CSS design system | ~2 h |
| Documentation | ~1 h |
| **Total** | **~9.5 h** |
