const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// In-memory room storage
// rooms[roomId] = { puzzle, grid (current state), players: { socketId: { name, color, cursor } } }
const rooms = {};

// Cache fetched puzzles so we don't re-fetch the same date
const puzzleCache = {};

const PLAYER_COLORS = ["#6C63FF", "#FF6584"];

// ---------- NYT Crossword Fetcher ----------

async function fetchNYTPuzzle(dateStr) {
  // dateStr format: "YYYY-MM-DD"
  if (puzzleCache[dateStr]) return puzzleCache[dateStr];

  const [year, month, day] = dateStr.split("-");
  const url = `https://raw.githubusercontent.com/doshea/nyt_crosswords/master/${year}/${month}/${day}.json`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Puzzle not found for ${dateStr} (HTTP ${res.status})`);

  const raw = await res.json();
  const puzzle = transformNYTPuzzle(raw, dateStr);
  puzzleCache[dateStr] = puzzle;
  return puzzle;
}

function transformNYTPuzzle(raw, dateStr) {
  const rows = raw.size.rows;
  const cols = raw.size.cols;

  // Build 2D solution grid and gridnums
  const solution = [];
  const gridnums = [];
  for (let r = 0; r < rows; r++) {
    const solRow = [];
    const numRow = [];
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const cell = raw.grid[idx];
      solRow.push(cell === "." ? null : cell);
      numRow.push(raw.gridnums[idx] || 0);
    }
    solution.push(solRow);
    gridnums.push(numRow);
  }

  // Parse clues — format: "1. Clue text here"
  function parseClues(clueList) {
    return clueList.map((clueStr) => {
      const match = clueStr.match(/^(\d+)\.\s*(.+)$/);
      if (!match) return { number: 0, text: clueStr };
      return { number: parseInt(match[1], 10), text: match[2] };
    });
  }

  // Build across clues with row/col positions
  const acrossClues = parseClues(raw.clues.across).map((clue) => {
    const pos = findCluePosition(gridnums, clue.number);
    return { ...clue, ...pos };
  });

  const downClues = parseClues(raw.clues.down).map((clue) => {
    const pos = findCluePosition(gridnums, clue.number);
    return { ...clue, ...pos };
  });

  const title = raw.title || `NYT Crossword — ${dateStr}`;
  const dow = raw.dow || "";

  return {
    id: `nyt-${dateStr}`,
    title,
    dow,
    date: dateStr,
    rows,
    cols,
    solution,
    gridnums,
    clues: { across: acrossClues, down: downClues },
  };
}

function findCluePosition(gridnums, number) {
  for (let r = 0; r < gridnums.length; r++) {
    for (let c = 0; c < gridnums[r].length; c++) {
      if (gridnums[r][c] === number) return { row: r, col: c };
    }
  }
  return { row: 0, col: 0 };
}

// ---------- REST endpoints ----------

// Fetch puzzle info (lightweight — just checks if it exists)
app.get("/api/puzzle/:date", async (req, res) => {
  try {
    const puzzle = await fetchNYTPuzzle(req.params.date);
    res.json({ id: puzzle.id, title: puzzle.title, dow: puzzle.dow, rows: puzzle.rows, cols: puzzle.cols });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post("/api/rooms", express.json(), async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: "Date is required" });

    const puzzle = await fetchNYTPuzzle(date);

    const roomId = uuidv4().slice(0, 8);
    // Build an empty grid from the solution (null stays null, letters become "")
    const grid = puzzle.solution.map((row) =>
      row.map((cell) => (cell === null ? null : ""))
    );

    rooms[roomId] = { puzzle, grid, players: {} };
    res.json({ roomId });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
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
        dow: room.puzzle.dow,
        date: room.puzzle.date,
        rows: room.puzzle.rows,
        cols: room.puzzle.cols,
        clues: room.puzzle.clues,
        gridnums: room.puzzle.gridnums,
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

  socket.on("leave-room", () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].players[socket.id];
      socket.leave(currentRoom);
      io.to(currentRoom).emit("player-left", { id: socket.id });
      if (Object.keys(rooms[currentRoom].players).length === 0) {
        setTimeout(() => {
          if (rooms[currentRoom] && Object.keys(rooms[currentRoom].players).length === 0) {
            delete rooms[currentRoom];
          }
        }, 60000);
      }
      currentRoom = null;
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

const DEFAULT_PUZZLE_DATE = "2015-01-01";

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🧩 Cross-Coop running at http://localhost:${PORT}`);
  // Pre-warm the cache for the default puzzle so the lobby loads instantly
  try {
    await fetchNYTPuzzle(DEFAULT_PUZZLE_DATE);
    console.log(`✅ Default puzzle (${DEFAULT_PUZZLE_DATE}) cached`);
  } catch (err) {
    console.warn(`⚠️  Could not pre-cache default puzzle: ${err.message}`);
  }
});
