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
  query,
  where,
  orderBy,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// ---------------------
// Глобальные переменные
// ---------------------

// Текущее состояние (загружается из Firestore)
let currentState = structuredClone(EMPTY_STATE);

// ID турнира, который сейчас открыт в админке
let adminEditingTournamentId = null;

// Флаги, чтобы не поймать лишние записи в историю/Firestore
let isSaving = false;
let isInitialLoadDone = false;

// Кеш DOM-элементов
let publicRootEl = null;
let adminRootEl = null;

// ---------------------
// Вспомогательные утилиты
// ---------------------

function structuredCloneSafe(obj) {
  if (typeof structuredClone === "function") {
    return structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
}

function generateId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(
    36
  )}`;
}

function formatDateTime(date) {
  if (!(date instanceof Date)) return "";
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${d}.${m}.${y} ${hh}:${mm}`;
}

function sortPlayersByName(list) {
  return [...list].sort((a, b) => {
    const aName = `${a.lastName || ""} ${a.firstName || ""}`.trim().toLowerCase();
    const bName = `${b.lastName || ""} ${b.firstName || ""}`.trim().toLowerCase();
    return aName.localeCompare(bName);
  });
}

function getTournamentById(state, id) {
  return (state.tournaments || []).find((t) => t.id === id) || null;
}

function getActiveTournament(state) {
  if (!state) return null;
  const { activeTournamentId, tournaments } = state;
  if (!tournaments || tournaments.length === 0) return null;
  if (activeTournamentId) {
    const t = tournaments.find((x) => x.id === activeTournamentId);
    if (t) return t;
  }
  return tournaments[tournaments.length - 1] || null;
}

function hasPlayoffResults(tournament) {
  if (!tournament?.playoffs) return false;
  const allMatches = [];
  if (tournament.playoffs.mastersBracket?.rounds) {
    for (const r of tournament.playoffs.mastersBracket.rounds) {
      allMatches.push(...(r.matches || []));
    }
  }
  if (tournament.playoffs.challengeBracket?.rounds) {
    for (const r of tournament.playoffs.challengeBracket.rounds) {
      allMatches.push(...(r.matches || []));
    }
  }
  return allMatches.some(
    (m) =>
      typeof m.score1 === "number" &&
      typeof m.score2 === "number" &&
      !Number.isNaN(m.score1) &&
      !Number.isNaN(m.score2)
  );
}

// ---------------------
// Работа с состоянием
// ---------------------

async function updateState(mutator) {
  const prevState = structuredCloneSafe(currentState);
  const nextState = structuredCloneSafe(currentState);

  // Мутация в копии
  mutator(nextState);

  // Нормализация
  nextState.tournaments = Array.isArray(nextState.tournaments)
    ? nextState.tournaments
    : [];
  if (
    typeof nextState.activeTournamentId !== "string" &&
    nextState.tournaments.length > 0
  ) {
    nextState.activeTournamentId = nextState.tournaments[0].id;
  }

  currentState = nextState;

  if (typeof window !== "undefined") {
    window.__TOURNAMENT_STATE__ = currentState;
  }

  renderPublicPage();
  renderAdminPage();

  try {
    isSaving = true;
    await saveStateToCloud(nextState);
  } catch (e) {
    console.error("Ошибка при сохранении состояния:", e);
    currentState = prevState;
    renderPublicPage();
    renderAdminPage();
  } finally {
    isSaving = false;
  }
}

// ---------------------
// Рендер: Public (index.html)
// ---------------------

function renderPublicPage() {
  if (!publicRootEl) return;
  const pageType = document.body.dataset.page;
  if (pageType !== "public") return;

  const container = publicRootEl;
  container.innerHTML = "";

  const tournament = getActiveTournament(currentState);

  if (!tournament) {
    container.innerHTML = `
      <div class="lp-card lp-card--center">
        <h2 class="lp-card-title">Турнир пока не создан</h2>
        <p class="lp-card-text">Когда организатор создаст и активирует турнир, здесь появится информация.</p>
      </div>
    `;
    return;
  }

  const headerCard = document.createElement("section");
  headerCard.className = "lp-card";

  const name = tournament.name || "Турнир по настольному теннису";
  const location = tournament.location || "Саратов";
  const startDate = tournament.startDate
    ? new Date(tournament.startDate).toLocaleDateString("ru-RU")
    : "";

  headerCard.innerHTML = `
    <div class="lp-card-header">
      <div>
        <h2 class="lp-card-title">${name}</h2>
        <p class="lp-card-subtitle">
          ${location}${
    startDate ? ` · старт: <span class="lp-accent">${startDate}</span>` : ""
  }
        </p>
      </div>
      <div class="lp-card-badges">
        ${
          tournament.isRegistrationOpen
            ? `<span class="lp-badge lp-badge--success">Регистрация открыта</span>`
            : `<span class="lp-badge lp-badge--muted">Регистрация закрыта</span>`
        }
        <span class="lp-badge lp-badge--outline">
          Участников: ${tournament.players?.length || 0}
        </span>
      </div>
    </div>
  `;

  container.appendChild(headerCard);

  const registrationCard = document.createElement("section");
  registrationCard.className = "lp-card";

  const canRegister = tournament.isRegistrationOpen === true;

  registrationCard.innerHTML = `
    <div class="lp-card-header">
      <div>
        <h3 class="lp-card-title-sm">Регистрация</h3>
        <p class="lp-card-text">
          Заполните форму, чтобы участвовать в этом турнире. Ваши данные видны только организаторам.
        </p>
      </div>
    </div>

    ${
      canRegister
        ? `
      <form class="lp-form" id="public-registration-form">
        <div class="lp-form-grid">
          <label class="lp-field">
            <span class="lp-field-label">Имя</span>
            <input
              type="text"
              name="firstName"
              class="lp-input"
              placeholder="Иван"
              required
            />
          </label>
          <label class="lp-field">
            <span class="lp-field-label">Фамилия</span>
            <input
              type="text"
              name="lastName"
              class="lp-input"
              placeholder="Иванов"
              required
            />
          </label>
        </div>

        <div class="lp-form-grid">
          <label class="lp-field">
            <span class="lp-field-label">Отдел / команда (необязательно)</span>
            <input
              type="text"
              name="team"
              class="lp-input"
              placeholder="Продажи, логистика и т.п."
            />
          </label>
          <label class="lp-field">
            <span class="lp-field-label">Уровень игры</span>
            <select name="skill" class="lp-input">
              <option value="beginner">Новичок</option>
              <option value="intermediate">Любитель</option>
              <option value="advanced">Продвинутый</option>
            </select>
          </label>
        </div>

        <button type="submit" class="lp-btn lp-btn--primary">
          Отправить заявку
        </button>
        <p class="lp-card-text lp-text-muted lp-text-sm">
          Если ваша заявка уже отправлена, но нужно изменить данные — обратитесь к организатору турнира.
        </p>
      </form>
    `
        : `
      <div class="lp-empty-state">
        <p class="lp-card-text">
          Регистрация на турнир закрыта. Следите за объявлениями организаторов.
        </p>
      </div>
    `
    }
  `;

  container.appendChild(registrationCard);

  if (canRegister) {
    const form = registrationCard.querySelector("#public-registration-form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      handlePublicRegistrationSubmit(form, tournament.id);
    });
  }

  const participantsCard = document.createElement("section");
  participantsCard.className = "lp-card";

  const players = sortPlayersByName(tournament.players || []);

  participantsCard.innerHTML = `
    <div class="lp-card-header lp-card-header--with-actions">
      <div>
        <h3 class="lp-card-title-sm">Участники</h3>
        <p class="lp-card-text lp-text-muted">
          Список может дополняться и изменяться организатором.
        </p>
      </div>
      <div class="lp-badge lp-badge--soft">
        Всего участников: ${players.length}
      </div>
    </div>

    ${
      players.length === 0
        ? `
      <div class="lp-empty-state">
        <p class="lp-card-text">
          Пока еще никто не зарегистрировался. Будьте первым!
        </p>
      </div>
    `
        : `
      <div class="lp-table lp-table--participants">
        <div class="lp-table-row lp-table-row--head">
          <div class="lp-table-cell lp-table-cell--num">№</div>
          <div class="lp-table-cell">Участник</div>
          <div class="lp-table-cell lp-table-cell--team">Отдел / команда</div>
          <div class="lp-table-cell lp-table-cell--skill">Уровень</div>
        </div>
        ${players
          .map((p, idx) => {
            const fullName = `${p.lastName || ""} ${p.firstName || ""}`.trim();
            const skillLabel =
              p.skill === "advanced"
                ? "Продвинутый"
                : p.skill === "intermediate"
                ? "Любитель"
                : "Новичок";

            return `
            <div class="lp-table-row">
              <div class="lp-table-cell lp-table-cell--num">${idx + 1}</div>
              <div class="lp-table-cell">
                <div class="lp-player-name">${fullName || "Без имени"}</div>
              </div>
              <div class="lp-table-cell lp-table-cell--team">
                ${p.team || "—"}
              </div>
              <div class="lp-table-cell lp-table-cell--skill">
                <span class="lp-tag lp-tag--skill-${p.skill || "beginner"}">
                  ${skillLabel}
                </span>
              </div>
            </div>
          `;
          })
          .join("")}
      </div>
    `
    }
  `;

  container.appendChild(participantsCard);

  const groupsEl = renderGroupsSection(tournament);
  container.appendChild(groupsEl);

  const playoffsWrapper = document.createElement("section");
  playoffsWrapper.className = "lp-card lp-card--playoffs";

  playoffsWrapper.innerHTML = `
    <div class="lp-card-header">
      <div>
        <h3 class="lp-card-title-sm">Плей-офф</h3>
        <p class="lp-card-text lp-text-muted">
          Основные стадии турнира: Кубок Мастеров и Кубок Вызова.
        </p>
      </div>
    </div>
  `;

  const mastersBracketEl = renderBracket(tournament, "masters");
  const challengeBracketEl = renderBracket(tournament, "challenge");

  playoffsWrapper.appendChild(mastersBracketEl);
  playoffsWrapper.appendChild(challengeBracketEl);

  container.appendChild(playoffsWrapper);

  const historySection = renderHistorySection(tournament);
  container.appendChild(historySection);
}

