// tournament.js
// Вся логика турниров и UI.
// Работает и для index.html (public), и для admin.html (admin).

import {
  loadStateFromCloud,
  saveStateToCloud,
  subscribeToState,
  EMPTY_STATE,
  db,
} from "./firebase.js";
import {
  collection,
  addDoc,
  getDocs,
  query,
  orderBy,
  limit,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// ---------------------
// ГЛОБАЛЬНЫЙ STATE
// ---------------------

let currentState = structuredClone(EMPTY_STATE);
let isSaving = false;
let lastSaveError = null;

// для "оптимистичных" обновлений
let pendingLocalState = null;
let isApplyingRemote = false;

// id активного турнира в админке
let adminEditingTournamentId = null;

// ---------------------
// УТИЛИТЫ
// ---------------------

function deepClone(obj) {
  return obj == null ? obj : structuredClone(obj);
}

function generateId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 11)}`;
}

function getActiveTournament(state) {
  if (!state) return null;
  const id = state.activeTournamentId;
  if (!id) return null;
  return state.tournaments.find((t) => t.id === id) || null;
}

function getTournamentById(state, id) {
  if (!state || !id) return null;
  return state.tournaments.find((t) => t.id === id) || null;
}

function sortPlayersByName(players) {
  return [...players].sort((a, b) =>
    a.lastName.localeCompare(b.lastName, "ru", { sensitivity: "base" }) ||
    a.firstName.localeCompare(b.firstName, "ru", { sensitivity: "base" })
  );
}

function sortGroupsByName(groups) {
  return [...groups].sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

function sortMatchesByOrder(matches) {
  return [...matches].sort((a, b) => (a.order || 0) - (b.order || 0));
}

function formatScore(score1, score2) {
  if (score1 == null || score2 == null) return "—";
  return `${score1} : ${score2}`;
}

function normalizeTournament(t) {
  const base = {
    id: t.id || generateId("tour"),
    name: t.name || "Турнир без названия",
    location: t.location || "Саратов",
    startDate: t.startDate || null,
    endDate: t.endDate || null,
    status: t.status || "draft",

    players: Array.isArray(t.players) ? [...t.players] : [],
    groups: Array.isArray(t.groups) ? [...t.groups] : [],

    playoffMasters: t.playoffMasters || null,
    playoffChallenge: t.playoffChallenge || null,
  };

  base.players = base.players.map((p) => ({
    id: p.id || generateId("p"),
    firstName: p.firstName || "",
    lastName: p.lastName || "",
    seed: typeof p.seed === "number" ? p.seed : null,
    notes: p.notes || "",
  }));

  base.groups = base.groups.map((g, idx) => ({
    id: g.id || generateId("g"),
    name: g.name || `Группа ${idx + 1}`,
    playerIds: Array.isArray(g.playerIds) ? [...g.playerIds] : [],
    matches: Array.isArray(g.matches) ? [...g.matches] : [],
  }));

  if (base.playoffMasters) base.playoffMasters = normalizeBracket(base.playoffMasters);
  if (base.playoffChallenge) base.playoffChallenge = normalizeBracket(base.playoffChallenge);

  return base;
}

function normalizeBracket(br) {
  if (!br || typeof br !== "object") {
    return {
      id: generateId("br"),
      title: "Плей-офф",
      type: "single_elim",
      rounds: [],
    };
  }
  return {
    id: br.id || generateId("br"),
    title: br.title || "Плей-офф",
    type: br.type || "single_elim",
    rounds: Array.isArray(br.rounds) ? br.rounds.map(normalizeRound) : [],
  };
}

function normalizeRound(r) {
  if (!r || typeof r !== "object") {
    return {
      id: generateId("r"),
      title: "Раунд",
      order: 1,
      matches: [],
    };
  }
  return {
    id: r.id || generateId("r"),
    title: r.title || "Раунд",
    order: typeof r.order === "number" ? r.order : 1,
    matches: Array.isArray(r.matches) ? r.matches.map(normalizeMatch) : [],
  };
}

function normalizeMatch(m) {
  if (!m || typeof m !== "object") {
    return {
      id: generateId("m"),
      order: 1,
      player1Id: null,
      player2Id: null,
      score1: null,
      score2: null,
      notes: "",
    };
  }
  return {
    id: m.id || generateId("m"),
    order: typeof m.order === "number" ? m.order : 1,
    player1Id: m.player1Id || null,
    player2Id: m.player2Id || null,
    score1: m.score1 == null ? null : Number(m.score1),
    score2: m.score2 == null ? null : Number(m.score2),
    notes: m.notes || "",
  };
}

// проверка, есть ли результаты в плей-офф
function hasPlayoffResults(tour) {
  const brackets = [tour.playoffMasters, tour.playoffChallenge].filter(Boolean);
  for (const br of brackets) {
    for (const round of br.rounds || []) {
      for (const m of round.matches || []) {
        if (m.score1 != null || m.score2 != null) return true;
      }
    }
  }
  return false;
}

// (осталась, хотя автопродвижение мы теперь не используем, но пусть будет на будущее)
function getWinnerLoser(score1, score2, player1Id, player2Id) {
  if (score1 == null || score2 == null) return null;
  if (player1Id == null || player2Id == null) return null;
  if (score1 === score2) return null;
  return score1 > score2
    ? { winnerId: player1Id, loserId: player2Id }
    : { winnerId: player2Id, loserId: player1Id };
}

// ---------------------
// ЗАГРУЗКА / СОХРАНЕНИЕ
// ---------------------

function applyNewStateFromServer(newState) {
  const normalized = {
    ...structuredClone(EMPTY_STATE),
    ...newState,
  };

  normalized.tournaments = Array.isArray(normalized.tournaments)
    ? normalized.tournaments.map(normalizeTournament)
    : [];

  if (!normalized.activeTournamentId && normalized.tournaments.length > 0) {
    normalized.activeTournamentId = normalized.tournaments[0].id;
  }

  isApplyingRemote = true;
  currentState = normalized;
  pendingLocalState = null;
  renderAll();
  isApplyingRemote = false;
}

async function initialLoad() {
  const state = await loadStateFromCloud();
  applyNewStateFromServer(state);
}

async function persistState() {
  if (isSaving) return;
  isSaving = true;
  lastSaveError = null;
  updateSavingIndicator();

  try {
    await saveStateToCloud(currentState);
  } catch (e) {
    console.error("[tournament] persistState error:", e);
    lastSaveError = e;
  } finally {
    isSaving = false;
    updateSavingIndicator();
  }
}

function updateState(updater) {
  const next = deepClone(currentState);
  updater(next);
  currentState = next;
  pendingLocalState = next;
  renderAll();
  persistState();
}

// ---------------------
// РЕНДЕРИНГ UI
// ---------------------

const bodyEl = document.body;
const pageType = bodyEl.dataset.page;

const publicRoot = document.getElementById("public-root");
const adminRoot = document.getElementById("admin-root");

// индикатор сохранения
let savingIndicatorEl = null;

function ensureSavingIndicator() {
  let el = document.getElementById("saving-indicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "saving-indicator";
    el.className = "saving-indicator saving-indicator--hidden";
    document.body.appendChild(el);
  }
  savingIndicatorEl = el;
}

function updateSavingIndicator() {
  if (!savingIndicatorEl) return;
  if (isSaving) {
    savingIndicatorEl.textContent = "Сохранение…";
    savingIndicatorEl.classList.remove("saving-indicator--hidden");
  } else if (lastSaveError) {
    savingIndicatorEl.textContent = "Ошибка сохранения!";
    savingIndicatorEl.classList.remove("saving-indicator--hidden");
    setTimeout(() => {
      savingIndicatorEl.classList.add("saving-indicator--hidden");
    }, 4000);
  } else {
    savingIndicatorEl.classList.add("saving-indicator--hidden");
  }
}

// ---------------------
// PUBLIC PAGE
// ---------------------

function renderPublic() {
  if (!publicRoot) return;

  const tour = getActiveTournament(currentState);
  publicRoot.innerHTML = "";

  if (!tour) {
    const empty = document.createElement("div");
    empty.className = "lp-empty-state";
    empty.textContent = "Активный турнир не найден.";
    publicRoot.appendChild(empty);
    return;
  }

  const container = document.createElement("div");
  container.className = "public-layout";

  // Блок информации о турнире
  const infoCard = document.createElement("section");
  infoCard.className = "lp-card lp-card--info";

  infoCard.innerHTML = `
    <div class="lp-card-header">
      <h2 class="lp-card-title">${tour.name}</h2>
      <p class="lp-card-subtitle">
        ${tour.location || "Место не указано"}
      </p>
    </div>
    <div class="lp-card-body">
      <div class="lp-info-row">
        <span class="lp-info-label">Статус:</span>
        <span class="lp-info-value">${formatStatus(tour.status)}</span>
      </div>
      <div class="lp-info-row">
        <span class="lp-info-label">Игроков:</span>
        <span class="lp-info-value">${tour.players.length}</span>
      </div>
      <div class="lp-info-row">
        <span class="lp-info-label">Групп:</span>
        <span class="lp-info-value">${tour.groups.length}</span>
      </div>
    </div>
  `;
  container.appendChild(infoCard);

  // Участники
  const playersCard = document.createElement("section");
  playersCard.className = "lp-card";
  const sortedPlayers = sortPlayersByName(tour.players);

  playersCard.innerHTML = `
    <div class="lp-card-header">
      <h2 class="lp-card-title">Участники</h2>
      <p class="lp-card-subtitle">Список всех зарегистрированных игроков</p>
    </div>
    <div class="lp-card-body">
      ${
        sortedPlayers.length === 0
          ? `<div class="lp-empty-inline">Пока нет участников.</div>`
          : `
        <div class="players-grid">
          ${sortedPlayers
            .map(
              (p) => `
            <div class="player-pill">
              <span class="player-name">${escapeHtml(
                p.lastName
              )} ${escapeHtml(p.firstName)}</span>
              ${
                p.seed != null
                  ? `<span class="player-seed" title="Посев">${p.seed}</span>`
                  : ""
              }
            </div>
          `
            )
            .join("")}
        </div>
      `
      }
    </div>
  `;
  container.appendChild(playersCard);

  // Группы
  const groupsCard = document.createElement("section");
  groupsCard.className = "lp-card lp-card--groups";

  groupsCard.innerHTML = `
    <div class="lp-card-header">
      <div class="lp-card-header-main">
        <h2 class="lp-card-title">Групповой этап</h2>
        <p class="lp-card-subtitle">
          Распределение игроков по группам и результаты матчей
        </p>
      </div>
      <a class="lp-link-soft" href="groups-wall.html" target="_blank">
        Стена группового этапа
      </a>
    </div>
    <div class="lp-card-body"></div>
  `;

  const groupsBody = groupsCard.querySelector(".lp-card-body");
  const sortedGroups = sortGroupsByName(tour.groups);

  if (sortedGroups.length === 0) {
    groupsBody.innerHTML = `<div class="lp-empty-inline">Группы ещё не созданы.</div>`;
  } else {
    const grid = document.createElement("div");
    grid.className = "groups-grid";

    for (const g of sortedGroups) {
      const groupEl = document.createElement("div");
      groupEl.className = "group-card";

      const groupPlayers = g.playerIds
        .map((pid) => tour.players.find((p) => p.id === pid))
        .filter(Boolean);

      groupEl.innerHTML = `
        <div class="group-card-header">
          <h3 class="group-card-title">${escapeHtml(g.name)}</h3>
          <span class="group-count">${groupPlayers.length} игроков</span>
        </div>
        <div class="group-card-body">
          <div class="group-players-list">
            ${groupPlayers
              .map(
                (p) => `
              <div class="group-player-row">
                <span class="group-player-name">${escapeHtml(
                  p.lastName
                )} ${escapeHtml(p.firstName)}</span>
              </div>
            `
              )
              .join("")}
          </div>
        </div>
      `;

      const matchesContainer = document.createElement("div");
      matchesContainer.className = "group-matches-list";

      const sortedMatches = sortMatchesByOrder(g.matches);

      if (sortedMatches.length > 0) {
        const table = document.createElement("table");
        table.className = "lp-table lp-table--matches";
        table.innerHTML = `
          <thead>
            <tr>
              <th>Матч</th>
              <th>Игрок 1</th>
              <th>Игрок 2</th>
              <th>Счёт</th>
            </tr>
          </thead>
          <tbody></tbody>
        `;
        const tbody = table.querySelector("tbody");

        for (const m of sortedMatches) {
          const tr = document.createElement("tr");
          const p1 = tour.players.find((p) => p.id === m.player1Id);
          const p2 = tour.players.find((p) => p.id === m.player2Id);

          tr.innerHTML = `
            <td class="lp-cell-mono">#${m.order ?? "?"}</td>
            <td>${p1 ? escapeHtml(p1.lastName + " " + p1.firstName) : "—"}</td>
            <td>${p2 ? escapeHtml(p2.lastName + " " + p2.firstName) : "—"}</td>
            <td class="lp-cell-score">${formatScore(m.score1, m.score2)}</td>
          `;

          tbody.appendChild(tr);
        }

        matchesContainer.appendChild(table);
      }

      groupEl.querySelector(".group-card-body").appendChild(matchesContainer);
      grid.appendChild(groupEl);
    }

    groupsBody.appendChild(grid);
  }

  container.appendChild(groupsCard);

  // Плей-офф (две сетки)
  const playoffWrapper = document.createElement("section");
  playoffWrapper.className = "lp-card lp-card--playoff";

  playoffWrapper.innerHTML = `
    <div class="lp-card-header">
      <h2 class="lp-card-title">Плей-офф</h2>
      <p class="lp-card-subtitle">
        Сетки Кубка Мастеров и Кубка Вызова
      </p>
    </div>
    <div class="lp-card-body playoff-grid"></div>
  `;

  const playoffBody = playoffWrapper.querySelector(".lp-card-body");

  if (!tour.playoffMasters && !tour.playoffChallenge) {
    playoffBody.innerHTML = `<div class="lp-empty-inline">Плей-офф ещё не настроен.</div>`;
  } else {
    const grid = document.createElement("div");
    grid.className = "playoff-two-columns";

    const mastersCol = document.createElement("div");
    mastersCol.className = "playoff-column";
    mastersCol.innerHTML = `
      <h3 class="playoff-column-title">Кубок Мастеров</h3>
      <div class="playoff-column-body"></div>
    `;
    const mastersBody = mastersCol.querySelector(".playoff-column-body");

    if (tour.playoffMasters) {
      mastersBody.appendChild(renderBracket(tour, tour.playoffMasters));
    } else {
      mastersBody.innerHTML = `<div class="lp-empty-inline">Сетка ещё не создана.</div>`;
    }

    const challengeCol = document.createElement("div");
    challengeCol.className = "playoff-column";
    challengeCol.innerHTML = `
      <h3 class="playoff-column-title">Кубок Вызова</h3>
      <div class="playoff-column-body"></div>
    `;
    const challengeBody = challengeCol.querySelector(".playoff-column-body");

    if (tour.playoffChallenge) {
      challengeBody.appendChild(renderBracket(tour, tour.playoffChallenge));
    } else {
      challengeBody.innerHTML = `<div class="lp-empty-inline">Сетка ещё не создана.</div>`;
    }

    grid.appendChild(mastersCol);
    grid.appendChild(challengeCol);
    playoffBody.appendChild(grid);
  }

  container.appendChild(playoffWrapper);
  publicRoot.appendChild(container);
}

function formatStatus(status) {
  switch (status) {
    case "draft":
      return "Черновик";
    case "ongoing":
      return "Идёт";
    case "finished":
      return "Завершён";
    default:
      return status || "Не указан";
  }
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Рендер одной сетки (публичная версия)
function renderBracket(tour, bracket) {
  const wrapper = document.createElement("div");
  wrapper.className = "playoff-bracket-card";

  if (!bracket.rounds || bracket.rounds.length === 0) {
    wrapper.innerHTML = `<div class="lp-empty-inline">Сетка пуста.</div>`;
    return wrapper;
  }

  const roundsSorted = [...bracket.rounds].sort((a, b) => a.order - b.order);

  const inner = document.createElement("div");
  inner.className = "playoff-rounds-grid";

  for (const round of roundsSorted) {
    const roundEl = document.createElement("div");
    roundEl.className = "playoff-round-column";

    roundEl.innerHTML = `
      <div class="playoff-round-header">
        <span class="playoff-round-title">${escapeHtml(round.title)}</span>
      </div>
      <div class="playoff-round-body"></div>
    `;
    const roundBody = roundEl.querySelector(".playoff-round-body");

    const matches = sortMatchesByOrder(round.matches || []);
    if (matches.length === 0) {
      roundBody.innerHTML =
        '<div class="lp-empty-inline">Матчей нет</div>';
    } else {
      for (const m of matches) {
        const card = document.createElement("div");
        card.className = "playoff-match-card";

        const p1 = tour.players.find((p) => p.id === m.player1Id);
        const p2 = tour.players.find((p) => p.id === m.player2Id);

        card.innerHTML = `
          <div class="playoff-match-row">
            <span class="playoff-player-name">${
              p1
                ? escapeHtml(p1.lastName + " " + p1.firstName)
                : "<span class='playoff-empty'>—</span>"
            }</span>
          </div>
          <div class="playoff-match-row">
            <span class="playoff-player-name">${
              p2
                ? escapeHtml(p2.lastName + " " + p2.firstName)
                : "<span class='playoff-empty'>—</span>"
            }</span>
          </div>
          <div class="playoff-score-row">
            <span class="playoff-score-label">Счёт:</span>
            <span class="playoff-score-value">${formatScore(
              m.score1,
              m.score2
            )}</span>
          </div>
        `;

        roundBody.appendChild(card);
      }
    }

    inner.appendChild(roundEl);
  }

  wrapper.appendChild(inner);
  return wrapper;
}

// ---------------------
// ADMIN PAGE
// ---------------------

function renderAdmin() {
  if (!adminRoot) return;

  adminRoot.innerHTML = "";
  const container = document.createElement("div");
  container.className = "admin-layout";

  const left = document.createElement("div");
  left.className = "admin-left-pane";
  const right = document.createElement("div");
  right.className = "admin-right-pane";

  // Левая колонка: выбор турнира
  const toursCard = document.createElement("section");
  toursCard.className = "lp-card lp-card--admin";

  const toursHeader = document.createElement("div");
  toursHeader.className = "lp-card-header";

  toursHeader.innerHTML = `
    <div class="lp-card-header-main">
      <h2 class="lp-card-title">Турниры</h2>
      <p class="lp-card-subtitle">
        Выбор активного турнира и создание новых
      </p>
    </div>
    <button class="lp-btn lp-btn--primary" id="btn-create-tournament">
      + Новый турнир
    </button>
  `;

  toursCard.appendChild(toursHeader);

  const toursBody = document.createElement("div");
  toursBody.className = "lp-card-body";

  const toursList = document.createElement("div");
  toursList.className = "tournament-list";

  if (!currentState.tournaments.length) {
    toursList.innerHTML =
      '<div class="lp-empty-inline">Пока нет ни одного турнира.</div>';
  } else {
    for (const t of currentState.tournaments) {
      const isActive =
        currentState.activeTournamentId === t.id ||
        adminEditingTournamentId === t.id;

      const item = document.createElement("button");
      item.className = "tournament-list-item";
      if (isActive) item.classList.add("tournament-list-item--active");

      item.innerHTML = `
        <div class="tournament-list-main">
          <span class="tournament-list-name">${escapeHtml(t.name)}</span>
          <span class="tournament-list-location">${escapeHtml(
            t.location || "Саратов"
          )}</span>
        </div>
        <div class="tournament-list-meta">
          <span>${t.players.length} игроков</span>
          <span>${t.groups.length} групп</span>
        </div>
      `;

      item.addEventListener("click", () => {
        adminEditingTournamentId = t.id;
        updateState((state) => {
          state.activeTournamentId = t.id;
        });
      });

      toursList.appendChild(item);
    }
  }

  toursBody.appendChild(toursList);
  toursCard.appendChild(toursBody);
  left.appendChild(toursCard);

  // Правая колонка: детали выбранного турнира
  const tour = getTournamentById(currentState, adminEditingTournamentId);
  const detailsCard = document.createElement("section");
  detailsCard.className = "lp-card lp-card--admin-details";

  if (!tour) {
    detailsCard.innerHTML = `
      <div class="lp-card-header">
        <h2 class="lp-card-title">Детали турнира</h2>
      </div>
      <div class="lp-card-body">
        <div class="lp-empty-inline">
          Выберите турнир слева или создайте новый.
        </div>
      </div>
    `;
  } else {
    detailsCard.appendChild(renderAdminTournamentDetails(tour));
  }

  right.appendChild(detailsCard);
  container.appendChild(left);
  container.appendChild(right);
  adminRoot.appendChild(container);

  const btnCreate = document.getElementById("btn-create-tournament");
  if (btnCreate) {
    btnCreate.addEventListener("click", handleCreateTournament);
  }
}

function renderAdminTournamentDetails(tour) {
  const root = document.createElement("div");
  root.className = "admin-tournament-details";

  const metaCard = document.createElement("section");
  metaCard.className = "lp-card lp-card--sub";

  metaCard.innerHTML = `
    <div class="lp-card-header">
      <h2 class="lp-card-title">Общие настройки</h2>
    </div>
    <div class="lp-card-body">
      <div class="lp-form-grid">
        <label class="lp-field">
          <span class="lp-field-label">Название турнира</span>
          <input type="text" class="lp-input" id="admin-name" value="${escapeHtml(
            tour.name
          )}" />
        </label>

        <label class="lp-field">
          <span class="lp-field-label">Локация</span>
          <input type="text" class="lp-input" id="admin-location" value="${escapeHtml(
            tour.location || "Саратов"
          )}" />
        </label>

        <label class="lp-field">
          <span class="lp-field-label">Статус</span>
          <select class="lp-select" id="admin-status">
            <option value="draft" ${
              tour.status === "draft" ? "selected" : ""
            }>Черновик</option>
            <option value="ongoing" ${
              tour.status === "ongoing" ? "selected" : ""
            }>Идёт</option>
            <option value="finished" ${
              tour.status === "finished" ? "selected" : ""
            }>Завершён</option>
          </select>
        </label>
      </div>

      <div class="lp-form-actions">
        <button class="lp-btn lp-btn--primary" id="btn-save-meta">
          Сохранить изменения
        </button>
      </div>
    </div>
  `;

  root.appendChild(metaCard);

  // Участники
  const playersCard = document.createElement("section");
  playersCard.className = "lp-card lp-card--sub";

  const sortedPlayers = sortPlayersByName(tour.players);

  playersCard.innerHTML = `
    <div class="lp-card-header">
      <div class="lp-card-header-main">
        <h2 class="lp-card-title">Участники</h2>
        <p class="lp-card-subtitle">
          Добавление, редактирование и посев игроков
        </p>
      </div>
      <button class="lp-btn lp-btn--ghost" id="btn-add-player">
        + Добавить игрока
      </button>
    </div>
    <div class="lp-card-body">
      ${
        sortedPlayers.length === 0
          ? `<div class="lp-empty-inline">Список участников пуст.</div>`
          : `
        <table class="lp-table lp-table--admin">
          <thead>
            <tr>
              <th>#</th>
              <th>Фамилия</th>
              <th>Имя</th>
              <th>Посев</th>
              <th>Заметки</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${sortedPlayers
              .map(
                (p, index) => `
              <tr data-player-id="${p.id}">
                <td class="lp-cell-mono">${index + 1}</td>
                <td><input class="lp-input lp-input--table player-lastName" value="${escapeHtml(
                  p.lastName
                )}" /></td>
                <td><input class="lp-input lp-input--table player-firstName" value="${escapeHtml(
                  p.firstName
                )}" /></td>
                <td><input class="lp-input lp-input--table player-seed" value="${
                  p.seed ?? ""
                }" /></td>
                <td><input class="lp-input lp-input--table player-notes" value="${escapeHtml(
                  p.notes || ""
                )}" /></td>
                <td>
                  <button class="lp-icon-btn lp-icon-btn--danger btn-delete-player" title="Удалить игрока">
                    ✕
                  </button>
                </td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      `
      }

      <div class="lp-form-actions">
        <button class="lp-btn lp-btn--primary" id="btn-save-players">
          Сохранить список участников
        </button>
      </div>
    </div>
  `;

  root.appendChild(playersCard);

  // Группы
  const groupsCard = document.createElement("section");
  groupsCard.className = "lp-card lp-card--sub";

  groupsCard.innerHTML = `
    <div class="lp-card-header">
      <div class="lp-card-header-main">
        <h2 class="lp-card-title">Групповой этап</h2>
        <p class="lp-card-subtitle">
          Распределение по группам и результаты матчей
        </p>
      </div>
      <button class="lp-btn lp-btn--ghost" id="btn-auto-groups">
        Авто-распределение
      </button>
    </div>
    <div class="lp-card-body">
      ${
        tour.groups.length === 0
          ? `<div class="lp-empty-inline">Группы ещё не созданы.</div>`
          : `
        <div class="admin-groups-grid">
          ${sortGroupsByName(tour.groups)
            .map((g) => renderAdminGroupCard(tour, g))
            .join("")}
        </div>
      `
      }
    </div>
  `;

  root.appendChild(groupsCard);

  // Плей-офф
  const playoffCard = document.createElement("section");
  playoffCard.className = "lp-card lp-card--sub";

  playoffCard.innerHTML = `
    <div class="lp-card-header">
      <div class="lp-card-header-main">
        <h2 class="lp-card-title">Плей-офф</h2>
        <p class="lp-card-subtitle">
          Ручная настройка сеток Кубка Мастеров и Кубка Вызова
        </p>
      </div>
      <div class="lp-card-header-actions">
        <button class="lp-btn lp-btn--ghost" id="btn-configure-playoff">
          Создать / пересоздать сетки
        </button>
        <button class="lp-btn lp-btn--ghost" id="btn-reset-playoff-results">
          Сбросить результаты плей-офф
        </button>
      </div>
    </div>
    <div class="lp-card-body playoff-admin-grid"></div>
  `;

  root.appendChild(playoffCard);

  // теперь навесим события
  setTimeout(() => {
    const nameInput = document.getElementById("admin-name");
    const locInput = document.getElementById("admin-location");
    const statusSelect = document.getElementById("admin-status");
    const btnSaveMeta = document.getElementById("btn-save-meta");
    if (btnSaveMeta && nameInput && locInput && statusSelect) {
      btnSaveMeta.addEventListener("click", () =>
        handleSaveMeta(tour.id, {
          name: nameInput.value.trim(),
          location: locInput.value.trim(),
          status: statusSelect.value,
        })
      );
    }

    const btnAddPlayer = document.getElementById("btn-add-player");
    if (btnAddPlayer) {
      btnAddPlayer.addEventListener("click", () =>
        handleAddPlayer(tour.id)
      );
    }

    const btnSavePlayers = document.getElementById("btn-save-players");
    if (btnSavePlayers) {
      btnSavePlayers.addEventListener("click", () =>
        handleSavePlayers(tour.id)
      );
    }

    const btnAutoGroups = document.getElementById("btn-auto-groups");
    if (btnAutoGroups) {
      btnAutoGroups.addEventListener("click", () =>
        handleAutoGroups(tour.id)
      );
    }

    const groupsGrid = root.querySelector(".admin-groups-grid");
    if (groupsGrid) {
      groupsGrid.addEventListener("click", (e) => {
        const btn = e.target.closest(".btn-group-action");
        if (!btn) return;
        const action = btn.dataset.action;
        const groupId = btn.dataset.groupId;
        if (!action || !groupId) return;
        if (action === "add-match") {
          handleAddGroupMatch(tour.id, groupId);
        } else if (action === "delete-match") {
          const matchId = btn.dataset.matchId;
          if (matchId) {
            handleDeleteGroupMatch(tour.id, groupId, matchId);
          }
        } else if (action === "edit-score") {
          const matchId = btn.dataset.matchId;
          if (matchId) {
            handleEditGroupMatchScore(tour.id, groupId, matchId);
          }
        }
      });
    }

    // обработка таблиц игроков (удаление)
    const playersTable = root.querySelector(
      ".lp-table--admin tbody"
    );
    if (playersTable) {
      playersTable.addEventListener("click", (e) => {
        const btn = e.target.closest(".btn-delete-player");
        if (!btn) return;
        const row = btn.closest("tr");
        if (!row) return;
        const pid = row.dataset.playerId;
        if (pid && confirm("Удалить этого игрока?")) {
          handleDeletePlayer(tour.id, pid);
        }
      });
    }

    const btnConfigurePlayoff =
      document.getElementById("btn-configure-playoff");
    if (btnConfigurePlayoff) {
      btnConfigurePlayoff.addEventListener("click", () =>
        handleConfigurePlayoff(tour.id)
      );
    }

    const btnResetPlayoffResults = document.getElementById(
      "btn-reset-playoff-results"
    );
    if (btnResetPlayoffResults) {
      btnResetPlayoffResults.addEventListener("click", () =>
        handleResetPlayoffResults(tour.id)
      );
    }

    const playoffAdminGrid = root.querySelector(
      ".playoff-admin-grid"
    );
    if (playoffAdminGrid) {
      playoffAdminGrid.innerHTML = "";

      const mastersCol = document.createElement("div");
      mastersCol.className = "admin-playoff-column";
      mastersCol.innerHTML = `
        <h3 class="admin-playoff-title">Кубок Мастеров</h3>
        <div class="admin-playoff-body" data-bracket="masters"></div>
      `;
      playoffAdminGrid.appendChild(mastersCol);

      const challengeCol = document.createElement("div");
      challengeCol.className = "admin-playoff-column";
      challengeCol.innerHTML = `
        <h3 class="admin-playoff-title">Кубок Вызова</h3>
        <div class="admin-playoff-body" data-bracket="challenge"></div>
      `;
      playoffAdminGrid.appendChild(challengeCol);

      const mastersBody = mastersCol.querySelector(
        ".admin-playoff-body"
      );
      const challengeBody = challengeCol.querySelector(
        ".admin-playoff-body"
      );

      if (mastersBody) {
        if (tour.playoffMasters) {
          mastersBody.appendChild(
            renderAdminBracket(tour, tour.playoffMasters, "masters")
          );
        } else {
          mastersBody.innerHTML =
            '<div class="lp-empty-inline">Сетка не создана.</div>';
        }
      }

      if (challengeBody) {
        if (tour.playoffChallenge) {
          challengeBody.appendChild(
            renderAdminBracket(
              tour,
              tour.playoffChallenge,
              "challenge"
            )
          );
        } else {
          challengeBody.innerHTML =
            '<div class="lp-empty-inline">Сетка не создана.</div>';
        }
      }
    }
  }, 0);

  return root;
}

