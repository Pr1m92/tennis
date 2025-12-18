import { subscribeToState, EMPTY_STATE } from "./firebase.js";

const root = document.getElementById("groups-container");
const loading = document.querySelector(".loading");
const exportBtn = document.getElementById("export-png");

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
    activeTournamentId: typeof s.activeTournamentId === "string" ? s.activeTournamentId : null,
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
  return `${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}`.trim();
}

// --------------------
// URL / Hotkeys
// --------------------
const params = new URLSearchParams(location.search);

function applyWallSettingsFromUrl() {
  const cols = Math.max(1, Math.min(5, parseInt(params.get("cols") || "3", 10) || 3));
  document.body.classList.remove("wall-cols-1","wall-cols-2","wall-cols-3","wall-cols-4","wall-cols-5");
  document.body.classList.add(`wall-cols-${cols}`);

  const zoom = Math.max(0.7, Math.min(1.8, parseFloat(params.get("zoom") || "1") || 1));
  document.documentElement.style.setProperty("--wall-zoom", String(zoom));

  const matches = params.get("matches");
  document.body.classList.toggle("wall-hide-matches", matches === "0");
}

function setParam(key, value) {
  if (value == null) params.delete(key);
  else params.set(key, String(value));
  const url = `${location.pathname}?${params.toString()}`;
  history.replaceState(null, "", url);
  applyWallSettingsFromUrl();
}