async function handlePublicRegistrationSubmit(form, tournamentId) {
  const formData = new FormData(form);
  const firstName = (formData.get("firstName") || "").trim();
  const lastName = (formData.get("lastName") || "").trim();
  const team = (formData.get("team") || "").trim();
  const skill = formData.get("skill") || "beginner";

  if (!firstName || !lastName) {
    alert("Пожалуйста, заполните имя и фамилию.");
    return;
  }

  try {
    const tournament = getTournamentById(currentState, tournamentId);
    if (!tournament) {
      alert("Турнир не найден. Попробуйте обновить страницу.");
      return;
    }
    if (!tournament.isRegistrationOpen) {
      alert("Регистрация уже закрыта.");
      return;
    }

    await updateState((state) => {
      const tour = getTournamentById(state, tournamentId);
      if (!tour) return;

      const newPlayer = {
        id: generateId("pl"),
        firstName,
        lastName,
        team,
        skill,
        addedAt: Date.now(),
      };

      if (!Array.isArray(tour.players)) {
        tour.players = [];
      }
      tour.players.push(newPlayer);

      if (!Array.isArray(tour.history)) {
        tour.history = [];
      }
      tour.history.push({
        id: generateId("h"),
        type: "registration",
        timestamp: Date.now(),
        title: "Новый участник",
        description: `Зарегистрирован участник: ${lastName} ${firstName}${
          team ? ` (${team})` : ""
        }`,
      });
    });

    form.reset();
    alert("Заявка отправлена! Организатор увидит вас в списке участников.");
  } catch (e) {
    console.error("Ошибка при отправке регистрации:", e);
    alert("Не удалось отправить заявку. Попробуйте ещё раз.");
  }
}

// ---------------------
// Рендер: группы (общая функция)
// ---------------------

function renderGroupsSection(tournament) {
  const section = document.createElement("section");
  section.className = "lp-groups-section";

  const groups = tournament.groups || [];

  if (!groups.length) {
    section.innerHTML = `
      <div class="lp-card">
        <div class="lp-card-header">
          <h3 class="lp-card-title-sm">Групповой этап</h3>
        </div>
        <div class="lp-empty-state">
          <p class="lp-card-text">
            Группы пока не созданы. Ожидайте распределения участников организатором.
          </p>
        </div>
      </div>
    `;
    return section;
  }

  const header = document.createElement("div");
  header.className = "lp-card lp-card--subheader";
  header.innerHTML = `
    <div class="lp-card-header">
      <div>
        <h3 class="lp-card-title-sm">Групповой этап</h3>
        <p class="lp-card-text lp-text-muted">
          Результаты матчей в группах и текущие позиции участников.
        </p>
      </div>
    </div>
  `;
  section.appendChild(header);

  const groupsGrid = document.createElement("div");
  groupsGrid.className = "lp-groups-grid";

  groups
    .slice()
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .forEach((group) => {
      const groupEl = document.createElement("article");
      groupEl.className = "lp-card lp-group-card";

      const groupPlayers = (group.playerIds || [])
        .map((id) => tournament.players.find((p) => p.id === id))
        .filter(Boolean);

      const matchById = {};
      for (const match of group.matches || []) {
        matchById[match.id] = match;
      }

      const playerStats = groupPlayers.map((p) => ({
        player: p,
        played: 0,
        won: 0,
        lost: 0,
        points: 0,
      }));

      const statsByPlayerId = {};
      for (const s of playerStats) {
        statsByPlayerId[s.player.id] = s;
      }

      for (const match of group.matches || []) {
        const s1 = match.score1;
        const s2 = match.score2;
        if (typeof s1 === "number" && typeof s2 === "number") {
          const ps1 = statsByPlayerId[match.player1Id];
          const ps2 = statsByPlayerId[match.player2Id];
          if (ps1 && ps2) {
            ps1.played++;
            ps2.played++;
            if (s1 > s2) {
              ps1.won++;
              ps2.lost++;
              ps1.points += 2;
              ps2.points += 1;
            } else if (s2 > s1) {
              ps2.won++;
              ps1.lost++;
              ps2.points += 2;
              ps1.points += 1;
            } else {
              ps1.points += 1;
              ps2.points += 1;
            }
          }
        }
      }

      playerStats.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.won !== a.won) return b.won - a.won;
        return a.player.lastName.localeCompare(b.player.lastName);
      });

      groupEl.innerHTML = `
        <div class="lp-group-card-header">
          <div>
            <h4 class="lp-group-title">Группа ${group.name || ""}</h4>
            <p class="lp-group-subtitle">
              Участников: ${groupPlayers.length}
            </p>
          </div>
        </div>

        ${
          groupPlayers.length === 0
            ? `
          <div class="lp-empty-state lp-empty-state--sm">
            <p class="lp-card-text">
              В этой группе пока нет участников.
            </p>
          </div>
        `
            : `
          <div class="lp-table lp-table--group-standings">
            <div class="lp-table-row lp-table-row--head lp-table-row--dense">
              <div class="lp-table-cell lp-table-cell--num">№</div>
              <div class="lp-table-cell">Участник</div>
              <div class="lp-table-cell lp-table-cell--center">И</div>
              <div class="lp-table-cell lp-table-cell--center">В</div>
              <div class="lp-table-cell lp-table-cell--center">П</div>
              <div class="lp-table-cell lp-table-cell--center">Очки</div>
            </div>
            ${playerStats
              .map((st, index) => {
                const fullName = `${st.player.lastName || ""} ${
                  st.player.firstName || ""
                }`.trim();
                return `
                <div class="lp-table-row lp-table-row--dense">
                  <div class="lp-table-cell lp-table-cell--num">${
                    index + 1
                  }</div>
                  <div class="lp-table-cell">
                    <div class="lp-player-name lp-player-name--sm">${
                      fullName || "Без имени"
                    }</div>
                  </div>
                  <div class="lp-table-cell lp-table-cell--center">${
                    st.played
                  }</div>
                  <div class="lp-table-cell lp-table-cell--center">${st.won}</div>
                  <div class="lp-table-cell lp-table-cell--center">${st.lost}</div>
                  <div class="lp-table-cell lp-table-cell--center lp-table-cell--points">
                    <span class="lp-pill lp-pill--points">${st.points}</span>
                  </div>
                </div>
              `;
              })
              .join("")}
          </div>
        `
        }

        <div class="lp-group-matches">
          <h5 class="lp-group-matches-title">Матчи в группе</h5>
          ${
            (group.matches || []).length === 0
              ? `
            <div class="lp-empty-state lp-empty-state--sm">
              <p class="lp-card-text">
                Матчи ещё не назначены.
              </p>
            </div>
          `
              : `
            <div class="lp-matches-list">
              ${(group.matches || [])
                .map((match) => {
                  const p1 =
                    tournament.players.find((p) => p.id === match.player1Id) ||
                    null;
                  const p2 =
                    tournament.players.find((p) => p.id === match.player2Id) ||
                    null;

                  const p1Name = p1
                    ? `${p1.lastName || ""} ${p1.firstName || ""}`.trim()
                    : "—";
                  const p2Name = p2
                    ? `${p2.lastName || ""} ${p2.firstName || ""}`.trim()
                    : "—";

                  const hasScore =
                    typeof match.score1 === "number" &&
                    typeof match.score2 === "number";

                  let scoreStr = "— : —";
                  if (hasScore) {
                    scoreStr = `${match.score1} : ${match.score2}`;
                  }

                  return `
                    <div class="lp-match-chip ${
                      hasScore ? "lp-match-chip--played" : ""
                    }">
                      <div class="lp-match-chip-players">
                        <span class="lp-match-chip-player">${p1Name}</span>
                        <span class="lp-match-chip-vs">vs</span>
                        <span class="lp-match-chip-player">${p2Name}</span>
                      </div>
                      <div class="lp-match-chip-score">${scoreStr}</div>
                    </div>
                  `;
                })
                .join("")}
            </div>
          `
          }
        </div>
      `;

      groupsGrid.appendChild(groupEl);
    });

  section.appendChild(groupsGrid);
  return section;
}

// ---------------------
// Рендер: Плей-офф (brackets)
// ---------------------

