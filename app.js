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
const LAST_SWEEP_KEY = "sameclue-last-room-sweep";
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const elements = {
  btnCreate: document.getElementById("btn-create"),
  btnJoinToggle: document.getElementById("btn-join-toggle"),
  btnJoin: document.getElementById("btn-join"),
  btnCopyCode: document.getElementById("btn-copy-code"),
  btnShareCode: document.getElementById("btn-share-code"),
  btnReady: document.getElementById("btn-ready"),
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
let deadlineTimeoutId = null;
let disconnectHandlers = [];
let disconnectRefreshSignature = "";
let roomActionInFlight = false;

function showScreen(id) {
  currentScreen = id;
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.classList.toggle("active", screen.id === id);
  });
  window.scrollTo(0, 0);
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

function getPlayerCount(data) {
  return getOrderedPlayerIds(data).length;
}

async function cleanupOrphanRooms() {
  const now = Date.now();
  const lastSweep = Number(window.localStorage.getItem(LAST_SWEEP_KEY) || 0);
  if (now - lastSweep < SWEEP_INTERVAL_MS) {
    return;
  }
  window.localStorage.setItem(LAST_SWEEP_KEY, String(now));

  try {
    const roomsSnap = await get(ref(db, "rooms"));
    if (!roomsSnap.exists()) {
      return;
    }

    const updates = {};
    roomsSnap.forEach((roomChild) => {
      const room = roomChild.val() || {};
      const roomPlayers = Array.isArray(room.playerOrder)
        ? room.playerOrder.filter((id) => room.players?.[id])
        : [];
      if (roomPlayers.length === 0) {
        updates[roomChild.key] = null;
      }
    });

    if (Object.keys(updates).length > 0) {
      void update(ref(db, "rooms"), updates);
    }
  } catch {
    // Best-effort cleanup only; ignore sweep errors.
  }
}