applyWallSettingsFromUrl();

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();

  if (["1","2","3","4","5"].includes(e.key)) setParam("cols", e.key);
  if (e.key === "+" || e.key === "=") {
    const cur = parseFloat(params.get("zoom") || "1") || 1;
    setParam("zoom", (cur + 0.05).toFixed(2));
  }
  if (e.key === "-" || e.key === "_") {
    const cur = parseFloat(params.get("zoom") || "1") || 1;
    setParam("zoom", (cur - 0.05).toFixed(2));
  }
  if (k === "m") {
    const cur = params.get("matches");
    setParam("matches", cur === "0" ? "1" : "0");
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

  const wall = document.querySelector(".wall-root");
  const toolbar = document.querySelector(".wall-toolbar");

  try {
    if (toolbar) toolbar.style.visibility = "hidden";
    await new Promise((r) => requestAnimationFrame(r));

    const scale = Math.max(2, Math.min(5, parseFloat(params.get("pngScale") || "3") || 3));

    const canvas = await window.html2canvas(wall, {
      scale,
      useCORS: true,
      backgroundColor: "#050505",
      removeContainer: true
    });

    const dataUrl = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.download = `groups-wall-${ts}.png`;
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
// Legend
// --------------------

function ensureLegend() {
  let el = document.querySelector(".wall-legend");
  if (el) return el;

  el = document.createElement("section");
  el.className = "wall-legend";

  el.innerHTML = `
    <div class="wall-legend-title">
      <span>Правила и проход</span>
    </div>

    <div class="wall-legend-grid">
      <div class="wall-legend-box">
        <h4>Как считаются очки</h4>
        <ul>
          <li>Победа <b>2:0</b> — <b>3</b> очка победителю</li>
          <li>Победа <b>2:1</b> — <b>2</b> очка победителю, <b>1</b> очко проигравшему</li>
        </ul>
      </div>

      <div class="wall-legend-box">
        <h4>Плей-офф</h4>
        <ul>
          <li><b>1–2 место</b> группы → <span class="wall-pill wall-pill--masters">Кубок Мастеров</span></li>
          <li><b>Остальные</b> → <span class="wall-pill wall-pill--challenge">Кубок Вызова</span></li>
        </ul>
      </div>
    </div>
  `;

  const main = document.querySelector(".wall-root");
  main.appendChild(el);
  return el;
}


// --------------------
// Render
// --------------------
function render(stateRaw) {
  const state = normalizeState(stateRaw);
  const t = getActiveTournament(state);

  root.innerHTML = "";

  if (!t) {
    loading.style.display = "none";
    root.innerHTML = `<div class="wall-group"><div class="wall-group-title">Нет активного турнира</div></div>`;
    ensureLegend();
    return;
  }

  const playersMap = new Map((t.players || []).map((p) => [p.id, p]));
  const groups = Array.isArray(t.groups) ? t.groups : [];

  if (!groups.length) {
    loading.style.display = "none";
    root.innerHTML = `<div class="wall-group"><div class="wall-group-title">Группы ещё не сформированы</div></div>`;
    ensureLegend();
    return;
  }

  groups.forEach((g, idx) => {
    const standings = Array.isArray(g.standings) ? g.standings : [];
    const sorted = [...standings].sort((a, b) => {
      const pa = a?.points ?? 0;
      const pb = b?.points ?? 0;
      if (pb !== pa) return pb - pa;

      const da = (a?.setsFor ?? 0) - (a?.setsAgainst ?? 0);
      const db = (b?.setsFor ?? 0) - (b?.setsAgainst ?? 0);
      if (db !== da) return db - da;

      return String(a?.playerId || "").localeCompare(String(b?.playerId || ""));
    });

    root.appendChild(createGroupBlock(g, idx + 1, sorted, playersMap));
  });

  loading.style.display = "none";
  ensureLegend();
}

function createGroupBlock(group, humanIndex, stList, playersMap) {
  const wrap = document.createElement("div");
  wrap.className = "wall-group";

  const title = document.createElement("div");
  title.className = "wall-group-title";

  const left = document.createElement("span");
  left.textContent = group?.name ? `Группа ${group.name}` : `Группа ${humanIndex}`;

  const matchesAll = Array.isArray(group?.matches) ? group.matches : [];
  const showTiebreaks = params.get("tiebreaks") === "1";
  const matches = showTiebreaks ? matchesAll : matchesAll.filter((m) => !m?.isTiebreak);

  const total = matches.length;
  const played = matches.filter((m) => isValidScore(m?.score1, m?.score2)).length;
  const done = total > 0 && played === total;

  const rightWrap = document.createElement("span");
  rightWrap.className = "wall-title-right";

  const rightText = document.createElement("span");
  rightText.className = "wall-title-right-text";
  rightText.textContent = total ? `Сыграно ${played}/${total}` : "";

  const badge = document.createElement("span");
  badge.className = "wall-badge" + (done ? " wall-badge--done" : "");
  badge.textContent = done ? "ГОТОВО" : "В ПРОЦЕССЕ";

  rightWrap.append(rightText, badge);

  title.append(left, rightWrap);
  wrap.append(title);

  const prog = document.createElement("div");
  prog.className = "wall-progress" + (done ? " wall-progress--done" : "");
  const bar = document.createElement("span");
  bar.style.width = total ? `${Math.round((played / total) * 100)}%` : "0%";
  prog.appendChild(bar);
  wrap.appendChild(prog);

  const body = document.createElement("div");
  body.className = "wall-group-body";

  const standingsBox = document.createElement("div");
  standingsBox.className = "wall-standings";
  standingsBox.appendChild(createStandingsTable(stList, playersMap));

  const matchesBox = document.createElement("div");
  matchesBox.className = "wall-matches";
  matchesBox.appendChild(createMatchesList(matches, playersMap));

  body.append(standingsBox, matchesBox);
  wrap.appendChild(body);

  return wrap;
}

function createStandingsTable(stList, playersMap) {
  const table = document.createElement("table");
  table.className = "wall-table";

  const rowsHtml = stList.length
    ? stList.map((row, i) => {
        const name = getPlayerName(playersMap, row.playerId);
        const pts = row.points ?? 0;
        const trClass = i < 2 ? "wall-row--top" : "";
        return `
          <tr class="${trClass}">
            <td>${name}</td>
            <td class="wall-score">${pts}</td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="2" style="color:#999;padding:8px 6px;">Таблица пустая</td></tr>`;

  table.innerHTML = `
    <thead>
      <tr>
        <th>Имя</th>
        <th style="text-align:right;">Очки</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  `;

  return table;
}

function createMatchesList(matches, playersMap) {
  if (!matches || !matches.length) {
    const empty = document.createElement("div");
    empty.className = "wall-empty";
    empty.textContent = "Матчей нет";
    return empty;
  }

  const sorted = [...matches].sort((a, b) => {
    const ca = a?.createdAt ?? 0;
    const cb = b?.createdAt ?? 0;
    if (ca !== cb) return ca - cb;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });

  const list = document.createElement("div");
  list.className = "lp-matches-list";

  const frag = document.createDocumentFragment();

  for (const m of sorted) {
    const p1 = getPlayerName(playersMap, m.player1Id);
    const p2 = getPlayerName(playersMap, m.player2Id);

    const s1 = m?.score1;
    const s2 = m?.score2;
    const valid = isValidScore(s1, s2);

    let leftWinner = false;
    let rightWinner = false;
    if (valid && s1 !== s2) {
      leftWinner = s1 > s2;
      rightWinner = s2 > s1;
    }

    const a = document.createElement("div");
    a.className = "lp-match-player lp-match-player--left" + (leftWinner ? " lp-match-winner" : "");
    a.textContent = p1;

    const score = document.createElement("div");
    score.className = "lp-match-score" + (!valid ? " lp-text-muted" : "");
    score.textContent = valid ? `${s1}:${s2}` : "— : —";

    const b = document.createElement("div");
    b.className = "lp-match-player lp-match-player--right" + (rightWinner ? " lp-match-winner" : "");
    b.textContent = p2;

    frag.appendChild(a);
    frag.appendChild(score);
    frag.appendChild(b);
  }

  list.appendChild(frag);
  return list;
}

// start
loading.style.display = "block";
subscribeToState((remoteState) => render(remoteState));
