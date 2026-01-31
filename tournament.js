// tournament.js
// Вся логика турниров и UI.
// Работает и для index.html (public), и для admin.html (admin).

import {
  loadStateFromCloud,
  saveStateToCloud,
  subscribeToState,
  EMPTY_STATE,
} from "./firebase.js";

const isAdminPage = document.body.dataset.page === "admin";

let currentState = structuredClone(EMPTY_STATE);
let isInitialized = false;

// id турнира, который сейчас редактируем в админке
let adminEditingTournamentId = null;

// Фильтры истории (если решим снова включить историю в интерфейсе)
let publicHistoryFilter = "all";
let adminHistoryFilter = "all";

// ---------------------
// Утилиты
// ---------------------

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDateTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getActiveTournament(state) {
  if (!state) return null;
  const id = state.activeTournamentId;
  if (!id) return null;
  return (state.tournaments || []).find((t) => t.id === id) || null;
}

function getTournamentById(state, id) {
  if (!state || !id) return null;
  return (state.tournaments || []).find((t) => t.id === id) || null;
}

function getEditingTournament(state) {
  return getTournamentById(state, adminEditingTournamentId);
}

function ensureTournamentShape(t) {
  const copy = deepClone(t);
  copy.players = Array.isArray(copy.players) ? copy.players : [];
  copy.groups = Array.isArray(copy.groups) ? copy.groups : [];
  copy.history = Array.isArray(copy.history) ? copy.history : [];
  copy.playoffs = copy.playoffs || {};
  copy.playoffs.mastersBracket = copy.playoffs.mastersBracket || null;
  copy.playoffs.challengeBracket = copy.playoffs.challengeBracket || null;
  copy.status = copy.status || "registration";
  copy.registrationOpen = !!copy.registrationOpen;
  return copy;
}

function normalizeState(state) {
  if (!state || typeof state !== "object") return deepClone(EMPTY_STATE);
  const s = deepClone(state);
  s.tournaments = Array.isArray(s.tournaments) ? s.tournaments : [];
  s.activeTournamentId =
    typeof s.activeTournamentId === "string" ? s.activeTournamentId : null;
  s.tournaments = s.tournaments.map(ensureTournamentShape);
  return s;
}

function updateState(mutator) {
  const next = deepClone(currentState);
  mutator(next);
  saveStateToCloud(next).catch((err) => {
    console.error("Ошибка сохранения состояния:", err);
  });
}

function shuffleInPlace(arr) {
  arr.sort(() => Math.random() - 0.5);
}

// Проверка счёта матча (до двух побед)
function isValidScore(score1, score2) {
  const a = Number(score1);
  const b = Number(score2);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a < 0 || b < 0) return false;
  const sum = a + b;
  if (sum < 2 || sum > 3) return false;
  if (a !== 2 && b !== 2) return false;
  if (a === 2 && (b === 0 || b === 1)) return true;
  if (b === 2 && (a === 0 || a === 1)) return true;
  return false;
}

// Определение победителя и проигравшего по счёту
function getWinnerLoser(score1, score2, player1Id, player2Id) {
  const a = Number(score1);
  const b = Number(score2);
  if (!isValidScore(a, b)) return null;
  if (a > b) {
    return { winnerId: player1Id, loserId: player2Id };
  }
  return { winnerId: player2Id, loserId: player1Id };
}

// Есть ли уже сыгранные матчи в группах / плей-офф
function hasGroupResults(tour) {
  return (tour.groups || []).some((g) =>
    (g.matches || []).some((m) => m.score1 != null || m.score2 != null)
  );
}

function hasPlayoffResults(tour) {
  const po = tour.playoffs || {};
  const checkBracket = (b) =>
    b &&
    Array.isArray(b.rounds) &&
    b.rounds.some((r) =>
      (r.matches || []).some((m) => m.score1 != null || m.score2 != null)
    );
  return checkBracket(po.mastersBracket) || checkBracket(po.challengeBracket);
}

// ---------------------
// Логика групп
// ---------------------

// Алгоритм распределения игроков по группам 4–5 человек
function createGroupsFromPlayers(players) {
  const shuffled = [...players];
  shuffleInPlace(shuffled);

  const total = shuffled.length;
  if (total < 4) {
    return [
      {
        playerIds: shuffled.map((p) => p.id),
      },
    ];
  }

  let groupsCount = Math.round(total / 4);
  if (groupsCount < 1) groupsCount = 1;

  if (total % 4 === 3 && groupsCount > 1) {
    groupsCount -= 1;
  }

  let baseSize = Math.floor(total / groupsCount);
  let remainder = total % groupsCount;

  let sizes = new Array(groupsCount).fill(baseSize);
  for (let i = 0; i < remainder; i++) {
    sizes[i]++;
  }

  for (let i = 0; i < sizes.length; i++) {
    if (sizes[i] === 3) {
      let j = sizes.findIndex((s, idx) => s > 4 && idx !== i);
      if (j !== -1) {
        sizes[i] = 4;
        sizes[j]--;
      }
    }
  }

  const groups = [];
  let index = 0;
  for (let g = 0; g < sizes.length; g++) {
    const size = sizes[g];
    const slice = shuffled.slice(index, index + size);
    index += size;
    groups.push({
      playerIds: slice.map((p) => p.id),
    });
  }

  return groups;
}

// Генерация всех матчей "каждый с каждым" внутри группы
function createRoundRobinMatchesForGroup(tournamentId, groupId, playerIds) {
  const matches = [];
  for (let i = 0; i < playerIds.length; i++) {
    for (let j = i + 1; j < playerIds.length; j++) {
      matches.push({
        id: generateId("gm"),
        tournamentId,
        groupId,
        stage: "groups",
        player1Id: playerIds[i],
        player2Id: playerIds[j],
        score1: null,
        score2: null,
        createdAt: Date.now(),
      });
    }
  }
  return matches;
}

// Пересчёт standings для группы (учитываем и переигровки, если есть)
function recomputeGroupStandings(group, tournament) {
  const playersMap = new Map(tournament.players.map((p) => [p.id, p]));
  const stats = new Map();

  for (const pid of group.playerIds) {
    stats.set(pid, {
      playerId: pid,
      wins: 0,
      losses: 0,
      setsFor: 0,
      setsAgainst: 0,
      points: 0,
    });
  }

  for (const match of group.matches || []) {
    if (match.score1 == null || match.score2 == null) continue;
    const a = Number(match.score1);
    const b = Number(match.score2);
    if (!isValidScore(a, b)) continue;

    const stat1 = stats.get(match.player1Id);
    const stat2 = stats.get(match.player2Id);
    if (!stat1 || !stat2) continue;

    // сеты
    stat1.setsFor += a;
    stat1.setsAgainst += b;
    stat2.setsFor += b;
    stat2.setsAgainst += a;

    // победы / поражения + система очков:
    // 2:0 → 3 очка победителю
    // 2:1 → 2 очка победителю и 1 очко проигравшему
    if (a > b) {
      stat1.wins++;
      stat2.losses++;
      if (a === 2 && b === 0) {
        stat1.points += 3;
      } else {
        stat1.points += 2;
        stat2.points += 1;
      }
    } else {
      stat2.wins++;
      stat1.losses++;
      if (b === 2 && a === 0) {
        stat2.points += 3;
      } else {
        stat2.points += 2;
        stat1.points += 1;
      }
    }
  }

  const standings = Array.from(stats.values());

  standings.sort((a, b) => {
    // 1) очки
    if (b.points !== a.points) return b.points - a.points;

    // 2) разница сетов
    const diffA = a.setsFor - a.setsAgainst;
    const diffB = b.setsFor - b.setsAgainst;
    if (diffB !== diffA) return diffB - diffA;

    // 3) набранные сеты
    if (b.setsFor !== a.setsFor) return b.setsFor - a.setsFor;

    // 4) алфавит (стабильный порядок, чтобы не прыгало)
    const pA = playersMap.get(a.playerId);
    const pB = playersMap.get(b.playerId);
    const nameA = pA ? `${pA.lastName} ${pA.firstName}` : "";
    const nameB = pB ? `${pB.lastName} ${pB.firstName}` : "";
    return nameA.localeCompare(nameB, "ru");
  });

  return standings;
}

// Все ли основные (не переигровочные) матчи в группе сыграны корректно
function areAllMainGroupMatchesCompleted(group) {
  const mainMatches = (group.matches || []).filter((m) => !m.isTiebreak);
  if (mainMatches.length === 0) return false;
  return mainMatches.every(
    (m) =>
      m.score1 != null &&
      m.score2 != null &&
      isValidScore(m.score1, m.score2)
  );
}

// ---------------------
// Переигровки за выход в Кубок мастеров
// ---------------------

// Кандидаты на переигровку за выход в Кубок мастеров.
function findMastersTiebreakCandidates(group) {
  const st = group.standings || [];
  if (st.length < 2) return [];

  // ключ: "points|diff|setsFor" → массив { row, index }
  const classes = new Map();

  st.forEach((row, index) => {
    const pts = row.points || 0;
    const diff = (row.setsFor || 0) - (row.setsAgainst || 0);
    const setsFor = row.setsFor || 0;
    const key = `${pts}|${diff}|${setsFor}`;
    if (!classes.has(key)) classes.set(key, []);
    classes.get(key).push({ row, index });
  });

  let bestClass = null;
  let bestMinIndex = Infinity;

  for (const groupEntries of classes.values()) {
    if (groupEntries.length <= 1) continue;
    const indices = groupEntries.map((e) => e.index);
    const minIndex = Math.min(...indices);

    if (minIndex <= 2) {
      if (minIndex < bestMinIndex) {
        bestMinIndex = minIndex;
        bestClass = groupEntries;
      }
    }
  }

  if (!bestClass) return [];
  return bestClass.map((e) => e.row);
}

function createTiebreakMatchesForGroup(tournament, group, playerIds, roundIndex) {
  const base = createRoundRobinMatchesForGroup(tournament.id, group.id, playerIds);
  base.forEach((m) => {
    m.isTiebreak = true;
    m.tiebreakRound = roundIndex || 1;
  });
  return base;
}

// Проверяем группу и при необходимости создаём / требуем переигровки.
function ensureMastersTiebreakMatches(group, tournament) {
  const allMatches = group.matches || [];
  const mainMatches = allMatches.filter((m) => !m.isTiebreak);
  const tbMatches = allMatches.filter((m) => m.isTiebreak);

  // 1) Пока не сыграны все основные матчи — никаких переигровок.
  if (!areAllMainGroupMatchesCompleted(group)) {
    group.tiebreakInfo = null;
    if (tbMatches.length > 0) {
      group.matches = mainMatches;
    }
    return { needTiebreak: false, reason: null };
  }

  // 2) Ищем кандидатов
  const candidates = findMastersTiebreakCandidates(group);
  if (candidates.length <= 1) {
    group.tiebreakInfo = null;
    group.matches = allMatches;
    return { needTiebreak: false, reason: null };
  }

  const candidateIds = candidates.map((c) => c.playerId);

  // 3) Есть ли незаконченные переигровки
  const hasIncomplete = tbMatches.some(
    (m) =>
      candidateIds.includes(m.player1Id) &&
      candidateIds.includes(m.player2Id) &&
      (m.score1 == null || m.score2 == null)
  );

  if (hasIncomplete) {
    group.tiebreakInfo = {
      type: "masters",
      candidateIds,
      message: "Не все переигровки за выход в Кубок мастеров сыграны.",
    };
    return { needTiebreak: true, reason: "incomplete" };
  }

  // 4) Все прежние переигровки доиграны, но равенство осталось — создаём новый круг
  let nextRound = 1;
  if (tbMatches.length > 0) {
    nextRound =
      Math.max(...tbMatches.map((m) => m.tiebreakRound || 1)) + 1;
  }

  const newMatches = createTiebreakMatchesForGroup(
    tournament,
    group,
    candidateIds,
    nextRound
  );

  group.matches = mainMatches.concat(tbMatches, newMatches);

  group.tiebreakInfo = {
    type: "masters",
    candidateIds,
    tiebreakRound: nextRound,
    message: "Созданы переигровки за выход в Кубок мастеров.",
  };

  return { needTiebreak: true, reason: "created" };
}

// ---------------------
// Логика плей-офф (брекеты)
// ---------------------

