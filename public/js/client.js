'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  CLIENT STATE
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  playerId:       null,
  playerName:     null,
  role:           null,       // 'impostor' | 'protector' | 'detective' | 'recruit'
  myCards:        null,       // { weapons:[], traces:[] }
  allCards:       {},         // { [playerId]: { weapons:[], traces:[] } }
  playerList:     [],         // PublicPlayer[]
  phase:          'join',
  isAlive:        true,
  isSpectator:    false,
  hasGuessed:     false,
  usedCards:      [],         // only populated for impostor role
  round:          0,
  timerInterval:  null,
  timerSeconds:   0,
  isHost:         false,
  // Accusation UI state
  accusation: {
    accusedId: null,
    weapon:    null,
    trace:     null
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  VOICE NARRATOR (Web Speech API — free, built-in browser)
// ─────────────────────────────────────────────────────────────────────────────
const voice = {
  enabled: false,
  synth:   window.speechSynthesis,

  _getVoice() {
    const voices = this.synth.getVoices();
    return voices.find(v => v.lang.startsWith('id'))
        || voices.find(v => v.lang.startsWith('en') && v.localService)
        || null;
  },

  speak(text) {
    if (!this.enabled || !text) return;
    this.synth.cancel();
    const utt    = new SpeechSynthesisUtterance(text);
    utt.lang     = 'id-ID';
    utt.rate     = 0.85;
    utt.pitch    = 0.8;
    utt.volume   = 0.95;
    const v = this._getVoice();
    if (v) utt.voice = v;
    this.synth.speak(utt);
  },

  stop() { this.synth.cancel(); },

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) this.stop();
    const btn = document.getElementById('btn-voice-toggle');
    if (btn) {
      btn.textContent = this.enabled ? '🔊 Suara Aktif' : '🔇 Suara Mati';
      btn.classList.toggle('active', this.enabled);
    }
    return this.enabled;
  }
};

// Load voices async (required in some browsers)
if (window.speechSynthesis.onvoiceschanged !== undefined) {
  window.speechSynthesis.onvoiceschanged = () => {};
}

// ─────────────────────────────────────────────────────────────────────────────
//  TYPEWRITER EFFECT
// ─────────────────────────────────────────────────────────────────────────────
function typewrite(el, text, charsPerTick = 3, tickMs = 18) {
  el.textContent = '';
  let i = 0;
  const timer = setInterval(() => {
    const chunk = text.slice(i, i + charsPerTick);
    el.textContent += chunk;
    i += charsPerTick;
    if (i >= text.length) clearInterval(timer);
  }, tickMs);
}


const socket = io({ transports: ['websocket', 'polling'] });

// ─────────────────────────────────────────────────────────────────────────────
//  SCREEN MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
const SCREENS = [
  'screen-join', 'screen-lobby', 'screen-intro',
  'screen-role-reveal', 'screen-impostor-action',
  'screen-protector-action', 'screen-morning', 'screen-day', 'screen-gameover'
];