function renderAdminGroupCard(tour, group) {
  const groupPlayers = group.playerIds
    .map((pid) => tour.players.find((p) => p.id === pid))
    .filter(Boolean);

  const sortedMatches = sortMatchesByOrder(group.matches || []);

  const matchesHtml =
    sortedMatches.length === 0
      ? `<div class="lp-empty-inline">Матчей ещё нет.</div>`
      : `
    <table class="lp-table lp-table--matches lp-table--admin">
      <thead>
        <tr>
          <th>#</th>
          <th>Игрок 1</th>
          <th>Игрок 2</th>
          <th>Счёт</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${sortedMatches
          .map((m) => {
            const p1 = tour.players.find((p) => p.id === m.player1Id);
            const p2 = tour.players.find((p) => p.id === m.player2Id);
            return `
          <tr>
            <td class="lp-cell-mono">${m.order ?? "?"}</td>
            <td>${p1 ? escapeHtml(p1.lastName + " " + p1.firstName) : "—"}</td>
            <td>${p2 ? escapeHtml(p2.lastName + " " + p2.firstName) : "—"}</td>
            <td class="lp-cell-score">${formatScore(m.score1, m.score2)}</td>
            <td>
              <button
                class="lp-icon-btn btn-group-action"
                data-action="edit-score"
                data-group-id="${group.id}"
                data-match-id="${m.id}"
                title="Изменить счёт"
              >
                ✎
              </button>
              <button
                class="lp-icon-btn lp-icon-btn--danger btn-group-action"
                data-action="delete-match"
                data-group-id="${group.id}"
                data-match-id="${m.id}"
                title="Удалить матч"
              >
                ✕
              </button>
            </td>
          </tr>
        `;
          })
          .join("")}
      </tbody>
    </table>
  `;

  return `
    <div class="admin-group-card">
      <div class="admin-group-header">
        <h3 class="admin-group-title">${escapeHtml(group.name)}</h3>
        <span class="admin-group-count">${groupPlayers.length} игроков</span>
      </div>
      <div class="admin-group-body">
        <div class="admin-group-players">
          <ul class="admin-group-players-list">
            ${groupPlayers
              .map(
                (p) => `
              <li class="admin-group-player-item">
                <span class="admin-group-player-name">${escapeHtml(
                  p.lastName + " " + p.firstName
                )}</span>
              </li>
            `
              )
              .join("")}
          </ul>
        </div>
        <div class="admin-group-matches">
          <div class="admin-group-matches-header">
            <span>Матчи</span>
            <button
              class="lp-btn lp-btn--ghost btn-group-action"
              data-action="add-match"
              data-group-id="${group.id}"
            >
              + Добавить матч
            </button>
          </div>
          <div class="admin-group-matches-body">
            ${matchesHtml}
          </div>
        </div>
      </div>
    </div>
  `;
}

