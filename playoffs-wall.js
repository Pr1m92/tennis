// playoffs-wall.js
// «Арена» плей-офф: Кубок мастеров / Кубок вызова. Экспорт в PNG.

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

function getPlayerName(playersMap, id) {
  const p = playersMap.get(id);
  if (!p) return "—";
  const full = `${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}`.trim();
  return full || "—";
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

  for (const b of switchButtons) {
    const isActive = (b.dataset.cup || "").toLowerCase() === cup;
    b.classList.toggle("is-active", isActive);
    b.setAttribute("aria-selected", isActive ? "true" : "false");
  }

  const mode = cup === "both" ? "both" : "single";
  cupsRoot.dataset.mode = mode;

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
// Export PNG (без большой шапки "Плей-офф")
// --------------------
async function exportPng() {
  if (!window.html2canvas) {
    alert("Не загрузилась библиотека html2canvas. Проверь интернет/доступ к CDN.");
    return;
  }

  const wall = document.getElementById("po-root");
  const toolbar = document.querySelector(".po-toolbar");
  const hero = document.querySelector(".po-hero");
  const stage = document.querySelector(".po-stage");
  const cup = (params.get("cup") || "both").toLowerCase();

  const heroDisplay = hero ? hero.style.display : "";
  const stageDisplay = stage ? stage.style.display : "";

  try {
    if (toolbar) toolbar.style.visibility = "hidden";
    if (hero) hero.style.display = "none";
    if (stage) stage.style.display = "none";

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
    if (hero) hero.style.display = heroDisplay;
    if (stage) stage.style.display = stageDisplay;
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

  // ✅ ПЬЕДЕСТАЛЫ УБРАЛИ (вообще не рендерим)

  const bracketWrap = document.createElement("div");
  bracketWrap.className = "po-bracket";
  bracketWrap.appendChild(renderBracket(bracket, playersMap, cupKey));
  wrap.appendChild(bracketWrap);

  return wrap;
}

function renderBracket(bracket, playersMap, cupKey) {
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

  const columns = [...mainRounds];
  if (third) columns.push(third);

  const grid = document.createElement("div");
  grid.className = "po-bracket-grid";

  for (const r of columns) {
    const col = document.createElement("div");
    col.className = "po-round";

    const rawMatches = Array.isArray(r.matches) ? r.matches : [];

    // ✅ Раунд 1: только полные пары
    const matches =
      r.name === "Раунд 1" || r.name === "Раунд 1 "
        ? rawMatches.filter((m) => m?.player1Id && m?.player2Id)
        : rawMatches;

    const total = matches.length;
    const played = matches.filter((m) => isValidScore(m?.score1, m?.score2)).length;

    col.innerHTML = `
      <div class="po-round-title">
        <b>${escapeHtml(r.name || "Раунд")}</b>
        <span>${total ? `Сыграно ${played}/${total}` : ""}</span>
      </div>
    `;

    const badge = document.createElement("div");
    badge.className = "po-round-badge";
    badge.textContent =
      r.name === "1/8 финала" ? "Матчи 1/8" :
      r.name === "1/4 финала" ? "Матчи 1/4" :
      r.name === "1/2 финала" ? "Матчи 1/2" :
      r.name === "Финал" ? "Матч 🏆" :
      r.name === "Матч за 3-е место" ? "Матч 🥉" :
      "Матчи";
    col.appendChild(badge);

    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "po-empty";
      empty.textContent = "Матчей нет";
      col.appendChild(empty);
      grid.appendChild(col);
      continue;
    }

    for (const m of matches) {
      col.appendChild(renderMatch(m, playersMap, cupKey));
    }

    grid.appendChild(col);
  }

  return grid;
}

function renderMatch(m, playersMap, cupKey) {
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

  const tag1 = !m.player1Id ? "—" : "Игрок";
  const tag2 = !m.player2Id ? "BYE" : "Игрок";

  const score1Text = valid ? String(s1) : "—";
  const score2Text = valid ? String(s2) : "—";
  const score1Class = "po-player-score" + (valid ? "" : " po-player-score--empty");
  const score2Class = "po-player-score" + (valid ? "" : " po-player-score--empty");

  card.innerHTML = `
    <div class="${p1Class}">
      <div class="po-player-left">
        <div class="po-player-name">${p1}</div>
        <div class="po-player-tag">${tag1}</div>
      </div>
      <div class="${score1Class}">${score1Text}</div>
    </div>

    <div class="${p2Class}">
      <div class="po-player-left">
        <div class="po-player-name">${p2}</div>
        <div class="po-player-tag">${tag2}</div>
      </div>
      <div class="${score2Class}">${score2Text}</div>
    </div>
  `;

  return card;
}

// start
loadingEl.style.display = "block";
subscribeToState((remoteState) => {
  lastRemoteState = remoteState;
  render(remoteState);
});
