// ---------- Cross-Coop Client ----------
const socket = io();

// DOM refs
const lobbyScreen = document.getElementById("lobby");
const gameScreen = document.getElementById("game");
const puzzleDateInput = document.getElementById("puzzleDate");
const puzzlePreview = document.getElementById("puzzlePreview");
const randomBtn = document.getElementById("randomBtn");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const roomInput = document.getElementById("roomInput");
const playerNameInput = document.getElementById("playerName");
const roomBadge = document.getElementById("roomBadge");
const roomCodeEl = document.getElementById("roomCode");
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
  selectedCell: null,
  direction: "across",
  activeClue: null,
};

// ---------- Lobby — Date Picker ----------

// Set default date to a known good puzzle
puzzleDateInput.value = "2015-01-01";

puzzleDateInput.addEventListener("change", () => {
  const date = puzzleDateInput.value;
  if (date) checkDate(date);
});

randomBtn.addEventListener("click", () => {
  const start = new Date(1976, 0, 5);
  const end = new Date(2017, 11, 31);
  const rand = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
  const yyyy = rand.getFullYear();
  const mm = String(rand.getMonth() + 1).padStart(2, "0");
  const dd = String(rand.getDate()).padStart(2, "0");
  const dateStr = `${yyyy}-${mm}-${dd}`;
  puzzleDateInput.value = dateStr;
  checkDate(dateStr);
});

let checkAbort = null;

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Request timed out"));
    }, timeoutMs);
    fetch(url, options).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function checkDate(dateStr, retries = 3) {
  createBtn.disabled = true;
  puzzlePreview.className = "puzzle-preview loading";
  puzzlePreview.textContent = "Loading...";

  if (checkAbort) checkAbort.abort();
  const controller = new AbortController();
  checkAbort = controller;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(
        `/api/puzzle/${dateStr}`,
        { signal: controller.signal },
        15000
      );
      if (!res.ok) throw new Error("not found");
      const info = await res.json();
      puzzlePreview.className = "puzzle-preview found";
      puzzlePreview.textContent = `${info.dow ? info.dow + " — " : ""}${info.rows}×${info.cols} grid`;
      createBtn.disabled = false;
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      puzzlePreview.className = "puzzle-preview error";
      puzzlePreview.textContent = "No puzzle found for this date — try another";
      createBtn.disabled = true;
    }
  }
}

// Load the default puzzle once socket is connected (ensures server is ready)
socket.on("connect", () => {
  checkDate(puzzleDateInput.value);
});

// ---------- Lobby Actions ----------

createBtn.addEventListener("click", async () => {
  const date = puzzleDateInput.value;
  if (!date) return;
  createBtn.disabled = true;
  createBtn.textContent = "Creating...";

  try {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    joinRoom(data.roomId);
  } catch (err) {
    showToast(err.message, "#ff4444");
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = "Create Room";
  }
});

joinBtn.addEventListener("click", () => {
  const code = roomInput.value.trim();
  if (code) joinRoom(code);
});

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

  history.replaceState(null, "", `?room=${data.roomId}`);

  lobbyScreen.classList.remove("active");
  gameScreen.classList.add("active");
  roomBadge.style.display = "block";
  roomCodeEl.textContent = data.roomId;
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
    tag.innerHTML = `<div class="player-dot" style="background:${p.color}"></div>${escHtml(p.name)}${id === state.myId ? " (you)" : ""}`;
    playersBar.appendChild(tag);
  });
}