function renderBracket(tournament, bracketType) {
  const bracket =
    bracketType === "masters"
      ? tournament.playoffs?.mastersBracket
      : tournament.playoffs?.challengeBracket;

  const bracketTitle =
    bracketType === "masters" ? "Кубок Мастеров" : "Кубок Вызова";

  const wrapper = document.createElement("div");
  wrapper.className = "lp-bracket-wrapper";

  if (!bracket || !Array.isArray(bracket.rounds) || bracket.rounds.length === 0) {
    wrapper.innerHTML = `
      <div class="lp-card lp-card--sub">
        <div class="lp-card-header lp-card-header--sm">
          <h4 class="lp-card-title-xs">${bracketTitle}</h4>
        </div>
        <div class="lp-empty-state lp-empty-state--sm">
          <p class="lp-card-text">
            Сетка пока не сформирована. Ожидайте результатов группового этапа или
            решения организаторов.
          </p>
        </div>
      </div>
    `;
    return wrapper;
  }

  const card = document.createElement("div");
  card.className = "lp-card lp-card--sub lp-bracket-card";

  const rounds = bracket.rounds;

  card.innerHTML = `
    <div class="lp-card-header lp-card-header--sm">
      <h4 class="lp-card-title-xs">${bracketTitle}</h4>
    </div>
  `;

  const roundsRow = document.createElement("div");
  roundsRow.className = "lp-bracket-rounds";

  rounds.forEach((round) => {
    const roundEl = document.createElement("div");
    roundEl.className = "lp-bracket-round";

    roundEl.innerHTML = `
      <div class="lp-bracket-round-title">
        ${round.name || "Раунд"}
      </div>
      <div class="lp-bracket-round-matches"></div>
    `;

    const matchesContainer = roundEl.querySelector(
      ".lp-bracket-round-matches"
    );

    (round.matches || []).forEach((match) => {
      const matchEl = document.createElement("div");
      matchEl.className = "lp-bracket-match";

      const p1 =
        tournament.players.find((p) => p.id === match.player1Id) || null;
      const p2 =
        tournament.players.find((p) => p.id === match.player2Id) || null;

      const p1Name = p1
        ? `${p1.lastName || ""} ${p1.firstName || ""}`.trim()
        : "—";
      const p2Name = p2
        ? `${p2.lastName || ""} ${p2.firstName || ""}`.trim()
        : "—";

      const hasScore =
        typeof match.score1 === "number" &&
        typeof match.score2 === "number" &&
        !Number.isNaN(match.score1) &&
        !Number.isNaN(match.score2);

      let p1Class = "lp-bracket-player";
      let p2Class = "lp-bracket-player";

      if (hasScore && match.score1 > match.score2) {
        p1Class += " lp-bracket-player--winner";
        p2Class += " lp-bracket-player--loser";
      } else if (hasScore && match.score2 > match.score1) {
        p2Class += " lp-bracket-player--winner";
        p1Class += " lp-bracket-player--loser";
      }

      matchEl.innerHTML = `
        <div class="${p1Class}">
          <span class="lp-bracket-player-name">${p1Name}</span>
          <span class="lp-bracket-player-score">${
            hasScore ? match.score1 : ""
          }</span>
        </div>
        <div class="${p2Class}">
          <span class="lp-bracket-player-name">${p2Name}</span>
          <span class="lp-bracket-player-score">${
            hasScore ? match.score2 : ""
          }</span>
        </div>
      `;

      matchesContainer.appendChild(matchEl);
    });

    roundsRow.appendChild(roundEl);
  });

  card.appendChild(roundsRow);
  wrapper.appendChild(card);
  return wrapper;
}

// ---------------------
// История (history)
// ---------------------

function renderHistorySection(tournament) {
  const section = document.createElement("section");
  section.className = "lp-card lp-card--history";

  const history = (tournament.history || [])
    .slice()
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  section.innerHTML = `
    <div class="lp-card-header">
      <div>
        <h3 class="lp-card-title-sm">История турнира</h3>
        <p class="lp-card-text lp-text-muted">
          Ключевые события: регистрации, распределение по группам, создание сеток и результаты плей-офф.
        </p>
      </div>
    </div>
    <div class="lp-history-list"></div>
  `;

  const listEl = section.querySelector(".lp-history-list");

  if (!history.length) {
    listEl.innerHTML = `
      <div class="lp-empty-state">
        <p class="lp-card-text">
          История событий пока пустая. Здесь появятся записи, когда начнутся действия.
        </p>
      </div>
    `;
    return section;
  }

  history.forEach((entry) => {
    const item = document.createElement("article");
    item.className = "lp-history-item";

    const ts = entry.timestamp ? formatDateTime(new Date(entry.timestamp)) : "";
    let typeLabel = "";
    let typeClass = "";

    switch (entry.type) {
      case "registration":
        typeLabel = "Регистрация";
        typeClass = "lp-history-badge--registration";
        break;
      case "groups":
        typeLabel = "Групповой этап";
        typeClass = "lp-history-badge--groups";
        break;
      case "playoff":
        typeLabel = "Плей-офф";
        typeClass = "lp-history-badge--playoff";
        break;
      default:
        typeLabel = "Событие";
        typeClass = "lp-history-badge--default";
    }

    item.innerHTML = `
      <div class="lp-history-item-header">
        <span class="lp-history-badge ${typeClass}">${typeLabel}</span>
        <span class="lp-history-timestamp">${ts}</span>
      </div>
      <h4 class="lp-history-title">${entry.title || "Событие"}</h4>
      <p class="lp-history-description">${entry.description || ""}</p>
    `;

    listEl.appendChild(item);
  });

  return section;
}

// ---------------------
// Рендер: Admin (admin.html)
// ---------------------

function renderAdminPage() {
  if (!adminRootEl) return;
  const pageType = document.body.dataset.page;
  if (pageType !== "admin") return;

  const container = adminRootEl;
  container.innerHTML = "";

  const state = currentState;
  const tournaments = state.tournaments || [];

  const topBar = document.createElement("div");
  topBar.className = "lp-card lp-admin-topbar";

  const activeTournament = getActiveTournament(state);

  if (!adminEditingTournamentId && activeTournament) {
    adminEditingTournamentId = activeTournament.id;
  }

  if (!tournaments.length) {
    topBar.innerHTML = `
      <div class="lp-admin-topbar-inner">
        <div>
          <h2 class="lp-card-title">Турниры</h2>
          <p class="lp-card-text">
            Пока нет ни одного турнира. Создайте новый, чтобы начать.
          </p>
        </div>
        <button class="lp-btn lp-btn--primary" id="admin-create-tournament">
          Создать турнир
        </button>
      </div>
    `;
    container.appendChild(topBar);

    topBar
      .querySelector("#admin-create-tournament")
      .addEventListener("click", () => {
        handleCreateTournament();
      });

    return;
  }

  topBar.innerHTML = `
    <div class="lp-admin-topbar-inner">
      <div>
        <h2 class="lp-card-title">Турниры</h2>
        <p class="lp-card-text">
          Выберите турнир для редактирования или создайте новый.
        </p>
      </div>
      <button class="lp-btn lp-btn--primary" id="admin-create-tournament">
        Создать турнир
      </button>
    </div>
    <div class="lp-admin-tournament-select-row">
      <label class="lp-field lp-field--inline">
        <span class="lp-field-label">Активный турнир</span>
        <select id="admin-active-tournament-select" class="lp-input lp-input--sm">
          ${(tournaments || [])
            .map((t) => {
              const selected =
                activeTournament && activeTournament.id === t.id ? "selected" : "";
              return `<option value="${t.id}" ${selected}>${t.name || "Без названия"}</option>`;
            })
            .join("")}
        </select>
      </label>
      <label class="lp-field lp-field--inline">
        <span class="lp-field-label">Редактируемый турнир</span>
        <select id="admin-editing-tournament-select" class="lp-input lp-input--sm">
          ${(tournaments || [])
            .map((t) => {
              const selected =
                adminEditingTournamentId === t.id ? "selected" : "";
              return `<option value="${t.id}" ${selected}>${t.name || "Без названия"}</option>`;
            })
            .join("")}
        </select>
      </label>
    </div>
  `;

  container.appendChild(topBar);

  topBar
    .querySelector("#admin-create-tournament")
    .addEventListener("click", () => {
      handleCreateTournament();
    });

  const activeSelect = topBar.querySelector("#admin-active-tournament-select");
  activeSelect.addEventListener("change", (e) => {
    const newId = e.target.value;
    updateState((state) => {
      if (state.tournaments.some((t) => t.id === newId)) {
        state.activeTournamentId = newId;
      }
    });
  });

  const editingSelect = topBar.querySelector(
    "#admin-editing-tournament-select"
  );
  editingSelect.addEventListener("change", (e) => {
    const newId = e.target.value;
    adminEditingTournamentId = newId;
    renderAdminPage();
  });

  const editingTournament = getTournamentById(state, adminEditingTournamentId);
  if (!editingTournament) {
    const card = document.createElement("div");
    card.className = "lp-card lp-card--center";
    card.innerHTML = `
      <p class="lp-card-text">
        Выберите турнир для редактирования.
      </p>
    `;
    container.appendChild(card);
    return;
  }

  const infoCard = renderAdminTournamentInfo(editingTournament);
  container.appendChild(infoCard);

  const participantsCard = renderAdminParticipants(editingTournament);
  container.appendChild(participantsCard);

  const groupsCard = renderAdminGroups(editingTournament);
  container.appendChild(groupsCard);

  const playoffsCard = renderAdminPlayoffs(editingTournament);
  container.appendChild(playoffsCard);

  const historyCard = renderAdminHistory(editingTournament);
  container.appendChild(historyCard);
}