function computeRoundName(roundIndex, totalRounds) {
  const fromEnd = totalRounds - roundIndex;
  if (fromEnd === 1) return "Финал";
  if (fromEnd === 2) return "1/2 финала";
  if (fromEnd === 3) return "1/4 финала";
  if (fromEnd === 4) return "1/8 финала";
  return `Раунд ${roundIndex + 1}`;
}

function createBracketSkeleton(playersCount, stage) {
  const bracketSize = Math.pow(2, Math.ceil(Math.log2(playersCount)));
  const roundsCount = Math.log2(bracketSize);

  const rounds = [];

  for (let r = 0; r < roundsCount; r++) {
    const matchesCount = Math.pow(2, roundsCount - r - 1);
    const round = {
      id: generateId("round"),
      name: computeRoundName(r, roundsCount),
      matches: [],
      roundIndex: r,
    };

    for (let m = 0; m < matchesCount; m++) {
      round.matches.push({
        id: generateId("m"),
        roundId: round.id,
        player1Id: null,
        player2Id: null,
        score1: null,
        score2: null,
        nextMatchId: null,
        nextSlot: null,
        loserNextMatchId: null,
        loserNextSlot: null,
        stage,
      });
    }
    rounds.push(round);
  }

  // связи победителей
  for (let r = 0; r < roundsCount - 1; r++) {
    const currentRound = rounds[r];
    const nextRound = rounds[r + 1];
    currentRound.matches.forEach((match, idx) => {
      const parentIdx = Math.floor(idx / 2);
      const parentMatch = nextRound.matches[parentIdx];
      match.nextMatchId = parentMatch.id;
      match.nextSlot = idx % 2 === 0 ? "p1" : "p2";
    });
  }

  // матч за 3-е место
  let thirdPlaceRound = null;
  if (roundsCount >= 2) {
    const semiRound = rounds[roundsCount - 2];
    thirdPlaceRound = {
      id: generateId("round"),
      name: "Матч за 3-е место",
      matches: [
        {
          id: generateId("m"),
          roundId: null,
          player1Id: null,
          player2Id: null,
          score1: null,
          score2: null,
          nextMatchId: null,
          nextSlot: null,
          loserNextMatchId: null,
          loserNextSlot: null,
          stage,
        },
      ],
    };
    thirdPlaceRound.matches[0].roundId = thirdPlaceRound.id;

    semiRound.matches.forEach((match, idx) => {
      match.loserNextMatchId = thirdPlaceRound.matches[0].id;
      match.loserNextSlot = idx === 0 ? "p1" : "p2";
    });
  }

  if (thirdPlaceRound) {
    rounds.push(thirdPlaceRound);
  }

  return { rounds, bracketSize, roundsCount };
}

function findMatchById(bracket, matchId) {
  for (const round of (bracket.rounds || [])) {
    for (const m of (round.matches || [])) {
      if (m.id === matchId) {
        return {
          match: m,
          round,
        };
      }
    }
  }
  return { match: null, round: null };
}

function autoAdvanceWinnerInBracket(bracket, match, winnerId) {
  if (!match.nextMatchId || !match.nextSlot) return;
  const { match: nextMatch } = findMatchById(bracket, match.nextMatchId);
  if (!nextMatch) return;
  if (match.nextSlot === "p1" && !nextMatch.player1Id) {
    nextMatch.player1Id = winnerId;
  } else if (match.nextSlot === "p2" && !nextMatch.player2Id) {
    nextMatch.player2Id = winnerId;
  }
}

// Проталкиваем все «автопроходы» (когда в матче один игрок без соперника)
function propagateByes(bracket) {
  if (!bracket || !Array.isArray(bracket.rounds)) return;

  for (const round of bracket.rounds) {
    for (const match of round.matches || []) {
      const hasScore = match.score1 != null || match.score2 != null;
      const hasP1 = !!match.player1Id;
      const hasP2 = !!match.player2Id;

      if (!hasScore && ((hasP1 && !hasP2) || (!hasP1 && hasP2))) {
        const winnerId = hasP1 ? match.player1Id : match.player2Id;
        autoAdvanceWinnerInBracket(bracket, match, winnerId);
      }
    }
  }
}

// players: [{ id, priority, seedScore?, groupId?, place? }]
function assignPlayersToBracket(bracket, players) {
  const B = bracket.bracketSize;
  const firstRound = bracket.rounds[0];
  const matchesCount = firstRound.matches.length;
  const stage = firstRound.matches[0]?.stage || null; // "masters" | "challenge"

  const shuffled = [...players];
  shuffleInPlace(shuffled);

  const N = shuffled.length;
  const byesCount = B - N;

  // --- 1. BYE ---
  const sortedForByes = [...shuffled].sort((a, b) => {
    const pa = a.priority ?? 999;
    const pb = b.priority ?? 999;
    if (pa !== pb) return pa - pb;

    const sa = a.seedScore ?? 0;
    const sb = b.seedScore ?? 0;
    return sb - sa;
  });

  const byeRecipients =
    byesCount > 0 ? sortedForByes.slice(0, byesCount) : [];
  const byeIds = new Set(byeRecipients.map((p) => p.id));

  const playing = shuffled.filter((p) => !byeIds.has(p.id));

  const matchesSlots = Array.from({ length: matchesCount }, () => ({
    p1: null,
    p2: null,
  }));

  const freeMatchIndices = Array.from({ length: matchesCount }, (_, i) => i);
  shuffleInPlace(freeMatchIndices);

  byeRecipients.forEach((p, idx) => {
    if (idx >= freeMatchIndices.length) return;
    const mi = freeMatchIndices[idx];
    const slotName = Math.random() < 0.5 ? "p1" : "p2";
    matchesSlots[mi][slotName] = p.id;
  });

  function popFrom(arr, predicate) {
    if (!arr.length) return null;
    if (!predicate) {
      return arr.shift();
    }
    const idx = arr.findIndex(predicate);
    if (idx === -1) return null;
    const [item] = arr.splice(idx, 1);
    return item;
  }

  // -----------------------------
  // ВЕТКА A: КУБОК ВЫЗОВА
  // -----------------------------
  if (stage === "challenge") {
    const tier3 = playing.filter((p) => p.place === 3);
    const tier4 = playing.filter((p) => p.place === 4);
    const tier5 = playing.filter((p) => p.place === 5);

    shuffleInPlace(tier3);
    shuffleInPlace(tier4);
    shuffleInPlace(tier5);

    for (let i = 0; i < matchesCount; i++) {
      const slot = matchesSlots[i];

      if (
        (slot.p1 && byeIds.has(slot.p1)) ||
        (slot.p2 && byeIds.has(slot.p2))
      ) {
        continue;
      }

      if (slot.p1 && slot.p2) continue;

      if (!slot.p1 && !slot.p2) {
        let a = null;
        let b = null;

        let arrA = null;
        if (tier3.length >= 2) arrA = tier3;
        else if (tier4.length >= 2) arrA = tier4;
        else if (tier5.length >= 2) arrA = tier5;

        if (arrA) {
          a = popFrom(arrA);
          b =
            popFrom(arrA, (p) => p.groupId !== a.groupId) ||
            popFrom(arrA);
        } else {
          a = popFrom(tier3) || popFrom(tier4) || popFrom(tier5);
          b = popFrom(tier3) || popFrom(tier4) || popFrom(tier5);
        }

        if (a) slot.p1 = a.id;
        if (b) slot.p2 = b?.id ?? slot.p2;
      } else {
        const takenId = slot.p1 || slot.p2;
        const taken =
          tier3.find((p) => p.id === takenId) ||
          tier4.find((p) => p.id === takenId) ||
          tier5.find((p) => p.id === takenId) ||
          null;

        let other = null;

        if (taken) {
          let arrPref =
            taken.place === 3 ? tier3 : taken.place === 4 ? tier4 : tier5;

          other =
            popFrom(arrPref, (p) => p.groupId !== taken.groupId) ||
            popFrom(arrPref) ||
            popFrom(tier3, (p) => p.groupId !== taken.groupId) ||
            popFrom(tier4, (p) => p.groupId !== taken.groupId) ||
            popFrom(tier5, (p) => p.groupId !== taken.groupId) ||
            popFrom(tier3) ||
            popFrom(tier4) ||
            popFrom(tier5);
        } else {
          other = popFrom(tier3) || popFrom(tier4) || popFrom(tier5);
        }

        if (!slot.p1 && other) slot.p1 = other.id;
        else if (!slot.p2 && other) slot.p2 = other.id;
      }
    }
  } else {
    // -----------------------------
    // ВЕТКА B: КУБОК МАСТЕРОВ
    // -----------------------------
    const firsts = playing.filter((p) => p.priority === 1);
    const seconds = playing.filter((p) => p.priority !== 1);

    for (let i = 0; i < matchesCount; i++) {
      const slot = matchesSlots[i];

      if (
        (slot.p1 && byeIds.has(slot.p1)) ||
        (slot.p2 && byeIds.has(slot.p2))
      ) {
        continue;
      }

      if (slot.p1 && slot.p2) continue;

      if (!slot.p1 && !slot.p2) {
        let a = null;
        let b = null;

        if (firsts.length && seconds.length) {
          const firstSide = firsts.length >= seconds.length ? "first" : "second";

          if (firstSide === "first") {
            a = popFrom(firsts);
            b =
              popFrom(seconds, (p) => p.groupId !== a.groupId) ||
              popFrom(seconds) ||
              popFrom(firsts, (p) => p.groupId !== a.groupId) ||
              popFrom(firsts);
          } else {
            a = popFrom(seconds);
            b =
              popFrom(firsts, (p) => p.groupId !== a.groupId) ||
              popFrom(firsts) ||
              popFrom(seconds, (p) => p.groupId !== a.groupId) ||
              popFrom(seconds);
          }
        } else if (firsts.length >= 2) {
          a = popFrom(firsts);
          b =
            popFrom(firsts, (p) => p.groupId !== a.groupId) ||
            popFrom(firsts);
        } else if (seconds.length >= 2) {
          a = popFrom(seconds);
          b =
            popFrom(seconds, (p) => p.groupId !== a.groupId) ||
            popFrom(seconds);
        } else {
          a = popFrom(firsts) || popFrom(seconds);
          b = popFrom(firsts) || popFrom(seconds);
        }

        if (a) slot.p1 = a.id;
        if (b) slot.p2 = b?.id ?? slot.p2;
      } else {
        const takenId = slot.p1 || slot.p2;
        const findAll = [...firsts, ...seconds];
        const taken = findAll.find((p) => p.id === takenId) || null;

        let other = null;
        if (taken) {
          if (taken.priority === 1) {
            other =
              popFrom(seconds, (p) => p.groupId !== taken.groupId) ||
              popFrom(seconds) ||
              popFrom(firsts, (p) => p.groupId !== taken.groupId) ||
              popFrom(firsts);
          } else {
            other =
              popFrom(firsts, (p) => p.groupId !== taken.groupId) ||
              popFrom(firsts) ||
              popFrom(seconds, (p) => p.groupId !== taken.groupId) ||
              popFrom(seconds);
          }
        } else {
          other = popFrom(firsts) || popFrom(seconds);
        }

        if (!slot.p1 && other) slot.p1 = other.id;
        else if (!slot.p2 && other) slot.p2 = other.id;
      }
    }
  }

  // --- 4. Переносим в матчи и запускаем автопроход BYE ---
  for (let i = 0; i < firstRound.matches.length; i++) {
    const match = firstRound.matches[i];
    const slot = matchesSlots[i];

    match.player1Id = slot.p1 || null;
    match.player2Id = slot.p2 || null;

    if (match.player1Id && !match.player2Id) {
      autoAdvanceWinnerInBracket(bracket, match, match.player1Id);
    } else if (!match.player1Id && match.player2Id) {
      autoAdvanceWinnerInBracket(bracket, match, match.player2Id);
    }
  }
}

function applyPlayoffResultToBracket(bracket, match, winnerId, loserId) {
  if (match.nextMatchId && match.nextSlot) {
    const { match: nextMatch } = findMatchById(bracket, match.nextMatchId);
    if (nextMatch) {
      if (match.nextSlot === "p1") {
        nextMatch.player1Id = winnerId;
      } else {
        nextMatch.player2Id = winnerId;
      }
    }
  }
  if (match.loserNextMatchId && match.loserNextSlot) {
    const { match: nextMatch } = findMatchById(
      bracket,
      match.loserNextMatchId
    );
    if (nextMatch) {
      if (match.loserNextSlot === "p1") {
        nextMatch.player1Id = loserId;
      } else {
        nextMatch.player2Id = loserId;
      }
    }
  }
}