function setRoomActionState(isBusy) {
  roomActionInFlight = isBusy;
  [
    elements.btnCreate,
    elements.btnJoin,
    elements.btnStart,
    elements.btnNextRound,
    elements.btnPlayAgain,
    elements.btnLeaveLobby,
    elements.btnHome,
    elements.btnReady
  ].forEach((button) => {
    if (button) {
      button.disabled = isBusy;
    }
  });
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

function buildRoundResult(data) {
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

  return {
    scores: nextScores,
    streak: nextStreak,
    bestStreak: Math.max(data.bestStreak || 0, nextStreak),
    totalMatches: (data.totalMatches || 0) + (matched ? 1 : 0),
    lastResult: {
      matched,
      fullMatch,
      largestGroupSize,
      scoringPlayers,
      bonusApplied
    }
  };
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
  if (deadlineTimeoutId) {
    window.clearTimeout(deadlineTimeoutId);
    deadlineTimeoutId = null;
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

  if (currentRoom?.hostId === playerId && currentRoom?.status === "playing") {
    const msUntilDeadline = Math.max(0, deadline - Date.now()) + 50;
    deadlineTimeoutId = window.setTimeout(() => {
      if (currentRoom?.status === "playing") {
        renderGame(currentRoom);
      }
      if (currentRoom && shouldEvaluateRound(currentRoom)) {
        void evaluateRound(currentRoom);
      }
    }, msUntilDeadline);
  } else {
    const msUntilDeadline = Math.max(0, deadline - Date.now()) + 50;
    deadlineTimeoutId = window.setTimeout(() => {
      if (currentRoom?.status === "playing") {
        renderGame(currentRoom);
      }
    }, msUntilDeadline);
  }
}

function cancelDisconnectHandlers() {
  disconnectHandlers.forEach((handler) => {
    void handler.cancel();
  });
  disconnectHandlers = [];
  disconnectRefreshSignature = "";
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
  setRoomActionState(false);
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
  const allReady = players.length >= MIN_PLAYERS && players.every((player) => player.ready);
  const meReady = Boolean(data.players?.[playerId]?.ready);

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
    if (player.ready) {
      card.classList.add("ready");
    }
    card.innerHTML = `
      <div class="slot-dot"></div>
      <strong>${player.name}</strong>
      <span class="slot-role">${player.id === playerId ? "You" : "Joined"}${player.id === data.hostId ? " | Host" : ""}</span>
      <span class="slot-state">${player.ready ? "Ready" : "Waiting"}</span>
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
  } else if (!allReady) {
    elements.lobbyStatus.textContent = isHost ? "Waiting for everyone to ready up." : "Mark yourself ready to start.";
  } else if (isHost) {
    elements.lobbyStatus.textContent = "Everyone is ready. Start the game.";
  } else {
    elements.lobbyStatus.textContent = "All players ready. Waiting for the host.";
  }

  elements.btnReady.textContent = meReady ? "Unready" : "Ready Up";
  elements.btnReady.classList.toggle("hidden", false);
  elements.btnStart.classList.toggle("hidden", !(isHost && allReady));
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
  const timedOut = Boolean(deadline) && Date.now() >= deadline;
  if (timedOut) {
    elements.waitingCopy.textContent = `Time is up. ${submittedCount}/${players.length} clues locked.`;
  } else if (remaining > 0) {
    elements.waitingCopy.textContent = `${submittedCount}/${players.length} clues locked. Waiting for ${remaining} player${remaining === 1 ? "" : "s"}...`;
  } else {
    elements.waitingCopy.textContent = "All clues are in. Resolving round...";
  }
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
    activeRoster: null,
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
    await runTransaction(roomRef, (room) => {
      if (!room || room.status !== "playing" || room.hostId !== playerId) {
        return room;
      }
      if ((room.resolvedRound || 0) >= (room.round || 1)) {
        return room;
      }
      const everybodySubmitted = countSubmittedPlayers(room) === getOrderedPlayerIds(room).length;
      const timedOut = Boolean(room.roundDeadline && Date.now() >= room.roundDeadline);
      if (!everybodySubmitted && !timedOut) {
        return room;
      }

      return {
        ...room,
        status: "reveal",
        resolvedRound: room.round,
        ...buildRoundResult(room)
      };
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
  setRoomActionState(false);

  const livePlayers = getOrderedPlayerIds(data);
  void registerDisconnectCleanup();

  const activeRoster = Array.isArray(data.activeRoster) ? data.activeRoster : [];
  const rosterChanged = activeRoster.length > 0 && activeRoster.some((id) => !livePlayers.includes(id));
  if (data.hostId && !livePlayers.includes(data.hostId) && livePlayers.length > 0 && playerId === livePlayers[0]) {
    void update(roomRef, { hostId: livePlayers[0] });
    return;
  }

  if ((data.status === "playing" || data.status === "reveal") && (livePlayers.length < MIN_PLAYERS || rosterChanged)) {
    if (livePlayers.length > 0 && playerId === livePlayers[0]) {
      const remainingPlayers = Object.fromEntries(
        livePlayers.map((id) => [id, data.players[id]])
      );
      void update(roomRef, buildLobbyReset({
        ...data,
        hostId: data.hostId && livePlayers.includes(data.hostId) ? data.hostId : livePlayers[0],
        players: remainingPlayers,
        playerOrder: livePlayers
      }));
    }
    return;
  }

  if (data.status !== "playing") {
    clearRoundTimer();
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
  if (!roomCode || !playerId || !currentRoom) {
    return;
  }

  const playerCount = getPlayerCount(currentRoom);
  const signature = `${roomCode}:${playerId}:${currentRoom.status}:${playerCount}:${currentRoom.hostId === playerId}`;
  if (disconnectRefreshSignature === signature) {
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

  if (playerCount === 1 && currentRoom.hostId === playerId) {
    handlers.push(onDisconnect(roomRef));
  }

  for (const handler of handlers) {
    await handler.remove();
  }

  disconnectHandlers = handlers;
  disconnectRefreshSignature = signature;
}

async function createRoom() {
  if (roomActionInFlight) {
    return;
  }
  setRoomActionState(true);
  const playerName = savePlayerName();
  playerId = generatePlayerId();
  const players = {
    [playerId]: {
      name: playerName,
      joinedAt: Date.now(),
      ready: true
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
      setRoomActionState(false);
      enterRoom();
      return;
    }
  }

  setRoomActionState(false);
  showToast("Could not create a room. Try again.");
}

async function joinRoom() {
  if (roomActionInFlight) {
    return;
  }
  setRoomActionState(true);
  const playerName = savePlayerName();
  const code = elements.joinCode.value.trim().toUpperCase();
  if (code.length < 4) {
    setRoomActionState(false);
    showToast("Enter a valid room code.");
    return;
  }

  const joinRef = ref(db, `rooms/${code}`);
  const snapshot = await get(joinRef);

  if (!snapshot.exists()) {
    setRoomActionState(false);
    showToast("Room not found.");
    return;
  }

  const data = snapshot.val();
  const playerOrder = getOrderedPlayerIds(data);

  if (data.status !== "lobby") {
    setRoomActionState(false);
    showToast("This room has already started.");
    return;
  }
  if (playerOrder.length >= MAX_PLAYERS) {
    setRoomActionState(false);
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
          joinedAt: Date.now(),
          ready: false
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
    setRoomActionState(false);
    showToast(nextRoom?.status === "lobby" ? "This room is full." : "This room has already started.");
    return;
  }

  playerId = nextPlayerId;
  roomCode = code;
  roomRef = joinRef;
  setRoomActionState(false);
  enterRoom();
}

async function leaveRoom() {
  if (roomActionInFlight) {
    return;
  }
  setRoomActionState(true);
  if (!roomCode || !playerId || !roomRef) {
    setRoomActionState(false);
    resetSession();
    return;
  }

  const snapshot = await get(roomRef);
  if (!snapshot.exists()) {
    setRoomActionState(false);
    resetSession();
    return;
  }

  const data = snapshot.val();
  const playerOrder = getOrderedPlayerIds(data);
  if (!playerOrder.includes(playerId)) {
    setRoomActionState(false);
    resetSession();
    return;
  }

  const remainingOrder = playerOrder.filter((id) => id !== playerId);
  if (remainingOrder.length === 0) {
    await remove(roomRef);
    setRoomActionState(false);
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
  setRoomActionState(false);
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
    const result = await runTransaction(roomRef, (room) => {
      if (!room || room.status !== "playing") {
        return room;
      }
      if ((room.roundDeadline || 0) <= Date.now()) {
        return room;
      }
      const roundKey = getRoundKey(room.round || 1);
      const roundData = room[roundKey] || {};
      if (roundData[playerId]) {
        return room;
      }

      return {
        ...room,
        [roundKey]: {
          ...roundData,
          [playerId]: clue
        }
      };
    });

    // If this client missed the deadline race, show explicit feedback.
    const after = result.snapshot.val();
    if (after?.status === "playing" && (after.roundDeadline || 0) <= Date.now() && !after[getRoundKey(after.round || 1)]?.[playerId]) {
      showToast("Time is up for this round.");
    }
  } catch (error) {
    showToast("Could not submit clue. Try again.");
  } finally {
    // Avoid permanent lock if no immediate room update arrives.
    submitInFlight = false;
  }
}

async function startGame() {
  if (roomActionInFlight) {
    return;
  }
  if (!currentRoom || currentRoom.hostId !== playerId) {
    return;
  }
  const players = getOrderedPlayers(currentRoom);
  if (players.length < MIN_PLAYERS) {
    showToast("Need at least 2 players.");
    return;
  }
  if (!players.every((player) => player.ready)) {
    showToast("Everyone must be ready.");
    return;
  }

  setRoomActionState(true);
  await runTransaction(roomRef, (room) => {
    if (!room || room.status !== "lobby" || room.hostId !== playerId) {
      return room;
    }
    const livePlayers = getOrderedPlayers(room);
    if (livePlayers.length < MIN_PLAYERS || !livePlayers.every((player) => player.ready)) {
      return room;
    }

    return {
      ...room,
      ...buildLobbyReset(room, {
        status: "playing",
        roundDeadline: createRoundDeadline(),
        activeRoster: getOrderedPlayerIds(room)
      })
    };
  });
  setRoomActionState(false);
}

async function goToNextRound() {
  if (roomActionInFlight) {
    return;
  }
  if (!currentRoom || currentRoom.hostId !== playerId) {
    return;
  }

  setRoomActionState(true);
  await runTransaction(roomRef, (room) => {
    if (!room || room.hostId !== playerId) {
      return room;
    }
    if (room.status !== "reveal") {
      return room;
    }
    if ((room.round || 1) >= TOTAL_ROUNDS) {
      return {
        ...room,
        status: "gameover"
      };
    }

    return {
      ...room,
      status: "playing",
      round: (room.round || 1) + 1,
      resolvedRound: room.round,
      lastResult: null,
      roundDeadline: createRoundDeadline(),
      activeRoster: getOrderedPlayerIds(room)
    };
  });
  setRoomActionState(false);
}

async function playAgain() {
  if (roomActionInFlight) {
    return;
  }
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

  setRoomActionState(true);
  await runTransaction(roomRef, (room) => {
    if (!room || room.hostId !== playerId) {
      return room;
    }
    const livePlayerIds = getOrderedPlayerIds(room);
    if (livePlayerIds.length < MIN_PLAYERS) {
      return room;
    }
    const readyPlayers = Object.fromEntries(livePlayerIds.map((id) => [
      id,
      {
        ...room.players[id],
        ready: id === playerId
      }
    ]));

    return {
      ...room,
      ...buildLobbyReset({
        ...room,
        players: readyPlayers
      }),
      players: readyPlayers
    };
  });
  setRoomActionState(false);
}

async function toggleReady() {
  if (roomActionInFlight || !currentRoom || currentRoom.status !== "lobby" || !playerId) {
    return;
  }
  setRoomActionState(true);
  await runTransaction(roomRef, (room) => {
    if (!room || room.status !== "lobby" || !room.players?.[playerId]) {
      return room;
    }
    return {
      ...room,
      players: {
        ...room.players,
        [playerId]: {
          ...room.players[playerId],
          ready: !Boolean(room.players[playerId].ready)
        }
      }
    };
  });
  setRoomActionState(false);
}

async function shareRoom() {
  if (!roomCode) {
    return;
  }
  const shareText = `Join my SameClue room: ${roomCode}`;
  if (navigator.share) {
    try {
      await navigator.share({
        title: "SameClue",
        text: shareText
      });
      return;
    } catch (error) {
      if (error?.name === "AbortError") {
        return;
      }
    }
  }
  navigator.clipboard.writeText(shareText)
    .then(() => {
      showToast("Invite copied.");
    })
    .catch(() => {
      showToast("Share unavailable on this browser.");
    });
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

elements.btnShareCode.addEventListener("click", () => {
  void shareRoom();
});

elements.btnReady.addEventListener("click", () => {
  void toggleReady();
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

void cleanupOrphanRooms();
