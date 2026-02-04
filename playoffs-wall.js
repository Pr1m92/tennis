// playoffs-wall.js
// «Арена» плей-офф: Кубок мастеров / Кубок вызова. Экспорт в PNG.
//
// URL параметры:
//   cup=masters|challenge|both (по умолчанию both)
//   zoom=0.7..1.8
//   pngScale=2..5
//
// Hotkeys:
//   1 — masters, 2 — challenge, 0 — оба
//   + / - — zoom
//   P — export PNG

import { subscribeToState, EMPTY_STATE } from "./firebase.js";

const exportBtn = document.getElementById("export-png");
const loadingEl = document.querySelector(".po-loading");
const cupsRoot = document.getElementById("cups-root");
const subtitleEl = document.getElementById("po-subtitle");
const switchButtons = Array.from(document.querySelectorAll(".po-switch-btn"));

const params = new URLSearchParams(location.search);
let lastRemoteState = null;

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeState(state) {
  const s = state && typeof state === "object" ? state : {};
  return {
    ...structuredClone(EMPTY_STATE),
    ...s,
    tournaments: Array.isArray(s.tournaments) ? s.tournaments : [],
    activeTournamentId:
      typeof s.activeTournamentId === "string" ? s.activeTournamentId : null,
  };
}

function getActiveTournament(state) {
  const id = state.activeTournamentId;
  if (!id) return null;
  return (state.tournaments || []).find((t) => t.id === id) || null;
}

function isValidScore(a, b) {
  return Number.isFinite(a) && Number.isFinite(b);
}

function getWinnerLoser(score1, score2, player1Id, player2Id) {
  const a = Number(score1);
  const b = Number(score2);
  if (!isValidScore(a, b)) return null;
  if (a > b) return { winnerId: player1Id, loserId: player2Id };
  return { winnerId: player2Id, loserId: player1Id };
}

function getPlayerName(playersMap, id) {
  const p = playersMap.get(id);
  if (!p) return "—";
  const full = `${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}`.trim();
  return full || "—";
}

function extractWinnersFromBracket(bracket) {
  if (!bracket || !Array.isArray(bracket.rounds) || !bracket.rounds.length) {
    return { gold: null, silver: null, bronze: null };
  }

  const finalRound = bracket.rounds.find((r) => r.name === "Финал");
  const thirdRound = bracket.rounds.find((r) => r.name === "Матч за 3-е место");

  let gold = null;
  let silver = null;
  let bronze = null;

  if (finalRound && finalRound.matches && finalRound.matches[0]) {
    const m = finalRound.matches[0];
    if (isValidScore(m.score1, m.score2)) {
      const res = getWinnerLoser(m.score1, m.score2, m.player1Id, m.player2Id);
      if (res) {
        gold = res.winnerId;
        silver = res.loserId;
      }
    }
  }

  if (thirdRound && thirdRound.matches && thirdRound.matches[0]) {
    const m = thirdRound.matches[0];
    if (isValidScore(m.score1, m.score2)) {
      const res = getWinnerLoser(m.score1, m.score2, m.player1Id, m.player2Id);
      if (res) bronze = res.winnerId;
    }
  }

  return { gold, silver, bronze };
}

// --------------------
// URL / Hotkeys
// --------------------
function setParam(key, value) {
  if (value == null) params.delete(key);
  else params.set(key, String(value));
  const url = `${location.pathname}?${params.toString()}`;
  history.replaceState(null, "", url);
  applyFromUrl();
  if (lastRemoteState) render(lastRemoteState);
}

function applyFromUrl() {
  const zoom = Math.max(
    0.7,
    Math.min(1.8, parseFloat(params.get("zoom") || "1") || 1)
  );
  document.documentElement.style.setProperty("--po-zoom", String(zoom));

  const cup = (params.get("cup") || "both").toLowerCase();
  document.body.dataset.cup = cup;

  // sync switch UI
  for (const b of switchButtons) {
    const isActive = (b.dataset.cup || "").toLowerCase() === cup;
    b.classList.toggle("is-active", isActive);
    b.setAttribute("aria-selected", isActive ? "true" : "false");
  }

  cupsRoot.dataset.mode = cup === "both" ? "both" : "single";

  // subtitle
  if (subtitleEl) {
    subtitleEl.textContent =
      cup === "masters"
        ? "Кубок мастеров — арена"
        : cup === "challenge"
        ? "Кубок вызова — арена"
        : "Арена результатов";
  }
}

applyFromUrl();