// Рендер сетки плей-офф (админ)
function renderAdminBracket(tour, bracket, bracketKey) {
  const wrapper = document.createElement("div");
  wrapper.className = "admin-playoff-bracket";

  if (!bracket.rounds || bracket.rounds.length === 0) {
    wrapper.innerHTML =
      '<div class="lp-empty-inline">Сетка ещё не создана.</div>';
    return wrapper;
  }

  const roundsSorted = [...bracket.rounds].sort((a, b) => a.order - b.order);

  const grid = document.createElement("div");
  grid.className = "admin-playoff-rounds-grid";

  for (const round of roundsSorted) {
    const roundEl = document.createElement("div");
    roundEl.className = "admin-playoff-round-column";

    roundEl.innerHTML = `
      <div class="admin-playoff-round-header">
        <span class="admin-playoff-round-title">${escapeHtml(
          round.title
        )}</span>
      </div>
      <div class="admin-playoff-round-body"></div>
    `;
    const roundBody = roundEl.querySelector(".admin-playoff-round-body");

    const matches = sortMatchesByOrder(round.matches || []);
    if (matches.length === 0) {
      roundBody.innerHTML =
        '<div class="lp-empty-inline">Матчей нет</div>';
    } else {
      const bracketPlayers = sortPlayersByName(tour.players);

      for (const match of matches) {
        const card = document.createElement("div");
        card.className = "admin-playoff-match-card";

        const p1 = tour.players.find((p) => p.id === match.player1Id);
        const p2 = tour.players.find((p) => p.id === match.player2Id);

        // ТЕПЕРЬ МОЖНО МЕНЯТЬ ПАРЫ ВСЕГДА, В Т.Ч. ПОСЛЕ ВВОДА СЧЁТА
        const canEditPlayers =
          bracketPlayers.length > 0;

        const player1Name = p1
          ? `${p1.lastName} ${p1.firstName}`
          : "—";
        const player2Name = p2
          ? `${p2.lastName} ${p2.firstName}`
          : "—";

        card.innerHTML = `
          <div class="admin-playoff-match-header">
            <span class="admin-playoff-match-label">Матч #${
              match.order ?? "?"
            }</span>
          </div>
          <div class="admin-playoff-match-body">
            <div class="admin-playoff-row">
              <span class="admin-playoff-row-label">Игрок 1</span>
              ${
                canEditPlayers
                  ? `
                <select
                  class="lp-select admin-playoff-player-select"
                  data-bracket="${bracketKey}"
                  data-round-id="${round.id}"
                  data-match-id="${match.id}"
                  data-slot="player1"
                >
                  <option value="">— не выбран —</option>
                  ${bracketPlayers
                    .map(
                      (p) => `
                    <option value="${p.id}" ${
                        p.id === match.player1Id ? "selected" : ""
                      }>
                      ${escapeHtml(p.lastName + " " + p.firstName)}
                    </option>
                  `
                    )
                    .join("")}
                </select>
              `
                  : `
                <span class="admin-playoff-player-text">${escapeHtml(
                  player1Name
                )}</span>
              `
              }
            </div>

            <div class="admin-playoff-row">
              <span class="admin-playoff-row-label">Игрок 2</span>
              ${
                canEditPlayers
                  ? `
                <select
                  class="lp-select admin-playoff-player-select"
                  data-bracket="${bracketKey}"
                  data-round-id="${round.id}"
                  data-match-id="${match.id}"
                  data-slot="player2"
                >
                  <option value="">— не выбран —</option>
                  ${bracketPlayers
                    .map(
                      (p) => `
                    <option value="${p.id}" ${
                        p.id === match.player2Id ? "selected" : ""
                      }>
                      ${escapeHtml(p.lastName + " " + p.firstName)}
                    </option>
                  `
                    )
                    .join("")}
                </select>
              `
                  : `
                <span class="admin-playoff-player-text">${escapeHtml(
                  player2Name
                )}</span>
              `
              }
            </div>

            <div class="admin-playoff-row admin-playoff-row--score">
              <span class="admin-playoff-row-label">Счёт</span>
              <div class="admin-playoff-score-inputs">
                <input
                  type="number"
                  class="lp-input admin-playoff-score"
                  data-bracket="${bracketKey}"
                  data-round-id="${round.id}"
                  data-match-id="${match.id}"
                  data-team="1"
                  min="0"
                  value="${match.score1 ?? ""}"
                  placeholder="0"
                />
                <span class="admin-playoff-score-sep">:</span>
                <input
                  type="number"
                  class="lp-input admin-playoff-score"
                  data-bracket="${bracketKey}"
                  data-round-id="${round.id}"
                  data-match-id="${match.id}"
                  data-team="2"
                  min="0"
                  value="${match.score2 ?? ""}"
                  placeholder="0"
                />
                <button
                  class="lp-btn lp-btn--ghost admin-playoff-save-score"
                  data-bracket="${bracketKey}"
                  data-round-id="${round.id}"
                  data-match-id="${match.id}"
                >
                  ✓
                </button>
              </div>
            </div>
          </div>
        `;

        roundBody.appendChild(card);
      }
    }

    grid.appendChild(roundEl);
  }

  wrapper.appendChild(grid);

  setTimeout(() => {
    wrapper.addEventListener("change", (e) => {
      const select = e.target.closest(".admin-playoff-player-select");
      if (select) {
        const bracketKey = select.dataset.bracket;
        const roundId = select.dataset.roundId;
        const matchId = select.dataset.matchId;
        const slot = select.dataset.slot;
        const playerId = select.value || null;
        handleSetPlayoffPlayer(bracketKey, roundId, matchId, slot, playerId);
      }

      const scoreInput = e.target.closest(".admin-playoff-score");
      if (scoreInput) {
        handleAutoSavePlayoffScore(scoreInput);
      }
    });

    wrapper.addEventListener("click", (e) => {
      const btn = e.target.closest(".admin-playoff-save-score");
      if (!btn) return;
      handleSavePlayoffScoreButton(btn);
    });
  }, 0);

  return wrapper;
}

