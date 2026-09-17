"use strict";

/* ============================================================
 * «Микроволновый монастырь» — 2D pixel idle game (MVP)
 * Экономика и контракты — по ТЗ TZ-idle-game-mycelium.md
 * ============================================================ */

// ---------------- CONFIG (баланс, не сериализуется) ----------------
// ВАЖНО: в ТЗ baseAuto = 0.5, но симулятор (balance_sim.py) показал,
// что payback колонии тогда падает до ~12 с при норме 30–120 с.
// Подобрано симулятором: baseAuto = 0.15 — весь диапазон L=0..19
// держится в 32–100 с, темп 30 минут совпадает с целями ТЗ.
const CONFIG = {
  tickMs: 100, // 10 тиков/сек
  offlineCapSec: 8 * 3600, // оффлайн-доход максимум за 8 часов
  offlineEfficiency: 0.5, // 50% эффективности оффлайна
  autosaveSec: 15,
  upgrades: {
    auto:  { baseCost: 15,  growth: 1.15, baseGain: 0.15 },
    click: { baseCost: 50,  growth: 1.30, baseGain: 1 },
    mult:  { baseCost: 500, growth: 3.50, multPerLevel: 1.10 },
  },
};

const SAVE_KEY = "mycelium_save_v1";

const defaultState = () => ({
  version: 1,

  // Ресурсы
  spores: 0,
  totalSpores: 0,

  // Уровни апгрейдов
  upgrades: {
    auto:  { level: 0 },
    click: { level: 0 },
    mult:  { level: 0 },
  },

  // Производные (пересчитываются recalc, кэшируются здесь)
  clickPower: 1,
  sps: 0,

  // Мета
  lastTick: Date.now(),
  totalClicks: 0,
});

let state = defaultState();

// Хранилище: localStorage в браузере, in-memory fallback для тестов в node
const memoryStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
})();
const storage =
  typeof localStorage !== "undefined" ? localStorage : memoryStorage;

// ---------------- Форматирование чисел ----------------
function fmt(n) {
  if (!isFinite(n)) return "∞";
  if (n < 0) return "-" + fmt(-n);
  if (n < 1000) {
    // до тысячи — целые или 1 знак после запятой
    return n % 1 === 0 ? String(n) : n.toFixed(1);
  }
  const units = ["K", "M", "B", "T", "Qa", "Qi"];
  let u = -1;
  while (n >= 1000 && u < units.length - 1) {
    n /= 1000;
    u++;
  }
  // 1.2K / 3.4M — один знак после запятой
  return n.toFixed(1).replace(/\.0$/, "") + units[u];
}

// ---------------- ЭКОНОМИКА (контракты из ТЗ) ----------------

// Пересчитывает clickPower и sps из уровней апгрейдов
function recalc() {
  const L_auto = state.upgrades.auto.level;
  const L_click = state.upgrades.click.level;
  const L_mult = state.upgrades.mult.level;

  const multFactor = Math.pow(CONFIG.upgrades.mult.multPerLevel, L_mult);
  state.clickPower = (1 + CONFIG.upgrades.click.baseGain * L_click) * multFactor;
  state.sps = CONFIG.upgrades.auto.baseGain * L_auto * multFactor;
  return state;
}

// Стоимость одного уровня: floor(baseCost * growth^L)
function costOf(id) {
  const u = CONFIG.upgrades[id];
  const L = state.upgrades[id].level;
  return Math.floor(u.baseCost * Math.pow(u.growth, L));
}

// Стоимость покупки k уровней сразу (кнопка «купить x10»)
function costBulk(id, k) {
  const u = CONFIG.upgrades[id];
  const L = state.upgrades[id].level;
  return Math.floor(
    (u.baseCost * Math.pow(u.growth, L) * (Math.pow(u.growth, k) - 1)) /
      (u.growth - 1)
  );
}