// Служебная проверка: скрываем только "лишние" матчи с автопроходом
function shouldHideByeMatch(match, round) {
  const hasP1 = !!match.player1Id;
  const hasP2 = !!match.player2Id;

  const isFirstRound =
    round && (round.roundIndex === 0 || /^Раунд\s*1$/i.test(round.name || ""));

  if (
    isFirstRound &&
    ((hasP1 && !hasP2) || (!hasP1 && hasP2))
  ) {
    return true;
  }

  if (isFirstRound && !hasP1 && !hasP2) {
    return true;
  }

  return false;
}

function createBracketFromPlayers(playersWithPriority, stage) {
  if (!playersWithPriority || playersWithPriority.length < 2) return null;

  const skeleton = createBracketSkeleton(playersWithPriority.length, stage);
  assignPlayersToBracket(skeleton, playersWithPriority);

  return {
    players: playersWithPriority.map((p) => p.id),
    rounds: skeleton.rounds,
  };
}

// Чем выше seedScore, тем "сильнее" игрок по результатам группы
function computeSeedScore(row) {
  if (!row) return 0;
  const diff = (row.setsFor || 0) - (row.setsAgainst || 0);
  const points = row.points || 0;
  const setsFor = row.setsFor || 0;

  return points * 10000 + diff * 100 + setsFor;
}

// Для Кубка мастеров: 1-е и 2-е места.
function createMastersPlayersFromGroups(groups, standingsByGroup) {
  const players = [];

  for (const group of groups) {
    const st = standingsByGroup.get(group.id) || [];

    if (st[0]) {
      players.push({
        id: st[0].playerId,
        groupId: group.id,
        priority: 1,
        seedScore: computeSeedScore(st[0]),
      });
    }

    if (st[1]) {
      players.push({
        id: st[1].playerId,
        groupId: group.id,
        priority: 2,
        seedScore: computeSeedScore(st[1]),
      });
    }
  }

  return players;
}

// Для Кубка вызова: 3–5 места
function createChallengePlayersFromGroups(groups, standingsByGroup) {
  const players = [];

  for (const group of groups) {
    const st = standingsByGroup.get(group.id) || [];

    if (st[2]) {
      players.push({
        id: st[2].playerId,
        groupId: group.id,
        place: 3,
        priority: 1,
        seedScore: computeSeedScore(st[2]),
      });
    }

    if (st[3]) {
      players.push({
        id: st[3].playerId,
        groupId: group.id,
        place: 4,
        priority: 2,
        seedScore: computeSeedScore(st[3]),
      });
    }

    if (st[4]) {
      players.push({
        id: st[4].playerId,
        groupId: group.id,
        place: 5,
        priority: 3,
        seedScore: computeSeedScore(st[4]),
      });
    }
  }

  return players;
}

// Получение медалистов по брекету
function extractWinnersFromBracket(bracket) {
  if (!bracket || !bracket.rounds || !bracket.rounds.length) {
    return {
      gold: null,
      silver: null,
      bronze: null,
    };
  }
  const finalRound = bracket.rounds.find((r) => r.name === "Финал");
  let gold = null;
  let silver = null;
  let bronze = null;

  if (finalRound && finalRound.matches[0]) {
    const m = finalRound.matches[0];
    if (isValidScore(m.score1, m.score2)) {
      const res = getWinnerLoser(m.score1, m.score2, m.player1Id, m.player2Id);
      if (res) {
        gold = res.winnerId;
        silver = res.loserId;
      }
    }
  }

  const thirdPlaceRound = bracket.rounds.find(
    (r) => r.name === "Матч за 3-е место"
  );
  if (thirdPlaceRound && thirdPlaceRound.matches[0]) {
    const m = thirdPlaceRound.matches[0];
    if (isValidScore(m.score1, m.score2)) {
      const res = getWinnerLoser(m.score1, m.score2, m.player1Id, m.player2Id);
      if (res) {
        bronze = res.winnerId;
      }
    }
  }

  return { gold, silver, bronze };
}

// Подготовка медалей и финальных результатов участников
function collectTournamentResults(tournament) {
  const po = tournament.playoffs || {};
  const mastersBracket = po.mastersBracket;
  const challengeBracket = po.challengeBracket;

  const medals = new Map(); // id -> 🥇/🥈/🥉
  const resultLabels = new Map(); // id -> текст результата

  function prettyRoundName(name) {
    if (name === "1/2 финала") return "Полуфинал";
    return name;
  }

  function applyMedals(bracket, cupLabel) {
    if (!bracket) return;
    const { gold, silver, bronze } = extractWinnersFromBracket(bracket);
    if (gold) {
      medals.set(gold, "🥇");
      resultLabels.set(gold, `1 место (${cupLabel})`);
    }
    if (silver) {
      medals.set(silver, "🥈");
      resultLabels.set(silver, `2 место (${cupLabel})`);
    }
    if (bronze) {
      medals.set(bronze, "🥉");
      resultLabels.set(bronze, `3 место (${cupLabel})`);
    }
  }

  applyMedals(mastersBracket, "Кубок мастеров");
  applyMedals(challengeBracket, "Кубок вызова");

  const elimInfo = new Map(); // id -> { priority, roundName, cupLabel }
  const inAnyPlayoff = new Set();

  function stagePriority(name) {
    if (!name) return 0;
    if (name.includes("1/8")) return 1;
    if (name.includes("1/4")) return 2;
    if (name.includes("1/2")) return 3;
    if (name === "Финал") return 4;
    if (name.includes("Матч за 3")) return 3.5;
    return 0.5;
  }

  function registerElimination(pid, roundName, cupLabel) {
    if (!pid) return;
    if (medals.has(pid)) return;
    const pr = stagePriority(roundName);
    const prev = elimInfo.get(pid);
    if (!prev || prev.priority < pr) {
      elimInfo.set(pid, { priority: pr, roundName, cupLabel });
    }
  }

  function processBracketElim(bracket, cupLabel) {
    if (!bracket || !bracket.rounds) return;
    for (const round of bracket.rounds) {
      for (const match of round.matches || []) {
        if (match.score1 == null || match.score2 == null) continue;
        if (!isValidScore(match.score1, match.score2)) continue;
        const res = getWinnerLoser(
          match.score1,
          match.score2,
          match.player1Id,
          match.player2Id
        );
        if (!res) continue;
        const { winnerId, loserId } = res;
        if (winnerId) inAnyPlayoff.add(winnerId);
        if (loserId) {
          inAnyPlayoff.add(loserId);
          registerElimination(loserId, round.name, cupLabel);
        }
      }
    }
  }

  processBracketElim(mastersBracket, "Кубок мастеров");
  processBracketElim(challengeBracket, "Кубок вызова");

  elimInfo.forEach((info, pid) => {
    if (!resultLabels.has(pid)) {
      const niceName = prettyRoundName(info.roundName);
      resultLabels.set(pid, `${niceName} (${info.cupLabel})`);
    }
  });

  const groups = tournament.groups || [];
  const inGroups = new Set();
  groups.forEach((g) => {
    (g.playerIds || []).forEach((pid) => inGroups.add(pid));
  });

  inGroups.forEach((pid) => {
    if (!resultLabels.has(pid) && !inAnyPlayoff.has(pid)) {
      resultLabels.set(pid, "Групповой этап");
    }
  });

  (tournament.players || []).forEach((p) => {
    if (!resultLabels.has(p.id)) {
      resultLabels.set(p.id, "Участник");
    }
  });

  return { medals, resultLabels };
}

// ---------------------
// Рендер Публичной страницы
// ---------------------