// ---------------------
// Обработчики Админ-панели
// ---------------------

function handleCreateTournament() {
  const name = prompt("Название нового турнира:", "Новый турнир");
  if (!name) return;

  updateState((state) => {
    const newTour = normalizeTournament({
      id: generateId("tour"),
      name,
      location: "Саратов",
      status: "draft",
      players: [],
      groups: [],
      playoffMasters: null,
      playoffChallenge: null,
    });

    state.tournaments.push(newTour);
    state.activeTournamentId = newTour.id;
    adminEditingTournamentId = newTour.id;
  });
}

function handleSaveMeta(tourId, meta) {
  updateState((state) => {
    const tour = getTournamentById(state, tourId);
    if (!tour) return;
    tour.name = meta.name || tour.name;
    tour.location = meta.location || tour.location;
    tour.status = meta.status || tour.status;
  });
}

function handleAddPlayer(tourId) {
  const lastName = prompt("Фамилия игрока:");
  if (!lastName) return;

  const firstName = prompt("Имя игрока:") || "";

  updateState((state) => {
    const tour = getTournamentById(state, tourId);
    if (!tour) return;
    const newPlayer = {
      id: generateId("p"),
      firstName,
      lastName,
      seed: null,
      notes: "",
    };
    tour.players.push(newPlayer);
  });
}