function renderAdminTournamentInfo(tournament) {
  const card = document.createElement("section");
  card.className = "lp-card";

  const startDateStr = tournament.startDate
    ? new Date(tournament.startDate).toISOString().slice(0, 10)
    : "";

  card.innerHTML = `
    <div class="lp-card-header lp-card-header--with-actions">
      <div>
        <h3 class="lp-card-title-sm">Основная информация</h3>
        <p class="lp-card-text lp-text-muted">
          Название турнира, место проведения, дата старта и статус регистрации.
        </p>
      </div>
      <button class="lp-btn lp-btn--danger lp-btn--outline" id="admin-delete-tournament">
        Удалить турнир
      </button>
    </div>

    <form class="lp-form" id="admin-tournament-info-form">
      <div class="lp-form-grid">
        <label class="lp-field">
          <span class="lp-field-label">Название турнира</span>
          <input
            type="text"
            name="name"
            class="lp-input"
            placeholder="Турнир по настольному теннису"
            value="${tournament.name || ""}"
          />
        </label>
        <label class="lp-field">
          <span class="lp-field-label">Место проведения</span>
          <input
            type="text"
            name="location"
            class="lp-input"
            placeholder="Саратов"
            value="${tournament.location || ""}"
          />
        </label>
      </div>

      <div class="lp-form-grid">
        <label class="lp-field">
          <span class="lp-field-label">Дата начала</span>
          <input
            type="date"
            name="startDate"
            class="lp-input"
            value="${startDateStr}"
          />
        </label>
        <label class="lp-field lp-field--switch">
          <span class="lp-field-label">Регистрация открыта</span>
          <label class="lp-switch">
            <input
              type="checkbox"
              name="isRegistrationOpen"
              ${tournament.isRegistrationOpen ? "checked" : ""}
            />
            <span class="lp-switch-slider"></span>
          </label>
        </label>
      </div>

      <div class="lp-form-actions">
        <button type="submit" class="lp-btn lp-btn--primary">
          Сохранить изменения
        </button>
      </div>
    </form>
  `;

  const form = card.querySelector("#admin-tournament-info-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const formData = new FormData(form);
    const name = (formData.get("name") || "").trim();
    const location = (formData.get("location") || "").trim();
    const startDateVal = formData.get("startDate");
    const isRegistrationOpen = formData.get("isRegistrationOpen") === "on";

    updateState((state) => {
      const t = getTournamentById(state, tournament.id);
      if (!t) return;

      t.name = name || "";
      t.location = location || "";
      t.isRegistrationOpen = isRegistrationOpen;
      t.startDate = startDateVal ? new Date(startDateVal).getTime() : null;
    });
  });

  card
    .querySelector("#admin-delete-tournament")
    .addEventListener("click", () => {
      if (
        !confirm(
          "Вы действительно хотите удалить этот турнир? Данные будут потеряны."
        )
      ) {
        return;
      }
      updateState((state) => {
        state.tournaments = (state.tournaments || []).filter(
          (t) => t.id !== tournament.id
        );
        if (state.activeTournamentId === tournament.id) {
          state.activeTournamentId = state.tournaments[0]?.id || null;
        }
        if (adminEditingTournamentId === tournament.id) {
          adminEditingTournamentId = state.activeTournamentId;
        }
      });
    });

  return card;
}

function renderAdminParticipants(tournament) {
  const card = document.createElement("section");
  card.className = "lp-card";

  const players = sortPlayersByName(tournament.players || []);

  card.innerHTML = `
    <div class="lp-card-header lp-card-header--with-actions">
      <div>
        <h3 class="lp-card-title-sm">Участники</h3>
        <p class="lp-card-text lp-text-muted">
          Добавляйте, редактируйте и удаляйте участников турнира.
        </p>
      </div>
      <button class="lp-btn lp-btn--secondary" id="admin-add-player">
        Добавить участника
      </button>
    </div>
    <div class="lp-table lp-table--participants lp-table--admin">
      <div class="lp-table-row lp-table-row--head">
        <div class="lp-table-cell lp-table-cell--num">№</div>
        <div class="lp-table-cell">Фамилия</div>
        <div class="lp-table-cell">Имя</div>
        <div class="lp-table-cell lp-table-cell--team">Отдел / команда</div>
        <div class="lp-table-cell lp-table-cell--skill">Уровень</div>
        <div class="lp-table-cell lp-table-cell--actions">Действия</div>
      </div>
      <div class="lp-table-body">
        ${
          players.length === 0
            ? `
          <div class="lp-empty-state lp-empty-state--sm">
            <p class="lp-card-text">
              Участники еще не добавлены. Нажмите "Добавить участника", чтобы начать.
            </p>
          </div>
        `
            : players
                .map((p, idx) => {
                  const skillLabel =
                    p.skill === "advanced"
                      ? "Продвинутый"
                      : p.skill === "intermediate"
                      ? "Любитель"
                      : "Новичок";
                  return `
                  <div class="lp-table-row lp-table-row--hover" data-player-id="${
                    p.id
                  }">
                    <div class="lp-table-cell lp-table-cell--num">${idx + 1}</div>
                    <div class="lp-table-cell">${p.lastName || ""}</div>
                    <div class="lp-table-cell">${p.firstName || ""}</div>
                    <div class="lp-table-cell lp-table-cell--team">${
                      p.team || ""
                    }</div>
                    <div class="lp-table-cell lp-table-cell--skill">
                      <span class="lp-tag lp-tag--skill-${p.skill || "beginner"}">
                        ${skillLabel}
                      </span>
                    </div>
                    <div class="lp-table-cell lp-table-cell--actions">
                      <button class="lp-btn lp-btn--icon lp-btn--ghost" data-action="edit">
                        ✏️
                      </button>
                      <button class="lp-btn lp-btn--icon lp-btn--ghost lp-btn--danger" data-action="delete">
                        🗑
                      </button>
                    </div>
                  </div>
                `;
                })
                .join("")
        }
      </div>
    </div>
  `;

  card
    .querySelector("#admin-add-player")
    .addEventListener("click", () => handleAddPlayer(tournament.id));

  card.querySelectorAll(".lp-table-row[data-player-id]").forEach((rowEl) => {
    const playerId = rowEl.dataset.playerId;
    rowEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      const action = btn.dataset.action;
      if (action === "edit") {
        handleEditPlayer(tournament.id, playerId);
      } else if (action === "delete") {
        handleDeletePlayer(tournament.id, playerId);
      }
    });
  });

  return card;
}

function handleAddPlayer(tournamentId) {
  const lastName = prompt("Фамилия участника:");
  if (lastName === null) return;
  const ln = lastName.trim();
  const firstName = prompt("Имя участника:");
  if (firstName === null) return;
  const fn = firstName.trim();
  const team = prompt("Отдел / команда (необязательно):") || "";
  const skill = prompt(
    "Уровень игры (beginner / intermediate / advanced):",
    "beginner"
  );

  if (!ln || !fn) {
    alert("Имя и фамилия обязательны.");
    return;
  }

  const normalizedSkill =
    skill === "advanced" || skill === "intermediate" ? skill : "beginner";

  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t) return;

    const newPlayer = {
      id: generateId("pl"),
      lastName: ln,
      firstName: fn,
      team: team.trim(),
      skill: normalizedSkill,
      addedAt: Date.now(),
    };

    if (!Array.isArray(t.players)) t.players = [];
    t.players.push(newPlayer);

    if (!Array.isArray(t.history)) t.history = [];
    t.history.push({
      id: generateId("h"),
      type: "registration",
      timestamp: Date.now(),
      title: "Добавлен участник",
      description: `Добавлен участник: ${ln} ${fn}${
        team ? ` (${team.trim()})` : ""
      }`,
    });
  });
}

function handleEditPlayer(tournamentId, playerId) {
  const tournament = getTournamentById(currentState, tournamentId);
  if (!tournament) return;
  const player = (tournament.players || []).find((p) => p.id === playerId);
  if (!player) return;

  const ln = prompt("Фамилия участника:", player.lastName || "");
  if (ln === null) return;
  const fn = prompt("Имя участника:", player.firstName || "");
  if (fn === null) return;
  const team = prompt("Отдел / команда (необязательно):", player.team || "");
  if (team === null) return;
  const skill = prompt(
    "Уровень игры (beginner / intermediate / advanced):",
    player.skill || "beginner"
  );
  if (skill === null) return;

  const normalizedSkill =
    skill === "advanced" || skill === "intermediate" ? skill : "beginner";

  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t) return;
    const p = (t.players || []).find((x) => x.id === playerId);
    if (!p) return;

    p.lastName = ln.trim();
    p.firstName = fn.trim();
    p.team = team.trim();
    p.skill = normalizedSkill;

    if (!Array.isArray(t.history)) t.history = [];
    t.history.push({
      id: generateId("h"),
      type: "registration",
      timestamp: Date.now(),
      title: "Изменены данные участника",
      description: `Обновлены данные: ${p.lastName} ${p.firstName}`,
    });
  });
}

