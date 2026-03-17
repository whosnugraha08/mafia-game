'use strict';

const CardPool = require('./CardPool');
const AINarrator = require('./AINarrator');

// ─── Phase Constants ─────────────────────────────────────────────────────────
const PHASES = {
  LOBBY:            'lobby',
  INTRO:            'intro',
  NIGHT_IMPOSTOR:   'night_impostor',
  NIGHT_PROTECTOR:  'night_protector',
  MORNING:          'morning',
  DAY:              'day',
  GAME_OVER:        'game_over'
};

const MAX_ROUNDS = 3;
const NIGHT_ACTION_TIMEOUT_MS = 90_000;   // 90s auto-skip for night actions
const MORNING_READ_DELAY_MS   = 9_000;    // 9s to read morning narrative
const NIGHT_TRANSITION_MS     = 2_500;    // delay between night-phase steps

// ─── GameManager ─────────────────────────────────────────────────────────────
class GameManager {
  constructor(io) {
    this.io       = io;
    this.narrator = new AINarrator();
    this.state    = this._createInitialState();

    // Pending timers (tracked for cleanup)
    this._timers  = {};
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  STATE FACTORY & RESET
  // ═══════════════════════════════════════════════════════════════════════════

  _createInitialState() {
    return {
      phase:              PHASES.LOBBY,
      round:              0,
      players:            {},   // socketId → playerData
      impostorId:         null,
      protectorId:        null,
      pendingImpostor:    null, // { targetId, weapon, trace, actionType }
      pendingProtector:   null, // { targetId }
      skipVotes:          new Set(),
      playAgainVotes:     new Set(),
      dayTimerDuration:   120,  // seconds (host-configurable)
      gameHistory:        [],   // narrative log
      hostId:             null
    };
  }

  /** Full reset while preserving connected players back to lobby */
  resetState() {
    this._clearAllTimers();

    // Snapshot current connected players (by socket.id)
    const survivors = Object.values(this.state.players).map(p => ({
      id:   p.id,
      name: p.name
    }));
    const prevHost        = this.state.hostId;
    const prevTimerDuration = this.state.dayTimerDuration;

    // Fresh state
    this.state = this._createInitialState();
    this.state.dayTimerDuration = prevTimerDuration;

    // Re-insert players as fresh lobby entries
    survivors.forEach(p => {
      this.state.players[p.id] = this._createPlayer(p.id, p.name);
    });

    // Re-assign host
    if (survivors.length > 0) {
      const newHost = survivors.find(p => p.id === prevHost) || survivors[0];
      this.state.hostId = newHost.id;
    }
  }

  _createPlayer(id, name) {
    return {
      id,
      name,
      role:        null,   // 'impostor' | 'protector' | 'detective' | 'recruit'
      isAlive:     true,
      isReady:     false,
      isSpectator: false,
      hasGuessed:  false,
      isRecruit:   false,
      cards:       { weapons: [], traces: [] },
      usedCards:   []      // accumulates across rounds; ONLY sent to impostor
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TIMER HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  _setTimer(key, fn, ms) {
    this._clearTimer(key);
    this._timers[key] = setTimeout(() => {
      delete this._timers[key];
      fn();
    }, ms);
  }

  _clearTimer(key) {
    if (this._timers[key]) {
      clearTimeout(this._timers[key]);
      delete this._timers[key];
    }
  }

  _clearAllTimers() {
    Object.keys(this._timers).forEach(k => clearTimeout(this._timers[k]));
    this._timers = {};
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LOBBY HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════

  handleJoinLobby(socket, rawName) {
    if (this.state.phase !== PHASES.LOBBY) {
      socket.emit('error_msg', { message: 'Game sedang berjalan. Tunggu hingga selesai.' });
      return;
    }

    const name = String(rawName || '').trim().slice(0, 20) || `Pemain_${Date.now() % 9999}`;

    // Prevent duplicate names
    if (Object.values(this.state.players).some(p => p.name === name)) {
      socket.emit('error_msg', { message: `Nama "${name}" sudah dipakai. Coba nama lain.` });
      return;
    }

    const isFirstPlayer = Object.keys(this.state.players).length === 0;
    this.state.players[socket.id] = this._createPlayer(socket.id, name);

    if (isFirstPlayer) {
      this.state.hostId = socket.id;
    }

    socket.join('game-room');

    socket.emit('joined_lobby', {
      playerId:         socket.id,
      isHost:           socket.id === this.state.hostId,
      dayTimerDuration: this.state.dayTimerDuration
    });

    this._broadcastLobbyUpdate();
  }

  handleSetReady(socket, ready) {
    const player = this.state.players[socket.id];
    if (!player || this.state.phase !== PHASES.LOBBY) return;

    player.isReady = !!ready;
    this._broadcastLobbyUpdate();
    this._checkLobbyStart();
  }

  handleHostConfig(socket, { dayTimerDuration }) {
    if (socket.id !== this.state.hostId)    return;
    if (this.state.phase !== PHASES.LOBBY)  return;

    const duration = Math.max(30, Math.min(600, parseInt(dayTimerDuration) || 120));
    this.state.dayTimerDuration = duration;
    this._broadcastLobbyUpdate();
  }

  _checkLobbyStart() {
    const players   = Object.values(this.state.players);
    const readyAll  = players.length >= 4 && players.every(p => p.isReady);
    if (readyAll) this._startGame();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GAME START & INTRO
  // ═══════════════════════════════════════════════════════════════════════════

  _startGame() {
    const players = Object.values(this.state.players);

    // ── Assign Roles ──────────────────────────────────────────────────────
    const shuffled = [...players].sort(() => Math.random() - 0.5);
    shuffled[0].role = 'impostor';
    shuffled[1].role = 'protector';
    for (let i = 2; i < shuffled.length; i++) shuffled[i].role = 'detective';

    this.state.impostorId  = shuffled[0].id;
    this.state.protectorId = shuffled[1].id;

    // ── Distribute Cards ──────────────────────────────────────────────────
    const { weaponPool, tracePool } = CardPool.getShuffledPools();
    let wi = 0, ti = 0;
    players.forEach(p => {
      p.cards.weapons = weaponPool.slice(wi, wi + 3);
      p.cards.traces  = tracePool.slice(ti, ti + 3);
      wi += 3;
      ti += 3;
    });

    // ── Build public card map (all 6 cards for every player, visible to all) ──
    const allCards = {};
    players.forEach(p => { allCards[p.id] = { weapons: p.cards.weapons, traces: p.cards.traces }; });

    // ── Send per-player private game_start ────────────────────────────────
    players.forEach(p => {
      const sock = this.io.sockets.sockets.get(p.id);
      if (!sock) return;
      sock.emit('game_start', {
        playerId:   p.id,
        role:       p.role,
        myCards:    p.cards,
        allCards,
        playerList: this._publicPlayerList()
      });
    });

    this.state.phase = PHASES.INTRO;
    this._runIntroNarration();
  }

  async _runIntroNarration() {
    this.state.skipVotes.clear();
    const playerCount = Object.keys(this.state.players).length;

    this.io.to('game-room').emit('phase_change', { phase: PHASES.INTRO });
    this.io.to('game-room').emit('skip_vote_update', { voted: 0, total: playerCount });

    try {
      const text = await this.narrator.generateIntro(playerCount);
      this.io.to('game-room').emit('narrator_text', { text });
    } catch (err) {
      console.error('[AINarrator] Intro failed:', err.message);
      this.io.to('game-room').emit('narrator_text', {
        text: 'Kegelapan menyelimuti desa kecil yang terisolir ini. Di antara wajah-wajah yang tampak polos, tersembunyi satu jiwa yang menyimpan niat kelam.\n\nPara Detektif, tugas kalian dimulai malam ini. Temukan pengkhianat sebelum semuanya terlambat...'
      });
    }
  }

  handleVoteSkipIntro(socket) {
    if (this.state.phase !== PHASES.INTRO) return;
    if (!this.state.players[socket.id])    return;

    this.state.skipVotes.add(socket.id);

    const total    = Object.keys(this.state.players).length;
    const voted    = this.state.skipVotes.size;
    const allVoted = voted >= total;

    this.io.to('game-room').emit('skip_vote_update', { voted, total });

    if (allVoted) this._startNight();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  NIGHT PHASE
  // ═══════════════════════════════════════════════════════════════════════════

  _startNight() {
    this.state.round++;
    this.state.pendingImpostor  = null;
    this.state.pendingProtector = null;
    this.state.phase            = PHASES.NIGHT_IMPOSTOR;

    // Black out ALL screens
    this.io.to('game-room').emit('screen_black', {
      isBlack: true,
      message: `Ronde ${this.state.round} — Malam tiba... Semua tutup mata.`
    });

    this._setTimer('wakeImpostor', () => this._wakeImpostor(), NIGHT_TRANSITION_MS);
  }

  _wakeImpostor() {
    const impostor = this.state.players[this.state.impostorId];
    const sock     = this.io.sockets.sockets.get(this.state.impostorId);

    if (!impostor || !impostor.isAlive || !sock) {
      // Impostor is dead / disconnected — auto-skip
      this._endImpostorTurn();
      return;
    }

    const targets = Object.values(this.state.players).filter(
      p => p.id !== this.state.impostorId && p.isAlive
    );

    sock.emit('screen_black', { isBlack: false });
    sock.emit('impostor_turn', {
      round:         this.state.round,
      targets:       targets.map(p => ({ id: p.id, name: p.name })),
      actionOptions: this.state.round === 1 ? ['kill', 'recruit'] : ['kill'],
      myCards:       impostor.cards,
      usedCards:     impostor.usedCards   // ← ONLY impostor receives this
    });

    // Auto-skip if impostor doesn't respond in time
    this._setTimer('impostorTimeout', () => {
      if (this.state.phase === PHASES.NIGHT_IMPOSTOR) {
        console.log('[AutoSkip] Impostor timed out');
        this._endImpostorTurn();
      }
    }, NIGHT_ACTION_TIMEOUT_MS);
  }

  handleImpostorAction(socket, { targetId, weapon, trace, actionType }) {
    if (socket.id !== this.state.impostorId)      return;
    if (this.state.phase !== PHASES.NIGHT_IMPOSTOR) return;

    const impostor = this.state.players[socket.id];
    const target   = this.state.players[targetId];

    // ── Validate ──────────────────────────────────────────────────────────
    if (!target || !target.isAlive) {
      socket.emit('action_error', { message: 'Target tidak valid atau sudah mati.' });
      return;
    }
    if (!impostor.cards.weapons.includes(weapon)) {
      socket.emit('action_error', { message: 'Senjata tidak ada dalam kartumu.' });
      return;
    }
    if (!impostor.cards.traces.includes(trace)) {
      socket.emit('action_error', { message: 'Jejak tidak ada dalam kartumu.' });
      return;
    }
    if (actionType === 'recruit' && this.state.round !== 1) {
      socket.emit('action_error', { message: 'Rekrut hanya tersedia di Ronde 1.' });
      return;
    }

    this._clearTimer('impostorTimeout');

    // Track used cards (accumulative, all rounds)
    if (!impostor.usedCards.includes(weapon)) impostor.usedCards.push(weapon);
    if (!impostor.usedCards.includes(trace))  impostor.usedCards.push(trace);

    this.state.pendingImpostor = { targetId, weapon, trace, actionType };

    // Confirm to impostor that action was registered
    socket.emit('action_confirmed', { weapon, trace, actionType, targetName: target.name });

    this._endImpostorTurn();
  }

  _endImpostorTurn() {
    // Black out impostor's screen again
    const sock = this.io.sockets.sockets.get(this.state.impostorId);
    if (sock) sock.emit('screen_black', { isBlack: true });

    this.state.phase = PHASES.NIGHT_PROTECTOR;

    this._setTimer('wakeProtector', () => this._wakeProtector(), NIGHT_TRANSITION_MS);
  }

  _wakeProtector() {
    const protector = this.state.players[this.state.protectorId];
    const sock      = this.io.sockets.sockets.get(this.state.protectorId);

    if (!protector || !protector.isAlive || !sock) {
      // Protector dead / disconnected — auto-skip
      this._endProtectorTurn();
      return;
    }

    const targets = Object.values(this.state.players).filter(p => p.isAlive);

    sock.emit('screen_black', { isBlack: false });
    sock.emit('protector_turn', {
      targets: targets.map(p => ({ id: p.id, name: p.name }))
    });

    this._setTimer('protectorTimeout', () => {
      if (this.state.phase === PHASES.NIGHT_PROTECTOR) {
        console.log('[AutoSkip] Protector timed out');
        this._endProtectorTurn();
      }
    }, NIGHT_ACTION_TIMEOUT_MS);
  }

  handleProtectorAction(socket, { targetId }) {
    if (socket.id !== this.state.protectorId)       return;
    if (this.state.phase !== PHASES.NIGHT_PROTECTOR) return;

    const target = this.state.players[targetId];
    if (!target || !target.isAlive) {
      socket.emit('action_error', { message: 'Target tidak valid.' });
      return;
    }

    this._clearTimer('protectorTimeout');
    this.state.pendingProtector = { targetId };

    socket.emit('action_confirmed', { targetName: target.name });
    this._endProtectorTurn();
  }

  _endProtectorTurn() {
    const sock = this.io.sockets.sockets.get(this.state.protectorId);
    if (sock) sock.emit('screen_black', { isBlack: true });

    this._setTimer('startMorning', () => this._startMorning(), NIGHT_TRANSITION_MS);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  MORNING PHASE
  // ═══════════════════════════════════════════════════════════════════════════

  async _startMorning() {
    this.state.phase = PHASES.MORNING;

    // Wake everyone up
    this.io.to('game-room').emit('screen_black', { isBlack: false });
    this.io.to('game-room').emit('phase_change', {
      phase:   PHASES.MORNING,
      round:   this.state.round,
      message: 'Pagi tiba... Semua bangun!'
    });

    const ia = this.state.pendingImpostor;
    const pa = this.state.pendingProtector;

    // ── Resolve night actions ──────────────────────────────────────────────
    let outcome     = 'none';
    let targetPlayer = null;

    if (ia) {
      targetPlayer         = this.state.players[ia.targetId];
      const isProtected    = pa && pa.targetId === ia.targetId;

      if (isProtected) {
        outcome = 'blocked';
      } else if (ia.actionType === 'kill') {
        outcome             = 'killed';
        targetPlayer.isAlive    = false;
        targetPlayer.isSpectator = true;
      } else if (ia.actionType === 'recruit') {
        outcome             = 'recruited';
        targetPlayer.isRecruit  = true;
        targetPlayer.role       = 'recruit';

        // ── Secret notification to recruited player ────────────────────
        const recruitSock = this.io.sockets.sockets.get(targetPlayer.id);
        if (recruitSock) {
          recruitSock.emit('secret_notification', {
            message: `🤫 Semalam kamu direkrut ke sisi gelap.\nKamu kini diam-diam berpihak pada Impostor.\nJika Impostor menang, kamu menang. Jika tertangkap, kamu kalah.\nJangan tunjukkan reaksi apapun!`
          });
        }
      }
    }

    // ── Record history ─────────────────────────────────────────────────────
    this.state.gameHistory.push({
      type:      'night',
      round:     this.state.round,
      outcome,
      targetId:  targetPlayer?.id   || null,
      targetName:targetPlayer?.name || null,
      weapon:    ia?.weapon  || null,
      trace:     ia?.trace   || null
    });

    // ── Generate AI narrative ──────────────────────────────────────────────
    let narrative;
    try {
      narrative = await this.narrator.generateMorningNarrative({
        outcome,
        targetName: targetPlayer?.name || null,
        weapon:     ia?.weapon  || null,
        trace:      ia?.trace   || null,
        round:      this.state.round
      });
    } catch (err) {
      console.error('[AINarrator] Morning failed:', err.message);
      narrative = AINarrator.getFallback(outcome, targetPlayer?.name, ia?.weapon, ia?.trace);
    }

    // ── Broadcast morning result ───────────────────────────────────────────
    this.io.to('game-room').emit('morning_result', {
      narrative,
      outcome,
      deadPlayerId: outcome === 'killed' ? targetPlayer?.id   : null,
      deadPlayerName: outcome === 'killed' ? targetPlayer?.name : null,
      round:        this.state.round,
      playerList:   this._publicPlayerList()
    });

    // ── Win condition check: ≤2 alive (impostor + 1 or 0 other) ───────────
    if (this._checkImpostorWinCondition()) {
      this._setTimer('endGame', () => this._endGame('impostor'), 4000);
      return;
    }

    // ── Proceed to Day after narrative reading time ────────────────────────
    this._setTimer('startDay', () => this._startDay(), MORNING_READ_DELAY_MS);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DAY PHASE
  // ═══════════════════════════════════════════════════════════════════════════

  _startDay() {
    this.state.phase = PHASES.DAY;

    this.io.to('game-room').emit('phase_change', {
      phase:   PHASES.DAY,
      round:   this.state.round,
      message: `Ronde ${this.state.round} — Siang Hari. Diskusikan dan temukan pelakunya!`
    });

    this.io.to('game-room').emit('day_start', {
      timerDuration: this.state.dayTimerDuration,
      round:         this.state.round,
      playerList:    this._publicPlayerList()
    });

    this._setTimer('dayTimer', () => this._endDay(), this.state.dayTimerDuration * 1000);
  }

  handleAccusation(socket, { accusedId, weapon, trace }) {
    if (this.state.phase !== PHASES.DAY) return;

    const accuser = this.state.players[socket.id];
    const accused = this.state.players[accusedId];

    // ── Guard checks ──────────────────────────────────────────────────────
    if (!accuser || !accuser.isAlive || accuser.isSpectator) return;
    if (accuser.hasGuessed) {
      socket.emit('error_msg', { message: 'Kamu sudah pernah menuduh. Hanya 1 kesempatan!' });
      return;
    }
    if (!accused || !accused.isAlive) {
      socket.emit('error_msg', { message: 'Tidak bisa menuduh pemain yang sudah mati.' });
      return;
    }
    if (accusedId === socket.id) {
      socket.emit('error_msg', { message: 'Kamu tidak bisa menuduh diri sendiri.' });
      return;
    }
    // Must pick weapon from accused's cards
    if (!accused.cards.weapons.includes(weapon) || !accused.cards.traces.includes(trace)) {
      socket.emit('error_msg', { message: 'Kartu yang dipilih tidak ada dalam daftar kartunya.' });
      return;
    }

    accuser.hasGuessed = true;

    const impostor     = this.state.players[this.state.impostorId];
    const correctTarget = accusedId === this.state.impostorId;
    const correctWeapon = impostor.usedCards.includes(weapon);
    const correctTrace  = impostor.usedCards.includes(trace);
    const isCorrect     = correctTarget && correctWeapon && correctTrace;

    // ── Log accusation ─────────────────────────────────────────────────────
    this.state.gameHistory.push({
      type:        'accusation',
      round:       this.state.round,
      accuserId:   socket.id,
      accuserName: accuser.name,
      accusedId,
      accusedName: accused.name,
      weapon,
      trace,
      isCorrect
    });

    if (isCorrect) {
      // ── DETECTIVE WINS ─────────────────────────────────────────────────
      this._clearTimer('dayTimer');
      this.io.to('game-room').emit('accusation_result', {
        accuserId:   socket.id,
        accuserName: accuser.name,
        accusedId,
        accusedName: accused.name,
        weapon,
        trace,
        isCorrect:   true,
        message:     `✅ ${accuser.name} berhasil mengungkap Impostor!\n"${accused.name}" adalah pelakunya dengan ${weapon} dan ${trace}!`
      });
      this._setTimer('endGame', () => this._endGame('detective'), 3500);

    } else {
      // ── WRONG ACCUSATION — accuser dies ───────────────────────────────
      accuser.isAlive    = false;
      accuser.isSpectator = true;

      this.io.to('game-room').emit('accusation_result', {
        accuserId:   socket.id,
        accuserName: accuser.name,
        accusedId,
        accusedName: accused.name,
        weapon,
        trace,
        isCorrect:   false,
        message:     `❌ ${accuser.name} salah menuduh dan tereliminasi!\n(${accused.name} bukan pelakunya)`
      });

      const accuserSock = this.io.sockets.sockets.get(socket.id);
      if (accuserSock) accuserSock.emit('you_died', { reason: 'wrong_accusation' });

      this.io.to('game-room').emit('player_update', { playerList: this._publicPlayerList() });

      // ── Check win after death ─────────────────────────────────────────
      if (this._checkImpostorWinCondition()) {
        this._clearTimer('dayTimer');
        this._setTimer('endGame', () => this._endGame('impostor'), 3000);
      }
    }
  }

  _endDay() {
    if (this.state.phase !== PHASES.DAY) return;

    this.io.to('game-room').emit('day_ended', {
      message: this.state.round >= MAX_ROUNDS
        ? 'Waktu habis! Impostor berhasil lolos...'
        : 'Waktu habis! Malam kembali tiba...'
    });

    if (this.state.round >= MAX_ROUNDS) {
      this._setTimer('endGame', () => this._endGame('impostor'), 3000);
    } else {
      this._setTimer('startNight', () => this._startNight(), 3000);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GAME OVER
  // ═══════════════════════════════════════════════════════════════════════════

  _checkImpostorWinCondition() {
    const alive       = Object.values(this.state.players).filter(p => p.isAlive);
    const impostorAlive = alive.some(p => p.id === this.state.impostorId);
    if (!impostorAlive) return false;  // Impossible normally, but guard anyway

    const aliveOthers = alive.filter(p => p.id !== this.state.impostorId);
    return aliveOthers.length <= 1;
  }

  _endGame(winner) {
    if (this.state.phase === PHASES.GAME_OVER) return; // Guard: only once
    this.state.phase = PHASES.GAME_OVER;
    this._clearAllTimers();

    const impostor  = this.state.players[this.state.impostorId];
    const protector = this.state.players[this.state.protectorId];
    const recruits  = Object.values(this.state.players)
      .filter(p => p.isRecruit)
      .map(p => ({ id: p.id, name: p.name }));

    // Full card reveal at game end
    const allCards = {};
    Object.values(this.state.players).forEach(p => {
      allCards[p.id] = { weapons: p.cards.weapons, traces: p.cards.traces };
    });

    this.io.to('game-room').emit('game_over', {
      winner,
      impostorId:    this.state.impostorId,
      impostorName:  impostor?.name  || '???',
      protectorId:   this.state.protectorId,
      protectorName: protector?.name || '???',
      impostorUsedCards: impostor?.usedCards || [],
      recruits,
      rounds:        this.state.round,
      history:       this.state.gameHistory,
      allPlayers:    Object.values(this.state.players).map(p => ({
        id:        p.id,
        name:      p.name,
        role:      p.role,
        isAlive:   p.isAlive
      })),
      allCards
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PLAY AGAIN
  // ═══════════════════════════════════════════════════════════════════════════

  handlePlayAgain(socket) {
    if (this.state.phase !== PHASES.GAME_OVER) return;
    if (!this.state.players[socket.id])        return;

    this.state.playAgainVotes.add(socket.id);

    const total     = Object.keys(this.state.players).length;
    const voted     = this.state.playAgainVotes.size;
    const threshold = Math.ceil(total / 2); // simple majority

    this.io.to('game-room').emit('play_again_vote', { voted, total, threshold });

    if (voted >= threshold) {
      this.resetState();
      this.io.to('game-room').emit('lobby_reset', {
        players:          this._publicPlayerList(),
        hostId:           this.state.hostId,
        dayTimerDuration: this.state.dayTimerDuration
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DISCONNECT
  // ═══════════════════════════════════════════════════════════════════════════

  handleDisconnect(socket) {
    const player = this.state.players[socket.id];
    if (!player) return;

    console.log(`[Disconnect] ${player.name} (${socket.id}) — phase: ${this.state.phase}`);

    if (this.state.phase === PHASES.LOBBY) {
      delete this.state.players[socket.id];
      // Re-assign host if needed
      if (socket.id === this.state.hostId) {
        const remaining = Object.keys(this.state.players);
        this.state.hostId = remaining[0] || null;
        if (this.state.hostId) {
          const newHostSock = this.io.sockets.sockets.get(this.state.hostId);
          if (newHostSock) newHostSock.emit('you_are_host');
        }
      }
      this._broadcastLobbyUpdate();
      return;
    }

    // Mid-game disconnect → spectate
    player.isAlive    = false;
    player.isSpectator = true;

    this.io.to('game-room').emit('player_disconnected', {
      playerId:   socket.id,
      name:       player.name,
      playerList: this._publicPlayerList()
    });

    // Auto-skip if it's their night turn
    if (socket.id === this.state.impostorId && this.state.phase === PHASES.NIGHT_IMPOSTOR) {
      this._clearTimer('impostorTimeout');
      this._endImpostorTurn();
      return;
    }
    if (socket.id === this.state.protectorId && this.state.phase === PHASES.NIGHT_PROTECTOR) {
      this._clearTimer('protectorTimeout');
      this._endProtectorTurn();
      return;
    }

    // Win condition check
    if (this._checkImpostorWinCondition() && this.state.phase !== PHASES.GAME_OVER) {
      this._clearTimer('dayTimer');
      this._endGame('impostor');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  BROADCAST HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  _broadcastLobbyUpdate() {
    const players  = Object.values(this.state.players);
    const readyAll = players.length >= 4 && players.every(p => p.isReady);

    this.io.to('game-room').emit('lobby_update', {
      players:          players.map(p => ({
        id:      p.id,
        name:    p.name,
        isReady: p.isReady,
        isHost:  p.id === this.state.hostId
      })),
      hostId:           this.state.hostId,
      dayTimerDuration: this.state.dayTimerDuration,
      canStart:         readyAll
    });
  }

  /** Public player list — roles are NEVER revealed during an active game */
  _publicPlayerList() {
    return Object.values(this.state.players).map(p => ({
      id:          p.id,
      name:        p.name,
      isAlive:     p.isAlive,
      isSpectator: p.isSpectator,
      hasGuessed:  p.hasGuessed,
      role:        null  // hidden during game; revealed on game_over
    }));
  }
}

module.exports = { GameManager, PHASES };