function renderGrid() {
  const { puzzle, grid } = state;
  const rows = puzzle.rows;
  const cols = puzzle.cols;

  // Compute cell size to fit nicely
  const maxWidth = Math.min(window.innerWidth - 60, 660);
  const cellSize = Math.max(24, Math.min(42, Math.floor(maxWidth / cols)));

  gridWrapper.innerHTML = "";
  const gridEl = document.createElement("div");
  gridEl.className = "crossword-grid";
  gridEl.style.gridTemplateColumns = `repeat(${cols}, ${cellSize}px)`;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.style.width = cellSize + "px";
      cell.style.height = cellSize + "px";
      cell.dataset.row = r;
      cell.dataset.col = c;

      if (grid[r][c] === null) {
        cell.classList.add("black");
      } else {
        // Number label from gridnums
        const num = puzzle.gridnums[r][c];
        if (num > 0) {
          const numEl = document.createElement("span");
          numEl.className = "number";
          numEl.style.fontSize = Math.max(7, cellSize * 0.26) + "px";
          numEl.textContent = num;
          cell.appendChild(numEl);
        }

        const input = document.createElement("input");
        input.type = "text";
        input.maxLength = 1;
        input.value = grid[r][c] || "";
        input.dataset.row = r;
        input.dataset.col = c;
        input.style.fontSize = Math.max(10, cellSize * 0.5) + "px";
        input.setAttribute("autocomplete", "off");
        input.setAttribute("autocorrect", "off");
        input.setAttribute("spellcheck", "false");

        input.addEventListener("focus", () => selectCell(r, c));
        input.addEventListener("input", (e) => handleInput(e, r, c));
        input.addEventListener("keydown", (e) => handleKeydown(e, r, c));
        input.addEventListener("dblclick", (e) => {
          e.preventDefault();
          state.direction = state.direction === "across" ? "down" : "across";
          highlightWord();
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
      li.innerHTML = `<span class="clue-num">${clue.number}.</span> ${escHtml(clue.text)}`;
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
  if (value) moveToNext(row, col);
}

function handleKeydown(e, row, col) {
  const { direction } = state;

  if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    const input = getCellInput(row, col);
    if (input && input.value !== "") {
      // Clear the current cell
      input.value = "";
      socket.emit("cell-update", { row, col, value: "" });
    } else if (e.key === "Backspace") {
      // Cell already empty — move back and clear that cell
      moveToPrev(row, col);
    }
    return;
  }

  if (e.key === " ") {
    e.preventDefault();
    state.direction = state.direction === "across" ? "down" : "across";
    highlightWord();
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();
    if (e.shiftKey) {
      moveToPrevClue(row, col);
    } else {
      moveToNextClue(row, col);
    }
    return;
  }

  const arrowMap = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  if (arrowMap[e.key]) {
    e.preventDefault();
    const [dr, dc] = arrowMap[e.key];
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

function moveToNextClue(row, col) {
  const dir = state.direction;
  const clues = state.puzzle.clues[dir];
  const otherDir = dir === "across" ? "down" : "across";
  const otherClues = state.puzzle.clues[otherDir];

  // Find which clue the current cell belongs to
  const currentClue = findClueForCell(row, col, dir);
  let idx = currentClue ? clues.findIndex((c) => c.row === currentClue.row && c.col === currentClue.col) : -1;

  if (idx >= 0 && idx < clues.length - 1) {
    // Next clue in same direction
    const next = clues[idx + 1];
    selectCell(next.row, next.col);
    getCellInput(next.row, next.col)?.focus();
  } else {
    // Wrap to first clue of the other direction
    state.direction = otherDir;
    const next = otherClues[0];
    if (next) {
      selectCell(next.row, next.col);
      getCellInput(next.row, next.col)?.focus();
    }
  }
}

function moveToPrevClue(row, col) {
  const dir = state.direction;
  const clues = state.puzzle.clues[dir];
  const otherDir = dir === "across" ? "down" : "across";
  const otherClues = state.puzzle.clues[otherDir];

  // Find which clue the current cell belongs to
  const currentClue = findClueForCell(row, col, dir);
  let idx = currentClue ? clues.findIndex((c) => c.row === currentClue.row && c.col === currentClue.col) : -1;

  if (idx > 0) {
    // Previous clue in same direction
    const prev = clues[idx - 1];
    selectCell(prev.row, prev.col);
    getCellInput(prev.row, prev.col)?.focus();
  } else {
    // Wrap to last clue of the other direction
    state.direction = otherDir;
    const prev = otherClues[otherClues.length - 1];
    if (prev) {
      selectCell(prev.row, prev.col);
      getCellInput(prev.row, prev.col)?.focus();
    }
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
      return;
    }
    nr += dr;
    nc += dc;
  }
}

function highlightWord() {
  document.querySelectorAll(".cell.selected, .cell.highlighted").forEach((c) => {
    c.classList.remove("selected", "highlighted");
  });
  document.querySelectorAll(".clue-item.active").forEach((c) => c.classList.remove("active"));

  if (!state.selectedCell) return;

  const { row, col } = state.selectedCell;
  const cell = getCell(row, col);
  if (cell) cell.classList.add("selected");

  const wordCells = getWordCells(row, col, state.direction);
  wordCells.forEach(([r, c]) => {
    const el = getCell(r, c);
    if (el && !(r === row && c === col)) el.classList.add("highlighted");
  });

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

  let sr = row, sc = col;
  while (sr - dr >= 0 && sc - dc >= 0 && state.grid[sr - dr]?.[sc - dc] !== null && state.grid[sr - dr]?.[sc - dc] !== undefined) {
    sr -= dr;
    sc -= dc;
  }

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

function escHtml(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

// ---------- Logo → back to lobby ----------
document.getElementById("logoBtn").addEventListener("click", () => {
  if (gameScreen.classList.contains("active")) {
    socket.emit("leave-room", { roomId: state.roomId });
    state = { roomId: null, puzzle: null, grid: null, players: {}, myId: null, selectedCell: null, direction: "across", activeClue: null };
    gridWrapper.innerHTML = "";
    cluesPanel.innerHTML = "";
    gameScreen.classList.remove("active");
    lobbyScreen.classList.add("active");
    roomBadge.style.display = "none";
    history.replaceState(null, "", window.location.pathname);
  }
});

// ---------- Auto-join from URL ----------
(function checkUrlRoom() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  if (room) {
    roomInput.value = room;
  }
})();