function handleSavePlayers(tourId) {
  const tbody = document.querySelector(
    ".lp-table--admin tbody"
  );
  if (!tbody) return;

  const rows = Array.from(tbody.querySelectorAll("tr"));
  const updatedPlayers = [];

  for (const row of rows) {
    const id = row.dataset.playerId;
    if (!id) continue;

    const lastNameInput = row.querySelector(".player-lastName");
    const firstNameInput = row.querySelector(".player-firstName");
    const seedInput = row.querySelector(".player-seed");
    const notesInput = row.querySelector(".player-notes");

    const lastName = lastNameInput?.value.trim() ?? "";
    const firstName = firstNameInput?.value.trim() ?? "";
    const seedRaw = seedInput?.value.trim() ?? "";
    const seed =
      seedRaw === "" || Number.isNaN(Number(seedRaw))
        ? null
        : Number(seedRaw);
    const notes = notesInput?.value.trim() ?? "";

    if (!lastName && !firstName) continue;

    updatedPlayers.push({
      id,
      lastName,
      firstName,
      seed,
      notes,
    });
  }

  updateState((state) => {
    const tour = getTournamentById(state, tourId);
    if (!tour) return;
    tour.players = updatedPlayers;
  });
}

function handleDeletePlayer(tourId, playerId) {
  updateState((state) => {
    const tour = getTournamentById(state, tourId);
    if (!tour) return;

    tour.players = tour.players.filter((p) => p.id !== playerId);
    tour.groups = tour.groups.map((g) => ({
      ...g,
      playerIds: (g.playerIds || []).filter((id) => id !== playerId),
      matches: (g.matches || []).filter(
        (m) => m.player1Id !== playerId && m.player2Id !== playerId
      ),
    }));

    if (tour.playoffMasters) {
      tour.playoffMasters.rounds = (tour.playoffMasters.rounds || []).map(
        (r) => ({
          ...r,
          matches: (r.matches || []).map((m) => ({
            ...m,
            player1Id: m.player1Id === playerId ? null : m.player1Id,
            player2Id: m.player2Id === playerId ? null : m.player2Id,
          })),
        })
      );
    }

    if (tour.playoffChallenge) {
      tour.playoffChallenge.rounds = (tour.playoffChallenge.rounds || []).map(
        (r) => ({
          ...r,
          matches: (r.matches || []).map((m) => ({
            ...m,
            player1Id: m.player1Id === playerId ? null : m.player1Id,
            player2Id: m.player2Id === playerId ? null : m.player2Id,
          })),
        })
      );
    }
  });
}