function renderPublicPage() {
  const root = document.getElementById("public-root");
  if (!root) return;

  const state = currentState;
  const t = getActiveTournament(state);

  if (!t) {
    root.innerHTML = `
      <div class="lp-card">
        <div class="lp-card-header">
          <h2 class="lp-card-title">Турнир пока не выбран</h2>
        </div>
        <p class="lp-text-muted">Обратитесь к организатору, чтобы в админ-панели создать и выбрать активный турнир.</p>
      </div>
    `;
    return;
  }

  const tournament = ensureTournamentShape(t);
  const playersMap = new Map(tournament.players.map((p) => [p.id, p]));

  const regStatus = tournament.registrationOpen
    ? "Регистрация открыта"
    : "Регистрация закрыта";
  const regBadgeClass = tournament.registrationOpen
    ? "lp-badge lp-badge-status-open"
    : "lp-badge lp-badge-gray";

  // ===== Блок «описание + регистрация» =====
  let html = `
    <section id="section-registration" class="lp-grid-2">
      <div class="lp-card">
        <div class="lp-card-header">
          <div>
            <h2 class="lp-card-title">${escapeHtml(
              tournament.name || "Без названия"
            )}</h2>
            <p class="lp-card-subtitle">Статус: ${
              tournament.status === "registration"
                ? "Регистрация"
                : tournament.status === "groups"
                ? "Групповой этап"
                : "Плей-офф"
            }</p>
          </div>
          <span class="${regBadgeClass}">${regStatus}</span>
        </div>
        <div class="lp-separator"></div>
        <p class="lp-text-muted lp-text-xs">
          Личный любительский турнир по настольному теннису. После завершения регистрации 
          организатор распределит игроков по группам, затем начнётся плей-офф.
        </p>
      </div>

      <div class="lp-card">
        <div class="lp-card-header">
          <h3 class="lp-card-title">Регистрация участника</h3>
        </div>
  `;

  if (!tournament.registrationOpen) {
    html += `
      <p class="lp-text-muted">Регистрация закрыта. Дождитесь следующего турнира или обратитесь к организатору.</p>
    `;
  } else {
    html += `
      <form id="public-registration-form" class="lp-form">
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <div style="flex:1 1 120px; min-width:120px;">
            <label class="lp-text-xs">Имя</label>
            <input type="text" name="firstName" class="lp-input" placeholder="Иван" required />
          </div>
          <div style="flex:1 1 120px; min-width:120px;">
            <label class="lp-text-xs">Фамилия</label>
            <input type="text" name="lastName" class="lp-input" placeholder="Иванов" required />
          </div>
        </div>
        <div style="margin-top:10px; display:flex; justify-content:flex-end;">
          <button type="submit" class="lp-btn lp-btn-primary lp-btn-sm">
            Записаться на турнир
          </button>
        </div>
      </form>
      <p class="lp-text-muted lp-text-xs" style="margin-top:6px;">
        После отправки формы вы появитесь в списке участников (по имени и фамилии).
        Изменить данные можно только через организатора.
      </p>
    `;
  }

  html += `</div></section>`;

  // ===== Групповой этап =====
  if (tournament.groups && tournament.groups.length > 0) {
    html += `
      <section id="section-groups" class="lp-card">
        <div class="lp-card-header">
          <h3 class="lp-card-title">Групповой этап</h3>
          <span class="lp-pill"><span class="lp-pill-dot"></span> Пары «каждый с каждым»</span>
        </div>
        <p class="lp-card-subtitle">
          Победа 2:0 — 3 очка; победа 2:1 — 2 очка победителю и 1 очко проигравшему. 
          В скобках — разница сетов.
        </p>
        <p class="lp-text-muted lp-text-xs" style="margin-top:4px;">
          1–2 места в группе выходят в плей-офф Кубка Мастеров, остальные — в плей-офф Кубка Вызова.
        </p>
        <div class="lp-groups-grid">
    `;

    for (let i = 0; i < tournament.groups.length; i++) {
      const g = tournament.groups[i];
      const standings = g.standings || [];

      const allMatches = g.matches || [];
      const mainMatches = allMatches.filter((m) => !m.isTiebreak);
      const tiebreakMatches = allMatches.filter((m) => m.isTiebreak);

      html += `
        <div class="lp-group-card lp-group-card--public">
          <div class="lp-group-header-line">
            <span class="lp-group-name">Группа ${i + 1}</span>
          </div>
          <div class="lp-table-scroll">
            <table class="lp-table lp-table--sticky-name">
              <thead>
                <tr>
                  <th>Игрок</th>
                  <th>Сеты</th>
                  <th>(+/−)</th>
                  <th>Победы</th>
                  <th>Поражения</th>
                  <th>Очки</th>
                </tr>
              </thead>
              <tbody>
      `;

      for (let j = 0; j < standings.length; j++) {
        const row = standings[j];
        const player = playersMap.get(row.playerId);
        const name = player
          ? `${escapeHtml(player.firstName)} ${escapeHtml(player.lastName)}`
          : "—";
        const diff = row.setsFor - row.setsAgainst;
        const diffText = diff > 0 ? `+${diff}` : `${diff}`;
        const highlight = j === 0 || j === 1 ? "lp-table-row-highlight" : "";

        html += `
          <tr class="${highlight}">
            <td>${name}</td>
            <td>${row.setsFor}:${row.setsAgainst}</td>
            <td>${diffText}</td>
            <td>${row.wins}</td>
            <td>${row.losses}</td>
            <td>${row.points}</td>
          </tr>
        `;
      }

      html += `
              </tbody>
            </table>
          </div>
      `;

      if (mainMatches.length > 0) {
        html += `
          <div class="lp-card-section-title" style="margin-top:10px;">Матчи группы</div>
          <div class="lp-matches-list">
        `;

        for (const m of mainMatches) {
          const p1 = playersMap.get(m.player1Id);
          const p2 = playersMap.get(m.player2Id);
          const name1 = p1
            ? `${escapeHtml(p1.firstName)} ${escapeHtml(p1.lastName)}`
            : "—";
          const name2 = p2
            ? `${escapeHtml(p2.firstName)} ${escapeHtml(p2.lastName)}`
            : "—";

          const hasScore = m.score1 != null && m.score2 != null;
          const scoreText = hasScore ? `${m.score1}:${m.score2}` : "— : —";

          let winnerClass1 = "";
          let winnerClass2 = "";
          if (hasScore && isValidScore(m.score1, m.score2)) {
            const res = getWinnerLoser(
              m.score1,
              m.score2,
              m.player1Id,
              m.player2Id
            );
            if (res) {
              if (res.winnerId === m.player1Id) winnerClass1 = "lp-match-winner";
              if (res.winnerId === m.player2Id) winnerClass2 = "lp-match-winner";
            }
          }

          const scoreClass = hasScore
            ? "lp-match-score"
            : "lp-match-score lp-text-muted";

          html += `
            <div class="lp-match-row">
              <div class="lp-match-player lp-match-player--left ${winnerClass1}">
                ${name1}
              </div>
              <div class="${scoreClass}">
                ${scoreText}
              </div>
              <div class="lp-match-player lp-match-player--right ${winnerClass2}">
                ${name2}
              </div>
            </div>
          `;
        }

        html += `</div>`;
      }

      if (tiebreakMatches.length > 0) {
        html += `
          <div class="lp-card-section-title" style="margin-top:10px;">
            Переигровки за выход в Кубок мастеров
          </div>
          <div class="lp-matches-list lp-matches-list--tiebreaks">
        `;

        for (const m of tiebreakMatches) {
          const p1 = playersMap.get(m.player1Id);
          const p2 = playersMap.get(m.player2Id);
          const name1 = p1
            ? `${escapeHtml(p1.firstName)} ${escapeHtml(p1.lastName)}`
            : "—";
          const name2 = p2
            ? `${escapeHtml(p2.firstName)} ${escapeHtml(p2.lastName)}`
            : "—";

          const hasScore = m.score1 != null && m.score2 != null;
          const scoreText = hasScore ? `${m.score1}:${m.score2}` : "— : —";

          let winnerClass1 = "";
          let winnerClass2 = "";
          if (hasScore && isValidScore(m.score1, m.score2)) {
            const res = getWinnerLoser(
              m.score1,
              m.score2,
              m.player1Id,
              m.player2Id
            );
            if (res) {
              if (res.winnerId === m.player1Id) winnerClass1 = "lp-match-winner";
              if (res.winnerId === m.player2Id) winnerClass2 = "lp-match-winner";
            }
          }

          const scoreClass = hasScore
            ? "lp-match-score"
            : "lp-match-score lp-text-muted";

          html += `
            <div class="lp-match-row">
              <div class="lp-match-player lp-match-player--left ${winnerClass1}">
                ${name1}
              </div>
              <div class="${scoreClass}">
                ${scoreText}
              </div>
              <div class="lp-match-player lp-match-player--right ${winnerClass2}">
                ${name2}
              </div>
            </div>
          `;
        }

        html += `</div>`;
      }

      html += `</div>`;
    }

    html += `
        </div>
      </section>
    `;
  }

  // Плей-офф
  html += renderPublicPlayoffs(tournament);

  // Участники
  html += renderPublicParticipantsSection(tournament);

  // Дисклеймер
  html += `
    <section class="lp-card" style="margin-top:12px;">
      <p class="lp-text-muted lp-text-xs" style="text-align:center;">
        Личный любительский проект для учёта результатов по настольному теннису.
        Не является официальным ресурсом какой-либо компании или организации.
      </p>
    </section>
  `;

  root.innerHTML = html;

  const form = document.getElementById("public-registration-form");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const formData = new FormData(form);
      const firstName = String(formData.get("firstName") || "").trim();
      const lastName = String(formData.get("lastName") || "").trim();
      if (!firstName || !lastName) {
        alert("Пожалуйста, заполните имя и фамилию.");
        return;
      }
      handlePublicRegisterPlayer(firstName, lastName);
      form.reset();
    });
  }
}

// ---------------------
// Плей-офф (публичная)
// ---------------------

function renderPublicPlayoffs(tournament) {
  const playersMap = new Map(tournament.players.map((p) => [p.id, p]));

  const mastersBracket = tournament.playoffs.mastersBracket;
  const challengeBracket = tournament.playoffs.challengeBracket;

  if (!mastersBracket && !challengeBracket) return "";

  let html = `
    <section id="section-playoffs" class="lp-card">
      <div class="lp-card-header">
        <h3 class="lp-card-title">Плей-офф</h3>
        <span class="lp-pill">
          <span class="lp-pill-dot"></span>
          Игры на вылет до двух побед
        </span>
      </div>
      <div class="lp-playoffs-grid">
  `;

  if (mastersBracket) {
    html += `
      <div class="lp-playoffs-block">
        <h4 class="lp-card-section-title">Кубок мастеров</h4>
        <div class="lp-bracket">
          ${renderBracket(mastersBracket, playersMap)}
        </div>
      </div>
    `;
  }

  if (challengeBracket) {
    html += `
      <div class="lp-playoffs-block">
        <h4 class="lp-card-section-title">Кубок вызова</h4>
        <div class="lp-bracket">
          ${renderBracket(challengeBracket, playersMap)}
        </div>
      </div>
    `;
  }

  html += `
      </div>
    </section>
  `;

  return html;
}

function renderBracket(bracket, playersMap) {
  if (!bracket || !bracket.rounds || bracket.rounds.length === 0) {
    return `<p class="lp-text-muted lp-text-xs">Сетка ещё не сформирована.</p>`;
  }

  let html = `<div class="lp-bracket-inner">`;
  for (const round of bracket.rounds) {
    const isFinal = round.name === "Финал";
    const isThird = round.name === "Матч за 3-е место";
    const roundClass = isFinal
      ? "lp-bracket-round lp-bracket-round--final"
      : isThird
      ? "lp-bracket-round lp-bracket-round--third"
      : "lp-bracket-round";

    html += `<div class="${roundClass}">
      <div class="lp-bracket-round-title">${escapeHtml(round.name)}</div>
    `;
    for (const match of round.matches) {
      if (shouldHideByeMatch(match, round)) continue;

      const p1 = playersMap.get(match.player1Id);
      const p2 = playersMap.get(match.player2Id);
      const name1 = p1
        ? `${escapeHtml(p1.firstName)} ${escapeHtml(p1.lastName)}`
        : "—";
      const name2 = p2
        ? `${escapeHtml(p2.firstName)} ${escapeHtml(p2.lastName)}`
        : "—";

      let p1Class = "lp-bracket-player-name";
      let p2Class = "lp-bracket-player-name";

      if (match.score1 != null && match.score2 != null) {
        if (isValidScore(match.score1, match.score2)) {
          const res = getWinnerLoser(
            match.score1,
            match.score2,
            match.player1Id,
            match.player2Id
          );
          if (res) {
            if (res.winnerId === match.player1Id) {
              p1Class += " lp-bracket-player--winner";
            } else if (res.winnerId === match.player2Id) {
              p2Class += " lp-bracket-player--winner";
            }
          }
        }
      }

      const score1 =
        match.score1 != null && match.score2 != null
          ? String(match.score1)
          : "";
      const score2 =
        match.score1 != null && match.score2 != null
          ? String(match.score2)
          : "";

      html += `
        <div class="lp-bracket-match">
          <div class="lp-bracket-player-row">
            <span class="${p1Class}">${name1}</span>
            <span class="lp-bracket-player-score">${score1}</span>
          </div>
          <div class="lp-bracket-player-row">
            <span class="${p2Class}">${name2}</span>
            <span class="lp-bracket-player-score">${score2}</span>
          </div>
        </div>
      `;
    }
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

// ---------------------
// Пьедестал + участники
// ---------------------

function renderPodium(title, winners, playersMap) {
  const { gold, silver, bronze } = winners;

  if (!gold && !silver && !bronze) {
    return `
      <div class="lp-podium-block">
        <h4 class="lp-card-section-title">${escapeHtml(title)}</h4>
        <p class="lp-text-muted lp-text-xs">Итоговые места будут показаны после завершения плей-офф.</p>
      </div>
    `;
  }

  function nameOf(id) {
    const p = playersMap.get(id);
    if (!p) return "—";
    return `${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}`;
  }

  return `
    <div class="lp-podium-block">
      <h4 class="lp-card-section-title">${escapeHtml(title)}</h4>
      <div class="lp-podium">
        <div class="lp-podium-item lp-podium-2">
          <div class="lp-podium-medal">🥈</div>
          <div class="lp-podium-place">2 место</div>
          <div class="lp-podium-name">${silver ? nameOf(silver) : "—"}</div>
        </div>
        <div class="lp-podium-item lp-podium-1">
          <div class="lp-podium-medal lp-podium-medal--gold">🥇</div>
          <div class="lp-podium-place">1 место</div>
          <div class="lp-podium-name">${gold ? nameOf(gold) : "—"}</div>
        </div>
        <div class="lp-podium-item lp-podium-3">
          <div class="lp-podium-medal">🥉</div>
          <div class="lp-podium-place">3 место</div>
          <div class="lp-podium-name">${bronze ? nameOf(bronze) : "—"}</div>
        </div>
      </div>
    </div>
  `;
}

function renderPublicParticipantsSection(tournament) {
  const players = tournament.players || [];
  const playersMap = new Map(players.map((p) => [p.id, p]));

  const mastersBracket = tournament.playoffs.mastersBracket;
  const challengeBracket = tournament.playoffs.challengeBracket;

  const mastersMedals = extractWinnersFromBracket(mastersBracket);
  const challengeMedals = extractWinnersFromBracket(challengeBracket);

  const { medals: medalMap, resultLabels } = collectTournamentResults(
    tournament
  );

  const groups = tournament.groups || [];
  const groupByPlayer = new Map();
  groups.forEach((g, idx) => {
    for (const pid of g.playerIds || []) {
      groupByPlayer.set(pid, idx + 1);
    }
  });

  const mastersPlayers = new Set(
    (tournament.playoffs.mastersBracket?.players || []).map((p) => p)
  );
  const challengePlayers = new Set(
    (tournament.playoffs.challengeBracket?.players || []).map((p) => p)
  );

  function buildStatus(pid) {
    if (mastersPlayers.has(pid)) {
      return {
        label: "Кубок мастеров",
        className: "lp-badge lp-badge-masters",
      };
    }
    if (challengePlayers.has(pid)) {
      return {
        label: "Кубок вызова",
        className: "lp-badge lp-badge-challenge",
      };
    }
    const groupIndex = groupByPlayer.get(pid);
    if (groupIndex) {
      return {
        label: `Группа ${groupIndex}`,
        className: "lp-badge lp-badge-group",
      };
    }
    return {
      label: "Ожидает жеребьёвки",
      className: "lp-badge lp-badge-gray",
    };
  }

  let html = `
    <section id="section-participants" class="lp-card">
      <div class="lp-card-header">
        <h3 class="lp-card-title">Участники</h3>
        <span class="lp-card-subtitle">Всего участников: ${players.length}</span>
      </div>
  `;

  let podiumsHtml = "";
  if (mastersBracket) {
    podiumsHtml += renderPodium("Кубок мастеров", mastersMedals, playersMap);
  }
  if (challengeBracket) {
    podiumsHtml += renderPodium("Кубок вызова", challengeMedals, playersMap);
  }

  if (podiumsHtml) {
    html += `
      <div style="margin-top:10px; display:flex; flex-wrap:wrap; gap:12px;">
        ${podiumsHtml}
      </div>
    `;
  }

  html += `
      <div class="lp-table-scroll" style="margin-top:12px;">
        <table class="lp-table lp-table--sticky-name lp-table-participants">
          <thead>
            <tr>
              <th>Имя</th>
              <th>Фамилия</th>
              <th>Статус</th>
              <th>Результат</th>
            </tr>
          </thead>
          <tbody>
  `;

  players.forEach((p) => {
    const status = buildStatus(p.id);
    const medalEmoji = medalMap.get(p.id) || "";
    const resultText = resultLabels.get(p.id) || "";
    const resultCell =
      (medalEmoji ? `<span class="lp-medal">${medalEmoji}</span> ` : "") +
      escapeHtml(resultText);

    html += `
      <tr>
        <td>${escapeHtml(p.firstName)}</td>
        <td>${escapeHtml(p.lastName)}</td>
        <td class="lp-status-cell"><span class="${status.className}">${status.label}</span></td>
        <td>${resultCell}</td>
      </tr>
    `;
  });

  html += `
          </tbody>
        </table>
      </div>
    </section>
  `;
  return html;
}

// ---------------------
// История матчей (функции оставили, но пока не рендерим)
// ---------------------

function renderHistorySection(tournament, isAdmin) {
  const history = tournament.history || [];
  const playersMap = new Map(tournament.players.map((p) => [p.id, p]));
  const filter = isAdmin ? adminHistoryFilter : publicHistoryFilter;

  const filtered = history.filter((h) => {
    if (filter === "all") return true;
    if (filter === "groups") return h.stage === "groups";
    if (filter === "masters") return h.stage === "masters";
    if (filter === "challenge") return h.stage === "challenge";
    return true;
  });

  let html = `
    <section class="lp-card">
      <div class="lp-card-header">
        <h3 class="lp-card-title">История матчей</h3>
      </div>
      <div class="lp-chip-row" data-history-filter-root="${
        isAdmin ? "admin" : "public"
      }">
        ${renderHistoryFilterChip("all", "Все", filter)}
        ${renderHistoryFilterChip("groups", "Групповой этап", filter)}
        ${renderHistoryFilterChip("masters", "Кубок мастеров", filter)}
        ${renderHistoryFilterChip("challenge", "Кубок вызова", filter)}
      </div>
  `;

  if (filtered.length === 0) {
    html += `<p class="lp-text-muted lp-text-xs" style="margin-top:8px;">
      Матчи ещё не сыграны или не сохранены.
    </p>`;
  } else {
    html += `<div class="lp-matches-list" style="margin-top:8px; max-width:700px; margin-left:auto; margin-right:auto;">`;
    const sorted = [...filtered].sort((a, b) => b.createdAt - a.createdAt);
    for (const item of sorted) {
      const p1Name =
        item.player1Name ||
        (() => {
          const p = playersMap.get(item.player1Id);
          return p ? `${p.firstName} ${p.lastName}` : "—";
        })();
      const p2Name =
        item.player2Name ||
        (() => {
          const p = playersMap.get(item.player2Id);
          return p ? `${p.firstName} ${p.lastName}` : "—";
        })();
      const score = `${item.score1}:${item.score2}`;
      const winnerId = item.winnerId;

      const w1Class = winnerId === item.player1Id ? "lp-match-winner" : "";
      const w2Class = winnerId === item.player2Id ? "lp-match-winner" : "";

      const stageLabel =
        item.stage === "groups"
          ? "Групповой этап"
          : item.stage === "masters"
          ? "Кубок мастеров"
          : item.stage === "challenge"
          ? "Кубок вызова"
          : "";

      html += `
        <div class="lp-match-row">
          <div class="lp-match-player lp-match-player--left ${w1Class}">
            ${escapeHtml(p1Name)}
          </div>
          <div class="lp-match-score">
            ${score}
          </div>
          <div class="lp-match-player lp-match-player--right ${w2Class}">
            ${escapeHtml(p2Name)}
          </div>
        </div>
        <div class="lp-text-muted lp-text-xs" style="margin:0 10px 6px;">
          ${formatDateTime(item.createdAt)} · ${stageLabel}
        </div>
      `;
    }
    html += `</div>`;
  }

  html += `</section>`;
  return html;
}

function renderHistoryFilterChip(value, label, current) {
  const active = value === current ? "lp-chip lp-chip--active" : "lp-chip";
  return `<button type="button" class="${active}" data-history-filter="${value}">${label}</button>`;
}

function bindHistoryFilterHandlers(isAdmin) {
  const root = document.querySelector(
    `[data-history-filter-root="${isAdmin ? "admin" : "public"}"]`
  );
  if (!root) return;

  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-history-filter]");
    if (!btn) return;

    const value = btn.dataset.historyFilter;
    if (isAdmin) {
      adminHistoryFilter = value;
    } else {
      publicHistoryFilter = value;
    }

    if (isAdminPage === isAdmin) {
      render();
    }
  });
}

