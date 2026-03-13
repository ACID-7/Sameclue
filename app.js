import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase,
  get,
  onDisconnect,
  onValue,
  remove,
  ref,
  runTransaction,
  update
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getWordList } from "./words.js";

const firebaseConfig = {
  apiKey: "AIzaSyAretLJexB_PRmp9mZtjyiWy9BiNDpkyVc",
  authDomain: "sameclue-1b0fa.firebaseapp.com",
  databaseURL: "https://sameclue-1b0fa-default-rtdb.firebaseio.com",
  projectId: "sameclue-1b0fa",
  storageBucket: "sameclue-1b0fa.firebasestorage.app",
  messagingSenderId: "683693192650",
  appId: "1:683693192650:web:1b10fc40b1d134ed25cb33",
  measurementId: "G-7Q4W4FL6Z3"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const TOTAL_ROUNDS = 10;
const ROUND_DURATION_MS = 30000;
const PLAYER_NAME_KEY = "sameclue-player-name";

const elements = {
  btnCreate: document.getElementById("btn-create"),
  btnJoinToggle: document.getElementById("btn-join-toggle"),
  btnJoin: document.getElementById("btn-join"),
  btnCopyCode: document.getElementById("btn-copy-code"),
  btnStart: document.getElementById("btn-start"),
  btnLeaveLobby: document.getElementById("btn-leave-lobby"),
  btnSubmitClue: document.getElementById("btn-submit-clue"),
  btnNextRound: document.getElementById("btn-next-round"),
  btnPlayAgain: document.getElementById("btn-play-again"),
  btnHome: document.getElementById("btn-home"),
  joinForm: document.getElementById("join-form"),
  joinCode: document.getElementById("join-code"),
  playerName: document.getElementById("player-name"),
  toast: document.getElementById("toast"),
  lobbyStatus: document.getElementById("lobby-status"),
  lobbyPlayerCount: document.getElementById("lobby-player-count"),
  lobbyHostLabel: document.getElementById("lobby-host-label"),
  displayRoomCode: document.getElementById("display-room-code"),
  playerSlots: document.getElementById("player-slots"),
  roundNum: document.getElementById("round-num"),
  scoreMe: document.getElementById("score-me"),
  scoreLeader: document.getElementById("score-leader"),
  playerCount: document.getElementById("player-count"),
  roundTimer: document.getElementById("round-timer"),
  streakBadge: document.getElementById("streak-badge"),
  streakNum: document.getElementById("streak-num"),
  secretWord: document.getElementById("secret-word"),
  clueEntry: document.getElementById("clue-entry"),
  clueInput: document.getElementById("clue-input"),
  waitingPanel: document.getElementById("waiting-panel"),
  waitingCopy: document.getElementById("waiting-copy"),
  myLockedWord: document.getElementById("my-locked-word"),
  revealSecretWord: document.getElementById("reveal-secret-word"),
  resultBadge: document.getElementById("result-badge"),
  resultPoints: document.getElementById("result-points"),
  revealCluesList: document.getElementById("reveal-clues-list"),
  revealScoreMe: document.getElementById("reveal-score-me"),
  revealScoreLeader: document.getElementById("reveal-score-leader"),
  finalTrophy: document.getElementById("final-trophy"),
  finalTitle: document.getElementById("final-title"),
  finalSubtitle: document.getElementById("final-subtitle"),
  finalRank: document.getElementById("final-rank"),
  finalScoreMe: document.getElementById("final-score-me"),
  statMatches: document.getElementById("stat-matches"),
  statStreak: document.getElementById("stat-streak"),
  statRounds: document.getElementById("stat-rounds"),
  leaderboard: document.getElementById("leaderboard")
};

let roomCode = null;
let playerId = null;
let roomRef = null;
let roomUnsubscribe = null;
let currentRoom = null;
let currentScreen = "screen-home";
let evaluationInFlight = false;
let toastTimeoutId = null;
let submitInFlight = false;
let timerIntervalId = null;
let disconnectHandlers = [];

function showScreen(id) {
  currentScreen = id;
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.classList.toggle("active", screen.id === id);
  });
}

