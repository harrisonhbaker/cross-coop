const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const puzzles = require("./puzzles");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// In-memory room storage
// rooms[roomId] = { puzzle, grid (current state), players: { socketId: { name, color, cursor } } }
const rooms = {};

const PLAYER_COLORS = ["#6C63FF", "#FF6584"];

// ---------- REST endpoints ----------

app.get("/api/puzzles", (_req, res) => {
  res.json(
    puzzles.map((p) => ({ id: p.id, title: p.title, size: p.size }))
  );
});

app.post("/api/rooms", express.json(), (req, res) => {
  const { puzzleId } = req.body;
  const puzzle = puzzles.find((p) => p.id === puzzleId);
  if (!puzzle) return res.status(404).json({ error: "Puzzle not found" });

  const roomId = uuidv4().slice(0, 8);
  // Build an empty grid from the solution (null stays null, letters become "")
  const grid = puzzle.solution.map((row) =>
    row.map((cell) => (cell === null ? null : ""))
  );

  rooms[roomId] = {
    puzzle,
    grid,
    players: {},
  };

  res.json({ roomId });
});

// ---------- Socket.IO ----------

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("join-room", ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("error-msg", "Room not found");
      return;
    }

    const playerCount = Object.keys(room.players).length;
    if (playerCount >= 2 && !room.players[socket.id]) {
      socket.emit("error-msg", "Room is full (max 2 players)");
      return;
    }

    currentRoom = roomId;
    socket.join(roomId);

    const color = PLAYER_COLORS[playerCount] || PLAYER_COLORS[0];
    room.players[socket.id] = {
      name: playerName || `Player ${playerCount + 1}`,
      color,
      cursor: null,
    };

    // Send the full state to the joining player
    socket.emit("room-state", {
      roomId,
      puzzle: {
        id: room.puzzle.id,
        title: room.puzzle.title,
        size: room.puzzle.size,
        clues: room.puzzle.clues,
        // Send grid shape (null = black) without solutions
        shape: room.puzzle.solution.map((row) =>
          row.map((cell) => (cell === null ? null : true))
        ),
      },
      grid: room.grid,
      players: room.players,
      you: socket.id,
    });

    // Notify others
    socket.to(roomId).emit("player-joined", {
      id: socket.id,
      ...room.players[socket.id],
    });
  });

  socket.on("cell-update", ({ row, col, value }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    // Only allow single uppercase letter or empty
    const sanitized = (value || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 1);
    if (room.grid[row] && room.grid[row][col] !== undefined && room.grid[row][col] !== null) {
      room.grid[row][col] = sanitized;
      io.to(currentRoom).emit("cell-updated", { row, col, value: sanitized, player: socket.id });

      // Check if puzzle is complete
      checkCompletion(room, currentRoom);
    }
  });

  socket.on("cursor-move", ({ row, col, direction }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.players[socket.id]) {
      room.players[socket.id].cursor = { row, col, direction };
      socket.to(currentRoom).emit("cursor-moved", {
        player: socket.id,
        row,
        col,
        direction,
        color: room.players[socket.id].color,
      });
    }
  });

  socket.on("disconnect", () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].players[socket.id];
      io.to(currentRoom).emit("player-left", { id: socket.id });

      // Clean up empty rooms after a delay
      if (Object.keys(rooms[currentRoom].players).length === 0) {
        setTimeout(() => {
          if (rooms[currentRoom] && Object.keys(rooms[currentRoom].players).length === 0) {
            delete rooms[currentRoom];
          }
        }, 60000);
      }
    }
  });
});

function checkCompletion(room, roomId) {
  const { puzzle, grid } = room;
  for (let r = 0; r < puzzle.solution.length; r++) {
    for (let c = 0; c < puzzle.solution[r].length; c++) {
      if (puzzle.solution[r][c] === null) continue;
      if (grid[r][c] !== puzzle.solution[r][c]) return;
    }
  }
  // All cells match!
  io.to(roomId).emit("puzzle-complete");
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🧩 Cross-Coop running at http://localhost:${PORT}`);
});