function handleDeletePlayer(tournamentId, playerId) {
  if (
    !confirm(
      "Вы действительно хотите удалить участника? Он будет удалён из групп и сеток."
    )
  ) {
    return;
  }

  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t) return;

    const player = (t.players || []).find((p) => p.id === playerId);

    t.players = (t.players || []).filter((p) => p.id !== playerId);

    (t.groups || []).forEach((g) => {
      g.playerIds = (g.playerIds || []).filter((id) => id !== playerId);
      g.matches = (g.matches || []).filter(
        (m) => m.player1Id !== playerId && m.player2Id !== playerId
      );
    });

    if (t.playoffs?.mastersBracket?.rounds) {
      for (const r of t.playoffs.mastersBracket.rounds) {
        r.matches = (r.matches || []).map((m) => ({
          ...m,
          player1Id: m.player1Id === playerId ? null : m.player1Id,
          player2Id: m.player2Id === playerId ? null : m.player2Id,
        }));
      }
    }
    if (t.playoffs?.challengeBracket?.rounds) {
      for (const r of t.playoffs.challengeBracket.rounds) {
        r.matches = (r.matches || []).map((m) => ({
          ...m,
          player1Id: m.player1Id === playerId ? null : m.player1Id,
          player2Id: m.player2Id === playerId ? null : m.player2Id,
        }));
      }
    }

    if (!Array.isArray(t.history)) t.history = [];
    t.history.push({
      id: generateId("h"),
      type: "registration",
      timestamp: Date.now(),
      title: "Удалён участник",
      description: player
        ? `Удалён участник: ${player.lastName || ""} ${
            player.firstName || ""
          }`.trim()
        : "Удалён участник",
    });
  });
}

function renderAdminGroups(tournament) {
  const card = document.createElement("section");
  card.className = "lp-card";

  card.innerHTML = `
    <div class="lp-card-header lp-card-header--with-actions">
      <div>
        <h3 class="lp-card-title-sm">Групповой этап</h3>
        <p class="lp-card-text lp-text-muted">
          Распределение участников по группам и результаты матчей.
        </p>
      </div>
      <div class="lp-card-header-actions">
        <button class="lp-btn lp-btn--secondary" id="admin-groups-auto">
          Авто-распределение
        </button>
        <button class="lp-btn lp-btn--ghost" id="admin-groups-clear">
          Очистить группы
        </button>
      </div>
    </div>
    <div class="lp-groups-admin"></div>
  `;

  const groupsContainer = card.querySelector(".lp-groups-admin");

  const groups = tournament.groups || [];
  const players = sortPlayersByName(tournament.players || []);

  if (!groups.length) {
    const hint = document.createElement("div");
    hint.className = "lp-empty-state";
    hint.innerHTML = `
      <p class="lp-card-text">
        Группы пока не созданы. Нажмите "Авто-распределение", чтобы автоматически разбить участников на группы, или создайте группы вручную.
      </p>
    `;
    groupsContainer.appendChild(hint);
  }

  groups
    .slice()
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .forEach((group) => {
      const groupEl = document.createElement("div");
      groupEl.className = "lp-group-admin-card";
      groupEl.dataset.groupId = group.id;

      const groupPlayers = (group.playerIds || [])
        .map((id) => players.find((p) => p.id === id))
        .filter(Boolean);

      groupEl.innerHTML = `
        <div class="lp-group-admin-header">
          <div>
            <h4 class="lp-group-title">Группа ${group.name || ""}</h4>
            <p class="lp-group-subtitle">
              Участников: ${groupPlayers.length}
            </p>
          </div>
          <div class="lp-group-admin-header-actions">
            <button class="lp-btn lp-btn--icon lp-btn--ghost" data-action="rename-group">
              ✏️
            </button>
            <button class="lp-btn lp-btn--icon lp-btn--ghost lp-btn--danger" data-action="delete-group">
              🗑
            </button>
          </div>
        </div>

        <div class="lp-group-admin-body">
          <div class="lp-group-admin-column">
            <div class="lp-group-admin-block">
              <div class="lp-group-admin-block-header">
                <h5>Участники</h5>
                <button class="lp-btn lp-btn--xs lp-btn--ghost" data-action="add-player">
                  + Добавить
                </button>
              </div>
              ${
                groupPlayers.length === 0
                  ? `
                <div class="lp-empty-state lp-empty-state--sm">
                  <p class="lp-card-text">
                    Участников нет. Добавьте участников из общего списка.
                  </p>
                </div>
              `
                  : `
                <div class="lp-chip-list lp-chip-list--group-players">
                  ${groupPlayers
                    .map((p) => {
                      const name = `${p.lastName || ""} ${
                        p.firstName || ""
                      }`.trim();
                      return `
                        <button class="lp-chip lp-chip--player" data-player-id="${
                          p.id
                        }">
                          <span class="lp-chip-label">${name}</span>
                          <span class="lp-chip-remove">×</span>
                        </button>
                      `;
                    })
                    .join("")}
                </div>
              `
              }
            </div>
          </div>

          <div class="lp-group-admin-column">
            <div class="lp-group-admin-block">
              <div class="lp-group-admin-block-header">
                <h5>Матчи</h5>
                <div class="lp-group-admin-block-actions">
                  <button class="lp-btn lp-btn--xs lp-btn--secondary" data-action="auto-matches">
                    Сгенерировать матчи
                  </button>
                  <button class="lp-btn lp-btn--xs lp-btn--ghost" data-action="clear-matches">
                    Очистить
                  </button>
                </div>
              </div>
              ${
                (group.matches || []).length === 0
                  ? `
                <div class="lp-empty-state lp-empty-state--sm">
                  <p class="lp-card-text">
                    Матчи отсутствуют. Нажмите "Сгенерировать матчи", чтобы создать круговой турнир.
                  </p>
                </div>
              `
                  : `
                <div class="lp-group-matches-admin-list">
                  ${(group.matches || [])
                    .map((match) => {
                      const p1 =
                        players.find((p) => p.id === match.player1Id) || null;
                      const p2 =
                        players.find((p) => p.id === match.player2Id) || null;
                      const p1Name = p1
                        ? `${p1.lastName || ""} ${
                            p1.firstName || ""
                          }`.trim()
                        : "—";
                      const p2Name = p2
                        ? `${p2.lastName || ""} ${
                            p2.firstName || ""
                          }`.trim()
                        : "—";

                      const score1 =
                        typeof match.score1 === "number" ? match.score1 : "";
                      const score2 =
                        typeof match.score2 === "number" ? match.score2 : "";

                      return `
                        <div class="lp-group-match-admin-row" data-match-id="${
                          match.id
                        }">
                          <div class="lp-group-match-admin-players">
                            <span>${p1Name}</span>
                            <span class="lp-group-match-admin-vs">vs</span>
                            <span>${p2Name}</span>
                          </div>
                          <div class="lp-group-match-admin-score">
                            <input
                              type="number"
                              class="lp-input lp-input--xs lp-input--score"
                              data-field="score1"
                              value="${score1}"
                              min="0"
                            />
                            <span>:</span>
                            <input
                              type="number"
                              class="lp-input lp-input--xs lp-input--score"
                              data-field="score2"
                              value="${score2}"
                              min="0"
                            />
                            <button class="lp-btn lp-btn--xs lp-btn--ghost" data-action="save-score">
                              ✓
                            </button>
                          </div>
                        </div>
                      `;
                    })
                    .join("")}
                </div>
              `
              }
            </div>
          </div>
        </div>
      `;

      groupsContainer.appendChild(groupEl);
    });

  card
    .querySelector("#admin-groups-auto")
    .addEventListener("click", () =>
      handleAutoDistributeGroups(tournament.id)
    );

  card
    .querySelector("#admin-groups-clear")
    .addEventListener("click", () =>
      handleClearGroups(tournament.id)
    );

  card.querySelectorAll(".lp-group-admin-card").forEach((groupEl) => {
    const groupId = groupEl.dataset.groupId;

    groupEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      const action = btn.dataset.action;

      if (action === "rename-group") {
        const newName = prompt("Введите название группы:");
        if (newName !== null) {
          handleRenameGroup(tournament.id, groupId, newName.trim());
        }
      } else if (action === "delete-group") {
        handleDeleteGroup(tournament.id, groupId);
      } else if (action === "add-player") {
        handleAddPlayerToGroup(tournament.id, groupId);
      } else if (action === "auto-matches") {
        handleAutoGenerateGroupMatches(tournament.id, groupId);
      } else if (action === "clear-matches") {
        handleClearGroupMatches(tournament.id, groupId);
      }
    });

    groupEl.querySelectorAll(".lp-chip--player").forEach((chip) => {
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!e.target.classList.contains("lp-chip-remove")) return;
        const playerId = chip.dataset.playerId;
        handleRemovePlayerFromGroup(tournament.id, groupId, playerId);
      });
    });

    groupEl
      .querySelectorAll(".lp-group-match-admin-row")
      .forEach((matchRow) => {
        const matchId = matchRow.dataset.matchId;
        const saveBtn = matchRow.querySelector(
          'button[data-action="save-score"]'
        );
        if (!saveBtn) return;
        saveBtn.addEventListener("click", () => {
          const input1 = matchRow.querySelector(
            'input[data-field="score1"]'
          );
          const input2 = matchRow.querySelector(
            'input[data-field="score2"]'
          );
          const s1 = input1.value.trim();
          const s2 = input2.value.trim();
          handleSaveGroupMatchScore(
            tournament.id,
            groupId,
            matchId,
            s1,
            s2
          );
        });
      });
  });

  return card;
}

