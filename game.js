// Color Matcher - Vanilla JS Canvas Game
// Uses requestAnimationFrame for smooth animation and responsive canvas sizing

const COLORS = [
  { name: 'Red', key: 'r', color: '#ff4d4f' },
  { name: 'Blue', key: 'b', color: '#4096ff' },
  { name: 'Green', key: 'g', color: '#52c41a' },
  { name: 'Yellow', key: 'y', color: '#fadb14' },
  { name: 'Purple', key: 'p', color: '#9254de' },
  { name: 'Orange', key: 'o', color: '#fa8c16' },
];

const GAME_STATE = {
  START: 'start',
  RUNNING: 'running',
  PAUSED: 'paused',
  GAME_OVER: 'game_over',
};

class InputManager {
  constructor() {
    this.pressedKeys = new Set();
    this.listeners = new Map();
    window.addEventListener('keydown', e => this.#onKey(e, true));
    window.addEventListener('keyup', e => this.#onKey(e, false));
  }

  on(key, callback) {
    const k = key.toLowerCase();
    if (!this.listeners.has(k)) this.listeners.set(k, new Set());
    this.listeners.get(k).add(callback);
    return () => this.listeners.get(k).delete(callback);
  }

  #onKey(e, isDown) {
    const key = e.key.toLowerCase();
    if (isDown) this.pressedKeys.add(key); else this.pressedKeys.delete(key);
    const callbacks = this.listeners.get(key);
    if (callbacks && isDown) {
      for (const cb of callbacks) cb();
    }
  }
}

class Random {
  static range(min, max) { return Math.random() * (max - min) + min; }
  static int(min, max) { return Math.floor(Random.range(min, max)); }
  static choice(arr) { return arr[Random.int(0, arr.length)]; }
}

class Particle {
  constructor(x, y, color) {
    this.x = x; this.y = y; this.color = color;
    this.vx = Random.range(-120, 120);
    this.vy = Random.range(-220, -60);
    this.life = Random.range(0.35, 0.7);
    this.size = Random.range(2, 5);
    this.alive = true;
  }
  update(dt) {
    if (!this.alive) return;
    this.life -= dt; if (this.life <= 0) { this.alive = false; return; }
    this.vy += 980 * dt * 0.75;
    this.x += this.vx * dt; this.y += this.vy * dt;
  }
  render(ctx) {
    if (!this.alive) return;
    ctx.globalAlpha = Math.max(0, this.life);
    ctx.fillStyle = this.color;
    ctx.fillRect(this.x, this.y, this.size, this.size);
    ctx.globalAlpha = 1;
  }
}

class Block {
  constructor(x, y, size, speed, mapping) {
    this.x = x;
    this.y = y;
    this.size = size;
    this.speed = speed;
    this.mapping = mapping; // { name, key, color }
    this.markedForRemoval = false;
  }
  update(dt) { this.y += this.speed * dt; }
  render(ctx) {
    ctx.fillStyle = this.mapping.color;
    ctx.fillRect(this.x, this.y, this.size, this.size);
    // subtle border
    ctx.strokeStyle = 'rgba(0,0,0,.25)';
    ctx.strokeRect(this.x + 0.5, this.y + 0.5, this.size - 1, this.size - 1);
  }
  isInHitZone(hitTop, hitBottom) {
    const within = this.y + this.size >= hitTop && this.y <= hitBottom;
    return within;
  }
}

class ScoreSystem {
  constructor() {
    this.score = 0;
    this.combo = 1;
    this.streak = 0;
    this.bestCombo = 1;
  }
  reset() { this.score = 0; this.combo = 1; this.streak = 0; this.bestCombo = 1; }
  hit() {
    this.streak += 1;
    if (this.streak % 5 === 0) this.combo = Math.min(10, this.combo + 1);
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const points = 10 * this.combo;
    this.score += points;
    return points;
  }
  miss() { this.streak = 0; this.combo = 1; }
}

class DifficultyManager {
  constructor() {
    this.elapsed = 0;
    this.level = 1;
    this.baseFallTime = 2.0; // seconds to traverse screen height initially
    this.spawnInterval = 1.2; // seconds
    this.capFallTime = 0.7; // fastest fall time
    this.minSpawnInterval = 0.35;
  }
  reset() { this.elapsed = 0; this.level = 1; this.baseFallTime = 2.0; this.spawnInterval = 1.2; }
  onGoodHit() {
    // every 5 hits, small boost
    this.level += 0.1;
    this.#recompute();
  }
  update(dt) {
    this.elapsed += dt;
    if (this.elapsed >= 12) { // time-based scaling
      this.elapsed = 0;
      this.level += 1;
      this.#recompute();
    }
  }
  fallSpeedFor(heightPx) { // pixels per second
    const time = Math.max(this.capFallTime, this.baseFallTime);
    return heightPx / time;
  }
  #recompute() {
    this.baseFallTime = Math.max(this.capFallTime, 2.0 - (this.level * 0.12));
    this.spawnInterval = Math.max(this.minSpawnInterval, 1.2 - (this.level * 0.06));
  }
}

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.input = new InputManager();
    this.scoreSystem = new ScoreSystem();
    this.difficulty = new DifficultyManager();
    this.blocks = [];
    this.particles = [];
    this.state = GAME_STATE.START;
    this.lastTime = 0;
    this.accumulator = 0;
    this.spawnTimer = 0;
    this.health = 1; // 0..1
    this.lives = 5;
    this.hitZoneHeight = 90;
    this.margin = 24;
    this.blockBaseSize = 46;
    this.audioEnabled = false;
    this.sounds = createAudio();
    this.#bindKeys();
    this.#resize();
    window.addEventListener('resize', () => this.#resize());
  }

  #bindKeys() {
    // color keys
    for (const m of COLORS) {
      this.input.on(m.key, () => this.#attemptMatch(m.key));
    }
    // pause
    this.input.on(' ', () => {
      if (this.state === GAME_STATE.RUNNING) this.pause();
      else if (this.state === GAME_STATE.PAUSED) this.resume();
    });
  }

  #resize() {
    const maxWidth = 1100;
    const ratio = 16 / 9;
    const width = Math.min(maxWidth, Math.floor(this.canvas.clientWidth || 960));
    const height = Math.floor(width / ratio);
    this.canvas.width = width;
    this.canvas.height = height;
  }

  start() {
    this.state = GAME_STATE.RUNNING;
    this.blocks.length = 0;
    this.particles.length = 0;
    this.scoreSystem.reset();
    this.difficulty.reset();
    this.lastTime = performance.now();
    this.spawnTimer = 0;
    this.health = 1;
    this.lives = 3;
    requestAnimationFrame(t => this.#loop(t));
  }

  pause() { this.state = GAME_STATE.PAUSED; togglePanel('pause', true); }
  resume() { if (this.state === GAME_STATE.PAUSED) { this.state = GAME_STATE.RUNNING; togglePanel('pause', false); this.lastTime = performance.now(); requestAnimationFrame(t => this.#loop(t)); } }
  gameOver() { this.state = GAME_STATE.GAME_OVER; showGameOver(this.scoreSystem.score); }

  #loop(timestamp) {
    if (this.state !== GAME_STATE.RUNNING) return;
    const dt = Math.min(0.033, (timestamp - this.lastTime) / 1000);
    this.lastTime = timestamp;

    this.update(dt);
    this.render();

    requestAnimationFrame(t => this.#loop(t));
  }

  #spawnBlock() {
    const size = this.blockBaseSize;
    const cols = Math.max(6, Math.floor(this.canvas.width / (size + 10)));
    const laneWidth = (this.canvas.width - this.margin * 2 - size) / (cols - 1);
    const lane = Random.int(0, cols);
    const x = this.margin + lane * laneWidth;
    const y = -size - 10;
    const speed = this.difficulty.fallSpeedFor(this.canvas.height);
    const mapping = Random.choice(COLORS);
    // dynamic background accent
    document.documentElement.style.setProperty('--accent', mapping.color);
    this.blocks.push(new Block(x, y, size, speed, mapping));
  }

  #attemptMatch(key) {
    if (this.state !== GAME_STATE.RUNNING) return;
    // Find the lowest block in hit zone matching key (closest to bottom)
    const hitTop = this.canvas.height - this.hitZoneHeight - this.margin;
    const hitBottom = this.canvas.height - this.margin;
    let candidate = null;
    for (const b of this.blocks) {
      if (b.mapping.key === key && b.isInHitZone(hitTop, hitBottom)) {
        if (!candidate || b.y > candidate.y) candidate = b;
      }
    }
    if (candidate) {
      // success
      candidate.markedForRemoval = true;
      this.#spawnParticles(candidate.x + candidate.size / 2, candidate.y + candidate.size / 2, candidate.mapping.color);
      const gained = this.scoreSystem.hit();
      this.difficulty.onGoodHit();
      updateScoreHUD(this.scoreSystem.score, this.scoreSystem.combo);
      this.#playSound('hit');
    } else {
      // wrong key small penalty
      this.scoreSystem.miss();
      updateScoreHUD(this.scoreSystem.score, this.scoreSystem.combo);
      this.#flashHitZone('wrong');
      this.#playSound('fail');
    }
  }

  #spawnParticles(x, y, color) {
    for (let i = 0; i < 24; i++) this.particles.push(new Particle(x, y, color));
    this.#flashHitZone('good');
  }

  #flashHitZone(kind) {
    const elt = document.getElementById('gameCanvas');
    if (!elt) return;
    const cls = kind === 'good' ? 'hit-good' : 'hit-bad';
    elt.classList.remove('hit-good', 'hit-bad');
    // force reflow
    void elt.offsetWidth;
    elt.classList.add(cls);
    setTimeout(() => elt.classList.remove(cls), 120);
  }

  #playSound(name) {
    if (!this.audioEnabled) return;
    this.sounds[name]?.();
  }

  update(dt) {
    // difficulty over time
    this.difficulty.update(dt);

    // spawn blocks
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.#spawnBlock();
      this.spawnTimer = this.difficulty.spawnInterval;
    }

    // update blocks
    for (const b of this.blocks) b.update(dt);

    // check bottom collisions (misses)
    const bottom = this.canvas.height - this.margin;
    for (const b of this.blocks) {
      if (b.y > bottom) {
        b.markedForRemoval = true;
        this.scoreSystem.miss();
        this.#damage();
        this.#playSound('fail');
      }
    }

    // remove marked blocks
    this.blocks = this.blocks.filter(b => !b.markedForRemoval);

    // update particles
    for (const p of this.particles) p.update(dt);
    this.particles = this.particles.filter(p => p.alive);
  }

  #damage() {
    if (this.health > 0.34) {
      this.health -= 0.34;
    } else {
      this.lives -= 1;
      this.health = 1;
    }
    updateHealthHUD(this.health, this.lives);
    if (this.lives <= 0) this.gameOver();
  }

  render() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // background subtle grid
    drawBackground(ctx, canvas);

    // hit zone
    const hitTop = canvas.height - this.hitZoneHeight - this.margin;
    const hitBottom = canvas.height - this.margin;
    drawHitZone(ctx, 16, hitTop, canvas.width - 32, this.hitZoneHeight);

    // blocks
    for (const b of this.blocks) b.render(ctx);

    // particles
    for (const p of this.particles) p.render(ctx);
  }
}

