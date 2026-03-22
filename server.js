require("dotenv").config();
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

const PLAYER_COLORS = [
  "#6C63FF", "#FF6584", "#43C59E", "#FFB347", "#4FC3F7",
  "#BA68C8", "#F06292", "#AED581", "#FF8A65", "#4DB6AC",
];

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

// ---------- APIVerve Generated Puzzle ----------

async function fetchGeneratedPuzzle({ size, theme, difficulty } = {}) {
  const apiKey = process.env.APIVERVE_KEY;
  if (!apiKey) throw new Error("APIVERVE_KEY not set in environment");

  const params = new URLSearchParams();
  if (size) params.set("size", size);
  if (theme) params.set("theme", theme);
  if (difficulty) params.set("difficulty", difficulty);

  const url = `https://api.apiverve.com/v1/crossword${params.toString() ? "?" + params : ""}`;
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`Generated puzzle API error: HTTP ${res.status}`);

  const json = await res.json();
  if (json.status !== "ok") throw new Error(json.error || "API returned error");

  return transformAPIPuzzle(json.data);
}

function transformAPIPuzzle(data) {
  const size = data.size;
  const grid = data.grid; // 2D array: null or letter string

  // Build gridnums using standard crossword numbering (reading order)
  const gridnums = Array.from({ length: size }, () => Array(size).fill(0));
  let num = 1;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c] === null) continue;
      const startsAcross = (c === 0 || grid[r][c - 1] === null) && c + 1 < size && grid[r][c + 1] !== null;
      const startsDown = (r === 0 || grid[r - 1][c] === null) && r + 1 < size && grid[r + 1][c] !== null;
      if (startsAcross || startsDown) gridnums[r][c] = num++;
    }
  }

  const acrossClues = data.across.map((c) => {
    const pos = findCluePosition(gridnums, c.number);
    return { number: c.number, text: c.clue, ...pos };
  });
  const downClues = data.down.map((c) => {
    const pos = findCluePosition(gridnums, c.number);
    return { number: c.number, text: c.clue, ...pos };
  });

  const theme = data.theme ? data.theme.charAt(0).toUpperCase() + data.theme.slice(1) : "Generated";
  return {
    id: `generated-${Date.now()}`,
    title: `${theme} Crossword`,
    dow: "",
    date: new Date().toISOString().slice(0, 10),
    rows: size,
    cols: size,
    solution: grid,
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

app.post("/api/rooms/generated", express.json(), async (req, res) => {
  try {
    const { size, theme, difficulty } = req.body || {};
    const puzzle = await fetchGeneratedPuzzle({ size, theme, difficulty });
    const roomId = uuidv4().slice(0, 5).toUpperCase();
    const grid = puzzle.solution.map((row) =>
      row.map((cell) => (cell === null ? null : ""))
    );
    rooms[roomId] = { puzzle, grid, players: {} };
    res.json({ roomId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/rooms", express.json(), async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: "Date is required" });

    const puzzle = await fetchNYTPuzzle(date);

    const roomId = uuidv4().slice(0, 5).toUpperCase();
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
    if (playerCount >= 10 && !room.players[socket.id]) {
      socket.emit("error-msg", "Room is full (max 10 players)");
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

  socket.on("new-puzzle", async ({ date, generated, theme, size, difficulty }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    try {
      const puzzle = generated
        ? await fetchGeneratedPuzzle({ theme, size, difficulty })
        : await fetchNYTPuzzle(date);
      const room = rooms[currentRoom];
      room.puzzle = puzzle;
      room.grid = puzzle.solution.map((row) => row.map((cell) => (cell === null ? null : "")));
      io.to(currentRoom).emit("puzzle-reset", {
        puzzle: {
          id: puzzle.id,
          title: puzzle.title,
          dow: puzzle.dow,
          date: puzzle.date,
          rows: puzzle.rows,
          cols: puzzle.cols,
          clues: puzzle.clues,
          gridnums: puzzle.gridnums,
          shape: puzzle.solution.map((row) => row.map((cell) => (cell === null ? null : true))),
        },
        grid: room.grid,
      });
    } catch (err) {
      socket.emit("error-msg", err.message);
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