function handleAutoDistributeGroups(tournamentId) {
  const tournament = getTournamentById(currentState, tournamentId);
  if (!tournament) return;

  const players = sortPlayersByName(tournament.players || []);
  if (players.length === 0) {
    alert("Нет участников для распределения.");
    return;
  }

  const groupCountStr = prompt(
    "На сколько групп разбить участников? (2-8):",
    "4"
  );
  if (groupCountStr === null) return;
  const groupCount = parseInt(groupCountStr, 10);
  if (!groupCount || groupCount < 2 || groupCount > 8) {
    alert("Некорректное количество групп.");
    return;
  }

  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t) return;

    const playerIds = sortPlayersByName(t.players || []).map((p) => p.id);

    t.groups = [];
    for (let i = 0; i < groupCount; i++) {
      const name = String.fromCharCode(65 + i);
      t.groups.push({
        id: generateId("g"),
        name,
        playerIds: [],
        matches: [],
      });
    }

    playerIds.forEach((playerId, index) => {
      const groupIndex = index % groupCount;
      t.groups[groupIndex].playerIds.push(playerId);
    });

    if (!Array.isArray(t.history)) t.history = [];
    t.history.push({
      id: generateId("h"),
      type: "groups",
      timestamp: Date.now(),
      title: "Авто-распределение по группам",
      description: `Участники автоматически распределены на ${groupCount} групп(ы).`,
    });
  });
}

function handleClearGroups(tournamentId) {
  if (
    !confirm(
      "Вы действительно хотите очистить все группы и матчи? Это действие нельзя отменить."
    )
  ) {
    return;
  }

  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t) return;

    t.groups = [];

    if (!Array.isArray(t.history)) t.history = [];
    t.history.push({
      id: generateId("h"),
      type: "groups",
      timestamp: Date.now(),
      title: "Группы очищены",
      description: "Все группы и матчи в них удалены.",
    });
  });
}

function handleRenameGroup(tournamentId, groupId, newName) {
  if (!newName) return;
  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t) return;
    const g = (t.groups || []).find((x) => x.id === groupId);
    if (!g) return;
    g.name = newName;

    if (!Array.isArray(t.history)) t.history = [];
    t.history.push({
      id: generateId("h"),
      type: "groups",
      timestamp: Date.now(),
      title: "Изменено название группы",
      description: `Группа переименована в "${newName}".`,
    });
  });
}

function handleDeleteGroup(tournamentId, groupId) {
  if (!confirm("Удалить эту группу?")) return;

  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t) return;
    t.groups = (t.groups || []).filter((g) => g.id !== groupId);

    if (!Array.isArray(t.history)) t.history = [];
    t.history.push({
      id: generateId("h"),
      type: "groups",
      timestamp: Date.now(),
      title: "Удалена группа",
      description: "Одна из групп была удалена.",
    });
  });
}

function handleAddPlayerToGroup(tournamentId, groupId) {
  const tournament = getTournamentById(currentState, tournamentId);
  if (!tournament) return;

  const allPlayers = sortPlayersByName(tournament.players || []);
  if (!allPlayers.length) {
    alert("Нет участников для добавления.");
    return;
  }

  const group = (tournament.groups || []).find((g) => g.id === groupId);
  if (!group) return;

  const existingIds = new Set(group.playerIds || []);
  const available = allPlayers.filter((p) => !existingIds.has(p.id));
  if (!available.length) {
    alert("Все участники уже добавлены в эту группу.");
    return;
  }

  const list = available
    .map((p, i) => {
      const name = `${p.lastName || ""} ${p.firstName || ""}`.trim();
      return `${i + 1}. ${name}`;
    })
    .join("\n");
  const indexStr = prompt(
    "Выберите номер участника для добавления:\n" + list,
    "1"
  );
  if (indexStr === null) return;

  const index = parseInt(indexStr, 10) - 1;
  if (index < 0 || index >= available.length) {
    alert("Некорректный номер.");
    return;
  }

  const playerId = available[index].id;

  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t) return;
    const g = (t.groups || []).find((x) => x.id === groupId);
    if (!g) return;
    if (!Array.isArray(g.playerIds)) g.playerIds = [];
    if (!g.playerIds.includes(playerId)) {
      g.playerIds.push(playerId);
    }

    if (!Array.isArray(t.history)) t.history = [];
    t.history.push({
      id: generateId("h"),
      type: "groups",
      timestamp: Date.now(),
      title: "Добавлен участник в группу",
      description: "В одну из групп добавлен новый участник.",
    });
  });
}

function handleRemovePlayerFromGroup(tournamentId, groupId, playerId) {
  if (!confirm("Удалить участника из группы?")) return;
  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t) return;
    const g = (t.groups || []).find((x) => x.id === groupId);
    if (!g) return;

    g.playerIds = (g.playerIds || []).filter((id) => id !== playerId);
    g.matches = (g.matches || []).filter(
      (m) => m.player1Id !== playerId && m.player2Id !== playerId
    );

    if (!Array.isArray(t.history)) t.history = [];
    t.history.push({
      id: generateId("h"),
      type: "groups",
      timestamp: Date.now(),
      title: "Удалён участник из группы",
      description: "Из одной из групп удалён участник.",
    });
  });
}

function handleAutoGenerateGroupMatches(tournamentId, groupId) {
  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t) return;
    const g = (t.groups || []).find((x) => x.id === groupId);
    if (!g) return;

    const playerIds = (g.playerIds || []).slice();
    if (playerIds.length < 2) {
      alert("Недостаточно участников для создания матчей.");
      return;
    }

    const matches = [];
    for (let i = 0; i < playerIds.length; i++) {
      for (let j = i + 1; j < playerIds.length; j++) {
        matches.push({
          id: generateId("gm"),
          player1Id: playerIds[i],
          player2Id: playerIds[j],
          score1: null,
          score2: null,
        });
      }
    }

    g.matches = matches;

    if (!Array.isArray(t.history)) t.history = [];
    t.history.push({
      id: generateId("h"),
      type: "groups",
      timestamp: Date.now(),
      title: "Сгенерированы матчи группы",
      description: `Для группы ${g.name || ""} сгенерирован круговой турнир.`,
    });
  });
}

function handleClearGroupMatches(tournamentId, groupId) {
  if (!confirm("Очистить все матчи в этой группе?")) return;

  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t) return;
    const g = (t.groups || []).find((x) => x.id === groupId);
    if (!g) return;

    g.matches = [];

    if (!Array.isArray(t.history)) t.history = [];
    t.history.push({
      id: generateId("h"),
      type: "groups",
      timestamp: Date.now(),
      title: "Очистка матчей группы",
      description: `Все матчи в группе ${g.name || ""} были удалены.`,
    });
  });
}

function handleSaveGroupMatchScore(
  tournamentId,
  groupId,
  matchId,
  score1Str,
  score2Str
) {
  const s1 = score1Str === "" ? null : Number(score1Str);
  const s2 = score2Str === "" ? null : Number(score2Str);

  if (
    s1 !== null &&
    s2 !== null &&
    (Number.isNaN(s1) || Number.isNaN(s2))
  ) {
    alert("Некорректные значения счёта.");
    return;
  }

  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t) return;
    const g = (t.groups || []).find((x) => x.id === groupId);
    if (!g) return;
    const match = (g.matches || []).find((m) => m.id === matchId);
    if (!match) return;

    match.score1 = s1;
    match.score2 = s2;

    if (!Array.isArray(t.history)) t.history = [];
    t.history.push({
      id: generateId("h"),
      type: "groups",
      timestamp: Date.now(),
      title: "Обновлён результат матча в группе",
      description: "Был изменён счёт одного из матчей группового этапа.",
    });
  });
}

function renderAdminPlayoffs(tournament) {
  const card = document.createElement("section");
  card.className = "lp-card";

  card.innerHTML = `
    <div class="lp-card-header lp-card-header--with-actions">
      <div>
        <h3 class="lp-card-title-sm">Плей-офф</h3>
        <p class="lp-card-text lp-text-muted">
          Формирование сеток Кубка Мастеров и Кубка Вызова, а также запись результатов.
        </p>
      </div>
      <div class="lp-card-header-actions">
        <button class="lp-btn lp-btn--secondary" id="admin-playoffs-auto">
          Авто-сетка
        </button>
        <button class="lp-btn lp-btn--ghost" id="admin-playoffs-clear">
          Очистить плей-офф
        </button>
      </div>
    </div>
    <div class="lp-playoffs-admin-grid">
      <div class="lp-playoffs-admin-column" data-bracket="masters"></div>
      <div class="lp-playoffs-admin-column" data-bracket="challenge"></div>
    </div>
  `;

  card
    .querySelector("#admin-playoffs-auto")
    .addEventListener("click", () =>
      handleAutoCreatePlayoffs(tournament.id)
    );

  card
    .querySelector("#admin-playoffs-clear")
    .addEventListener("click", () =>
      handleClearPlayoffs(tournament.id)
    );

  const mastersCol = card.querySelector(
    '.lp-playoffs-admin-column[data-bracket="masters"]'
  );
  const challengeCol = card.querySelector(
    '.lp-playoffs-admin-column[data-bracket="challenge"]'
  );

  mastersCol.appendChild(
    renderAdminBracket(tournament, "masters")
  );
  challengeCol.appendChild(
    renderAdminBracket(tournament, "challenge")
  );

  return card;
}