// ---------------------
// Публичные обработчики
// ---------------------

function handlePublicRegisterPlayer(firstName, lastName) {
  const t = getActiveTournament(currentState);
  if (!t) {
    alert("Активный турнир не найден. Обратитесь к организатору.");
    return;
  }
  if (!t.registrationOpen) {
    alert("Регистрация уже закрыта.");
    return;
  }

  updateState((state) => {
    const tour = getActiveTournament(state);
    if (!tour) return;
    const newPlayer = {
      id: generateId("p"),
      firstName: firstName.trim(),
      lastName: lastName.trim(),
    };
    tour.players.push(newPlayer);
  });
}

// ---------------------
// Рендер Админ-панели
// ---------------------

function renderAdminPage() {
  const root = document.getElementById("admin-root");
  if (!root) return;

  const state = currentState;
  const tournaments = state.tournaments || [];

  const activePublicTournament = getActiveTournament(state);

  let editingTournament = getEditingTournament(state);
  if (!editingTournament && tournaments.length > 0) {
    editingTournament = activePublicTournament || tournaments[0];
    adminEditingTournamentId = editingTournament.id;
  }

  let html = `
    <section class="lp-card">
      <div class="lp-card-header">
        <h2 class="lp-card-title">Турниры</h2>
      </div>
      <div class="lp-row" style="margin-top:8px; align-items:flex-end;">
        <div style="flex:1 1 160px; min-width:160px;">
          <label class="lp-text-xs">Турнир для редактирования</label>
          <select id="admin-tournament-select" class="lp-select">
  `;

  if (tournaments.length === 0) {
    html += `<option value="">(турниров пока нет)</option>`;
  } else {
    tournaments.forEach((t) => {
      const selected =
        editingTournament && t.id === editingTournament.id ? "selected" : "";
      html += `<option value="${escapeHtml(t.id)}" ${selected}>${escapeHtml(
        t.name || "Без названия"
      )}</option>`;
    });
  }

  html += `
          </select>
        </div>
        <button type="button" class="lp-btn lp-btn-outline lp-btn-sm" data-action="set-active-tournament">
          Сделать активным
        </button>
        <div class="lp-spacer"></div>
        <div style="flex:1 1 200px; min-width:180px;">
          <label class="lp-text-xs">Название нового турнира</label>
          <input type="text" id="admin-new-tournament-name" class="lp-input" placeholder="Турнир по настольному теннису" />
        </div>
        <button type="button" class="lp-btn lp-btn-primary lp-btn-sm" data-action="create-tournament">
          Создать турнир
        </button>
      </div>
  `;

  if (activePublicTournament) {
    html += `
      <div class="lp-separator"></div>
      <p class="lp-text-muted lp-text-xs">
        <strong>Сейчас на публичной странице показываетcя:</strong>
        ${escapeHtml(activePublicTournament.name || "Без названия")}
      </p>
    `;
  } else {
    html += `
      <div class="lp-separator"></div>
      <p class="lp-text-muted lp-text-xs">
        На публичной странице пока не выбран активный турнир.
      </p>
    `;
  }

  html += `</section>`;

  if (!editingTournament) {
    html += `
      <div class="lp-card">
        <p class="lp-text-muted">
          Создайте турнир, чтобы управлять участниками, группами и плей-офф.
        </p>
      </div>
    `;
    // Дисклеймер
    html += `
      <section class="lp-card" style="margin-top:12px;">
        <p class="lp-text-muted lp-text-xs" style="text-align:center;">
          Админ-панель личного любительского турнира по настольному теннису.
          Не является официальным ресурсом какой-либо компании или организации.
        </p>
      </section>
    `;
    root.innerHTML = html;
    bindAdminRootHandlers();
    return;
  }

  const tournament = ensureTournamentShape(editingTournament);

  html += `
    <section class="lp-card">
      <div class="lp-card-header">
        <h3 class="lp-card-title">Регистрация</h3>
      </div>
      <div class="lp-row" style="margin-top:8px; align-items:center;">
        <span class="lp-text-muted lp-text-xs">Состояние: ${
          tournament.registrationOpen
            ? "Регистрация открыта"
            : "Регистрация закрыта"
        }</span>
        <div class="lp-spacer"></div>
        <button type="button" class="lp-btn lp-btn-outline lp-btn-sm" data-action="toggle-registration">
          ${
            tournament.registrationOpen
              ? "Закрыть регистрацию"
              : "Открыть регистрацию"
          }
        </button>
        <button type="button" class="lp-btn lp-btn-danger lp-btn-sm" data-action="reset-groups-playoffs">
          Сбросить группы и плей-офф (полный)
        </button>
      </div>
    </section>
  `;

  html += renderAdminPlayersSection(tournament);
  html += renderAdminGroupsSection(tournament);
  html += renderAdminPlayoffsSection(tournament);

  // Дисклеймер
  html += `
    <section class="lp-card" style="margin-top:12px;">
      <p class="lp-text-muted lp-text-xs" style="text-align:center;">
        Админ-панель личного любительского турнира по настольному теннису.
        Не является официальным ресурсом какой-либо компании или организации.
      </p>
    </section>
  `;

  root.innerHTML = html;
  bindAdminRootHandlers();
}

function renderAdminPlayersSection(tournament) {
  const players = tournament.players || [];
  let html = `
    <section class="lp-card">
      <div class="lp-card-header">
        <h3 class="lp-card-title">Участники турнира</h3>
        <span class="lp-card-subtitle">Всего: ${players.length}</span>
      </div>
      <div class="lp-row" style="margin-top:8px; align-items:flex-end;">
        <div style="flex:1 1 120px; min-width:120px;">
          <label class="lp-text-xs">Имя</label>
          <input type="text" id="admin-add-firstName" class="lp-input" placeholder="Иван" />
        </div>
        <div style="flex:1 1 120px; min-width:120px;">
          <label class="lp-text-xs">Фамилия</label>
          <input type="text" id="admin-add-lastName" class="lp-input" placeholder="Иванов" />
        </div>
        <button type="button" class="lp-btn lp-btn-primary lp-btn-sm" data-action="add-player">
          Добавить участника
        </button>
      </div>
      <div class="lp-table-scroll" style="margin-top:10px;">
        <table class="lp-table lp-table--sticky-name">
          <thead>
            <tr>
              <th>Имя</th>
              <th>Фамилия</th>
              <th style="width:150px;">Действия</th>
            </tr>
          </thead>
          <tbody>
  `;

  players.forEach((p) => {
    html += `
      <tr>
        <td>
          <input type="text" class="lp-input-inline" data-player-id="${escapeHtml(
            p.id
          )}" data-player-field="firstName" value="${escapeHtml(
      p.firstName
    )}" />
        </td>
        <td>
          <input type="text" class="lp-input-inline" data-player-id="${escapeHtml(
            p.id
          )}" data-player-field="lastName" value="${escapeHtml(
      p.lastName
    )}" />
        </td>
        <td>
          <button type="button" class="lp-btn lp-btn-outline lp-btn-sm" data-action="save-player" data-player-id="${escapeHtml(
            p.id
          )}">Сохранить</button>
          <button type="button" class="lp-btn lp-btn-danger lp-btn-sm" data-action="delete-player" data-player-id="${escapeHtml(
            p.id
          )}">Удалить</button>
        </td>
      </tr>
    `;
  });

  html += `
          </tbody>
        </table>
      </div>
    </section>
  `;
  return html;
}