function handleAutoGroups(tourId) {
  updateState((state) => {
    const tour = getTournamentById(state, tourId);
    if (!tour) return;
    const players = sortPlayersByName(tour.players);

    if (players.length === 0) {
      alert("Сначала добавьте участников.");
      return;
    }

    const groupCount = Math.min(Math.ceil(players.length / 4), 8);
    const groups = [];
    for (let i = 0; i < groupCount; i++) {
      groups.push({
        id: generateId("g"),
        name: `Группа ${String.fromCharCode(65 + i)}`,
        playerIds: [],
        matches: [],
      });
    }

    for (let i = 0; i < players.length; i++) {
      const groupIndex = i % groupCount;
      groups[groupIndex].playerIds.push(players[i].id);
    }

    for (const g of groups) {
      g.matches = [];
      let order = 1;
      for (let i = 0; i < g.playerIds.length; i++) {
        for (let j = i + 1; j < g.playerIds.length; j++) {
          g.matches.push({
            id: generateId("gm"),
            order: order++,
            player1Id: g.playerIds[i],
            player2Id: g.playerIds[j],
            score1: null,
            score2: null,
            notes: "",
          });
        }
      }
    }

    tour.groups = groups;
  });
}

function handleAddGroupMatch(tourId, groupId) {
  updateState((state) => {
    const tour = getTournamentById(state, tourId);
    if (!tour) return;

    const group = tour.groups.find((g) => g.id === groupId);
    if (!group) return;

    if ((group.playerIds || []).length < 2) {
      alert("В группе должно быть минимум 2 игрока.");
      return;
    }

    const playerOptions = tour.players
      .filter((p) => group.playerIds.includes(p.id))
      .map((p) => `${p.id}:${p.lastName} ${p.firstName}`)
      .join("\n");

    const p1Id = prompt(
      "ID игрока 1 (выберите из списка):\n" + playerOptions
    );
    if (!p1Id) return;

    const p2Id = prompt(
      "ID игрока 2 (выберите из списка):\n" + playerOptions
    );
    if (!p2Id || p2Id === p1Id) {
      alert("Нужно выбрать двух разных игроков.");
      return;
    }

    const order =
      (group.matches && group.matches.length
        ? Math.max(...group.matches.map((m) => m.order || 0)) + 1
        : 1);

    group.matches = group.matches || [];
    group.matches.push({
      id: generateId("gm"),
      order,
      player1Id: p1Id,
      player2Id: p2Id,
      score1: null,
      score2: null,
      notes: "",
    });
  });
}

