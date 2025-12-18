// firebase.js
// Firestore: один документ состояния -> config/globalState
// Экспорты для tournament.js:
// - loadStateFromCloud
// - saveStateToCloud
// - subscribeToState
// - EMPTY_STATE
// + db

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// ==== ТВОЙ firebaseConfig (НОВЫЙ проект tennis-312ab) ====
const firebaseConfig = {
  apiKey: "AIzaSyBS4ftWIZQ0ETkmpZVA1I5UM3knRz3YOZs",
  authDomain: "tennis-312ab.firebaseapp.com",
  projectId: "tennis-312ab",
  storageBucket: "tennis-312ab.firebasestorage.app",
  messagingSenderId: "675391646244",
  appId: "1:675391646244:web:74e60327bb0bc97180c6b1",
  // measurementId нам не нужен для Firestore, можно не использовать
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
export { db };

// Документ, где лежит ВСЁ состояние сайта
const STATE_DOC = doc(db, "config", "globalState");

// Пустое состояние (если документа ещё нет)
export const EMPTY_STATE = {
  activeTournamentId: null,
  tournaments: [],
};

/** Нормализация: чтобы не было undefined/битых типов */
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

/**
 * Читает state из Firestore.
 * Если документа нет — вернёт EMPTY_STATE.
 */
export async function loadStateFromCloud() {
  try {
    const snap = await getDoc(STATE_DOC);
    if (!snap.exists()) return structuredClone(EMPTY_STATE);
    return normalizeState(snap.data());
  } catch (e) {
    console.error("[firebase] loadStateFromCloud error:", e);
    return structuredClone(EMPTY_STATE);
  }
}

/**
 * Сохраняет state в Firestore (полная перезапись документа).
 * ВАЖНО: state должен быть сериализуемым (без функций/циклов).
 */
export async function saveStateToCloud(state) {
  try {
    const clean = JSON.parse(JSON.stringify(normalizeState(state)));
    await setDoc(STATE_DOC, clean, { merge: false });
  } catch (e) {
    console.error("[firebase] saveStateFromCloud error:", e);
    throw e;
  }
}

/**
 * Подписка на изменения state в реальном времени.
 * Возвращает функцию unsubscribe().
 */
export function subscribeToState(cb) {
  if (typeof cb !== "function") {
    throw new Error("subscribeToState(cb): cb must be a function");
  }

  return onSnapshot(
    STATE_DOC,
    (snap) => {
      if (!snap.exists()) {
        cb(structuredClone(EMPTY_STATE));
        return;
      }
      cb(normalizeState(snap.data()));
    },
    (err) => {
      console.error("[firebase] subscribeToState error:", err);
      cb(structuredClone(EMPTY_STATE));
    }
  );
}