function renderAdminGroupsSection(tournament) {
  const groups = tournament.groups || [];
  const players = tournament.players || [];
  const playersMap = new Map(players.map((p) => [p.id, p]));

  const playerIdsInGroups = new Set();
  groups.forEach((g) => {
    (g.playerIds || []).forEach((id) => playerIdsInGroups.add(id));
  });
  const playersWithoutGroup = players.filter((p) => !playerIdsInGroups.has(p.id));

  let html = `
    <section class="lp-card">
      <div class="lp-card-header">
        <h3 class="lp-card-title">Групповой этап</h3>
        <span class="lp-card-subtitle">Раунд «каждый с каждым»</span>
      </div>
      <p class="lp-text-muted lp-text-xs" style="margin-top:4px;">
        Система очков: победа 2:0 — 3 очка; победа 2:1 — 2 очка победителю и 1 очко проигравшему.
        1–2 места идут в Кубок мастеров, остальные — в Кубок вызова.
      </p>
      <div class="lp-row" style="margin-top:8px; flex-wrap:wrap; gap:8px;">
        <button type="button" class="lp-btn lp-btn-outline lp-btn-sm" data-action="generate-groups">
          Распределить по группам (по ~4 чел.)
        </button>
        <button type="button" class="lp-btn lp-btn-outline lp-btn-sm" data-action="generate-playoffs">
          Сформировать плей-офф
        </button>
        <button type="button" class="lp-btn lp-btn-outline lp-btn-sm" data-action="fill-random-group-results">
          Заполнить результаты случайно
        </button>
        <button type="button" class="lp-btn lp-btn-danger lp-btn-sm" data-action="reset-group-results">
          Сбросить результаты групп
        </button>
      </div>
  `;

  if (groups.length > 0) {
    html += `
      <div class="lp-row" style="margin-top:10px; flex-wrap:wrap; gap:8px;">
        <div style="flex:1 1 200px; min-width:180px;">
          <label class="lp-text-xs">Игрок</label>
          <select id="admin-group-player-select" class="lp-select">
            <option value="">(выберите игрока)</option>
    `;
    players.forEach((p) => {
      html += `<option value="${escapeHtml(
        p.id
      )}">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</option>`;
    });
    html += `
          </select>
        </div>
        <div style="flex:1 1 160px; min-width:160px;">
          <label class="lp-text-xs">Группа</label>
          <select id="admin-group-target-select" class="lp-select">
            <option value="">Без группы</option>
    `;
    groups.forEach((g, idx) => {
      html += `<option value="${escapeHtml(
        g.id
      )}">Группа ${idx + 1}</option>`;
    });
    html += `
          </select>
        </div>
        <button type="button" class="lp-btn lp-btn-outline lp-btn-sm" data-action="move-player-to-group">
          Назначить в группу
        </button>
      </div>
      <p class="lp-text-muted lp-text-xs" style="margin-top:4px;">
        Изменять состав групп можно только пока в группах нет сыгранных матчей.
      </p>
    `;

    if (playersWithoutGroup.length > 0) {
      html += `<p class="lp-text-muted lp-text-xs" style="margin-top:6px;">Игроки без группы: `;
      playersWithoutGroup.forEach((p) => {
        const name = `${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}`;
        html += `<span class="lp-badge lp-badge-gray" style="margin-right:4px; margin-bottom:2px;">${name}</span>`;
      });
      html += `</p>`;
    } else {
      html += `<p class="lp-text-muted lp-text-xs" style="margin-top:6px;">
        Все участники распределены по группам.
      </p>`;
    }
  } else {
    html += `
      <p class="lp-text-muted lp-text-xs" style="margin-top:8px;">
        Группы ещё не сформированы. Нажмите «Распределить по группам», когда список участников будет готов.
      </p>
    `;
  }

  if (groups.length > 0) {
    groups.forEach((g, idx) => {
      const standings = g.standings || [];
      const allMatches = g.matches || [];
      const mainMatches = allMatches.filter((m) => !m.isTiebreak);
      const tiebreakMatches = allMatches.filter((m) => m.isTiebreak);
      const hasTiebreaks = tiebreakMatches.length > 0;
      const tInfo = g.tiebreakInfo || null;

      html += `
        <div class="lp-group-card">
          <div class="lp-group-header-line">
            <span class="lp-group-name">Группа ${idx + 1}</span>
            <span class="lp-group-note">
              Победа 2:0 — 3 очка; 2:1 — 2 очка победителю и 1 очко проигравшему. 
              В скобках — разница сетов.
            </span>
          </div>
          <div class="lp-table-scroll">
            <table class="lp-table lp-table--sticky-name">
              <thead>
                <tr>
                  <th>Игрок</th>
                  <th>Сеты</th>
                  <th>(+/−)</th>
                  <th>Победы</th>
                  <th>Поражения</th>
                  <th>Очки</th>
                </tr>
              </thead>
              <tbody>
      `;
      standings.forEach((row, pos) => {
        const p = playersMap.get(row.playerId);
        const name = p
          ? `${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}`
          : "—";
        const diff = row.setsFor - row.setsAgainst;
        const diffText = diff > 0 ? `+${diff}` : `${diff}`;
        const highlight = pos <= 1 ? "lp-table-row-highlight" : "";
        html += `
          <tr class="${highlight}">
            <td>${name}</td>
            <td>${row.setsFor}:${row.setsAgainst}</td>
            <td>${diffText}</td>
            <td>${row.wins}</td>
            <td>${row.losses}</td>
            <td>${row.points}</td>
          </tr>
        `;
      });
      html += `
              </tbody>
            </table>
          </div>

          <div class="lp-card-section-title" style="margin-top:10px;">Матчи группы</div>
          <div class="lp-table-scroll">
            <table class="lp-table">
              <thead>
                <tr>
                  <th>Игрок 1</th>
                  <th>Игрок 2</th>
                  <th>Счёт</th>
                  <th>Сохранить</th>
                </tr>
              </thead>
              <tbody>
      `;
      mainMatches.forEach((m) => {
        const p1 = playersMap.get(m.player1Id);
        const p2 = playersMap.get(m.player2Id);
        const name1 = p1
          ? `${escapeHtml(p1.firstName)} ${escapeHtml(p1.lastName)}`
          : "—";
        const name2 = p2
          ? `${escapeHtml(p2.firstName)} ${escapeHtml(p2.lastName)}`
          : "—";
        const score1 = m.score1 != null ? m.score1 : "";
        const score2 = m.score2 != null ? m.score2 : "";
        html += `
          <tr>
            <td>${name1}</td>
            <td>${name2}</td>
            <td>
              <input type="number" min="0" max="2" class="lp-input-inline lp-input-score" id="gm-${m.id}-s1" value="${score1}" />
              :
              <input type="number" min="0" max="2" class="lp-input-inline lp-input-score" id="gm-${m.id}-s2" value="${score2}" />
            </td>
            <td>
              <button type="button" class="lp-btn lp-btn-outline lp-btn-sm" data-action="save-group-match" data-group-id="${escapeHtml(
                g.id
              )}" data-match-id="${escapeHtml(m.id)}">Сохранить</button>
            </td>
          </tr>
        `;
      });
      html += `
              </tbody>
            </table>
          </div>
      `;

      if (hasTiebreaks) {
        html += `
          <div class="lp-card-section-title" style="margin-top:10px;">Переигровки за выход в Кубок мастеров</div>
        `;
        if (tInfo && tInfo.message) {
          html += `
            <p class="lp-text-muted lp-text-xs" style="margin-top:4px;">
              ${escapeHtml(tInfo.message)}
            </p>
          `;
        }
        html += `
          <div class="lp-table-scroll" style="margin-top:4px;">
            <table class="lp-table">
              <thead>
                <tr>
                  <th>Игрок 1</th>
                  <th>Игрок 2</th>
                  <th>Счёт</th>
                  <th>Сохранить</th>
                </tr>
              </thead>
              <tbody>
        `;
        tiebreakMatches.forEach((m) => {
          const p1 = playersMap.get(m.player1Id);
          const p2 = playersMap.get(m.player2Id);
          const name1 = p1
            ? `${escapeHtml(p1.firstName)} ${escapeHtml(p1.lastName)}`
            : "—";
          const name2 = p2
            ? `${escapeHtml(p2.firstName)} ${escapeHtml(p2.lastName)}`
            : "—";
          const score1 = m.score1 != null ? m.score1 : "";
          const score2 = m.score2 != null ? m.score2 : "";
          html += `
            <tr>
              <td>${name1}</td>
              <td>${name2}</td>
              <td>
                <input type="number" min="0" max="2" class="lp-input-inline lp-input-score" id="gm-${m.id}-s1" value="${score1}" />
                :
                <input type="number" min="0" max="2" class="lp-input-inline lp-input-score" id="gm-${m.id}-s2" value="${score2}" />
              </td>
              <td>
                <button type="button" class="lp-btn lp-btn-outline lp-btn-sm" data-action="save-group-match" data-group-id="${escapeHtml(
                  g.id
                )}" data-match-id="${escapeHtml(m.id)}">Сохранить</button>
              </td>
            </tr>
          `;
        });
        html += `
              </tbody>
            </table>
          </div>
        `;
      }

      html += `
        </div>
      `;
    });
  }

  html += `</section>`;
  return html;
}

function renderAdminPlayoffsSection(tournament) {
  const playersMap = new Map(tournament.players.map((p) => [p.id, p]));
  const mastersBracket = tournament.playoffs.mastersBracket;
  const challengeBracket = tournament.playoffs.challengeBracket;

  let html = `
    <section class="lp-card">
      <div class="lp-card-header">
        <h3 class="lp-card-title">Плей-офф</h3>
      </div>
      <p class="lp-text-muted lp-text-xs" style="margin-top:4px;">
        После завершения группового этапа нажмите «Сформировать плей-офф». Здесь можно вводить результаты матчей, победители будут автоматически продвигаться по сетке.
      </p>
      <div class="lp-row" style="margin-top:8px; flex-wrap:wrap; gap:8px;">
        <button type="button" class="lp-btn lp-btn-danger lp-btn-sm" data-action="reset-playoff-results">
          Сбросить результаты плей-офф
        </button>
      </div>
      <div class="lp-brackets-wrapper" style="margin-top:10px;">
  `;

  if (!mastersBracket && !challengeBracket) {
    html += `<p class="lp-text-muted lp-text-xs" style="margin-top:8px;">
      Плей-офф ещё не сформирован.
    </p>`;
    html += `</section>`;
    return html;
  }

  if (mastersBracket) {
    html += `
      <div>
        <h4 class="lp-card-section-title">Кубок мастеров</h4>
        <div class="lp-bracket">
          ${renderAdminBracket(mastersBracket, playersMap, "masters")}
        </div>
      </div>
    `;
  }

  if (challengeBracket) {
    html += `
      <div>
        <h4 class="lp-card-section-title">Кубок вызова</h4>
        <div class="lp-bracket">
          ${renderAdminBracket(challengeBracket, playersMap, "challenge")}
        </div>
      </div>
    `;
  }

  html += `</div></section>`;
  return html;
}