function showToast(message, duration = 2200) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  elements.toast.classList.add("show");
  if (toastTimeoutId) {
    window.clearTimeout(toastTimeoutId);
  }
  toastTimeoutId = window.setTimeout(() => {
    elements.toast.classList.remove("show");
  }, duration);
}

function sanitizePlayerName(value) {
  const cleaned = (value || "").replace(/\s+/g, " ").trim().slice(0, 18);
  return cleaned || "Player";
}

function loadStoredPlayerName() {
  return sanitizePlayerName(window.localStorage.getItem(PLAYER_NAME_KEY) || "Player");
}

function savePlayerName() {
  const name = sanitizePlayerName(elements.playerName.value);
  elements.playerName.value = name;
  window.localStorage.setItem(PLAYER_NAME_KEY, name);
  return name;
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function generatePlayerId() {
  const token = Math.random().toString(36).slice(2, 10);
  return `p_${token}`;
}

function getRoundKey(round) {
  return `round_${round}`;
}

function getOrderedPlayerIds(data) {
  return Array.isArray(data.playerOrder) ? data.playerOrder.filter((id) => data.players?.[id]) : [];
}

function getOrderedPlayers(data) {
  return getOrderedPlayerIds(data).map((id) => ({
    id,
    ...data.players[id]
  }));
}

function getPlayerName(id, data) {
  return data.players?.[id]?.name || "Player";
}

function getRoundData(data, round = data.round) {
  return data[getRoundKey(round)] || {};
}

function countSubmittedPlayers(data) {
  return Object.keys(getRoundData(data)).length;
}

function getLeaderScore(data) {
  return Math.max(0, ...Object.values(data.scores || {}));
}

function createResetRounds() {
  return Object.fromEntries(
    Array.from({ length: TOTAL_ROUNDS }, (_, index) => [getRoundKey(index + 1), null])
  );
}

function createRoundDeadline() {
  return Date.now() + ROUND_DURATION_MS;
}

function clearRoundTimer() {
  if (timerIntervalId) {
    window.clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
}

function updateRoundTimer(deadline) {
  if (!deadline) {
    elements.roundTimer.textContent = "--";
    return;
  }

  const remainingMs = Math.max(0, deadline - Date.now());
  elements.roundTimer.textContent = String(Math.ceil(remainingMs / 1000));
}

function startRoundTimer(deadline) {
  clearRoundTimer();
  updateRoundTimer(deadline);
  if (!deadline) {
    return;
  }

  timerIntervalId = window.setInterval(() => {
    updateRoundTimer(deadline);
  }, 250);
}

function cancelDisconnectHandlers() {
  disconnectHandlers.forEach((handler) => {
    void handler.cancel();
  });
  disconnectHandlers = [];
}

function sanitizeClue(clue) {
  return clue.trim().toLowerCase().replace(/\s+/g, "");
}

function validateClue(rawClue, secretWord) {
  const clue = sanitizeClue(rawClue);
  const word = secretWord.toLowerCase();

  if (!clue) {
    return { ok: false, error: "Enter a clue first." };
  }
  if (/\s/.test(rawClue.trim())) {
    return { ok: false, error: "Use one word only." };
  }
  if (clue === word) {
    return { ok: false, error: "You cannot use the secret word." };
  }
  if (clue.includes(word) || word.includes(clue)) {
    return { ok: false, error: "That clue is too close to the secret word." };
  }

  return { ok: true, clue };
}

function detachRoomListener() {
  if (roomUnsubscribe) {
    roomUnsubscribe();
    roomUnsubscribe = null;
  }
}

function resetSession() {
  detachRoomListener();
  cancelDisconnectHandlers();
  clearRoundTimer();
  roomCode = null;
  playerId = null;
  roomRef = null;
  currentRoom = null;
  evaluationInFlight = false;
  submitInFlight = false;
  elements.clueInput.value = "";
  showScreen("screen-home");
}

function renderLobby(data) {
  if (currentScreen !== "screen-lobby") {
    showScreen("screen-lobby");
  }

  const players = getOrderedPlayers(data);
  const hostName = getPlayerName(data.hostId, data);
  const isHost = data.hostId === playerId;

  elements.displayRoomCode.textContent = roomCode;
  elements.lobbyPlayerCount.textContent = `${players.length} / ${MAX_PLAYERS}`;
  elements.lobbyHostLabel.textContent = hostName;
  elements.playerSlots.innerHTML = "";

  for (const player of players) {
    const card = document.createElement("div");
    card.className = "player-slot";
    if (player.id === playerId) {
      card.classList.add("you");
    }
    if (player.id === data.hostId) {
      card.classList.add("host");
    }
    card.innerHTML = `
      <div class="slot-dot"></div>
      <strong>${player.name}</strong>
      <span class="slot-role">${player.id === playerId ? "You" : "Joined"}${player.id === data.hostId ? " · Host" : ""}</span>
    `;
    elements.playerSlots.appendChild(card);
  }

  for (let index = players.length; index < MAX_PLAYERS; index += 1) {
    const empty = document.createElement("div");
    empty.className = "player-slot empty";
    empty.innerHTML = `
      <strong>Open Slot</strong>
      <span class="slot-role">Share code to join</span>
    `;
    elements.playerSlots.appendChild(empty);
  }

  if (players.length < MIN_PLAYERS) {
    elements.lobbyStatus.textContent = "Need at least 2 players to start.";
  } else if (isHost) {
    elements.lobbyStatus.textContent = "Lobby is ready. Start whenever you want.";
  } else {
    elements.lobbyStatus.textContent = "Waiting for the host to start the game.";
  }

  elements.btnStart.classList.toggle("hidden", !(isHost && players.length >= MIN_PLAYERS));
}

function renderGame(data) {
  if (currentScreen !== "screen-game") {
    showScreen("screen-game");
  }

  const roundData = getRoundData(data);
  const submitted = Boolean(roundData[playerId]);
  const submittedCount = countSubmittedPlayers(data);
  const players = getOrderedPlayers(data);
  const secretWord = data.words?.[(data.round || 1) - 1] || "---";
  const deadline = data.roundDeadline || 0;

  elements.roundNum.textContent = String(data.round || 1);
  elements.scoreMe.textContent = String(data.scores?.[playerId] || 0);
  elements.scoreLeader.textContent = String(getLeaderScore(data));
  elements.playerCount.textContent = String(players.length);
  elements.secretWord.textContent = secretWord;
  startRoundTimer(deadline);

  if ((data.streak || 0) >= 2) {
    elements.streakBadge.classList.remove("hidden");
    elements.streakNum.textContent = String(data.streak);
  } else {
    elements.streakBadge.classList.add("hidden");
  }

  if (submitted) {
    elements.clueEntry.classList.add("hidden");
    elements.waitingPanel.classList.remove("hidden");
    elements.myLockedWord.textContent = roundData[playerId];
  } else {
    const timedOut = Boolean(deadline) && Date.now() >= deadline;
    if (timedOut) {
      elements.clueEntry.classList.add("hidden");
      elements.waitingPanel.classList.remove("hidden");
      elements.myLockedWord.textContent = "No clue";
    } else {
      elements.clueEntry.classList.remove("hidden");
      elements.waitingPanel.classList.add("hidden");
      elements.clueInput.focus();
    }
  }

  const remaining = players.length - submittedCount;
  elements.waitingCopy.textContent = remaining > 0
    ? `Waiting for ${remaining} player${remaining === 1 ? "" : "s"}...`
    : "All clues are in. Resolving round...";
}

function buildLobbyReset(data, overrides = {}) {
  const playerIds = getOrderedPlayerIds(data);
  const scores = Object.fromEntries(playerIds.map((id) => [id, 0]));

  return {
    status: "lobby",
    round: 1,
    words: getWordList(TOTAL_ROUNDS),
    scores,
    streak: 0,
    bestStreak: 0,
    totalMatches: 0,
    resolvedRound: 0,
    lastResult: null,
    roundDeadline: null,
    ...createResetRounds(),
    ...overrides
  };
}

function renderReveal(data) {
  if (currentScreen !== "screen-reveal") {
    showScreen("screen-reveal");
  }

  const result = data.lastResult || {};
  const players = getOrderedPlayers(data);
  const scoringPlayers = new Set(result.scoringPlayers || []);
  const roundData = getRoundData(data);
  clearRoundTimer();
  updateRoundTimer(null);

  elements.revealSecretWord.textContent = data.words?.[(data.round || 1) - 1] || "---";
  elements.revealScoreMe.textContent = String(data.scores?.[playerId] || 0);
  elements.revealScoreLeader.textContent = String(getLeaderScore(data));
  elements.revealCluesList.innerHTML = "";

  if (result.matched) {
    elements.resultBadge.className = "result-badge matched";
    elements.resultBadge.textContent = result.fullMatch ? "FULL TABLE MATCH" : `${result.largestGroupSize}-PLAYER MATCH`;
    elements.resultPoints.textContent = result.bonusApplied
      ? "Matching players earned 3 points this round with the streak bonus."
      : "Matching players earned 2 points this round.";
  } else {
    elements.resultBadge.className = "result-badge no-match";
    elements.resultBadge.textContent = "NO MATCH";
    elements.resultPoints.textContent = "No duplicate clues this round.";
  }

  for (const player of players) {
    const card = document.createElement("div");
    card.className = "reveal-clue-card";
    if (player.id === playerId) {
      card.classList.add("you");
    }
    if (scoringPlayers.has(player.id)) {
      card.classList.add("matched");
    }
    card.innerHTML = `
      <div class="reveal-player">
        <strong>${player.name}</strong>
        <span>${player.id === playerId ? "You" : `Score ${data.scores?.[player.id] || 0}`}</span>
      </div>
      <div class="reveal-clue">${roundData[player.id] || "No clue"}</div>
    `;
    elements.revealCluesList.appendChild(card);
  }

  elements.btnNextRound.classList.toggle("hidden", data.hostId !== playerId);
  elements.btnNextRound.textContent = data.round >= TOTAL_ROUNDS ? "See Results" : "Next Round";
}

function renderFinal(data) {
  if (currentScreen !== "screen-final") {
    showScreen("screen-final");
  }

  const standings = getOrderedPlayers(data)
    .map((player) => ({
      ...player,
      score: data.scores?.[player.id] || 0
    }))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

  const rank = standings.findIndex((player) => player.id === playerId) + 1;
  const myScore = data.scores?.[playerId] || 0;
  clearRoundTimer();
  updateRoundTimer(null);

  elements.finalRank.textContent = `#${rank || standings.length}`;
  elements.finalScoreMe.textContent = String(myScore);
  elements.statMatches.textContent = String(data.totalMatches || 0);
  elements.statStreak.textContent = String(data.bestStreak || 0);
  elements.statRounds.textContent = String(TOTAL_ROUNDS);

  if (rank === 1) {
    elements.finalTrophy.textContent = "1";
    elements.finalTitle.textContent = "You finished first";
    elements.finalSubtitle.textContent = "Your clues stayed in sync with the room.";
  } else {
    elements.finalTrophy.textContent = String(rank || "-");
    elements.finalTitle.textContent = "Final standings";
    elements.finalSubtitle.textContent = `${standings[0]?.name || "Leader"} topped the board with ${standings[0]?.score || 0} points.`;
  }

  elements.leaderboard.innerHTML = "";
  standings.forEach((player, index) => {
    const row = document.createElement("div");
    row.className = "leaderboard-row";
    if (player.id === playerId) {
      row.classList.add("you");
    }
    row.innerHTML = `
      <div class="leaderboard-rank">#${index + 1}</div>
      <div class="leaderboard-name">
        <strong>${player.name}</strong>
        <span>${player.id === data.hostId ? "Host" : "Player"}</span>
      </div>
      <div class="leaderboard-score">${player.score}</div>
    `;
    elements.leaderboard.appendChild(row);
  });
}

async function evaluateRound(data) {
  if (evaluationInFlight) {
    return;
  }

  evaluationInFlight = true;

  try {
    const roundData = getRoundData(data);
    const clueGroups = {};

    for (const [id, clue] of Object.entries(roundData)) {
      if (!clueGroups[clue]) {
        clueGroups[clue] = [];
      }
      clueGroups[clue].push(id);
    }

    const matchingGroups = Object.entries(clueGroups).filter(([, ids]) => ids.length >= 2);
    const scoringPlayers = matchingGroups.flatMap(([, ids]) => ids);
    const matched = scoringPlayers.length > 0;
    const fullMatch = matched && matchingGroups.length === 1 && scoringPlayers.length === getOrderedPlayerIds(data).length;
    const largestGroupSize = matchingGroups.length > 0
      ? Math.max(...matchingGroups.map(([, ids]) => ids.length))
      : 1;

    const nextScores = { ...(data.scores || {}) };
    for (const id of scoringPlayers) {
      nextScores[id] = (nextScores[id] || 0) + 2;
    }

    const nextStreak = matched ? (data.streak || 0) + 1 : 0;
    let bonusApplied = false;
    if (matched && nextStreak >= 3) {
      for (const id of scoringPlayers) {
        nextScores[id] = (nextScores[id] || 0) + 1;
      }
      bonusApplied = true;
    }

    await update(roomRef, {
      status: "reveal",
      scores: nextScores,
      streak: nextStreak,
      bestStreak: Math.max(data.bestStreak || 0, nextStreak),
      totalMatches: (data.totalMatches || 0) + (matched ? 1 : 0),
      resolvedRound: data.round,
      lastResult: {
        matched,
        fullMatch,
        largestGroupSize,
        scoringPlayers,
        bonusApplied
      }
    });
  } finally {
    evaluationInFlight = false;
  }
}

function shouldEvaluateRound(data) {
  if (playerId !== data.hostId) {
    return false;
  }
  if (data.status !== "playing") {
    return false;
  }
  if ((data.resolvedRound || 0) >= (data.round || 1)) {
    return false;
  }
  if (countSubmittedPlayers(data) === getOrderedPlayerIds(data).length) {
    return true;
  }
  return Boolean(data.roundDeadline && Date.now() >= data.roundDeadline);
}

function handleRoomUpdate(data) {
  currentRoom = data;
  submitInFlight = false;

  const livePlayers = getOrderedPlayerIds(data);
  if (data.hostId && !livePlayers.includes(data.hostId) && livePlayers.length > 0 && playerId === livePlayers[0]) {
    void update(roomRef, { hostId: livePlayers[0] });
    return;
  }

  if (shouldEvaluateRound(data)) {
    void evaluateRound(data);
  }

  if (data.status === "lobby") {
    renderLobby(data);
    return;
  }
  if (data.status === "playing") {
    renderGame(data);
    return;
  }
  if (data.status === "reveal") {
    renderReveal(data);
    return;
  }
  if (data.status === "gameover") {
    renderFinal(data);
  }
}

function enterRoom() {
  elements.displayRoomCode.textContent = roomCode;
  detachRoomListener();
  void registerDisconnectCleanup();
  roomUnsubscribe = onValue(roomRef, (snapshot) => {
    if (!snapshot.exists()) {
      showToast("Room was closed.");
      resetSession();
      return;
    }
    handleRoomUpdate(snapshot.val());
  });
}

async function registerDisconnectCleanup() {
  if (!roomCode || !playerId) {
    return;
  }

  cancelDisconnectHandlers();
  const handlers = [
    onDisconnect(ref(db, `rooms/${roomCode}/players/${playerId}`)),
    onDisconnect(ref(db, `rooms/${roomCode}/scores/${playerId}`))
  ];

  for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
    handlers.push(onDisconnect(ref(db, `rooms/${roomCode}/${getRoundKey(round)}/${playerId}`)));
  }

  for (const handler of handlers) {
    await handler.remove();
  }

  disconnectHandlers = handlers;
}

async function createRoom() {
  const playerName = savePlayerName();
  playerId = generatePlayerId();
  const players = {
    [playerId]: {
      name: playerName,
      joinedAt: Date.now()
    }
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidateCode = generateRoomCode();
    const candidateRef = ref(db, `rooms/${candidateCode}`);
    const result = await runTransaction(candidateRef, (room) => {
      if (room) {
        return undefined;
      }
      return {
        status: "lobby",
        hostId: playerId,
        players,
        playerOrder: [playerId],
        scores: { [playerId]: 0 },
        round: 1,
        words: getWordList(TOTAL_ROUNDS),
        streak: 0,
        bestStreak: 0,
        totalMatches: 0,
        resolvedRound: 0,
        roundDeadline: null,
        created: Date.now(),
        ...createResetRounds()
      };
    });

    if (result.committed) {
      roomCode = candidateCode;
      roomRef = candidateRef;
      enterRoom();
      return;
    }
  }

  showToast("Could not create a room. Try again.");
}

async function joinRoom() {
  const playerName = savePlayerName();
  const code = elements.joinCode.value.trim().toUpperCase();
  if (code.length < 4) {
    showToast("Enter a valid room code.");
    return;
  }

  const joinRef = ref(db, `rooms/${code}`);
  const snapshot = await get(joinRef);

  if (!snapshot.exists()) {
    showToast("Room not found.");
    return;
  }

  const data = snapshot.val();
  const playerOrder = getOrderedPlayerIds(data);

  if (data.status !== "lobby") {
    showToast("This room has already started.");
    return;
  }
  if (playerOrder.length >= MAX_PLAYERS) {
    showToast("This room is full.");
    return;
  }

  const nextPlayerId = generatePlayerId();
  const result = await runTransaction(joinRef, (room) => {
    if (!room || room.status !== "lobby") {
      return room;
    }

    const liveOrder = Array.isArray(room.playerOrder) ? room.playerOrder.filter((id) => room.players?.[id]) : [];
    if (liveOrder.length >= MAX_PLAYERS) {
      return room;
    }

    const nextOrder = [...liveOrder, nextPlayerId];
    return {
      ...room,
      playerOrder: nextOrder,
      players: {
        ...(room.players || {}),
        [nextPlayerId]: {
          name: playerName,
          joinedAt: Date.now()
        }
      },
      scores: {
        ...(room.scores || {}),
        [nextPlayerId]: 0
      }
    };
  });

  const nextRoom = result.snapshot.val();
  const joined = Boolean(nextRoom?.players?.[nextPlayerId]);
  if (!result.committed || !joined) {
    showToast(nextRoom?.status === "lobby" ? "This room is full." : "This room has already started.");
    return;
  }

  playerId = nextPlayerId;
  roomCode = code;
  roomRef = joinRef;
  enterRoom();
}

async function leaveRoom() {
  if (!roomCode || !playerId || !roomRef) {
    resetSession();
    return;
  }

  const snapshot = await get(roomRef);
  if (!snapshot.exists()) {
    resetSession();
    return;
  }

  const data = snapshot.val();
  const playerOrder = getOrderedPlayerIds(data);
  if (!playerOrder.includes(playerId)) {
    resetSession();
    return;
  }

  const remainingOrder = playerOrder.filter((id) => id !== playerId);
  if (remainingOrder.length === 0) {
    await remove(roomRef);
    resetSession();
    return;
  }

  const updates = {
    [`players/${playerId}`]: null,
    [`scores/${playerId}`]: null,
    playerOrder: remainingOrder
  };

  if (data.hostId === playerId) {
    updates.hostId = remainingOrder[0];
  }

  for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
    updates[`${getRoundKey(round)}/${playerId}`] = null;
  }

  const activeGame = data.status === "playing" || data.status === "reveal";
  if (activeGame || remainingOrder.length < MIN_PLAYERS) {
    const remainingPlayersData = remainingOrder.reduce((acc, id) => {
      acc[id] = data.players[id];
      return acc;
    }, {});
    Object.assign(updates, buildLobbyReset({
      ...data,
      hostId: updates.hostId || data.hostId,
      playerOrder: remainingOrder,
      players: remainingPlayersData
    }));
  }

  await update(roomRef, updates);
  resetSession();
}