function renderAdminBracket(tournament, bracketType) {
  const bracket =
    bracketType === "masters"
      ? tournament.playoffs?.mastersBracket
      : tournament.playoffs?.challengeBracket;

  const bracketTitle =
    bracketType === "masters"
      ? "Кубок Мастеров"
      : "Кубок Вызова";

  const wrapper = document.createElement("div");
  wrapper.className = "lp-bracket-admin-wrapper";
  wrapper.dataset.bracketType = bracketType;

  const header = document.createElement("div");
  header.className = "lp-bracket-admin-header";
  header.innerHTML = `
    <h4 class="lp-card-title-xs">${bracketTitle}</h4>
    <p class="lp-card-text lp-text-muted">
      Редактируйте сетку: назначайте участников и редактируйте результаты матчей.
    </p>
  `;
  wrapper.appendChild(header);

  if (
    !bracket ||
    !Array.isArray(bracket.rounds) ||
    bracket.rounds.length === 0
  ) {
    const emptyState = document.createElement("div");
    emptyState.className = "lp-empty-state lp-empty-state--sm";
    emptyState.innerHTML = `
      <p class="lp-card-text">
        Сетка пока не создана. Нажмите "Авто-сетка" или создайте сетку вручную
        в коде/структуре турнира.
      </p>
    `;
    wrapper.appendChild(emptyState);
    return wrapper;
  }

  const roundsRow = document.createElement("div");
  roundsRow.className = "lp-bracket-admin-rounds";

  const players = sortPlayersByName(tournament.players || []);
  const bracketPlayers = (bracket.players || [])
    .map((id) => players.find((p) => p.id === id))
    .filter(Boolean);

  const playerOptions = bracketPlayers
    .map((p) => {
      const fullName = `${p.lastName || ""} ${
        p.firstName || ""
      }`.trim();
      return `<option value="${p.id}">${fullName}</option>`;
    })
    .join("");

  bracket.rounds.forEach((round) => {
    const roundEl = document.createElement("div");
    roundEl.className = "lp-bracket-admin-round";

    roundEl.innerHTML = `
      <div class="lp-bracket-admin-round-title">
        ${round.name || "Раунд"}
      </div>
      <div class="lp-bracket-admin-round-matches"></div>
    `;

    const matchesContainer = roundEl.querySelector(
      ".lp-bracket-admin-round-matches"
    );

    (round.matches || []).forEach((match) => {
      const matchEl = document.createElement("div");
      matchEl.className = "lp-bracket-admin-match";
      matchEl.dataset.matchId = match.id;

      const p1 =
        tournament.players.find((p) => p.id === match.player1Id) ||
        null;
      const p2 =
        tournament.players.find((p) => p.id === match.player2Id) ||
        null;

      const p1Score =
        typeof match.score1 === "number" ? match.score1 : "";
      const p2Score =
        typeof match.score2 === "number" ? match.score2 : "";

      const canEditPlayers = bracketPlayers.length > 0;

      matchEl.innerHTML = `
        <div class="lp-bracket-admin-match-row">
          <div class="lp-bracket-admin-player-select">
            ${
              canEditPlayers
                ? `
              <select class="lp-input lp-input--sm" data-slot="p1">
                <option value="">—</option>
                ${playerOptions}
              </select>
            `
                : `
              <div class="lp-bracket-admin-player-label">
                ${
                  p1
                    ? `${p1.lastName || ""} ${
                        p1.firstName || ""
                      }`.trim()
                    : "—"
                }
              </div>
            `
            }
          </div>
          <div class="lp-bracket-admin-score">
            <input
              type="number"
              class="lp-input lp-input--xs lp-input--score"
              data-field="score1"
              value="${p1Score}"
              min="0"
            />
            <span>:</span>
            <input
              type="number"
              class="lp-input lp-input--xs lp-input--score"
              data-field="score2"
              value="${p2Score}"
              min="0"
            />
            <button class="lp-btn lp-btn--xs lp-btn--ghost" data-action="save-score">
              ✓
            </button>
          </div>
          <div class="lp-bracket-admin-player-select">
            ${
              canEditPlayers
                ? `
              <select class="lp-input lp-input--sm" data-slot="p2">
                <option value="">—</option>
                ${playerOptions}
              </select>
            `
                : `
              <div class="lp-bracket-admin-player-label">
                ${
                  p2
                    ? `${p2.lastName || ""} ${
                        p2.firstName || ""
                      }`.trim()
                    : "—"
                }
              </div>
            `
            }
          </div>
        </div>
      `;

      if (canEditPlayers) {
        const selectP1 = matchEl.querySelector('select[data-slot="p1"]');
        const selectP2 = matchEl.querySelector('select[data-slot="p2"]');
        if (selectP1) {
          selectP1.value = match.player1Id || "";
          selectP1.addEventListener("change", () => {
            const playerId = selectP1.value || null;
            handleSetPlayoffPlayer(
              bracketType,
              match.id,
              "p1",
              playerId
            );
          });
        }
        if (selectP2) {
          selectP2.value = match.player2Id || "";
          selectP2.addEventListener("change", () => {
            const playerId = selectP2.value || null;
            handleSetPlayoffPlayer(
              bracketType,
              match.id,
              "p2",
              playerId
            );
          });
        }
      }

      const saveBtn = matchEl.querySelector(
        'button[data-action="save-score"]'
      );
      if (saveBtn) {
        saveBtn.addEventListener("click", () => {
          const input1 = matchEl.querySelector(
            'input[data-field="score1"]'
          );
          const input2 = matchEl.querySelector(
            'input[data-field="score2"]'
          );
          const s1 = input1.value.trim();
          const s2 = input2.value.trim();
          handleSavePlayoffMatch(
            tournament.id,
            bracketType,
            match.id,
            s1,
            s2
          );
        });
      }

      matchesContainer.appendChild(matchEl);
    });

    roundsRow.appendChild(roundEl);
  });

  wrapper.appendChild(roundsRow);
  return wrapper;
}

function handleAutoCreatePlayoffs(tournamentId) {
  const tournament = getTournamentById(currentState, tournamentId);
  if (!tournament) return;

  const groups = tournament.groups || [];
  if (!groups.length) {
    alert("Сначала сформируйте группы и результаты.");
    return;
  }

  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t) return;

    const ranking = [];

    (t.groups || []).forEach((group) => {
      const gPlayers = (group.playerIds || []).map((id) =>
        t.players.find((p) => p.id === id)
      );
      const stats = gPlayers.map((p) => ({
        playerId: p.id,
        points: 0,
        wins: 0,
        name: `${p.lastName || ""} ${p.firstName || ""}`.trim(),
      }));

      const statsById = {};
      stats.forEach((s) => {
        statsById[s.playerId] = s;
      });

      (group.matches || []).forEach((m) => {
        const s1 = m.score1;
        const s2 = m.score2;
        if (typeof s1 === "number" && typeof s2 === "number") {
          const ps1 = statsById[m.player1Id];
          const ps2 = statsById[m.player2Id];
          if (!ps1 || !ps2) return;

          if (s1 > s2) {
            ps1.points += 2;
            ps1.wins++;
            ps2.points += 1;
          } else if (s2 > s1) {
            ps2.points += 2;
            ps2.wins++;
            ps1.points += 1;
          } else {
            ps1.points += 1;
            ps2.points += 1;
          }
        }
      });

      stats.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.wins !== a.wins) return b.wins - a.wins;
        return a.name.localeCompare(b.name);
      });

      const best = stats[0];
      const second = stats[1];
      const others = stats.slice(2);

      if (best) ranking.push({ ...best, groupId: group.id, place: 1 });
      if (second) ranking.push({ ...second, groupId: group.id, place: 2 });
      others.forEach((o) => {
        ranking.push({ ...o, groupId: group.id, place: 3 });
      });
    });

    const mastersPlayers = ranking
      .filter((r) => r.place === 1 || r.place === 2)
      .map((r) => r.playerId);
    const challengePlayers = ranking
      .filter((r) => r.place >= 3)
      .map((r) => r.playerId);

    const createBracketForPlayers = (playerIds) => {
      if (playerIds.length < 2) return null;

      const sorted = [...playerIds];
      const fullSize = Math.pow(2, Math.ceil(Math.log2(sorted.length)));
      while (sorted.length < fullSize) {
        sorted.push(null);
      }

      const rounds = [];
      let currentRoundPlayers = sorted.slice();

      let roundIndex = 1;
      while (currentRoundPlayers.length >= 2) {
        const roundMatches = [];
        for (let i = 0; i < currentRoundPlayers.length; i += 2) {
          const p1 = currentRoundPlayers[i];
          const p2 = currentRoundPlayers[i + 1];
          roundMatches.push({
            id: generateId("pm"),
            player1Id: p1,
            player2Id: p2,
            score1: null,
            score2: null,
          });
        }
        rounds.push({
          id: generateId("pr"),
          name: roundIndex === 1 ? "1/4 финала" : "Следующий раунд",
          matches: roundMatches,
        });

        currentRoundPlayers = new Array(Math.ceil(roundMatches.length / 2)).fill(
          null
        );
        roundIndex++;
      }

      return {
        id: generateId("br"),
        players: playerIds,
        rounds,
      };
    };

    const mastersBracket = createBracketForPlayers(mastersPlayers);
    const challengeBracket = createBracketForPlayers(challengePlayers);

    t.playoffs = t.playoffs || {};
    t.playoffs.mastersBracket = mastersBracket;
    t.playoffs.challengeBracket = challengeBracket;

    if (!Array.isArray(t.history)) t.history = [];
    t.history.push({
      id: generateId("h"),
      type: "playoff",
      timestamp: Date.now(),
      title: "Сформированы сетки плей-офф",
      description:
        "Автоматически созданы сетки Кубка Мастеров и Кубка Вызова по итогам группового этапа.",
    });
  });
}