// Switch click
for (const b of switchButtons) {
  b.addEventListener("click", () => {
    const cup = (b.dataset.cup || "both").toLowerCase();
    setParam("cup", cup);
  });
}

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();

  if (e.key === "1") setParam("cup", "masters");
  if (e.key === "2") setParam("cup", "challenge");
  if (e.key === "0") setParam("cup", "both");

  if (e.key === "+" || e.key === "=") {
    const cur = parseFloat(params.get("zoom") || "1") || 1;
    setParam("zoom", (cur + 0.05).toFixed(2));
  }
  if (e.key === "-" || e.key === "_") {
    const cur = parseFloat(params.get("zoom") || "1") || 1;
    setParam("zoom", (cur - 0.05).toFixed(2));
  }

  if (k === "p") exportPng();
});

// --------------------
// Export PNG
// --------------------
async function exportPng() {
  if (!window.html2canvas) {
    alert("Не загрузилась библиотека html2canvas. Проверь интернет/доступ к CDN.");
    return;
  }

  const wall = document.getElementById("po-root");
  const toolbar = document.querySelector(".po-toolbar");
  const cup = (params.get("cup") || "both").toLowerCase();

  try {
    if (toolbar) toolbar.style.visibility = "hidden";
    await new Promise((r) => requestAnimationFrame(r));

    const scale = Math.max(
      2,
      Math.min(5, parseFloat(params.get("pngScale") || "3") || 3)
    );

    const canvas = await window.html2canvas(wall, {
      scale,
      useCORS: true,
      backgroundColor: "#050505",
      removeContainer: true,
    });

    const dataUrl = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.download = `playoffs-${cup}-${ts}.png`;
    a.href = dataUrl;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    console.error(err);
    alert("Не получилось экспортировать PNG. Открой консоль (F12) — там будет причина.");
  } finally {
    if (toolbar) toolbar.style.visibility = "";
  }
}

if (exportBtn) exportBtn.addEventListener("click", exportPng);

// --------------------
// Render
// --------------------
function render(stateRaw) {
  const state = normalizeState(stateRaw);
  const t = getActiveTournament(state);

  cupsRoot.innerHTML = "";

  if (!t) {
    loadingEl.style.display = "none";
    cupsRoot.innerHTML = `<div class="po-empty">Нет активного турнира</div>`;
    return;
  }

  const tournamentName = escapeHtml(t.name || "Турнир");
  const playersMap = new Map((t.players || []).map((p) => [p.id, p]));
  const po = t.playoffs || {};
  const masters = po.mastersBracket || null;
  const challenge = po.challengeBracket || null;

  const cupMode = (params.get("cup") || "both").toLowerCase();

  const showMasters = cupMode === "both" || cupMode === "masters";
  const showChallenge = cupMode === "both" || cupMode === "challenge";

  if (showMasters) {
    cupsRoot.appendChild(
      renderCup({
        bracket: masters,
        playersMap,
        cupKey: "masters",
        title: "Кубок мастеров",
        subtitle: tournamentName,
      })
    );
  }

  if (showChallenge) {
    cupsRoot.appendChild(
      renderCup({
        bracket: challenge,
        playersMap,
        cupKey: "challenge",
        title: "Кубок вызова",
        subtitle: tournamentName,
      })
    );
  }

  loadingEl.style.display = "none";
}

function renderCup({ bracket, playersMap, cupKey, title, subtitle }) {
  const wrap = document.createElement("section");
  wrap.className = `po-cup po-cup--${cupKey}`;
  wrap.dataset.cup = cupKey;

  const header = document.createElement("div");
  header.className = "po-cup-header";
  header.innerHTML = `
    <div class="po-cup-title">${escapeHtml(title)}</div>
    <div class="po-cup-chip">${escapeHtml(subtitle)}</div>
  `;
  wrap.appendChild(header);

  const podiumWrap = document.createElement("div");
  podiumWrap.className = "po-podium-wrap";
  podiumWrap.appendChild(renderPodium(bracket, playersMap));
  wrap.appendChild(podiumWrap);

  const bracketWrap = document.createElement("div");
  bracketWrap.className = "po-bracket";
  bracketWrap.appendChild(renderBracket(bracket, playersMap));
  wrap.appendChild(bracketWrap);

  return wrap;
}

