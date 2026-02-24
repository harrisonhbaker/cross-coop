// ---------- Cross-Coop Client ----------
const socket = io();

// DOM refs
const lobbyScreen = document.getElementById("lobby");
const gameScreen = document.getElementById("game");
const puzzleSelect = document.getElementById("puzzleSelect");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const roomInput = document.getElementById("roomInput");
const playerNameInput = document.getElementById("playerName");
const roomBadge = document.getElementById("roomBadge");
const roomCode = document.getElementById("roomCode");
const puzzleTitle = document.getElementById("puzzleTitle");
const playersBar = document.getElementById("playersBar");
const gridWrapper = document.getElementById("gridWrapper");
const cluesPanel = document.getElementById("cluesPanel");
const toast = document.getElementById("toast");
const completeOverlay = document.getElementById("completeOverlay");

// State
let state = {
  roomId: null,
  puzzle: null,
  grid: null,
  players: {},
  myId: null,
  selectedCell: null,     // { row, col }
  direction: "across",    // "across" | "down"
  activeClue: null,       // clue object
};

// ---------- Lobby ----------

async function loadPuzzles() {
  const res = await fetch("/api/puzzles");
  const puzzles = await res.json();
  puzzles.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.title} (${p.size}×${p.size})`;
    puzzleSelect.appendChild(opt);
  });
}
loadPuzzles();

createBtn.addEventListener("click", async () => {
  const puzzleId = puzzleSelect.value;
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ puzzleId }),
  });
  const { roomId } = await res.json();
  joinRoom(roomId);
});

joinBtn.addEventListener("click", () => {
  const code = roomInput.value.trim();
  if (code) joinRoom(code);
});

// Also allow Enter in the room input
roomInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBtn.click();
});

function joinRoom(roomId) {
  const playerName = playerNameInput.value.trim() || "Anonymous";
  socket.emit("join-room", { roomId, playerName });
}

// ---------- Socket Events ----------

socket.on("room-state", (data) => {
  state.roomId = data.roomId;
  state.puzzle = data.puzzle;
  state.grid = data.grid;
  state.players = data.players;
  state.myId = data.you;

  // Update URL for easy sharing
  history.replaceState(null, "", `?room=${data.roomId}`);

  // Show game
  lobbyScreen.classList.remove("active");
  gameScreen.classList.add("active");
  roomBadge.style.display = "block";
  roomCode.textContent = data.roomId;
  puzzleTitle.textContent = data.puzzle.title;

  renderPlayers();
  renderGrid();
  renderClues();
});

socket.on("player-joined", ({ id, name, color }) => {
  state.players[id] = { name, color, cursor: null };
  renderPlayers();
  showToast(`${name} joined!`, "#4CAF50");
});

socket.on("player-left", ({ id }) => {
  const name = state.players[id]?.name || "Player";
  delete state.players[id];
  renderPlayers();
  clearRemoteCursors();
  showToast(`${name} left`, "#FF9800");
});

socket.on("cell-updated", ({ row, col, value, player }) => {
  state.grid[row][col] = value;
  const input = getCellInput(row, col);
  if (input) {
    input.value = value;
    if (player !== state.myId) {
      input.parentElement.classList.add("correct");
      setTimeout(() => input.parentElement.classList.remove("correct"), 300);
    }
  }
});

socket.on("cursor-moved", ({ player, row, col, direction, color }) => {
  clearRemoteCursors();
  const cell = getCell(row, col);
  if (cell) {
    cell.classList.add("remote-cursor");
    cell.style.setProperty("--remote-color", color);
  }
});

socket.on("puzzle-complete", () => {
  completeOverlay.classList.add("active");
});

socket.on("error-msg", (msg) => {
  showToast(msg, "#ff4444");
});

// ---------- Rendering ----------

function renderPlayers() {
  playersBar.innerHTML = "";
  Object.entries(state.players).forEach(([id, p]) => {
    const tag = document.createElement("div");
    tag.className = "player-tag";
    tag.style.borderColor = p.color;
    tag.innerHTML = `<div class="player-dot" style="background:${p.color}"></div>${p.name}${id === state.myId ? " (you)" : ""}`;
    playersBar.appendChild(tag);
  });
}

function renderGrid() {
  const { puzzle, grid } = state;
  const size = puzzle.size;

  gridWrapper.innerHTML = "";
  const gridEl = document.createElement("div");
  gridEl.className = "crossword-grid";
  gridEl.style.gridTemplateColumns = `repeat(${size}, 42px)`;

  // Build a number map from clues
  const numberMap = {};
  [...puzzle.clues.across, ...puzzle.clues.down].forEach((clue) => {
    const key = `${clue.row}-${clue.col}`;
    numberMap[key] = clue.number;
  });

  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.row = r;
      cell.dataset.col = c;

      if (grid[r][c] === null) {
        cell.classList.add("black");
      } else {
        // Number label
        const key = `${r}-${c}`;
        if (numberMap[key] !== undefined) {
          const num = document.createElement("span");
          num.className = "number";
          num.textContent = numberMap[key];
          cell.appendChild(num);
        }

        const input = document.createElement("input");
        input.type = "text";
        input.maxLength = 1;
        input.value = grid[r][c] || "";
        input.dataset.row = r;
        input.dataset.col = c;
        input.setAttribute("autocomplete", "off");
        input.setAttribute("autocorrect", "off");
        input.setAttribute("spellcheck", "false");

        input.addEventListener("focus", () => selectCell(r, c));
        input.addEventListener("input", (e) => handleInput(e, r, c));
        input.addEventListener("keydown", (e) => handleKeydown(e, r, c));
        input.addEventListener("click", () => {
          // If clicking the same cell, toggle direction
          if (state.selectedCell && state.selectedCell.row === r && state.selectedCell.col === c) {
            state.direction = state.direction === "across" ? "down" : "across";
            highlightWord();
          }
        });

        cell.appendChild(input);
      }

      gridEl.appendChild(cell);
    }
  }

  gridWrapper.appendChild(gridEl);
}

function renderClues() {
  cluesPanel.innerHTML = "";
  ["across", "down"].forEach((dir) => {
    const section = document.createElement("div");
    section.className = "clue-section";
    const h3 = document.createElement("h3");
    h3.textContent = dir;
    section.appendChild(h3);

    const ul = document.createElement("ul");
    ul.className = "clue-list";

    state.puzzle.clues[dir].forEach((clue) => {
      const li = document.createElement("li");
      li.className = "clue-item";
      li.dataset.direction = dir;
      li.dataset.row = clue.row;
      li.dataset.col = clue.col;
      li.innerHTML = `<span class="clue-num">${clue.number}</span>${clue.text}`;
      li.addEventListener("click", () => {
        state.direction = dir;
        selectCell(clue.row, clue.col);
        getCellInput(clue.row, clue.col)?.focus();
      });
      ul.appendChild(li);
    });

    section.appendChild(ul);
    cluesPanel.appendChild(section);
  });
}

// ---------- Interaction ----------

function selectCell(row, col) {
  state.selectedCell = { row, col };
  highlightWord();
  socket.emit("cursor-move", { row, col, direction: state.direction });
}

function handleInput(e, row, col) {
  const value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(-1);
  e.target.value = value;
  socket.emit("cell-update", { row, col, value });

  if (value) {
    moveToNext(row, col);
  }
}

function handleKeydown(e, row, col) {
  const { direction } = state;

  if (e.key === "Backspace") {
    const input = getCellInput(row, col);
    if (input && input.value === "") {
      e.preventDefault();
      moveToPrev(row, col);
    } else if (input) {
      // The input event will handle clearing
    }
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();
    state.direction = direction === "across" ? "down" : "across";
    highlightWord();
    return;
  }

  const arrowMap = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  if (arrowMap[e.key]) {
    e.preventDefault();
    const [dr, dc] = arrowMap[e.key];
    // Set direction based on arrow
    if (dr !== 0) state.direction = "down";
    if (dc !== 0) state.direction = "across";

    let nr = row + dr;
    let nc = col + dc;
    while (nr >= 0 && nr < state.grid.length && nc >= 0 && nc < state.grid[0].length) {
      if (state.grid[nr][nc] !== null) {
        selectCell(nr, nc);
        getCellInput(nr, nc)?.focus();
        return;
      }
      nr += dr;
      nc += dc;
    }
  }

  // If a letter key is pressed and cell already has a value, replace it
  if (/^[a-zA-Z]$/.test(e.key)) {
    const input = getCellInput(row, col);
    if (input) {
      e.preventDefault();
      const value = e.key.toUpperCase();
      input.value = value;
      socket.emit("cell-update", { row, col, value });
      moveToNext(row, col);
    }
  }
}

function moveToNext(row, col) {
  const [dr, dc] = state.direction === "across" ? [0, 1] : [1, 0];
  let nr = row + dr;
  let nc = col + dc;
  while (nr >= 0 && nr < state.grid.length && nc >= 0 && nc < state.grid[0].length) {
    if (state.grid[nr][nc] !== null) {
      selectCell(nr, nc);
      getCellInput(nr, nc)?.focus();
      return;
    }
    nr += dr;
    nc += dc;
  }
}

function moveToPrev(row, col) {
  const [dr, dc] = state.direction === "across" ? [0, -1] : [-1, 0];
  let nr = row + dr;
  let nc = col + dc;
  while (nr >= 0 && nr < state.grid.length && nc >= 0 && nc < state.grid[0].length) {
    if (state.grid[nr][nc] !== null) {
      selectCell(nr, nc);
      getCellInput(nr, nc)?.focus();
      // Clear the cell we moved to
      const input = getCellInput(nr, nc);
      if (input && input.value) {
        input.value = "";
        socket.emit("cell-update", { row: nr, col: nc, value: "" });
      }
      return;
    }
    nr += dr;
    nc += dc;
  }
}

function highlightWord() {
  // Clear existing highlights
  document.querySelectorAll(".cell.selected, .cell.highlighted").forEach((c) => {
    c.classList.remove("selected", "highlighted");
  });
  document.querySelectorAll(".clue-item.active").forEach((c) => c.classList.remove("active"));

  if (!state.selectedCell) return;

  const { row, col } = state.selectedCell;
  const cell = getCell(row, col);
  if (cell) cell.classList.add("selected");

  // Find the word cells for the current direction
  const wordCells = getWordCells(row, col, state.direction);
  wordCells.forEach(([r, c]) => {
    const el = getCell(r, c);
    if (el && !(r === row && c === col)) {
      el.classList.add("highlighted");
    }
  });

  // Highlight the corresponding clue
  const clue = findClueForCell(row, col, state.direction);
  if (clue) {
    const clueEl = document.querySelector(
      `.clue-item[data-direction="${state.direction}"][data-row="${clue.row}"][data-col="${clue.col}"]`
    );
    if (clueEl) {
      clueEl.classList.add("active");
      clueEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    state.activeClue = clue;
  }
}

function getWordCells(row, col, direction) {
  const cells = [];
  const [dr, dc] = direction === "across" ? [0, 1] : [1, 0];

  // Go backward to find start of word
  let sr = row, sc = col;
  while (sr - dr >= 0 && sc - dc >= 0 && state.grid[sr - dr]?.[sc - dc] !== null && state.grid[sr - dr]?.[sc - dc] !== undefined) {
    sr -= dr;
    sc -= dc;
  }

  // Go forward from start
  let r = sr, c = sc;
  while (r < state.grid.length && c < state.grid[0].length && state.grid[r]?.[c] !== null && state.grid[r]?.[c] !== undefined) {
    cells.push([r, c]);
    r += dr;
    c += dc;
  }

  return cells;
}

function findClueForCell(row, col, direction) {
  const clues = state.puzzle.clues[direction];
  const wordCells = getWordCells(row, col, direction);
  if (wordCells.length === 0) return null;
  const [startRow, startCol] = wordCells[0];
  return clues.find((c) => c.row === startRow && c.col === startCol) || null;
}

// ---------- Helpers ----------

function getCell(row, col) {
  return gridWrapper.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
}

function getCellInput(row, col) {
  return gridWrapper.querySelector(`.cell[data-row="${row}"][data-col="${col}"] input`);
}

function clearRemoteCursors() {
  document.querySelectorAll(".cell.remote-cursor").forEach((c) => c.classList.remove("remote-cursor"));
}

function showToast(msg, color = "#ff4444") {
  toast.textContent = msg;
  toast.style.background = color;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3000);
}

// ---------- Auto-join from URL ----------
(function checkUrlRoom() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  if (room) {
    roomInput.value = room;
  }
})();