// Rendering helpers
function drawBackground(ctx, canvas) {
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, '#0b1220');
  grad.addColorStop(1, '#0b0f19');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(99,102,241,.12)';
  ctx.lineWidth = 1;
  const step = 36;
  ctx.beginPath();
  for (let x = (canvas.width % step); x < canvas.width; x += step) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, canvas.height);
  }
  for (let y = (canvas.height % step); y < canvas.height; y += step) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(canvas.width, y + 0.5);
  }
  ctx.stroke();
}

function drawHitZone(ctx, x, y, w, h) {
  ctx.save();
  // background with scanline effect
  ctx.fillStyle = 'rgba(15,23,42,.55)';
  roundRect(ctx, x, y, w, h, 12);
  ctx.fill();
  // scanlines
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(148,163,184,.08)';
  for (let yy = y + 6; yy < y + h; yy += 6) {
    ctx.moveTo(x + 10, yy + 0.5);
    ctx.lineTo(x + w - 10, yy + 0.5);
  }
  ctx.stroke();
  // neon border, pulsing, color from accent
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#67e8f9';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'white';
  ctx.shadowColor = accent;
  ctx.shadowBlur = 16 + Math.sin(performance.now() / 220) * 6;
  roundRect(ctx, x, y, w, h, 12);
  ctx.stroke();
  // label
  ctx.shadowBlur = 0;
  ctx.font = '600 14px Inter, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(203,213,225,.9)';
  ctx.fillText('HIT ZONE', x + 16, y + 22);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// HUD helpers
function updateScoreHUD(score, combo) {
  // odometer-style tween
  tweenScore(score);
  const comboValue = document.getElementById('comboValue');
  const badge = document.getElementById('comboBadge');
  if (comboValue) comboValue.textContent = `x${combo}`;
  if (badge) {
    badge.classList.remove('combo-bump');
    void badge.offsetWidth; // reflow to restart animation
    badge.classList.add('combo-bump');
    if (combo >= 5) badge.classList.add('combo-rainbow'); else badge.classList.remove('combo-rainbow');
    if (combo <= 1) {
      badge.classList.add('combo-fade');
      setTimeout(() => badge.classList.remove('combo-fade'), 350);
    }
  }
}

function updateHealthHUD(health01, lives) {
  const hearts = document.getElementById('livesHearts');
  if (hearts) renderHearts(hearts, lives);
}

function togglePanel(panel, show) {
  const overlay = document.getElementById('overlay');
  const start = document.getElementById('startPanel');
  const pause = document.getElementById('pausePanel');
  const over = document.getElementById('gameOverPanel');
  const map = { start, pause, over };
  if (panel === 'start') { start.classList.toggle('hidden', !show); }
  if (panel === 'pause') { pause.classList.toggle('hidden', !show); overlay.style.pointerEvents = show ? 'auto' : 'none'; overlay.style.display = show ? 'flex' : 'none'; }
}

function showGameOver(score) {
  const overlay = document.getElementById('overlay');
  const over = document.getElementById('gameOverPanel');
  const start = document.getElementById('startPanel');
  const pause = document.getElementById('pausePanel');
  start.classList.add('hidden');
  pause.classList.add('hidden');
  document.getElementById('finalScore').textContent = String(score);
  overlay.style.display = 'flex';
  overlay.style.pointerEvents = 'auto';
  over.classList.remove('hidden');
}

// Simple WebAudio tones (optional)
function createAudio() {
  let audioCtx = null;
  function getCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }
  function tone(freq, duration, type = 'sine', vol = 0.05) {
    const ctx = getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type; osc.frequency.value = freq;
    gain.gain.value = vol;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  }
  return {
    hit: () => tone(660, 0.07, 'triangle', 0.06),
    fail: () => tone(180, 0.12, 'sawtooth', 0.05),
  };
}