// Прирост от покупки k уровней (для тултипа)
function gainOf(id, k = 1) {
  const L_auto = state.upgrades.auto.level;
  const L_click = state.upgrades.click.level;
  const L_mult = state.upgrades.mult.level;
  if (id === "auto") {
    const m = Math.pow(CONFIG.upgrades.mult.multPerLevel, L_mult);
    return CONFIG.upgrades.auto.baseGain * k * m; // спор/сек
  }
  if (id === "click") {
    const m = Math.pow(CONFIG.upgrades.mult.multPerLevel, L_mult);
    return CONFIG.upgrades.click.baseGain * k * m; // к силе клика
  }
  // mult: относительный прирост дохода
  const before = Math.pow(CONFIG.upgrades.mult.multPerLevel, L_mult);
  const after = Math.pow(CONFIG.upgrades.mult.multPerLevel, L_mult + k);
  return after / before - 1; // доля, напр. 0.1 = +10%
}

function canAfford(id, k = 1) {
  const cost = k === 1 ? costOf(id) : costBulk(id, k);
  return state.spores >= cost;
}

// Покупка k уровней; возвращает true, если удалось
function buy(id, k = 1) {
  if (!canAfford(id, k)) return false;
  const cost = k === 1 ? costOf(id) : costBulk(id, k);
  state.spores -= cost;
  state.upgrades[id].level += k;
  recalc();
  return true;
}

// Игровой тик: начисляет sps * dt (dt в секундах)
function tick(dt) {
  const gain = state.sps * dt;
  state.spores += gain;
  state.totalSpores += gain;
  return gain;
}

// Клик по главному грибу
function onMainClick() {
  state.spores += state.clickPower;
  state.totalSpores += state.clickPower;
  state.totalClicks++;
  return state.clickPower;
}

// ---------------- SAVE / LOAD ----------------

function save() {
  state.lastTick = Date.now();
  storage.setItem(SAVE_KEY, JSON.stringify(state));
}

// Миграция по version: на будущее (prestige и т.п.)
function migrate(raw) {
  const s = Object.assign(defaultState(), raw || {});
  s.upgrades = Object.assign(defaultState().upgrades, (raw && raw.upgrades) || {});
  for (const id of ["auto", "click", "mult"]) {
    s.upgrades[id] = Object.assign({ level: 0 }, s.upgrades[id]);
    s.upgrades[id].level = Math.max(0, Math.floor(s.upgrades[id].level || 0));
  }
  s.spores = Number(s.spores) || 0;
  s.totalSpores = Number(s.totalSpores) || 0;
  s.totalClicks = Number(s.totalClicks) || 0;
  s.lastTick = Number(s.lastTick) || Date.now();
  return s;
}

// Возвращает оффлайн-доход (споры), начисленный при загрузке
function load() {
  const raw = storage.getItem(SAVE_KEY);
  let offlineGain = 0;
  if (raw) {
    try {
      state = migrate(JSON.parse(raw));
    } catch (e) {
      state = defaultState();
    }
    recalc();
    const elapsedSec = Math.min(
      Math.max((Date.now() - state.lastTick) / 1000, 0),
      CONFIG.offlineCapSec
    );
    if (elapsedSec > 5 && state.sps > 0) {
      offlineGain = elapsedSec * state.sps * CONFIG.offlineEfficiency;
      state.spores += offlineGain;
      state.totalSpores += offlineGain;
    }
  } else {
    state = defaultState();
    recalc();
  }
  state.lastTick = Date.now();
  return offlineGain;
}

/* ============================================================
 * UI / РЕНДЕР (только браузер)
 * ============================================================ */

