'use strict';

require('dotenv').config();

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');
const { GameManager } = require('./game/GameManager');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout:  60_000,
  pingInterval: 25_000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Single Game Room ────────────────────────────────────────────────────────
// One global GameManager handles all players in a single room.
// For multi-room support, extend with a RoomManager layer.
const game = new GameManager(io);

io.on('connection', (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // ── Lobby ─────────────────────────────────────────────────────────────────
  socket.on('join_lobby',   ({ name })                   => game.handleJoinLobby(socket, name));
  socket.on('set_ready',    ({ ready })                  => game.handleSetReady(socket, ready));
  socket.on('host_config',  (cfg)                        => game.handleHostConfig(socket, cfg));

  // ── Intro ─────────────────────────────────────────────────────────────────
  socket.on('vote_skip_intro', ()                        => game.handleVoteSkipIntro(socket));

  // ── Night ─────────────────────────────────────────────────────────────────
  socket.on('impostor_action',  (data)                   => game.handleImpostorAction(socket, data));
  socket.on('protector_action', (data)                   => game.handleProtectorAction(socket, data));

  // ── Day ───────────────────────────────────────────────────────────────────
  socket.on('submit_accusation', (data)                  => game.handleAccusation(socket, data));

  // ── Post-Game ─────────────────────────────────────────────────────────────
  socket.on('play_again',   ()                           => game.handlePlayAgain(socket));

  // ── System ────────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Socket disconnected: ${socket.id}`);
    game.handleDisconnect(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎭 Deduksi Game Server running → http://localhost:${PORT}\n`);
});