function handleClearPlayoffs(tournamentId) {
  if (
    !confirm(
      "Очистить все сетки плей-офф?\nВсе результаты и пары будут удалены."
    )
  ) {
    return;
  }

  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t) return;
    t.playoffs = {
      mastersBracket: null,
      challengeBracket: null,
    };

    if (!Array.isArray(t.history)) t.history = [];
    t.history.push({
      id: generateId("h"),
      type: "playoff",
      timestamp: Date.now(),
      title: "Плей-офф очищен",
      description: "Все сетки плей-офф были сброшены.",
    });
  });
}

function getWinnerLoser(score1, score2, player1Id, player2Id) {
  if (
    typeof score1 !== "number" ||
    typeof score2 !== "number" ||
    player1Id == null ||
    player2Id == null
  ) {
    return null;
  }
  if (score1 === score2) {
    return null;
  }
  if (score1 > score2) {
    return { winnerId: player1Id, loserId: player2Id };
  } else {
    return { winnerId: player2Id, loserId: player1Id };
  }
}

function applyPlayoffResultToBracket(bracket, match, winnerId, loserId) {
  if (!bracket || !Array.isArray(bracket.rounds)) return;

  for (let i = 0; i < bracket.rounds.length; i++) {
    const round = bracket.rounds[i];
    const matchIndex = (round.matches || []).findIndex(
      (m) => m.id === match.id
    );
    if (matchIndex === -1) continue;

    const nextRound = bracket.rounds[i + 1];
    if (!nextRound) return;

    const targetMatchIndex = Math.floor(matchIndex / 2);
    const targetMatch = nextRound.matches[targetMatchIndex];
    if (!targetMatch) return;

    const isFirstOfPair = matchIndex % 2 === 0;

    if (isFirstOfPair) {
      targetMatch.player1Id = winnerId;
    } else {
      targetMatch.player2Id = winnerId;
    }

    if (loserId === targetMatch.player1Id) {
      targetMatch.player1Id = null;
    }
    if (loserId === targetMatch.player2Id) {
      targetMatch.player2Id = null;
    }

    return;
  }
}

function handleSavePlayoffMatch(
  tournamentId,
  bracketType,
  matchId,
  score1Str,
  score2Str
) {
  const s1 = score1Str === "" ? null : Number(score1Str);
  const s2 = score2Str === "" ? null : Number(score2Str);

  if (
    s1 !== null &&
    s2 !== null &&
    (Number.isNaN(s1) || Number.isNaN(s2))
  ) {
    alert("Некорректные значения счёта.");
    return;
  }

  updateState((state) => {
    const t = getTournamentById(state, tournamentId);
    if (!t || !t.playoffs) return;

    const b =
      bracketType === "masters"
        ? t.playoffs.mastersBracket
        : t.playoffs.challengeBracket;
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

    foundMatch.score1 = s1;
    foundMatch.score2 = s2;

    const res = getWinnerLoser(
      foundMatch.score1,
      foundMatch.score2,
      foundMatch.player1Id,
      foundMatch.player2Id
    );
    if (!res) return;

    // Автоматическое продвижение победителей по сетке отключено.

    const p1 =
      t.players.find((p) => p.id === foundMatch.player1Id) || null;
    const p2 =
      t.players.find((p) => p.id === foundMatch.player2Id) || null;

    const p1Name = p1
      ? `${p1.lastName || ""} ${p1.firstName || ""}`.trim()
      : "—";
    const p2Name = p2
      ? `${p2.lastName || ""} ${p2.firstName || ""}`.trim()
      : "—";

    if (!Array.isArray(t.history)) t.history = [];
    const description = `Результат матча плей-офф (${
      bracketType === "masters" ? "Кубок Мастеров" : "Кубок Вызова"
    }): ${p1Name} ${s1 ?? "—"} : ${s2 ?? "—"} ${p2Name}`;

    const existing = t.history.find(
      (h) =>
        h.type === "playoff" &&
        h.matchId === matchId &&
        h.bracketType === bracketType
    );

    if (existing) {
      existing.timestamp = Date.now();
      existing.description = description;
    } else {
      t.history.unshift({
        id: generateId("h"),
        type: "playoff",
        bracketType,
        matchId,
        timestamp: Date.now(),
        title: "Обновлён результат матча плей-офф",
        description,
      });
    }
  });
}

function handleCreateTournament() {
  const name = prompt("Название турнира:", "Турнир по настольному теннису");
  if (name === null) return;
  const loc = prompt("Место проведения:", "Саратов");
  if (loc === null) return;
  const startDateStr = prompt(
    "Дата начала (ГГГГ-ММ-ДД), можно оставить пустым:",
    ""
  );

  let startDate = null;
  if (startDateStr && startDateStr.trim()) {
    const d = new Date(startDateStr.trim());
    if (!Number.isNaN(d.getTime())) {
      startDate = d.getTime();
    }
  }

  updateState((state) => {
    const newTournament = {
      id: generateId("t"),
      name: name.trim(),
      location: loc.trim(),
      startDate,
      isRegistrationOpen: true,
      players: [],
      groups: [],
      playoffs: {
        mastersBracket: null,
        challengeBracket: null,
      },
      history: [],
      createdAt: Date.now(),
    };

    if (!Array.isArray(state.tournaments)) {
      state.tournaments = [];
    }
    state.tournaments.push(newTournament);
    state.activeTournamentId = newTournament.id;
    adminEditingTournamentId = newTournament.id;

    if (!Array.isArray(newTournament.history)) newTournament.history = [];
    newTournament.history.push({
      id: generateId("h"),
      type: "event",
      timestamp: Date.now(),
      title: "Создан турнир",
      description: `Создан новый турнир "${newTournament.name}".`,
    });
  });
}

function renderAdminHistory(tournament) {
  const card = document.createElement("section");
  card.className = "lp-card lp-card--history-admin";

  const history = (tournament.history || [])
    .slice()
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  card.innerHTML = `
    <div class="lp-card-header">
      <div>
        <h3 class="lp-card-title-sm">История событий (админ)</h3>
        <p class="lp-card-text lp-text-muted">
          Хронология изменений: добавление участников, распределение по группам,
          создание и изменение сеток плей-офф.
        </p>
      </div>
    </div>
    <div class="lp-history-list lp-history-list--admin"></div>
  `;

  const listEl = card.querySelector(".lp-history-list");

  if (!history.length) {
    listEl.innerHTML = `
      <div class="lp-empty-state">
        <p class="lp-card-text">
          История пока пустая. События появятся после действий в админ-панели.
        </p>
      </div>
    `;
    return card;
  }

  history.forEach((entry) => {
    const item = document.createElement("article");
    item.className = "lp-history-item";

    const ts = entry.timestamp ? formatDateTime(new Date(entry.timestamp)) : "";
    let typeLabel = "";
    let typeClass = "";

    switch (entry.type) {
      case "registration":
        typeLabel = "Регистрация";
        typeClass = "lp-history-badge--registration";
        break;
      case "groups":
        typeLabel = "Группы";
        typeClass = "lp-history-badge--groups";
        break;
      case "playoff":
        typeLabel = "Плей-офф";
        typeClass = "lp-history-badge--playoff";
        break;
      default:
        typeLabel = "Событие";
        typeClass = "lp-history-badge--default";
    }

    item.innerHTML = `
      <div class="lp-history-item-header">
        <span class="lp-history-badge ${typeClass}">${typeLabel}</span>
        <span class="lp-history-timestamp">${ts}</span>
      </div>
      <h4 class="lp-history-title">${entry.title || "Событие"}</h4>
      <p class="lp-history-description">${entry.description || ""}</p>
    `;

    listEl.appendChild(item);
  });

  return card;
}

function handleSetPlayoffPlayer(bracketType, matchId, slot, playerId) {
  if (!adminEditingTournamentId) return;

  updateState((state) => {
    const tour = getTournamentById(state, adminEditingTournamentId);
    if (!tour) return;
    const b =
      bracketType === "masters"
        ? tour.playoffs.mastersBracket
        : tour.playoffs.challengeBracket;
    if (!b || !b.rounds) return;

    let foundMatch = null;
    for (const round of b.rounds) {
      const m = (round.matches || []).find((x) => x.id === matchId);
      if (m) {
        foundMatch = m;
        break;
      }
    }
    if (!foundMatch) return;

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

let isInitDone = false;

async function init() {
  if (isInitDone) return;
  isInitDone = true;

  publicRootEl = document.getElementById("public-root");
  adminRootEl = document.getElementById("admin-root");

  try {
    const initialState = await loadStateFromCloud();
    currentState = structuredCloneSafe(initialState);
    window.__TOURNAMENT_STATE__ = currentState;
    isInitialLoadDone = true;

    renderPublicPage();
    renderAdminPage();
  } catch (e) {
    console.error("Ошибка при начальной загрузке:", e);
  }

  subscribeToState((remoteState) => {
    if (isSaving) return;

    currentState = structuredCloneSafe(remoteState);
    window.__TOURNAMENT_STATE__ = currentState;

    renderPublicPage();
    renderAdminPage();
  });

  const pageType = document.body.dataset.page;
  if (pageType === "admin") {
    try {
      const historiesRef = collection(db, "matchHistories");
      const q = query(historiesRef, orderBy("timestamp", "desc"));

      onSnapshot(
        q,
        (snapshot) => {
          console.log("Real-time histories snapshot:", snapshot.size);
        },
        (error) => {
          console.error("Error in histories snapshot:", error);
        }
      );
    } catch (e) {
      console.error("Error setting up histories listener:", e);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => console.error(e));
});