function renderAdminBracket(bracket, playersMap, bracketType) {
  if (!bracket || !bracket.rounds || bracket.rounds.length === 0) {
    return `<p class="lp-text-muted lp-text-xs">Сетка ещё не сформирована.</p>`;
  }

  const bracketPlayers = Array.isArray(bracket.players) ? bracket.players : [];

  let html = `<div class="lp-bracket-inner">`;
  for (const round of bracket.rounds) {
    const isFinal = round.name === "Финал";
    const isThird = round.name === "Матч за 3-е место";
    const roundClass = isFinal
      ? "lp-bracket-round lp-bracket-round--final"
      : isThird
      ? "lp-bracket-round lp-bracket-round--third"
      : "lp-bracket-round";

    html += `<div class="${roundClass}">
      <div class="lp-bracket-round-title">${escapeHtml(round.name)}</div>
    `;

    for (const match of round.matches) {
      if (shouldHideByeMatch(match, round)) continue;

      const p1 = playersMap.get(match.player1Id);
      const p2 = playersMap.get(match.player2Id);
      const name1 = p1
        ? `${escapeHtml(p1.firstName)} ${escapeHtml(p1.lastName)}`
        : "—";
      const name2 = p2
        ? `${escapeHtml(p2.firstName)} ${escapeHtml(p2.lastName)}`
        : "—";

      const s1 = match.score1 != null ? match.score1 : "";
      const s2 = match.score2 != null ? match.score2 : "";

      const canEditPlayers =
        bracketPlayers.length > 0 &&
        match.score1 == null &&
        match.score2 == null;

      let player1Control = `<span class="lp-bracket-player-name">${name1}</span>`;
      let player2Control = `<span class="lp-bracket-player-name">${name2}</span>`;

      if (canEditPlayers) {
        let optionsHtml1 = `<option value="">—</option>`;
        bracketPlayers.forEach((pid) => {
          const pl = playersMap.get(pid);
          if (!pl) return;
          const label = `${escapeHtml(pl.firstName)} ${escapeHtml(
            pl.lastName
          )}`;
          const optSelected = pid === match.player1Id ? "selected" : "";
          optionsHtml1 += `<option value="${escapeHtml(
            pid
          )}" ${optSelected}>${label}</option>`;
        });

        let optionsHtml2 = `<option value="">—</option>`;
        bracketPlayers.forEach((pid) => {
          const pl = playersMap.get(pid);
          if (!pl) return;
          const label = `${escapeHtml(pl.firstName)} ${escapeHtml(
            pl.lastName
          )}`;
          const optSelected = pid === match.player2Id ? "selected" : "";
          optionsHtml2 += `<option value="${escapeHtml(
            pid
          )}" ${optSelected}>${label}</option>`;
        });

        player1Control = `
          <select
            class="lp-select"
            style="padding:2px 6px; font-size:12px;"
            data-action="set-playoff-player"
            data-bracket="${bracketType}"
            data-match-id="${escapeHtml(match.id)}"
            data-slot="p1"
          >
            ${optionsHtml1}
          </select>
        `;

        player2Control = `
          <select
            class="lp-select"
            style="padding:2px 6px; font-size:12px;"
            data-action="set-playoff-player"
            data-bracket="${bracketType}"
            data-match-id="${escapeHtml(match.id)}"
            data-slot="p2"
          >
            ${optionsHtml2}
          </select>
        `;
      }

      html += `
        <div class="lp-bracket-match">
          <div class="lp-bracket-match-label">Матч</div>
          <div class="lp-bracket-player-row">
            ${player1Control}
          </div>
          <div class="lp-bracket-player-row" style="margin-bottom:4px;">
            ${player2Control}
          </div>
          <div class="lp-row" style="align-items:center;">
            <div>
              <input type="number" min="0" max="2" class="lp-input-inline lp-input-score" id="pm-${match.id}-s1" value="${s1}" />
              :
              <input type="number" min="0" max="2" class="lp-input-inline lp-input-score" id="pm-${match.id}-s2" value="${s2}" />
            </div>
            <div class="lp-spacer"></div>
            <button type="button" class="lp-btn lp-btn-outline lp-btn-sm" data-action="save-playoff-match" data-bracket="${bracketType}" data-round-id="${escapeHtml(
        round.id
      )}" data-match-id="${escapeHtml(match.id)}">
              Сохранить
            </button>
          </div>
        </div>
      `;
    }

    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

// ---------------------
// Обработчики Админ-панели
// ---------------------

function bindAdminRootHandlers() {
  const root = document.getElementById("admin-root");
  if (!root) return;

  root.onclick = (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;

    switch (action) {
      case "create-tournament":
        handleCreateTournament();
        break;
      case "set-active-tournament":
        handleSetActiveTournament();
        break;
      case "toggle-registration":
        handleToggleRegistration();
        break;
      case "reset-groups-playoffs":
        handleResetGroupsPlayoffs();
        break;
      case "reset-group-results":
        handleResetGroupResults();
        break;
      case "fill-random-group-results":
        handleFillRandomGroupResults();
        break;
      case "reset-playoff-results":
        handleResetPlayoffResults();
        break;
      case "add-player":
        handleAddPlayer();
        break;
      case "save-player":
        handleSavePlayer(btn.dataset.playerId);
        break;
      case "delete-player":
        handleDeletePlayer(btn.dataset.playerId);
        break;
      case "generate-groups":
        handleGenerateGroups();
        break;
      case "move-player-to-group":
        handleMovePlayerToGroup();
        break;
      case "save-group-match":
        handleSaveGroupMatch(btn.dataset.groupId, btn.dataset.matchId);
        break;
      case "generate-playoffs":
        handleGeneratePlayoffs();
        break;
      case "save-playoff-match":
        handleSavePlayoffMatch(
          btn.dataset.bracket,
          btn.dataset.roundId,
          btn.dataset.matchId
        );
        break;
      default:
        break;
    }
  };

  root.addEventListener("change", (e) => {
    const select = e.target.closest("select[data-action]");
    if (!select) return;
    const action = select.dataset.action;
    if (action === "set-playoff-player") {
      handleSetPlayoffPlayer(
        select.dataset.bracket,
        select.dataset.matchId,
        select.dataset.slot,
        select.value || ""
      );
    }
  });

  const select = document.getElementById("admin-tournament-select");
  if (select) {
    select.addEventListener("change", () => {
      adminEditingTournamentId = select.value || null;
      render();
    });
  }
}

function handleCreateTournament() {
  const input = document.getElementById("admin-new-tournament-name");
  const name = input ? input.value.trim() : "";
  if (!name) {
    alert("Введите название турнира.");
    return;
  }

  const id = generateId("t");
  const now = Date.now();

  updateState((state) => {
    const tournament = {
      id,
      name,
      createdAt: now,
      status: "registration",
      registrationOpen: true,
      players: [],
      groups: [],
      history: [],
      playoffs: {
        mastersBracket: null,
        challengeBracket: null,
      },
    };
    state.tournaments.push(tournament);
  });

  adminEditingTournamentId = id;
  if (input) input.value = "";
}

function handleSetActiveTournament() {
  const select = document.getElementById("admin-tournament-select");
  if (!select) return;
  const value = select.value || null;
  updateState((state) => {
    state.activeTournamentId = value;
  });
}

function handleToggleRegistration() {
  if (!adminEditingTournamentId) return;
  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour) return;
    tour.registrationOpen = !tour.registrationOpen;
    if (tour.registrationOpen) {
      tour.status = "registration";
    }
  });
}

function handleResetGroupsPlayoffs() {
  if (
    !confirm(
      "Полностью сбросить группы, плей-офф и историю матчей для текущего турнира?"
    )
  ) {
    return;
  }
  if (!adminEditingTournamentId) return;
  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour) return;
    tour.groups = [];
    tour.playoffs = {
      mastersBracket: null,
      challengeBracket: null,
    };
    tour.history = [];
    tour.status = "registration";
  });
}

function handleResetGroupResults() {
  if (!adminEditingTournamentId) return;
  if (
    !confirm(
      "Сбросить все результаты группового этапа? Состав групп останется прежним."
    )
  ) {
    return;
  }
  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour || !tour.groups) return;
    tour.groups.forEach((g) => {
      (g.matches || []).forEach((m) => {
        m.score1 = null;
        m.score2 = null;
      });
      g.standings = recomputeGroupStandings(g, tour);
      g.tiebreakInfo = null;
    });
    tour.history = (tour.history || []).filter((h) => h.stage !== "groups");
  });
}

function handleFillRandomGroupResults() {
  if (!adminEditingTournamentId) return;
  if (
    !confirm(
      "Случайно заполнить результаты всех матчей группового этапа, где ещё нет счёта? Уже введённые результаты изменены не будут."
    )
  ) {
    return;
  }

  let groupsWithTie = [];

  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour || !tour.groups) return;

    const variants = [
      [2, 0],
      [2, 1],
      [0, 2],
      [1, 2],
    ];

    tour.groups.forEach((g, idx) => {
      (g.matches || []).forEach((m) => {
        if (m.score1 != null && m.score2 != null) return;
        const [s1, s2] = variants[Math.floor(Math.random() * variants.length)];
        m.score1 = s1;
        m.score2 = s2;
      });

      g.standings = recomputeGroupStandings(g, tour);

      const tb = ensureMastersTiebreakMatches(g, tour);
      if (tb.needTiebreak) {
        groupsWithTie.push(idx + 1);
      }
    });
  });

  if (groupsWithTie.length) {
    alert(
      "В группах " +
        groupsWithTie.join(", ") +
        " полное равенство за выход в Кубок мастеров.\n" +
        "Созданы матчи-переигровки справа от основных матчей. " +
        "Сначала сыграйте их, затем сформируйте плей-офф."
    );
  }
}

function handleResetPlayoffResults() {
  if (!adminEditingTournamentId) return;
  if (
    !confirm(
      "Сбросить все результаты плей-офф и пересобрать сетку по текущим группам?"
    )
  ) {
    return;
  }
  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour) return;

    tour.history = (tour.history || []).filter(
      (h) => h.stage !== "masters" && h.stage !== "challenge"
    );

    if (!tour.groups || tour.groups.length === 0) {
      tour.playoffs = {
        mastersBracket: null,
        challengeBracket: null,
      };
      return;
    }

    const standingsByGroup = new Map();
    tour.groups.forEach((g) => {
      g.standings = recomputeGroupStandings(g, tour);
      standingsByGroup.set(g.id, g.standings);
    });

    const mastersPlayers = createMastersPlayersFromGroups(
      tour.groups,
      standingsByGroup
    );
    const challengePlayers = createChallengePlayersFromGroups(
      tour.groups,
      standingsByGroup
    );

    tour.playoffs = {
      mastersBracket:
        mastersPlayers.length >= 2
          ? createBracketFromPlayers(mastersPlayers, "masters")
          : null,
      challengeBracket:
        challengePlayers.length >= 2
          ? createBracketFromPlayers(challengePlayers, "challenge")
          : null,
    };

    if (tour.playoffs.mastersBracket || tour.playoffs.challengeBracket) {
      tour.status = "playoffs";
    }
  });
}

function handleAddPlayer() {
  if (!adminEditingTournamentId) return;
  const firstNameEl = document.getElementById("admin-add-firstName");
  const lastNameEl = document.getElementById("admin-add-lastName");
  const firstName = (firstNameEl?.value || "").trim();
  const lastName = (lastNameEl?.value || "").trim();
  if (!firstName || !lastName) {
    alert("Заполните Имя и Фамилию.");
    return;
  }

  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour) return;
    const newPlayer = {
      id: generateId("p"),
      firstName,
      lastName,
    };
    tour.players.push(newPlayer);
  });

  if (firstNameEl) firstNameEl.value = "";
  if (lastNameEl) lastNameEl.value = "";
}

function handleSavePlayer(playerId) {
  if (!playerId || !adminEditingTournamentId) return;
  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour) return;
    const p = tour.players.find((pl) => pl.id === playerId);
    if (!p) return;
    const inputs = document.querySelectorAll(
      `[data-player-id="${playerId}"][data-player-field]`
    );
    inputs.forEach((input) => {
      const field = input.dataset.playerField;
      const value = input.value.trim();
      if (field && value != null) {
        p[field] = value;
      }
    });
  });
}

function handleDeletePlayer(playerId) {
  if (!playerId || !adminEditingTournamentId) return;
  if (!confirm("Удалить участника и все его матчи?")) return;
  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour) return;
    tour.players = tour.players.filter((p) => p.id !== playerId);
    tour.groups.forEach((g) => {
      g.playerIds = (g.playerIds || []).filter((id) => id !== playerId);
      g.matches = (g.matches || []).filter(
        (m) => m.player1Id !== playerId && m.player2Id !== playerId
      );
      g.standings = (g.standings || []).filter(
        (s) => s.playerId !== playerId
      );
    });
    tour.history = (tour.history || []).filter(
      (h) => h.player1Id !== playerId && h.player2Id !== playerId
    );
  });
}