function renderPodium(bracket, playersMap) {
  const winners = extractWinnersFromBracket(bracket);
  const goldName = winners.gold ? getPlayerName(playersMap, winners.gold) : "—";
  const silverName = winners.silver ? getPlayerName(playersMap, winners.silver) : "—";
  const bronzeName = winners.bronze ? getPlayerName(playersMap, winners.bronze) : "—";

  const box = document.createElement("div");

  box.innerHTML = `
    <div class="po-podium">
      <div class="po-stand po-stand--second">
        <div class="po-stand-rank">🥈 2</div>
        <div class="po-stand-name">${silverName}</div>
        <div class="po-stand-sub">${winners.silver ? "Финал" : "—"}</div>
      </div>

      <div class="po-stand po-stand--first">
        <div class="po-stand-rank">🥇 1</div>
        <div class="po-stand-name">${goldName}</div>
        <div class="po-stand-sub">${winners.gold ? "Чемпион" : "—"}</div>
      </div>

      <div class="po-stand po-stand--third">
        <div class="po-stand-rank">🥉 3</div>
        <div class="po-stand-name">${bronzeName}</div>
        <div class="po-stand-sub">${winners.bronze ? "Матч за 3-е" : "—"}</div>
      </div>
    </div>

    <div class="po-podium-note">
      Подсказка: для отдельной картинки — открой <b>?cup=masters</b> или <b>?cup=challenge</b> и жми <b>PNG</b>.
    </div>
  `;
  return box;
}

function renderBracket(bracket, playersMap) {
  if (!bracket || !Array.isArray(bracket.rounds) || bracket.rounds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "po-empty";
    empty.textContent = "Сетка ещё не сформирована или участников мало.";
    return empty;
  }

  const rounds = [...bracket.rounds];

  const third = rounds.find((r) => r.name === "Матч за 3-е место") || null;

  const mainRounds = rounds
    .filter((r) => r.name !== "Матч за 3-е место")
    .sort((a, b) => (a.roundIndex ?? 999) - (b.roundIndex ?? 999));

  const firstMainRound = mainRounds[0] || null;

  // колонки: основные + матч за 3-е место в конце (если есть)
  const columns = [...mainRounds];
  if (third) columns.push(third);

  const grid = document.createElement("div");
  grid.className = "po-bracket-grid";
  grid.style.gridTemplateColumns = `repeat(${columns.length}, minmax(220px, 1fr))`;

  for (const r of columns) {
    const col = document.createElement("div");
    col.className = "po-round";

    const isFirstRound = firstMainRound && r === firstMainRound;
    const matches = Array.isArray(r.matches) ? r.matches : [];

    // ВАЖНО: в 1 раунде показываем только полные пары
    const visibleMatches = isFirstRound
      ? matches.filter((m) => m?.player1Id && m?.player2Id)
      : matches;

    const total = visibleMatches.length;
    const played = visibleMatches.filter((m) => isValidScore(m?.score1, m?.score2)).length;

    col.innerHTML = `
      <div class="po-round-title">
        <b>${escapeHtml(r.name || "Раунд")}</b>
        <span>${total ? `Сыграно ${played}/${total}` : ""}</span>
      </div>
    `;

    if (visibleMatches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "po-empty";
      empty.textContent = isFirstRound
        ? "В этом раунде нет полных пар."
        : "Матчей нет";
      col.appendChild(empty);
      grid.appendChild(col);
      continue;
    }

    for (const m of visibleMatches) {
      col.appendChild(renderMatch(m, playersMap, isFirstRound));
    }

    grid.appendChild(col);
  }

  return grid;
}

function renderMatch(m, playersMap, isFirstRound) {
  const card = document.createElement("div");
  card.className = "po-match";

  const p1 = getPlayerName(playersMap, m.player1Id);
  const p2 = getPlayerName(playersMap, m.player2Id);

  const s1 = m?.score1;
  const s2 = m?.score2;
  const valid = isValidScore(s1, s2);

  let w1 = false;
  let w2 = false;
  if (valid && s1 !== s2) {
    w1 = s1 > s2;
    w2 = s2 > s1;
  }

  const p1Class = "po-player" + (w1 ? " po-player--winner" : "");
  const p2Class = "po-player" + (w2 ? " po-player--winner" : "");

  // В 1 раунде у нас не будет пустых слотов (мы их фильтруем),
  // но в остальных раундах BYE остаётся как индикатор.
  const tag1 = !m.player1Id ? (isFirstRound ? "" : "BYE") : "Игрок";
  const tag2 = !m.player2Id ? (isFirstRound ? "" : "BYE") : "Игрок";

  const scoreText = valid ? `${s1}:${s2}` : "— : —";
  const scoreClass = "po-score" + (valid ? "" : " po-score--empty");

  card.innerHTML = `
    <div class="${p1Class}">
      <div class="po-player-name">${p1}</div>
      <div class="po-player-tag">${escapeHtml(tag1 || "Игрок")}</div>
    </div>

    <div class="${p2Class}">
      <div class="po-player-name">${p2}</div>
      <div class="po-player-tag">${escapeHtml(tag2 || "Игрок")}</div>
    </div>

    <div class="${scoreClass}">${scoreText}</div>
  `;

  return card;
}

// start
loadingEl.style.display = "block";
subscribeToState((remoteState) => {
  lastRemoteState = remoteState;
  render(remoteState);
});