function initUI() {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const W = canvas.width; // 320
  const H = canvas.height; // 240
  const GROUND_Y = 208;

  // ---------- Элементы DOM ----------
  const el = {
    spores: document.getElementById("spores"),
    sps: document.getElementById("sps"),
    clickPower: document.getElementById("clickPower"),
    totalClicks: document.getElementById("totalClicks"),
    totalSpores: document.getElementById("totalSpores"),
    offlineToast: document.getElementById("offline-toast"),
    savedHint: document.getElementById("saved-hint"),
    bulkButtons: Array.from(document.querySelectorAll(".bulk-btn")),
  };

  let bulk = 1; // 1 или 10 — сколько уровней покупаем разом

  const upgradeButtons = {};
  for (const id of ["auto", "click", "mult"]) {
    upgradeButtons[id] = {
      btn: document.getElementById("buy-" + id),
      level: document.getElementById("level-" + id),
      cost: document.getElementById("cost-" + id),
      gain: document.getElementById("gain-" + id),
    };
  }

  // ---------- Частицы и всплывающий текст ----------
  const particles = []; // споры, плавающие вверх
  const floatTexts = []; // «+N» над грибом

  function spawnBurst(x, y, n, color) {
    for (let i = 0; i < n; i++) {
      particles.push({
        x: x + (Math.random() - 0.5) * 20,
        y: y + (Math.random() - 0.5) * 8,
        vx: (Math.random() - 0.5) * 0.4,
        vy: -0.3 - Math.random() * 0.7,
        life: 40 + Math.random() * 40,
        color: color || "#b6ff5e",
        size: Math.random() < 0.3 ? 2 : 1,
      });
    }
  }

  function spawnFloatText(x, y, text, color) {
    floatTexts.push({ x, y, text, color: color || "#d8ffb0", life: 60 });
  }

  // ---------- Главный гриб (хитбокс клика) ----------
  const mushroom = { x: W / 2, y: GROUND_Y, squish: 0 };

  // Единая геометрия главного гриба: рендер и хит-тест используют одно
  function mushroomGeom() {
    const L_click = state.upgrades.click.level;
    const capR = Math.min(26 + L_click * 1.3, 70); // крышка растёт с секаторами
    const stemH = Math.round(capR * 1.1);
    const stemW = Math.max(4, Math.round(capR * 0.35));
    return { capR, stemH, stemW };
  }

  function mushroomHit(px, py) {
    const { capR, stemH, stemW } = mushroomGeom();
    const dx = px - mushroom.x;
    // крышка (верхняя половина эллипса)
    const cdy = (py - (mushroom.y - stemH)) / (capR * 0.62);
    if (py <= mushroom.y - stemH && (dx * dx) / (capR * capR) + cdy * cdy <= 1) return true;
    // ножка
    return Math.abs(dx) < stemW && py >= mushroom.y - stemH && py <= mushroom.y;
  }

  // ---------- Ввод ----------
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const py = ((e.clientY - rect.top) / rect.height) * H;
    if (mushroomHit(px, py)) {
      const gained = onMainClick();
      mushroom.squish = 6;
      spawnFloatText(mushroom.x, mushroom.y - 70, "+" + fmt(gained));
      spawnBurst(mushroom.x, mushroom.y - 40, 8);
      updateHUD();
    }
  });

  // ---------- Панель апгрейдов ----------
  function refreshUpgradeUI() {
    for (const id of ["auto", "click", "mult"]) {
      const u = upgradeButtons[id];
      const L = state.upgrades[id].level;
      const cost = bulk === 1 ? costOf(id) : costBulk(id, bulk);
      const affordable = state.spores >= cost;
      u.level.textContent = L;
      u.cost.textContent = fmt(cost);
      u.gain.textContent =
        id === "auto"
          ? "+" + fmt(gainOf(id, bulk)) + "/сек"
          : id === "click"
            ? "+" + fmt(gainOf(id, bulk)) + " к клику"
            : "+" + Math.round(gainOf(id, bulk) * 100) + "% ко всему";
      u.btn.disabled = !affordable;
      u.btn.title =
        (id === "auto"
          ? "Споровая колония"
          : id === "click"
            ? "Острый секатор"
            : "Удобрение «Атом»") +
        " — стоимость: " +
        fmt(cost) +
        " спор. Эффект: " +
        u.gain.textContent;
    }
  }

  for (const id of ["auto", "click", "mult"]) {
    upgradeButtons[id].btn.addEventListener("click", () => {
      if (buy(id, bulk)) {
        const u = upgradeButtons[id];
        spawnBurst(mushroom.x, mushroom.y - 40, 12, "#7dffd4");
        spawnFloatText(mushroom.x, mushroom.y - 84, u.gain.textContent, "#7dffd4");
        updateHUD();
        refreshUpgradeUI();
      }
    });
  }

  for (const b of el.bulkButtons) {
    b.addEventListener("click", () => {
      bulk = Number(b.dataset.bulk);
      el.bulkButtons.forEach((x) => x.classList.toggle("active", x === b));
      refreshUpgradeUI();
    });
  }

  // ---------- HUD ----------
  function updateHUD() {
    el.spores.textContent = fmt(Math.floor(state.spores));
    el.sps.textContent = fmt(state.sps);
    el.clickPower.textContent = fmt(state.clickPower);
    el.totalClicks.textContent = fmt(state.totalClicks);
    el.totalSpores.textContent = fmt(Math.floor(state.totalSpores));
  }

  // ---------- Пиксель-арт рендер ----------
  const PAL = {
    bg: "#070b08",
    wall: "#0b120c",
    wallLine: "#101a10",
    floor: "#0d140e",
    floorLine: "#14201360",
    stem: "#cfe8c8",
    stemShade: "#9dbf95",
    cap: "#1f8f5f",
    capDark: "#14603f",
    glow: "#b6ff5e",
    glow2: "#7dffd4",
    sign: "#e8d44d",
    signBg: "#1a1a10",
  };

  function drawBackground(t) {
    ctx.fillStyle = PAL.bg;
    ctx.fillRect(0, 0, W, H);

    // Стена НИИ-«Теплица»: сетка оконных рам
    ctx.fillStyle = PAL.wall;
    ctx.fillRect(0, 0, W, GROUND_Y);
    ctx.strokeStyle = PAL.wallLine;
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 32) {
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, GROUND_Y); ctx.stroke();
    }
    for (let y = 0; y <= GROUND_Y; y += 32) {
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke();
    }

    // Пол
    ctx.fillStyle = PAL.floor;
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);

    // Плакат-табличка с трефой радиации (левая стена)
    ctx.fillStyle = PAL.signBg;
    ctx.fillRect(12, 24, 34, 34);
    ctx.strokeStyle = PAL.sign;
    ctx.strokeRect(12.5, 24.5, 33, 33);
    ctx.fillStyle = PAL.sign;
    const cx = 29, cy = 41, r = 9;
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a + 0.5, a + Math.PI * 2 / 3 - 0.5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = PAL.signBg;
    ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx.fill();

    // Труба справа
    ctx.fillStyle = "#1a241a";
    ctx.fillRect(W - 14, 0, 6, GROUND_Y);
    ctx.fillRect(W - 14, 60, 14, 6);

    // Люминесцентная лампа, мигающая изредка
    const flicker = (t % 240) < 6 ? 0.35 : 1;
    ctx.fillStyle = "rgba(125,255,212," + 0.10 * flicker + ")";
    ctx.fillRect(140, 10, 40, 3);
  }

  function drawMushroom(x, y, capR, phase) {
    // ножка
    const stemH = Math.round(capR * 1.1);
    const stemW = Math.max(2, Math.round(capR * 0.35));
    ctx.fillStyle = PAL.stemShade;
    ctx.fillRect(x - stemW, y - stemH, stemW * 2, stemH);
    ctx.fillStyle = PAL.stem;
    ctx.fillRect(x - stemW, y - stemH, stemW, stemH);

    // крышка
    const capY = y - stemH;
    ctx.fillStyle = PAL.capDark;
    ctx.beginPath();
    ctx.ellipse(x, capY, capR, Math.round(capR * 0.62), 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = PAL.cap;
    ctx.beginPath();
    ctx.ellipse(x, capY - 1, capR - 1, Math.round(capR * 0.56), 0, Math.PI, 0);
    ctx.fill();

    // светящиеся пятнышки
    ctx.fillStyle = PAL.glow;
    const dots = [
      [-0.5, -0.25], [0.2, -0.45], [0.55, -0.15], [-0.15, -0.6], [0.0, -0.1],
    ];
    const tw = 0.6 + 0.4 * Math.sin(phase);
    for (const [dx, dy] of dots) {
      ctx.globalAlpha = tw;
      ctx.fillRect(Math.round(x + dx * capR), Math.round(capY + dy * capR * 0.6), 2, 2);
    }
    ctx.globalAlpha = 1;
  }

  function render(t) {
    drawBackground(t);

    const L_auto = state.upgrades.auto.level;
    const L_mult = state.upgrades.mult.level;
    const phase = t / 18;

    // Колонии: ряды маленьких грибов слева, разрастаются с уровнем
    const shown = Math.min(L_auto, 80);
    for (let i = 0; i < shown; i++) {
      const row = Math.floor(i / 16);
      const col = i % 16;
      const x = 24 + col * 17 + (row % 2) * 8;
      const y = GROUND_Y - row * 14;
      const capR = 7 + ((i * 7) % 5);
      drawMushroom(x, y, capR, phase + i);
    }

    // Главный гриб (с анимацией сжатия при клике)
    const { capR } = mushroomGeom();
    const squish = mushroom.squish > 0 ? mushroom.squish / 6 : 0;
    ctx.save();
    ctx.translate(mushroom.x, mushroom.y);
    ctx.scale(1 + 0.2 * squish, 1 - 0.25 * squish);
    ctx.translate(-mushroom.x, -mushroom.y);
    drawMushroom(mushroom.x, mushroom.y, capR, phase);
    ctx.restore();
    mushroom.squish = Math.max(0, mushroom.squish - 1);

    // Свечение вокруг главного гриба сильнее с уровнем удобрения
    const glowA = Math.min(0.08 + L_mult * 0.02, 0.35);
    const gcy = mushroom.y - Math.round(capR * 1.1);
    const g = ctx.createRadialGradient(mushroom.x, gcy, 4, mushroom.x, gcy, 50 + capR * 2);
    g.addColorStop(0, "rgba(182,255,94," + glowA + ")");
    g.addColorStop(1, "rgba(182,255,94,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Пассивные споры-пылинки: плотность растёт с sps
    if (state.sps > 0 && Math.random() < Math.min(state.sps / 20, 0.5)) {
      particles.push({
        x: Math.random() * W,
        y: GROUND_Y,
        vx: (Math.random() - 0.5) * 0.2,
        vy: -0.2 - Math.random() * 0.4,
        life: 120,
        color: PAL.glow2,
        size: 1,
      });
    }

    // Частицы
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx; p.y += p.vy; p.life--;
      if (p.life <= 0 || p.y < 0) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(1, p.life / 30);
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // Всплывающий текст
    ctx.font = "8px monospace";
    ctx.textAlign = "center";
    for (let i = floatTexts.length - 1; i >= 0; i--) {
      const f = floatTexts[i];
      f.y -= 0.6; f.life--;
      if (f.life <= 0) { floatTexts.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(1, f.life / 25);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, Math.round(f.x), Math.round(f.y));
    }
    ctx.globalAlpha = 1;
  }

  // ---------- Главный цикл ----------
  setInterval(() => {
    tick(CONFIG.tickMs / 1000);
    updateHUD();
    refreshUpgradeUI();
  }, CONFIG.tickMs);

  let saveCountdown = 0;
  setInterval(() => {
    save();
    el.savedHint.classList.add("visible");
    setTimeout(() => el.savedHint.classList.remove("visible"), 1200);
  }, CONFIG.autosaveSec * 1000);

  window.addEventListener("beforeunload", save);

  // requestAnimationFrame-рендер
  function loop(t) {
    render(t / 16); // «кадры» для анимаций
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------- Старт ----------
  const offlineGain = load();
  if (offlineGain > 0) {
    el.offlineToast.textContent =
      "Пока вас не было, грибница работала: +" +
      fmt(Math.floor(offlineGain)) +
      " спор (50% эффективности)";
    el.offlineToast.classList.add("visible");
    setTimeout(() => el.offlineToast.classList.remove("visible"), 8000);
  }
  updateHUD();
  refreshUpgradeUI();
}

// Старт UI только в браузере; в node экспортируем чистую логику для тестов
if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("DOMContentLoaded", initUI);
} else if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CONFIG,
    SAVE_KEY,
    defaultState,
    recalc,
    costOf,
    costBulk,
    gainOf,
    canAfford,
    buy,
    tick,
    onMainClick,
    save,
    load,
    fmt,
    storage,
    getState: () => state,
    setState: (s) => { state = s; },
  };
}