function handleDeleteGroupMatch(tourId, groupId, matchId) {
  updateState((state) => {
    const tour = getTournamentById(state, tourId);
    if (!tour) return;

    const group = tour.groups.find((g) => g.id === groupId);
    if (!group) return;

    group.matches = (group.matches || []).filter(
      (m) => m.id !== matchId
    );
  });
}

function handleEditGroupMatchScore(tourId, groupId, matchId) {
  const s = prompt("Введите счёт в формате 'x:y' (например, 3:2):", "");
  if (!s) return;

  const m = s.split(":").map((x) => x.trim());
  if (m.length !== 2) {
    alert("Неверный формат.");
    return;
  }
  const s1 = Number(m[0]);
  const s2 = Number(m[1]);
  if (Number.isNaN(s1) || Number.isNaN(s2)) {
    alert("Нужно вводить числа.");
    return;
  }

  updateState((state) => {
    const tour = getTournamentById(state, tourId);
    if (!tour) return;

    const group = tour.groups.find((g) => g.id === groupId);
    if (!group) return;

    const match = (group.matches || []).find((mm) => mm.id === matchId);
    if (!match) return;

    match.score1 = s1;
    match.score2 = s2;
  });
}

// ---------------------
// Плей-офф: настройка
// ---------------------

function handleConfigurePlayoff(tourId) {
  const mode = prompt(
    "Создать сетки заново?\n1 — стандартный шаблон\n2 — очистить плей-офф\nОтмена — ничего не делать",
    "1"
  );
  if (!mode) return;

  if (mode === "2") {
    updateState((state) => {
      const tour = getTournamentById(state, tourId);
      if (!tour) return;
      tour.playoffMasters = null;
      tour.playoffChallenge = null;
    });
    return;
  }

  updateState((state) => {
    const tour = getTournamentById(state, tourId);
    if (!tour) return;

    const baseTemplate = createBasePlayoffTemplate(8);

    const mastersBracket = normalizeBracket({
      id: generateId("br_masters"),
      title: "Кубок Мастеров",
      rounds: baseTemplate.rounds,
    });

    const extendedTemplate = createBasePlayoffTemplate(16);
    const challengeBracket = normalizeBracket({
      id: generateId("br_challenge"),
      title: "Кубок Вызова",
      rounds: extendedTemplate.rounds,
    });

    tour.playoffMasters = mastersBracket;
    tour.playoffChallenge = challengeBracket;
  });
}

function createBasePlayoffTemplate(slotCount) {
  const rounds = [];
  let currentCount = slotCount;
  let order = 1;

  while (currentCount >= 2) {
    let title;
    if (currentCount === 2) {
      title = "Финал";
    } else if (currentCount === 4) {
      title = "1/2 финала";
    } else if (currentCount === 8) {
      title = "1/4 финала";
    } else if (currentCount === 16) {
      title = "1/8 финала";
    } else {
      title = `${currentCount} участников`;
    }

    const matchCount = currentCount / 2;
    const matches = [];
    for (let i = 0; i < matchCount; i++) {
      matches.push({
        id: generateId("pm"),
        order: i + 1,
        player1Id: null,
        player2Id: null,
        score1: null,
        score2: null,
        notes: "",
      });
    }

    rounds.push({
      id: generateId("pr"),
      title,
      order,
      matches,
    });

    currentCount = matchCount;
    order++;
  }

  return { rounds };
}

function handleResetPlayoffResults(tourId) {
  if (
    !confirm(
      "Сбросить все результаты плей-офф? Игроки в сетке сохранятся, но все счёты будут очищены."
    )
  ) {
    return;
  }

  updateState((state) => {
    const tour = getTournamentById(state, tourId);
    if (!tour) return;

    const resetBracket = (br) => {
      if (!br || !br.rounds) return;
      for (const r of br.rounds) {
        for (const m of r.matches || []) {
          m.score1 = null;
          m.score2 = null;
        }
      }
    };

    resetBracket(tour.playoffMasters);
    resetBracket(tour.playoffChallenge);
  });
}

// Установка игрока в слоте плей-офф (теперь без запрета после результатов)
function handleSetPlayoffPlayer(
  bracketKey,
  roundId,
  matchId,
  slot,
  playerId
) {
  const t = getTournamentById(currentState, adminEditingTournamentId);
  if (!t) return;

  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour) return;

    const bracket =
      bracketKey === "masters"
        ? tour.playoffMasters
        : tour.playoffChallenge;
    if (!bracket || !bracket.rounds) return;

    const round = bracket.rounds.find((r) => r.id === roundId);
    if (!round) return;

    const match = (round.matches || []).find((m) => m.id === matchId);
    if (!match) return;

    if (slot === "player1") {
      match.player1Id = playerId;
    } else if (slot === "player2") {
      match.player2Id = playerId;
    }
  });
}