// Boot
const canvas = document.getElementById('gameCanvas');
const game = new Game(canvas);

// Start button
document.getElementById('startButton').addEventListener('click', () => {
  document.getElementById('overlay').style.display = 'none';
  document.getElementById('gameOverPanel').classList.add('hidden');
  document.getElementById('startPanel').classList.add('hidden');
  game.audioEnabled = true; // enable audio after user gesture
  game.start();
});

document.getElementById('restartButton').addEventListener('click', () => {
  document.getElementById('gameOverPanel').classList.add('hidden');
  document.getElementById('overlay').style.display = 'none';
  game.start();
});

// Pause button
document.getElementById('pauseButton').addEventListener('click', () => {
  if (game.state === GAME_STATE.RUNNING) game.pause();
  else if (game.state === GAME_STATE.PAUSED) game.resume();
});

// CSS hit feedback via class on canvas
const style = document.createElement('style');
style.textContent = `
  #gameCanvas.hit-good { box-shadow: 0 10px 30px rgba(0,0,0,.4), inset 0 0 80px rgba(34,197,94,.35); }
  #gameCanvas.hit-bad { box-shadow: 0 10px 30px rgba(0,0,0,.4), inset 0 0 80px rgba(239,68,68,.35); }
`;
document.head.appendChild(style);