function showScreen(id) {
  SCREENS.forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.toggle('active', s === id);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  BLACK OVERLAY
// ─────────────────────────────────────────────────────────────────────────────
function setBlackOverlay(isBlack, message = 'Malam tiba... Semua tutup mata.') {
  const overlay = document.getElementById('black-overlay');
  const msgEl   = document.getElementById('black-message');
  if (msgEl) msgEl.textContent = message;
  overlay.classList.toggle('active', isBlack);
}

// ─────────────────────────────────────────────────────────────────────────────
//  NOTIFICATION OVERLAY (secret notification, info dialogs)
// ─────────────────────────────────────────────────────────────────────────────
function showNotification({ icon, message, type = '', onClose = null }) {
  const overlay = document.getElementById('notification-overlay');
  const box     = document.getElementById('notif-box');
  const iconEl  = document.getElementById('notif-icon');
  const msgEl   = document.getElementById('notif-message');

  iconEl.textContent = icon || '';
  msgEl.textContent  = message;
  box.className = `notif-box ${type}`;
  overlay.classList.add('active');

  const btn = document.getElementById('btn-dismiss-notif');
  btn.onclick = () => {
    overlay.classList.remove('active');
    if (onClose) onClose();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  ACCUSATION BANNER (top toast)
// ─────────────────────────────────────────────────────────────────────────────
function showAccusationBanner(message, isCorrect) {
  const banner = document.getElementById('accusation-banner');
  banner.textContent = message;
  banner.className   = `active ${isCorrect ? 'correct' : 'wrong'}`;
  setTimeout(() => banner.classList.remove('active'), 6000);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SOCKET EVENT HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

socket.on('connect', () => {
  console.log('[Socket] Connected:', socket.id);
});

socket.on('disconnect', () => {
  console.log('[Socket] Disconnected');
});

socket.on('error_msg', ({ message }) => {
  showNotification({ icon: '⚠️', message, type: 'danger' });
});

// ── LOBBY ─────────────────────────────────────────────────────────────────────

socket.on('joined_lobby', ({ playerId, isHost, dayTimerDuration }) => {
  state.playerId   = playerId;
  state.isHost     = isHost;
  state.phase      = 'lobby';

  if (isHost) {
    document.getElementById('host-config').classList.remove('hidden');
    document.getElementById('day-timer-input').value = dayTimerDuration;
  }
  showScreen('screen-lobby');
});

socket.on('you_are_host', () => {
  state.isHost = true;
  document.getElementById('host-config').classList.remove('hidden');
  document.getElementById('day-timer-input').value = state.dayTimerDuration || 120;
});

socket.on('lobby_update', (data) => {
  state.playerList     = data.players.map(p => ({
    ...p,
    isAlive: true, isSpectator: false, hasGuessed: false
  }));
  state.dayTimerDuration = data.dayTimerDuration;
  renderLobby(data);
});

// ── GAME START → ROLE REVEAL ──────────────────────────────────────────────────

socket.on('game_start', ({ playerId, role, myCards, allCards, playerList }) => {
  state.playerId   = playerId;
  state.role       = role;
  state.myCards    = myCards;
  state.allCards   = allCards;
  state.playerList = playerList;
  state.isAlive    = true;
  state.isSpectator = false;
  state.hasGuessed = false;
  state.usedCards  = [];
  state.round      = 0;
  state.phase      = 'role_reveal';

  renderRoleReveal(role, myCards);
  showScreen('screen-role-reveal');
});

// ── INTRO ─────────────────────────────────────────────────────────────────────

socket.on('phase_change', ({ phase, round, message }) => {
  state.phase = phase;
  if (round !== undefined) state.round = round;

  if (phase === 'intro') {
    showScreen('screen-intro');
    document.getElementById('intro-text').textContent = '⏳ Narator mempersiapkan cerita...';
  }
  if (phase === 'morning') {
    stopDayTimer();
    document.getElementById('morning-round').textContent = round;
    document.getElementById('morning-narrative').textContent = '⏳ Narator menyusun berita pagi...';
    document.getElementById('morning-status-grid').innerHTML = '';
    showScreen('screen-morning');
  }
  if (phase === 'day') {
    // will be handled by day_start
  }
});

socket.on('narrator_text', ({ text }) => {
  const el = document.getElementById('intro-text');
  if (el) el.textContent = text;
  voice.speak(text);
});

socket.on('skip_vote_update', ({ voted, total }) => {
  const el = document.getElementById('skip-info');
  if (el) el.textContent = `Skip: ${voted} / ${total} pemain`;
});

// ── NIGHT ─────────────────────────────────────────────────────────────────────

socket.on('screen_black', ({ isBlack, message }) => {
  setBlackOverlay(isBlack, message);
});

socket.on('impostor_turn', (data) => {
  // Update used cards in state (server only sends this to impostor)
  state.usedCards = data.usedCards || [];
  state.round     = data.round;
  renderImpostorAction(data);
  showScreen('screen-impostor-action');
});

socket.on('protector_turn', (data) => {
  renderProtectorAction(data);
  showScreen('screen-protector-action');
});

socket.on('action_confirmed', (data) => {
  if (state.role === 'impostor') {
    showNotification({
      icon: '🎭',
      message: `Aksi dikirim!\nTarget: ${data.targetName}\nSenjata: ${data.weapon}\nJejak: ${data.trace}\nTipe: ${data.actionType === 'kill' ? 'BUNUH' : 'REKRUT'}\n\nTunggu instruksi berikutnya...`,
      type: 'info'
    });
  } else if (state.role === 'protector') {
    showNotification({
      icon: '🛡️',
      message: `Kamu melindungi ${data.targetName} malam ini.\nTunggu pagi hari...`,
      type: 'info'
    });
  }
});

socket.on('action_error', ({ message }) => {
  showNotification({ icon: '❌', message, type: 'danger' });
});

// ── MORNING ───────────────────────────────────────────────────────────────────

socket.on('morning_result', ({ narrative, outcome, deadPlayerId, deadPlayerName, round, playerList }) => {
  state.round      = round;
  state.playerList = playerList;

  const narrativeEl = document.getElementById('morning-narrative');
  typewrite(narrativeEl, narrative);
  voice.speak(narrative);

  // Sync our alive status
  const self = playerList.find(p => p.id === state.playerId);
  if (self) {
    state.isAlive    = self.isAlive;
    state.isSpectator = self.isSpectator;
  }

  // Render player status
  renderMorningStatus(playerList, deadPlayerId);
});

// ── DAY ───────────────────────────────────────────────────────────────────────

socket.on('day_start', ({ timerDuration, round, playerList }) => {
  state.round      = round;
  state.playerList = playerList;

  const self = playerList.find(p => p.id === state.playerId);
  if (self) {
    state.isAlive    = self.isAlive;
    state.isSpectator = self.isSpectator;
    state.hasGuessed = self.hasGuessed;
  }

  renderDayScreen(timerDuration);
  showScreen('screen-day');
  startDayTimer(timerDuration);
});

socket.on('player_update', ({ playerList }) => {
  state.playerList = playerList;
  const self = playerList.find(p => p.id === state.playerId);
  if (self) {
    state.isAlive    = self.isAlive;
    state.isSpectator = self.isSpectator;
  }

  // Refresh cards grid and accusation panel availability
  if (state.phase === 'day') {
    renderCardsGrid();
    updateAccusationPanelAccess();
  }
});

socket.on('accusation_result', ({ accuserName, accusedName, weapon, trace, isCorrect, message }) => {
  showAccusationBanner(message, isCorrect);

  // Update hasGuessed in playerList
  const accuser = state.playerList.find(p => p.name === accuserName);
  if (accuser) accuser.hasGuessed = true;

  if (!isCorrect) {
    // Accuser died — update list
    const accuserPlayer = state.playerList.find(p => p.name === accuserName);
    if (accuserPlayer) {
      accuserPlayer.isAlive    = false;
      accuserPlayer.isSpectator = true;
    }
    renderCardsGrid();
    updateAccusationPanelAccess();
  }

  // Hide accusation form
  closeAccusationForm();
});

socket.on('you_died', ({ reason }) => {
  state.isAlive    = false;
  state.isSpectator = true;
  closeAccusationForm();
  updateAccusationPanelAccess();
  showNotification({
    icon: '💀',
    message: reason === 'wrong_accusation'
      ? 'Tuduhan salah!\nKamu tereliminasi dan menjadi penonton.\nKamu masih bisa melihat jalannya game.'
      : 'Kamu tereliminasi.',
    type: 'danger'
  });
});

socket.on('day_ended', ({ message }) => {
  stopDayTimer();
  showAccusationBanner(message, false);
  closeAccusationForm();
});

// ── SECRET NOTIFICATION ────────────────────────────────────────────────────────

socket.on('secret_notification', ({ message }) => {
  // This is delivered to recruited player
  state.role = 'recruit';
  showNotification({
    icon: '🤫',
    message,
    type: 'secret'
  });
});

// ── PLAYER DISCONNECTED ────────────────────────────────────────────────────────

socket.on('player_disconnected', ({ name, playerList }) => {
  state.playerList = playerList;
  showAccusationBanner(`⚡ ${name} terputus dari game.`, false);
  if (state.phase === 'day') {
    renderCardsGrid();
    updateAccusationPanelAccess();
  }
});

// ── GAME OVER ─────────────────────────────────────────────────────────────────

socket.on('game_over', (data) => {
  stopDayTimer();
  setBlackOverlay(false);
  closeAccusationForm();
  renderGameOver(data);
  showScreen('screen-gameover');
});

socket.on('play_again_vote', ({ voted, total, threshold }) => {
  const el = document.getElementById('play-again-vote-info');
  if (el) el.textContent = `${voted}/${total} pemain setuju (butuh ${threshold})`;
});

// ── LOBBY RESET ───────────────────────────────────────────────────────────────

socket.on('lobby_reset', ({ players, hostId, dayTimerDuration }) => {
  // Reset client state
  state.role       = null;
  state.myCards    = null;
  state.allCards   = {};
  state.isAlive    = true;
  state.isSpectator = false;
  state.hasGuessed = false;
  state.usedCards  = [];
  state.round      = 0;
  state.phase      = 'lobby';
  state.accusation = { accusedId: null, weapon: null, trace: null };
  state.isHost     = (state.playerId === hostId);
  state.dayTimerDuration = dayTimerDuration;

  stopDayTimer();
  setBlackOverlay(false);

  // Reset ready state in player list
  state.playerList = players.map(p => ({
    ...p, isAlive: true, isSpectator: false, hasGuessed: false
  }));

  if (state.isHost) {
    document.getElementById('host-config').classList.remove('hidden');
    document.getElementById('day-timer-input').value = dayTimerDuration;
  } else {
    document.getElementById('host-config').classList.add('hidden');
  }

  renderLobby({ players, hostId, dayTimerDuration, canStart: false });
  showScreen('screen-lobby');
});

// ─────────────────────────────────────────────────────────────────────────────
//  RENDER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

// ── LOBBY ─────────────────────────────────────────────────────────────────────

function renderLobby({ players, hostId, dayTimerDuration, canStart }) {
  const list = document.getElementById('lobby-player-list');
  list.innerHTML = '';

  players.forEach(p => {
    const div  = document.createElement('div');
    div.className = 'player-entry';

    const ready = p.isReady;
    const isYou = p.id === state.playerId;

    div.innerHTML = `
      <div class="ready-indicator ${ready ? 'ready' : ''}"></div>
      <span class="pname">${escHtml(p.name)}</span>
      ${isYou  ? '<span class="badge badge-you">Kamu</span>' : ''}
      ${p.isHost ? '<span class="badge badge-host">👑 Host</span>' : ''}
      <span class="badge ${ready ? 'badge-ready' : 'badge-wait'}">${ready ? '✓ Siap' : 'Menunggu'}</span>
    `;
    list.appendChild(div);
  });

  // Update ready button label
  const self = players.find(p => p.id === state.playerId);
  const btn  = document.getElementById('btn-ready');
  if (btn && self) {
    btn.textContent = self.isReady ? 'Batalkan Siap' : 'Siap!';
    btn.className   = self.isReady ? 'btn-secondary' : 'btn-primary';
  }

  // Requirements info
  const reqEl = document.getElementById('lobby-req');
  if (reqEl) {
    const count = players.length;
    if (count < 4) {
      reqEl.textContent = `Butuh minimal 4 pemain (saat ini: ${count})`;
      reqEl.className   = 'dim text-sm mt-8';
    } else {
      const readyCount = players.filter(p => p.isReady).length;
      reqEl.textContent = canStart
        ? '✅ Semua siap! Game segera dimulai...'
        : `${readyCount}/${count} siap. Tunggu semua menekan "Siap!"`;
      reqEl.className   = canStart ? 'text-green text-sm mt-8' : 'dim text-sm mt-8';
    }
  }

  // Timer display
  const timerEl = document.getElementById('lobby-timer-display');
  if (timerEl) timerEl.textContent = `Durasi diskusi: ${dayTimerDuration} detik`;
}

// ── ROLE REVEAL ───────────────────────────────────────────────────────────────

function renderRoleReveal(role, myCards) {
  const ROLES = {
    impostor:  { icon: '🎭', label: 'Impostor',  cssClass: 'impostor',
                 desc: 'Kamu adalah pengkhianat.\nBunuh atau rekrut targetmu di malam hari.\nBertahan hingga Ronde 3 tanpa tertangkap.' },
    protector: { icon: '🛡️', label: 'Protector', cssClass: 'protector',
                 desc: 'Kamu adalah pelindung.\nSetiap malam, pilih satu orang untuk dilindungi dari serangan.\nDukung Detektif menemukan Impostor.' },
    detective: { icon: '🔍', label: 'Detektif',  cssClass: 'detective',
                 desc: 'Kamu adalah Detektif.\nPerhatikan clue dari Narator.\nGunakan satu-satunya kesempatan menuduh dengan bijak!' }
  };

  const r = ROLES[role] || ROLES.detective;
  document.getElementById('role-icon').textContent  = r.icon;
  document.getElementById('role-name').textContent  = r.label;
  document.getElementById('role-name').className    = `role-name ${r.cssClass}`;
  document.getElementById('role-desc').textContent  = r.desc;
  document.getElementById('role-box').className     = `role-box role-${role}`;

  // Show my cards preview
  const preview = document.getElementById('my-cards-preview');
  preview.innerHTML = '';
  myCards.weapons.forEach(w => {
    const span = document.createElement('span');
    span.className   = 'mini-card weapon';
    span.textContent = w;
    preview.appendChild(span);
  });
  myCards.traces.forEach(t => {
    const span = document.createElement('span');
    span.className   = 'mini-card trace';
    span.textContent = t;
    preview.appendChild(span);
  });
}

// ── IMPOSTOR ACTION ───────────────────────────────────────────────────────────

function renderImpostorAction({ round, targets, actionOptions, myCards, usedCards }) {
  state.usedCards = usedCards || [];
  document.getElementById('imp-round').textContent = round;

  // ── Target list ───────────────────────────────────────────────────────────
  const targetList = document.getElementById('imp-target-list');
  targetList.innerHTML = '';
  targets.forEach(t => {
    const btn = document.createElement('button');
    btn.className       = 'target-btn';
    btn.textContent     = t.name;
    btn.dataset.targetId = t.id;
    btn.onclick         = () => selectImpostorTarget(t.id, t.name, btn);
    targetList.appendChild(btn);
  });

  // ── Weapon list ───────────────────────────────────────────────────────────
  const wList = document.getElementById('imp-weapon-list');
  wList.innerHTML = '';
  myCards.weapons.forEach(w => {
    const btn = document.createElement('button');
    const used = usedCards.includes(w);
    btn.className    = `card-sel-btn weapon-btn ${used ? 'used-card' : ''}`;
    btn.textContent  = w;
    btn.dataset.card = w;
    btn.onclick      = () => selectImpostorCard('weapon', w, btn);
    wList.appendChild(btn);
  });

  // ── Trace list ────────────────────────────────────────────────────────────
  const tList = document.getElementById('imp-trace-list');
  tList.innerHTML = '';
  myCards.traces.forEach(t => {
    const btn = document.createElement('button');
    const used = usedCards.includes(t);
    btn.className    = `card-sel-btn trace-btn ${used ? 'used-card' : ''}`;
    btn.textContent  = t;
    btn.dataset.card = t;
    btn.onclick      = () => selectImpostorCard('trace', t, btn);
    tList.appendChild(btn);
  });

  // ── Action buttons ────────────────────────────────────────────────────────
  const actBtns = document.getElementById('imp-action-buttons');
  actBtns.innerHTML = '';
  if (actionOptions.includes('kill')) {
    const btn = document.createElement('button');
    btn.className  = 'btn-danger';
    btn.textContent = '🗡️ BUNUH';
    btn.id         = 'btn-kill';
    btn.disabled   = true;
    btn.onclick    = () => submitImpostorAction('kill');
    actBtns.appendChild(btn);
  }
  if (actionOptions.includes('recruit')) {
    const btn = document.createElement('button');
    btn.className  = 'btn-gold';
    btn.textContent = '🤝 REKRUT';
    btn.id         = 'btn-recruit';
    btn.disabled   = true;
    btn.onclick    = () => submitImpostorAction('recruit');
    actBtns.appendChild(btn);
  }

  // Reset selection summary
  document.getElementById('imp-summary').innerHTML = '<span class="dim">Pilih target dan kartumu...</span>';

  // Store pending selections
  window._impSel = { targetId: null, targetName: null, weapon: null, trace: null };
}

function selectImpostorTarget(targetId, targetName, btn) {
  document.querySelectorAll('.target-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  window._impSel.targetId   = targetId;
  window._impSel.targetName = targetName;
  updateImpostorSummary();
  checkImpostorReady();
}

function selectImpostorCard(type, card, btn) {
  if (type === 'weapon') {
    document.querySelectorAll('#imp-weapon-list .card-sel-btn').forEach(b => b.classList.remove('selected'));
    window._impSel.weapon = card;
  } else {
    document.querySelectorAll('#imp-trace-list .card-sel-btn').forEach(b => b.classList.remove('selected'));
    window._impSel.trace = card;
  }
  btn.classList.add('selected');
  updateImpostorSummary();
  checkImpostorReady();
}

function updateImpostorSummary() {
  const sel = window._impSel;
  const el  = document.getElementById('imp-summary');
  if (!el) return;
  el.innerHTML = `
    Target: <span>${sel.targetName || '—'}</span> &nbsp;|&nbsp;
    Senjata: <span>${sel.weapon || '—'}</span> &nbsp;|&nbsp;
    Jejak: <span>${sel.trace || '—'}</span>
  `;
}

function checkImpostorReady() {
  const sel  = window._impSel;
  const ready = sel.targetId && sel.weapon && sel.trace;
  const kill    = document.getElementById('btn-kill');
  const recruit = document.getElementById('btn-recruit');
  if (kill)    kill.disabled    = !ready;
  if (recruit) recruit.disabled = !ready;
}

function submitImpostorAction(actionType) {
  const sel = window._impSel;
  if (!sel.targetId || !sel.weapon || !sel.trace) return;

  socket.emit('impostor_action', {
    targetId:   sel.targetId,
    weapon:     sel.weapon,
    trace:      sel.trace,
    actionType
  });

  // Disable all buttons to prevent double-submit
  document.querySelectorAll('#screen-impostor-action button').forEach(b => b.disabled = true);
}

// ── PROTECTOR ACTION ──────────────────────────────────────────────────────────

function renderProtectorAction({ targets }) {
  const list = document.getElementById('prot-target-list');
  list.innerHTML = '';
  window._protSel = null;

  targets.forEach(t => {
    const btn = document.createElement('button');
    btn.className         = 'target-btn';
    btn.textContent       = t.name + (t.id === state.playerId ? ' (Kamu)' : '');
    btn.dataset.targetId  = t.id;
    btn.onclick           = () => {
      document.querySelectorAll('#prot-target-list .target-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      window._protSel = t.id;
      document.getElementById('btn-protect').disabled = false;
    };
    list.appendChild(btn);
  });

  document.getElementById('btn-protect').disabled = true;
}

function submitProtectorAction() {
  if (!window._protSel) return;
  socket.emit('protector_action', { targetId: window._protSel });
  document.querySelectorAll('#screen-protector-action button').forEach(b => b.disabled = true);
}

// ── MORNING ───────────────────────────────────────────────────────────────────

function renderMorningStatus(playerList, newDeadId) {
  const grid = document.getElementById('morning-status-grid');
  grid.innerHTML = '';

  playerList.forEach(p => {
    const tag = document.createElement('span');
    const isNew = p.id === newDeadId;
    tag.className = `morning-player-tag ${p.isAlive ? 'alive' : 'dead'} ${isNew ? 'new-death' : ''}`;
    tag.textContent = `${p.isAlive ? '✓' : '✕'} ${p.name}`;
    grid.appendChild(tag);
  });
}

// ── DAY SCREEN ────────────────────────────────────────────────────────────────

function renderDayScreen(timerDuration) {
  document.getElementById('day-round').textContent = state.round;

  // Spectator indicator
  const specBadge = document.getElementById('spectator-badge');
  if (specBadge) specBadge.classList.toggle('hidden', !state.isSpectator);

  renderCardsGrid();
  updateAccusationPanelAccess();
  closeAccusationForm();
}

function renderCardsGrid() {
  const grid = document.getElementById('cards-grid');
  if (!grid) return;
  grid.innerHTML = '';

  // Sort: alive first
  const sorted = [...state.playerList].sort((a, b) => (b.isAlive ? 1 : 0) - (a.isAlive ? 1 : 0));

  sorted.forEach(player => {
    const cards = state.allCards[player.id];
    if (!cards) return;

    const block = document.createElement('div');
    const isSelf        = player.id === state.playerId;
    const canAccuse     = !state.isSpectator && state.isAlive && !state.hasGuessed &&
                           player.id !== state.playerId && player.isAlive &&
                           state.phase === 'day';

    block.className = [
      'player-card-block',
      !player.isAlive ? 'dead' : '',
      isSelf          ? 'self' : '',
      canAccuse       ? 'clickable' : ''
    ].join(' ').trim();

    if (canAccuse) {
      block.title   = `Klik untuk menuduh ${player.name}`;
      block.onclick = () => openAccusationForm(player);
    }

    // Name row
    let nameHtml = `<div class="pcb-name">
      ${escHtml(player.name)}
      ${isSelf ? '<span class="you-tag">Kamu</span>' : ''}
      ${!player.isAlive ? '💀' : ''}
      ${player.hasGuessed && player.isAlive ? '<span class="you-tag" style="background:#2a1a0d;color:#e8a070;">Sudah Tuduh</span>' : ''}
    </div>`;

    // Weapons row
    let wHtml = '<div class="card-row">';
    cards.weapons.forEach(w => {
      // Grey out only if: this is the impostor's own card block, AND player is the impostor, AND card was used
      const isUsed = isSelf && state.role === 'impostor' && state.usedCards.includes(w);
      wHtml += `<span class="game-card weapon ${isUsed ? 'used' : ''}" title="${isUsed ? '(dipakai)' : ''}">${escHtml(w)}</span>`;
    });
    wHtml += '</div>';

    // Traces row
    let tHtml = '<div class="card-row">';
    cards.traces.forEach(t => {
      const isUsed = isSelf && state.role === 'impostor' && state.usedCards.includes(t);
      tHtml += `<span class="game-card trace ${isUsed ? 'used' : ''}" title="${isUsed ? '(dipakai)' : ''}">${escHtml(t)}</span>`;
    });
    tHtml += '</div>';

    block.innerHTML = nameHtml + wHtml + tHtml;
    grid.appendChild(block);
  });
}

function updateAccusationPanelAccess() {
  const hint = document.getElementById('accusation-hint');
  if (!hint) return;

  if (state.isSpectator || !state.isAlive) {
    hint.textContent = '👁️ Mode Penonton — kamu sedang menonton game.';
    hint.className   = 'dim text-sm';
  } else if (state.hasGuessed) {
    hint.textContent = '⚠️ Kamu sudah menggunakan kesempatan menuduh.';
    hint.className   = 'text-sm' ;
    hint.style.color = '#c9a227';
  } else {
    hint.textContent = '🎯 Klik kartu pemain untuk menuduhnya. Hanya 1 kesempatan!';
    hint.className   = 'text-sm text-muted';
  }
}

// ── ACCUSATION FORM ───────────────────────────────────────────────────────────

function openAccusationForm(targetPlayer) {
  if (state.isSpectator || !state.isAlive || state.hasGuessed) return;
  if (state.phase !== 'day') return;

  const cards = state.allCards[targetPlayer.id];
  if (!cards) return;

  state.accusation = { accusedId: targetPlayer.id, weapon: null, trace: null };

  const panel = document.getElementById('accusation-panel');
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <h3>🎯 Menuduh: ${escHtml(targetPlayer.name)}</h3>
    <p class="text-sm text-muted mb-16">Pilih senjata DAN jejak yang kamu yakini digunakan pelaku. Jika salah, kamu akan tereliminasi!</p>

    <div class="acc-section">
      <label>🗡️ Pilih Senjata</label>
      <div id="acc-weapons-row">
        ${cards.weapons.map(w =>
          `<button class="acc-card-btn weapon" data-card="${escHtml(w)}" onclick="selectAccCard('weapon','${escHtml(w)}',this)">${escHtml(w)}</button>`
        ).join('')}
      </div>
    </div>

    <div class="acc-section">
      <label>👣 Pilih Jejak</label>
      <div id="acc-traces-row">
        ${cards.traces.map(t =>
          `<button class="acc-card-btn trace" data-card="${escHtml(t)}" onclick="selectAccCard('trace','${escHtml(t)}',this)">${escHtml(t)}</button>`
        ).join('')}
      </div>
    </div>

    <div id="acc-confirm-row" class="hidden mt-16">
      <p class="text-sm mb-8" style="color:var(--red)">⚠️ Yakin menuduh <strong>${escHtml(targetPlayer.name)}</strong>? Ini tidak bisa dibatalkan!</p>
    </div>

    <div class="acc-actions">
      <button id="btn-submit-acc" class="btn-danger" disabled onclick="submitAccusation('${targetPlayer.id}')">
        🔫 Tuduh Sekarang!
      </button>
      <button class="btn-ghost btn-sm" onclick="closeAccusationForm()">Batal</button>
    </div>
  `;

  // Scroll to form
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function selectAccCard(type, card, btn) {
  if (type === 'weapon') {
    document.querySelectorAll('#acc-weapons-row .acc-card-btn').forEach(b => b.classList.remove('selected'));
    state.accusation.weapon = card;
  } else {
    document.querySelectorAll('#acc-traces-row .acc-card-btn').forEach(b => b.classList.remove('selected'));
    state.accusation.trace = card;
  }
  btn.classList.add('selected');

  // Enable submit when both selected
  const submitBtn = document.getElementById('btn-submit-acc');
  if (submitBtn) {
    const ready = state.accusation.weapon && state.accusation.trace;
    submitBtn.disabled = !ready;
    if (ready) {
      document.getElementById('acc-confirm-row')?.classList.remove('hidden');
    }
  }
}

function submitAccusation(accusedId) {
  const { weapon, trace } = state.accusation;
  if (!weapon || !trace || !accusedId) return;

  socket.emit('submit_accusation', { accusedId, weapon, trace });
  state.hasGuessed = true;

  // Disable all form elements
  document.querySelectorAll('#accusation-panel button').forEach(b => b.disabled = true);
}

function closeAccusationForm() {
  const panel = document.getElementById('accusation-panel');
  if (panel) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  }
  state.accusation = { accusedId: null, weapon: null, trace: null };
}

// ── TIMER ─────────────────────────────────────────────────────────────────────

function startDayTimer(seconds) {
  stopDayTimer();
  state.timerSeconds = seconds;
  renderTimer();

  state.timerInterval = setInterval(() => {
    state.timerSeconds--;
    renderTimer();
    if (state.timerSeconds <= 0) stopDayTimer();
  }, 1000);
}

function stopDayTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

function renderTimer() {
  const el = document.getElementById('day-timer');
  if (!el) return;

  const m = Math.floor(state.timerSeconds / 60);
  const s = state.timerSeconds % 60;
  el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  el.classList.toggle('urgent', state.timerSeconds <= 15);
}

// ── GAME OVER ─────────────────────────────────────────────────────────────────

function renderGameOver({ winner, impostorId, impostorName, protectorId, protectorName,
                           impostorUsedCards, recruits, rounds, history, allPlayers, allCards }) {
  // Winner title
  const titleEl = document.getElementById('gameover-title');
  titleEl.textContent = winner === 'detective' ? '🔍 Para Detektif Menang!' : '🎭 Impostor Menang!';
  titleEl.className   = `winner-title ${winner}`;

  // Role reveals
  const rolesEl = document.getElementById('go-roles');
  rolesEl.innerHTML = '';

  const roleCards = [
    { label: '🎭 Impostor', name: impostorName, cls: 'rrc-impostor',
      extra: `Kartu dipakai: ${impostorUsedCards.join(', ') || '—'}` },
    { label: '🛡️ Protector', name: protectorName, cls: 'rrc-protector', extra: '' }
  ];
  recruits.forEach(r => {
    roleCards.push({ label: '🤝 Rekrutan', name: r.name, cls: 'rrc-recruit', extra: 'Berpihak pada Impostor' });
  });

  roleCards.forEach(({ label, name, cls, extra }) => {
    rolesEl.innerHTML += `
      <div class="role-reveal-card ${cls}">
        <div class="rrc-role">${label}</div>
        <div class="rrc-name">${escHtml(name)}</div>
        ${extra ? `<div class="text-sm text-muted mt-8">${escHtml(extra)}</div>` : ''}
      </div>
    `;
  });

  // History log
  const histEl = document.getElementById('go-history');
  histEl.innerHTML = '';

  history.forEach(entry => {
    const div = document.createElement('div');
    if (entry.type === 'night') {
      div.className = 'history-entry night';
      const outcomeText = {
        killed:    `💀 ${entry.targetName} dibunuh (${entry.weapon}, ${entry.trace})`,
        recruited: `🤝 ${entry.targetName} direkrut (${entry.weapon}, ${entry.trace})`,
        blocked:   `🛡️ Serangan digagalkan (${entry.weapon}, ${entry.trace})`,
        none:      `😴 Malam tenang, tidak ada kejadian`
      }[entry.outcome] || '?';
      div.innerHTML = `<strong>Ronde ${entry.round} — Malam:</strong> ${outcomeText}`;
    } else if (entry.type === 'accusation') {
      div.className = `history-entry day-acc ${entry.isCorrect ? 'correct' : 'wrong-acc'}`;
      div.innerHTML = `
        <strong>Ronde ${entry.round} — Tuduhan:</strong>
        ${escHtml(entry.accuserName)} menuduh ${escHtml(entry.accusedName)}
        (${escHtml(entry.weapon)}, ${escHtml(entry.trace)})
        — ${entry.isCorrect ? '✅ BENAR' : '❌ SALAH'}
      `;
    }
    histEl.appendChild(div);
  });

  // All players final status
  const playersEl = document.getElementById('go-players');
  playersEl.innerHTML = allPlayers.map(p => {
    const roleLabel = { impostor: '🎭 Impostor', protector: '🛡️ Protector',
                        detective: '🔍 Detektif', recruit: '🤝 Rekrutan' }[p.role] || '?';
    return `<div class="player-entry">
      <div class="ready-indicator ${p.isAlive ? 'ready' : ''}"></div>
      <span class="pname">${escHtml(p.name)}</span>
      <span class="badge badge-wait">${roleLabel}</span>
      <span class="badge ${p.isAlive ? 'badge-ready' : 'badge-wait'}">${p.isAlive ? 'Hidup' : 'Mati'}</span>
    </div>`;
  }).join('');

  // Reset vote info
  const voteInfo = document.getElementById('play-again-vote-info');
  if (voteInfo) voteInfo.textContent = '';
}

// ─────────────────────────────────────────────────────────────────────────────
//  USER INTERACTION BINDINGS (DOM event listeners)
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

  // ── Voice toggle ─────────────────────────────────────────────────────────
  const voiceBtn = document.getElementById('btn-voice-toggle');
  if (voiceBtn) {
    voiceBtn.addEventListener('click', () => {
      voice.toggle();
      // If just enabled, re-speak current intro text if available
      if (voice.enabled) {
        const introText = document.getElementById('intro-text')?.textContent;
        if (introText && introText.length > 20) voice.speak(introText);
      }
    });
  }

  // ── Join ──────────────────────────────────────────────────────────────────
  const joinInput = document.getElementById('name-input');
  const joinBtn   = document.getElementById('btn-join');

  function doJoin() {
    const name = joinInput.value.trim();
    if (!name) { joinInput.focus(); return; }
    state.playerName = name;
    socket.emit('join_lobby', { name });
    joinBtn.disabled = true;
    joinBtn.textContent = 'Masuk...';
  }

  joinBtn.addEventListener('click', doJoin);
  joinInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

  // ── Lobby ─────────────────────────────────────────────────────────────────
  document.getElementById('btn-ready').addEventListener('click', () => {
    const self = state.playerList.find(p => p.id === state.playerId);
    const newReady = self ? !self.isReady : true;
    socket.emit('set_ready', { ready: newReady });
  });

  document.getElementById('day-timer-input').addEventListener('change', (e) => {
    socket.emit('host_config', { dayTimerDuration: parseInt(e.target.value) || 120 });
  });

  // ── Intro skip ────────────────────────────────────────────────────────────
  document.getElementById('btn-skip-intro').addEventListener('click', () => {
    socket.emit('vote_skip_intro');
    document.getElementById('btn-skip-intro').disabled = true;
    document.getElementById('btn-skip-intro').textContent = 'Skip terkirim...';
  });

  // ── Role reveal → proceed ─────────────────────────────────────────────────
  document.getElementById('btn-role-proceed').addEventListener('click', () => {
    // Just go to intro screen which is already being shown
    showScreen('screen-intro');
    // Re-show the intro if we already got narrator_text
    // (game_start → role_reveal → intro are in sequence)
  });

  // ── Protector action ──────────────────────────────────────────────────────
  document.getElementById('btn-protect').addEventListener('click', submitProtectorAction);

  // ── Play Again ────────────────────────────────────────────────────────────
  document.getElementById('btn-play-again').addEventListener('click', () => {
    socket.emit('play_again');
    document.getElementById('btn-play-again').textContent = 'Menunggu vote...';
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  UTILITY
// ─────────────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