function handleAutoSavePlayoffScore(inputEl) {
  const bracketKey = inputEl.dataset.bracket;
  const roundId = inputEl.dataset.roundId;
  const matchId = inputEl.dataset.matchId;
  if (!bracketKey || !roundId || !matchId) return;

  const container = inputEl.closest(".admin-playoff-score-inputs");
  if (!container) return;

  const s1Input = container.querySelector(
    '.admin-playoff-score[data-team="1"]'
  );
  const s2Input = container.querySelector(
    '.admin-playoff-score[data-team="2"]'
  );
  if (!s1Input || !s2Input) return;

  const s1Raw = s1Input.value.trim();
  const s2Raw = s2Input.value.trim();

  const s1 = s1Raw === "" ? null : Number(s1Raw);
  const s2 = s2Raw === "" ? null : Number(s2Raw);

  if (
    (s1Raw !== "" && Number.isNaN(s1)) ||
    (s2Raw !== "" && Number.isNaN(s2))
  ) {
    alert("Счёт должен быть числом.");
    return;
  }

  handleSavePlayoffMatch(bracketKey, roundId, matchId, s1, s2);
}

function handleSavePlayoffScoreButton(btnEl) {
  const bracketKey = btnEl.dataset.bracket;
  const roundId = btnEl.dataset.roundId;
  const matchId = btnEl.dataset.matchId;
  if (!bracketKey || !roundId || !matchId) return;

  const container = btnEl.closest(".admin-playoff-score-inputs");
  if (!container) return;

  const s1Input = container.querySelector(
    '.admin-playoff-score[data-team="1"]'
  );
  const s2Input = container.querySelector(
    '.admin-playoff-score[data-team="2"]'
  );
  if (!s1Input || !s2Input) return;

  const s1Raw = s1Input.value.trim();
  const s2Raw = s2Input.value.trim();

  const s1 = s1Raw === "" ? null : Number(s1Raw);
  const s2 = s2Raw === "" ? null : Number(s2Raw);

  if (s1Raw !== "" && Number.isNaN(s1)) {
    alert("Счёт игрока 1 должен быть числом.");
    return;
  }
  if (s2Raw !== "" && Number.isNaN(s2)) {
    alert("Счёт игрока 2 должен быть числом.");
    return;
  }

  handleSavePlayoffMatch(bracketKey, roundId, matchId, s1, s2);
}

// Сохранение матча плей-офф (без автопродвижения по сетке)
function handleSavePlayoffMatch(
  bracketKey,
  roundId,
  matchId,
  s1,
  s2
) {
  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour) return;

    const bracket =
      bracketKey === "masters"
        ? tour.playoffMasters
        : tour.playoffChallenge;
    if (!bracket || !bracket.rounds) return;

    let foundMatch = null;
    for (const round of bracket.rounds) {
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

    const p1 = tour.players.find((p) => p.id === foundMatch.player1Id);
    const p2 = tour.players.find((p) => p.id === foundMatch.player2Id);
    const description = `${p1
      ? p1.lastName + " " + p1.firstName
      : "—"} vs ${
      p2 ? p2.lastName + " " + p2.firstName : "—"
    } — ${s1 ?? "?"}:${s2 ?? "?"}`;

    savePlayoffLog(tour.id, bracket.id, roundId, matchId, description);
  });
}

// Логирование изменений плей-офф
async function savePlayoffLog(
  tournamentId,
  bracketId,
  roundId,
  matchId,
  description
) {
  try {
    const colRef = collection(db, "playoff_logs");
    await addDoc(colRef, {
      tournamentId,
      bracketId,
      roundId,
      matchId,
      description,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("Ошибка записи лога плей-офф:", e);
  }
}

// ---------------------
// ГРУППОВОЙ ЭТАП: "СТЕНА"
// ---------------------

if (document.body.dataset.page === "groups-wall") {
  initGroupsWallPage();
}

function initGroupsWallPage() {
  const wallRoot = document.getElementById("groups-wall-root");
  if (!wallRoot) return;

  function renderWall() {
    wallRoot.innerHTML = "";

    const tour = getActiveTournament(currentState);
    if (!tour) {
      wallRoot.innerHTML =
        '<div class="wall-empty">Активный турнир не найден.</div>';
      return;
    }

    const container = document.createElement("div");
    container.className = "groups-wall-layout";

    const header = document.createElement("header");
    header.className = "groups-wall-header";
    header.innerHTML = `
      <h1 class="groups-wall-title">${escapeHtml(tour.name)}</h1>
      <p class="groups-wall-subtitle">
        Групповой этап · ${escapeHtml(
          tour.location || "Саратов"
        )}
      </p>
    `;
    container.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "groups-wall-grid";

    const sortedGroups = sortGroupsByName(tour.groups);

    for (const g of sortedGroups) {
      const groupPlayers = g.playerIds
        .map((pid) => tour.players.find((p) => p.id === pid))
        .filter(Boolean);

      const matches = sortMatchesByOrder(g.matches || []);

      const groupEl = document.createElement("section");
      groupEl.className = "groups-wall-card";

      groupEl.innerHTML = `
        <div class="groups-wall-card-header">
          <h2 class="groups-wall-group-name">${escapeHtml(
            g.name
          )}</h2>
          <span class="groups-wall-group-count">${
            groupPlayers.length
          } игроков</span>
        </div>
        <div class="groups-wall-card-body"></div>
      `;
      const body = groupEl.querySelector(".groups-wall-card-body");

      const playersTable = document.createElement("table");
      playersTable.className = "groups-wall-table groups-wall-table--players";
      playersTable.innerHTML = `
        <thead>
          <tr>
            <th>Игрок</th>
          </tr>
        </thead>
        <tbody>
          ${groupPlayers
            .map(
              (p) => `
            <tr>
              <td>${escapeHtml(
                p.lastName + " " + p.firstName
              )}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      `;

      const matchesTable = document.createElement("table");
      matchesTable.className = "groups-wall-table groups-wall-table--matches";
      matchesTable.innerHTML = `
        <thead>
          <tr>
            <th>#</th>
            <th>Игрок 1</th>
            <th>Игрок 2</th>
            <th>Счёт</th>
          </tr>
        </thead>
        <tbody>
          ${matches
            .map((m) => {
              const p1 = tour.players.find(
                (p) => p.id === m.player1Id
              );
              const p2 = tour.players.find(
                (p) => p.id === m.player2Id
              );
              return `
            <tr>
              <td class="lp-cell-mono">${m.order ?? "?"}</td>
              <td>${
                p1
                  ? escapeHtml(
                      p1.lastName + " " + p1.firstName
                    )
                  : "—"
              }</td>
              <td>${
                p2
                  ? escapeHtml(
                      p2.lastName + " " + p2.firstName
                    )
                  : "—"
              }</td>
              <td class="lp-cell-score">${formatScore(
                m.score1,
                m.score2
              )}</td>
            </tr>
          `;
            })
            .join("")}
        </tbody>
      `;

      body.appendChild(playersTable);
      body.appendChild(matchesTable);
      grid.appendChild(groupEl);
    }

    container.appendChild(grid);
    wallRoot.appendChild(container);
  }

  renderWall();
  subscribeToState((state) => {
    currentState = state;
    renderWall();
  });
}

// ---------------------
// РЕНДЕР ВСЕЙ СТРАНИЦЫ
// ---------------------

function renderAll() {
  if (pageType === "public") {
    renderPublic();
  } else if (pageType === "admin") {
    renderAdmin();
  }
}

// ---------------------
// ИНИЦИАЛИЗАЦИЯ
// ---------------------

ensureSavingIndicator();
updateSavingIndicator();

initialLoad();

subscribeToState((state) => {
  if (isApplyingRemote) return;
  applyNewStateFromServer(state);
});