async function submitClue() {
  if (!currentRoom || currentRoom.status !== "playing" || submitInFlight) {
    return;
  }
  if (currentRoom.roundDeadline && Date.now() >= currentRoom.roundDeadline) {
    showToast("Time is up for this round.");
    return;
  }

  const secretWord = currentRoom.words?.[(currentRoom.round || 1) - 1] || "";
  const validation = validateClue(elements.clueInput.value, secretWord);

  if (!validation.ok) {
    showToast(validation.error);
    return;
  }

  const clue = validation.clue;
  submitInFlight = true;
  elements.clueInput.value = "";

  try {
    await update(ref(db, `rooms/${roomCode}/${getRoundKey(currentRoom.round)}`), {
      [playerId]: clue
    });
  } catch (error) {
    submitInFlight = false;
    showToast("Could not submit clue. Try again.");
  }
}

async function startGame() {
  if (!currentRoom || currentRoom.hostId !== playerId) {
    return;
  }
  if (getOrderedPlayerIds(currentRoom).length < MIN_PLAYERS) {
    showToast("Need at least 2 players.");
    return;
  }

  await update(roomRef, {
    ...buildLobbyReset(currentRoom, {
      status: "playing",
      roundDeadline: createRoundDeadline()
    })
  });
}

async function goToNextRound() {
  if (!currentRoom || currentRoom.hostId !== playerId) {
    return;
  }

  if ((currentRoom.round || 1) >= TOTAL_ROUNDS) {
    await update(roomRef, {
      status: "gameover"
    });
    return;
  }

  await update(roomRef, {
    status: "playing",
    round: (currentRoom.round || 1) + 1,
    resolvedRound: currentRoom.round,
    lastResult: null,
    roundDeadline: createRoundDeadline()
  });
}