// HUD rendering helpers (odometer, hearts, level ring)
let displayedScore = 0;
function tweenScore(target) {
  const el = document.getElementById('scoreOdometer');
  const now = performance.now();
  const diff = target - displayedScore;
  if (Math.abs(diff) < 1) {
    displayedScore = target;
  } else {
    displayedScore += Math.sign(diff) * Math.max(1, Math.floor(Math.abs(diff) * 0.2));
  }
  if (el) el.textContent = String(displayedScore).padStart(5, '0');
  // level ring and level text
  const ring = document.getElementById('levelRing');
  const levelEl = document.getElementById('levelValue');
  if (ring && levelEl) {
    const circumference = 2 * Math.PI * 18; // r=18
    const progress = Math.max(0, Math.min(1, game.difficulty.elapsed / 12));
    ring.style.strokeDasharray = `${circumference}`;
    ring.style.strokeDashoffset = `${circumference * (1 - progress)}`;
    levelEl.textContent = String(Math.max(1, Math.floor(game.difficulty.level)));
  }
}

function renderHearts(container, lives) {
  container.innerHTML = '';
  const total = 5;
  for (let i = 0; i < total; i++) {
    const filled = i < lives;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.innerHTML = `<path d="M12 21s-6.716-4.384-9.364-7.03C.99 12.325 1.015 8.77 3.536 6.95c2.02-1.44 4.682-.89 6.03.848C10.782 6.06 13.444 5.51 15.464 6.95c2.52 1.82 2.546 5.375.9 7.02C18.716 16.616 12 21 12 21z" fill="${filled ? '#ef4444' : 'none'}" stroke="#ef4444" stroke-width="1.5"/>`;
    container.appendChild(svg);
  }
}


