import { WebSocketServer } from 'ws';
import { MicReceiver } from './audio/micReceiver.js';
import { createStaticServer } from './staticServer.js';

const AUTH_TIMEOUT_MS = 5000;

export class LocalWsServer {
  constructor({ port, token, obs, chat, helix, pcmPlayer }) {
    this.port = port;
    this.token = token;
    this.obs = obs;
    this.chat = chat;
    this.helix = helix;
    this.pcmPlayer = pcmPlayer;
    this.wss = null;
    this.authedClients = new Set();
  }

  start() {
    // Même port pour les fichiers statiques (public/, testable depuis le
    // téléphone en HTTP) et le WebSocket (upgrade sur le même serveur HTTP).
    this.httpServer = createStaticServer();
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.httpServer.listen(this.port);

    this.wss.on('connection', (ws) => this._handleConnection(ws));

    // Relaie les évènements OBS et le chat Twitch vers tous les clients
    // authentifiés (dashboard, chat live, notifications).
    this.obs.on('event', (payload) => this._broadcast({ type: 'event', ...payload }));
    this.obs.on('status', (status) => this._broadcast({ type: 'event', name: 'obs.connection', ...status }));
    this.chat.on('message', (msg) => this._broadcast({ type: 'event', name: 'chat.message', ...msg }));
    this.chat.on('status', (status) => this._broadcast({ type: 'event', name: 'twitch.connection', ...status }));

    console.log(`[http+ws] public/ + serveur local en écoute sur le port ${this.port}`);
  }

  _broadcast(payload) {
    const raw = JSON.stringify(payload);
    for (const ws of this.authedClients) {
      if (ws.readyState === ws.OPEN) ws.send(raw);
    }
  }

  _handleConnection(ws) {
    const conn = {
      authed: false,
      authTimer: setTimeout(() => ws.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS),
      // Sérialise les commandes d'un même client : sans ça, deux commandes
      // envoyées coup sur coup (ex. double-tap) s'exécutent en parallèle
      // côté OBS/Twitch et peuvent terminer dans le désordre.
      queue: Promise.resolve(),
      micReceiver: null,
    };

    ws.on('message', (raw) => {
      conn.queue = conn.queue.then(() => this._handleMessage(ws, raw, conn));
    });

    ws.on('close', () => {
      clearTimeout(conn.authTimer);
      this.authedClients.delete(ws);
      conn.micReceiver?.close();
    });
  }

  async _handleMessage(ws, raw, conn) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return ws.send(JSON.stringify({ type: 'error', error: 'JSON invalide' }));
    }

    if (!conn.authed) {
      if (msg.type === 'auth' && msg.token === this.token) {
        conn.authed = true;
        clearTimeout(conn.authTimer);
        this.authedClients.add(ws);
        ws.send(JSON.stringify({ type: 'welcome' }));
        try {
          const state = await this.obs.getState();
          ws.send(JSON.stringify({ type: 'state', ...state }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', error: `état OBS indisponible: ${err.message}` }));
        }
      } else {
        ws.close(4003, 'auth invalide');
      }
      return;
    }

    if (msg.type === 'command') {
      const result = await this._runCommand(msg.action, msg.payload || {});
      ws.send(JSON.stringify({ type: 'result', id: msg.id, ...result }));
      return;
    }

    if (msg.type === 'webrtc-offer') {
      // Une nouvelle offre remplace toute connexion audio précédente de ce
      // client (ex. le téléphone rouvre l'app après une coupure réseau).
      conn.micReceiver?.close();
      conn.micReceiver = new MicReceiver({
        pcmPlayer: this.pcmPlayer,
        onIceCandidate: (candidate) => ws.send(JSON.stringify({ type: 'webrtc-ice', candidate })),
        onStatus: (state) => ws.send(JSON.stringify({ type: 'event', name: 'webrtc.connection', state })),
      });
      try {
        const sdp = await conn.micReceiver.handleOffer(msg.sdp);
        ws.send(JSON.stringify({ type: 'webrtc-answer', sdp }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: `offre WebRTC refusée: ${err.message}` }));
      }
      return;
    }

    if (msg.type === 'webrtc-ice') {
      try {
        await conn.micReceiver?.addIceCandidate(msg.candidate);
      } catch (err) {
        console.error('[audio] candidat ICE refusé:', err.message);
      }
      return;
    }

    if (msg.type === 'webrtc-hangup') {
      conn.micReceiver?.close();
      conn.micReceiver = null;
    }
  }

  async _runCommand(action, payload) {
    try {
      const data = await this._dispatch(action, payload);
      return { ok: true, data: data ?? null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async _dispatch(action, payload) {
    switch (action) {
      case 'state.get':
        return this.obs.getState();

      case 'obs.switchScene':
        return this.obs.switchScene(payload.sceneName);
      case 'obs.startStream':
        return this.obs.startStream();
      case 'obs.stopStream':
        return this.obs.stopStream();
      case 'obs.toggleMic':
        return { muted: await this.obs.toggleMic() };
      case 'obs.setMicMuted':
        return this.obs.setMicMuted(Boolean(payload.muted));

      case 'chat.send':
        return this.chat.sendMessage(payload.message);
      case 'chat.delete':
        return this.helix.deleteChatMessage(payload.messageId);

      case 'chat.timeout': {
        const user = await this.helix.getUserByLogin(payload.username);
        if (!user) throw new Error(`Utilisateur introuvable: ${payload.username}`);
        return this.helix.banUser(user.id, { duration: payload.duration || 600, reason: payload.reason });
      }
      case 'chat.ban': {
        const user = await this.helix.getUserByLogin(payload.username);
        if (!user) throw new Error(`Utilisateur introuvable: ${payload.username}`);
        return this.helix.banUser(user.id, { reason: payload.reason });
      }
      case 'chat.unban': {
        const user = await this.helix.getUserByLogin(payload.username);
        if (!user) throw new Error(`Utilisateur introuvable: ${payload.username}`);
        return this.helix.unbanUser(user.id);
      }

      default:
        throw new Error(`Action inconnue: ${action}`);
    }
  }
}