async function playAgain() {
  if (!currentRoom) {
    return;
  }

  if (currentRoom.hostId !== playerId) {
    showToast("Waiting for the host to restart.");
    return;
  }

  const playerIds = getOrderedPlayerIds(currentRoom);
  if (playerIds.length < MIN_PLAYERS) {
    showToast("Need at least 2 players.");
    return;
  }

  await update(roomRef, buildLobbyReset(currentRoom));
}

elements.btnCreate.addEventListener("click", () => {
  void createRoom();
});

elements.playerName.value = loadStoredPlayerName();
elements.playerName.addEventListener("change", () => {
  savePlayerName();
});

elements.btnJoinToggle.addEventListener("click", () => {
  elements.joinForm.classList.toggle("hidden");
  if (!elements.joinForm.classList.contains("hidden")) {
    elements.joinCode.focus();
  }
});

elements.btnJoin.addEventListener("click", () => {
  void joinRoom();
});

elements.joinCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    void joinRoom();
  }
});

elements.btnCopyCode.addEventListener("click", () => {
  if (!roomCode) {
    return;
  }
  navigator.clipboard.writeText(roomCode).then(() => {
    showToast("Room code copied.");
  });
});

elements.btnStart.addEventListener("click", () => {
  void startGame();
});

elements.btnLeaveLobby.addEventListener("click", () => {
  void leaveRoom();
});

elements.btnSubmitClue.addEventListener("click", () => {
  void submitClue();
});

elements.clueInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    void submitClue();
  }
});

elements.btnNextRound.addEventListener("click", () => {
  void goToNextRound();
});

elements.btnPlayAgain.addEventListener("click", () => {
  void playAgain();
});

elements.btnHome.addEventListener("click", () => {
  void leaveRoom();
});

window.addEventListener("pagehide", () => {
  if (roomCode && playerId) {
    void leaveRoom();
  }
});