function handleGenerateGroups() {
  if (!adminEditingTournamentId) return;
  const t = getTournamentById(currentState, adminEditingTournamentId);
  if (!t) return;

  if (hasGroupResults(t)) {
    alert(
      "Нельзя заново распределять по группам: уже есть сыгранные матчи. Сначала сбросьте результаты группового этапа."
    );
    return;
  }

  if (t.players.length < 4 && !confirm("Менее 4 игроков. Всё равно распределить?")) {
    return;
  }

  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour) return;

    const groupsRaw = createGroupsFromPlayers(tour.players);
    const groups = groupsRaw.map((gRaw, idx) => {
      const id = generateId("g");
      const matches = createRoundRobinMatchesForGroup(
        tour.id,
        id,
        gRaw.playerIds
      );
      return {
        id,
        name: `Группа ${idx + 1}`,
        stage: "groups",
        playerIds: gRaw.playerIds,
        matches,
        standings: [],
        tiebreakInfo: null,
      };
    });

    groups.forEach((g) => {
      g.standings = recomputeGroupStandings(g, tour);
    });

    tour.groups = groups;
    tour.status = "groups";
    tour.history = (tour.history || []).filter(
      (h) =>
        h.stage !== "groups" && h.stage !== "masters" && h.stage !== "challenge"
    );
    tour.playoffs = {
      mastersBracket: null,
      challengeBracket: null,
    };
  });
}

function handleMovePlayerToGroup() {
  if (!adminEditingTournamentId) return;
  const t = getTournamentById(currentState, adminEditingTournamentId);
  if (!t) return;

  if (hasGroupResults(t)) {
    alert(
      "Нельзя редактировать состав групп: уже есть сыгранные матчи. Сначала сбросьте результаты группового этапа."
    );
    return;
  }

  const playerSelect = document.getElementById("admin-group-player-select");
  const groupSelect = document.getElementById("admin-group-target-select");
  if (!playerSelect || !groupSelect) return;

  const playerId = playerSelect.value;
  const targetGroupId = groupSelect.value;

  if (!playerId) {
    alert("Выберите игрока.");
    return;
  }

  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour) return;
    const groups = tour.groups || [];

    groups.forEach((g) => {
      g.playerIds = (g.playerIds || []).filter((id) => id !== playerId);
      g.matches = (g.matches || []).filter(
        (m) => m.player1Id !== playerId && m.player2Id !== playerId
      );
      g.tiebreakInfo = null;
    });

    if (targetGroupId) {
      const group = groups.find((g) => g.id === targetGroupId);
      if (!group) return;
      group.playerIds = group.playerIds || [];
      if (!group.playerIds.includes(playerId)) {
        group.playerIds.push(playerId);
      }
      group.matches = createRoundRobinMatchesForGroup(
        tour.id,
        group.id,
        group.playerIds
      );
    }

    groups.forEach((g) => {
      g.standings = recomputeGroupStandings(g, tour);
    });

    tour.history = (tour.history || []).filter((h) => h.stage !== "groups");
  });
}

function handleSaveGroupMatch(groupId, matchId) {
  if (!adminEditingTournamentId) return;

  const s1Input = document.getElementById(`gm-${matchId}-s1`);
  const s2Input = document.getElementById(`gm-${matchId}-s2`);
  if (!s1Input || !s2Input) return;
  const s1 = Number(s1Input.value);
  const s2 = Number(s2Input.value);

  if (!isValidScore(s1, s2)) {
    alert("Некорректный счёт. Допустимы только варианты 2–0, 2–1, 0–2, 1–2.");
    return;
  }

  let tiebreakCreated = false;
  let tiebreakGroupNumber = null;

  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour) return;
    const group = tour.groups.find((g) => g.id === groupId);
    if (!group) return;
    const match = group.matches.find((m) => m.id === matchId);
    if (!match) return;

    match.score1 = s1;
    match.score2 = s2;

    group.standings = recomputeGroupStandings(group, tour);

    const tbResult = ensureMastersTiebreakMatches(group, tour);

    if (tbResult && tbResult.needTiebreak && tbResult.reason === "created") {
      tiebreakCreated = true;
      const idx = tour.groups.findIndex((g) => g.id === groupId);
      if (idx !== -1) {
        tiebreakGroupNumber = idx + 1;
      }
    }

    const res = getWinnerLoser(s1, s2, match.player1Id, match.player2Id);
    if (!res) return;
    const p1 = tour.players.find((p) => p.id === match.player1Id);
    const p2 = tour.players.find((p) => p.id === match.player2Id);
    const description = `${p1 ? p1.firstName + " " + p1.lastName : "—"} ${s1}:${s2} ${
      p2 ? p2.firstName + " " + p2.lastName : "—"
    }`;

    const existing = tour.history.find((h) => h.matchId === match.id);
    const payload = {
      id: existing ? existing.id : generateId("h"),
      matchId: match.id,
      tournamentId: tour.id,
      createdAt: Date.now(),
      description,
      groupId: group.id,
      stage: "groups",
      winnerId: res.winnerId,
      player1Id: match.player1Id,
      player2Id: match.player2Id,
      player1Name: p1 ? `${p1.firstName} ${p1.lastName}` : null,
      player2Name: p2 ? `${p2.firstName} ${p2.lastName}` : null,
      score1: s1,
      score2: s2,
    };

    if (existing) {
      Object.assign(existing, payload);
    } else {
      tour.history.push(payload);
    }
  });

  if (tiebreakCreated) {
    const groupText = tiebreakGroupNumber
      ? `В группе ${tiebreakGroupNumber}`
      : "В одной из групп";
    alert(
      groupText +
        " полное равенство за выход в Кубок мастеров.\n" +
        "Созданы матчи-переигровки справа от основных матчей. " +
        "Сначала сыграйте их, затем снова нажмите «Сформировать плей-офф»."
    );
  }
}

function handleGeneratePlayoffs() {
  if (!adminEditingTournamentId) return;
  const t = getTournamentById(currentState, adminEditingTournamentId);
  if (!t) return;

  if (!t.groups || t.groups.length === 0) {
    alert("Сначала распределите игроков по группам.");
    return;
  }

  if (hasPlayoffResults(t)) {
    alert(
      "Нельзя заново формировать плей-офф: уже есть сыгранные матчи. Сначала сбросьте результаты плей-офф."
    );
    return;
  }

  let needTiebreak = false;
  const groupsWithTie = [];

  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour) return;

    const standingsByGroup = new Map();

    tour.groups.forEach((g, idx) => {
      g.standings = recomputeGroupStandings(g, tour);
      standingsByGroup.set(g.id, g.standings);

      const tb = ensureMastersTiebreakMatches(g, tour);
      if (tb.needTiebreak) {
        needTiebreak = true;
        groupsWithTie.push(idx + 1);
      }
    });

    if (needTiebreak) {
      tour.playoffs = {
        mastersBracket: null,
        challengeBracket: null,
      };
      tour.status = "groups";
      return;
    }

    const mastersPlayers = createMastersPlayersFromGroups(
      tour.groups,
      standingsByGroup
    );
    const challengePlayers = createChallengePlayersFromGroups(
      tour.groups,
      standingsByGroup
    );

    tour.playoffs = {
      mastersBracket:
        mastersPlayers.length >= 2
          ? createBracketFromPlayers(mastersPlayers, "masters")
          : null,
      challengeBracket:
        challengePlayers.length >= 2
          ? createBracketFromPlayers(challengePlayers, "challenge")
          : null,
    };
    tour.status = "playoffs";
  });

  if (needTiebreak) {
    alert(
      "В группах " +
        groupsWithTie.join(", ") +
        " полное равенство за выход в Кубок мастеров.\n" +
        "Созданы матчи-переигровки справа от основных матчей. " +
        "Сначала сыграйте их, затем снова нажмите «Сформировать плей-офф»."
    );
  }
}

function handleSavePlayoffMatch(bracketType, roundId, matchId) {
  if (!adminEditingTournamentId) return;
  const t = getTournamentById(currentState, adminEditingTournamentId);
  if (!t) return;
  const bracket =
    bracketType === "masters"
      ? t.playoffs.mastersBracket
      : t.playoffs.challengeBracket;
  if (!bracket) return;

  const s1Input = document.getElementById(`pm-${matchId}-s1`);
  const s2Input = document.getElementById(`pm-${matchId}-s2`);
  if (!s1Input || !s2Input) return;
  const s1 = Number(s1Input.value);
  const s2 = Number(s2Input.value);

  if (!isValidScore(s1, s2)) {
    alert("Некорректный счёт. Допустимы только варианты 2–0, 2–1, 0–2, 1–2.");
    return;
  }

  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour) return;
    const b =
      bracketType === "masters"
        ? tour.playoffs.mastersBracket
        : tour.playoffs.challengeBracket;
    if (!b) return;

    let foundMatch = null;
    for (const round of b.rounds) {
      if (round.id !== roundId) continue;
      const m = round.matches.find((x) => x.id === matchId);
      if (m) {
        foundMatch = m;
        break;
      }
    }
    if (!foundMatch) return;

    foundMatch.score1 = s1;
    foundMatch.score2 = s2;

    const res = getWinnerLoser(
      s1,
      s2,
      foundMatch.player1Id,
      foundMatch.player2Id
    );
    if (!res) return;

    applyPlayoffResultToBracket(b, foundMatch, res.winnerId, res.loserId);

    const p1 = tour.players.find((p) => p.id === foundMatch.player1Id);
    const p2 = tour.players.find((p) => p.id === foundMatch.player2Id);
    const description = `${p1 ? p1.firstName + " " + p1.lastName : "—"} ${s1}:${s2} ${
      p2 ? p2.firstName + " " + p2.lastName : "—"
    }`;

    const existing = tour.history.find((h) => h.matchId === foundMatch.id);
    const payload = {
      id: existing ? existing.id : generateId("h"),
      matchId: foundMatch.id,
      tournamentId: tour.id,
      createdAt: Date.now(),
      description,
      groupId: null,
      stage: bracketType === "masters" ? "masters" : "challenge",
      winnerId: res.winnerId,
      player1Id: foundMatch.player1Id,
      player2Id: foundMatch.player2Id,
      player1Name: p1 ? `${p1.firstName} ${p1.lastName}` : null,
      player2Name: p2 ? `${p2.firstName} ${p2.lastName}` : null,
      score1: s1,
      score2: s2,
    };

    if (existing) {
      Object.assign(existing, payload);
    } else {
      tour.history.push(payload);
    }
  });
}

function handleSetPlayoffPlayer(bracketType, matchId, slot, playerId) {
  if (!adminEditingTournamentId) return;

  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour || !tour.playoffs) return;

    const b =
      bracketType === "masters"
        ? tour.playoffs.mastersBracket
        : tour.playoffs.challengeBracket;
    if (!b || !Array.isArray(b.rounds)) return;

    let foundMatch = null;
    for (const round of b.rounds) {
      const m = (round.matches || []).find((x) => x.id === matchId);
      if (m) {
        foundMatch = m;
        break;
      }
    }
    if (!foundMatch) return;

    // ⚠️ Разрешаем менять пары даже если в других матчах уже есть результаты.
    // Селекты для игроков всё равно рисуются только там, где нет счёта,
    // так что уже сыгранные матчи не трогаем.

    if (slot === "p1") {
      foundMatch.player1Id = playerId || null;
    } else if (slot === "p2") {
      foundMatch.player2Id = playerId || null;
    }
  });
}


// ---------------------
// Инициализация
// ---------------------

async function init() {
  if (isInitialized) return;
  isInitialized = true;

  try {
    const initial = await loadStateFromCloud();
    currentState = normalizeState(initial);
    render();

    subscribeToState((remoteState) => {
      currentState = normalizeState(remoteState);
      render();
    });
  } catch (err) {
    console.error("Ошибка инициализации:", err);
    const containerId = isAdminPage ? "admin-root" : "public-root";
    const root = document.getElementById(containerId);
    if (root) {
      root.innerHTML = `
        <div class="lp-card">
          <h2 class="lp-card-title">Ошибка подключения</h2>
          <p class="lp-text-muted">Проверьте конфигурацию Firebase в файле <code>firebase.js</code>.</p>
        </div>
      `;
    }
  }
}

function render() {
  if (isAdminPage) {
    renderAdminPage();
  } else {
    renderPublicPage();
  }
}

document.addEventListener("DOMContentLoaded", init);

