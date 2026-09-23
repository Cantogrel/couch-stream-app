import { WebSocketServer } from 'ws';
import { MicReceiver } from './audio/micReceiver.js';
import { createStaticServer } from './staticServer.js';
import { launchObs } from './obsLocator.js';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from './config.js';
import { ENV_PATH } from './paths.js';

const AUTH_TIMEOUT_MS = 5000;

export class LocalWsServer {
  constructor({ port, token, obs, chat, helix, pcmPlayer, service, devices, identity }) {
    this.devices = devices;
    this.identity = identity;
    this.service = service;
    this.twitchConnected = false;
    this.port = port;
    this.token = token;
    this.obs = obs;
    this.chat = chat;
    this.helix = helix;
    this.pcmPlayer = pcmPlayer;
    this.wss = null;
    this.authedClients = new Set();
    // Le flux audio natif n'est ouvert que pendant qu'au moins un client
    // envoie son micro — voir pcmPlayer.js pour pourquoi (gel possible au
    // redémarrage d'OBS si tenu ouvert en continu).
    this.activeMicCount = 0;
  }

  start() {
    // Même port pour les fichiers statiques (public/, testable depuis le
    // téléphone en HTTP) et le WebSocket (upgrade sur le même serveur HTTP).
    this.httpServer = createStaticServer({ getStatus: () => this.getStatus(), launchObs, devices: this.devices, identity: this.identity, listDevices: () => this.listDevices(), revokeDevice: (id) => this.revokeDevice(id), service: this.service });
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.httpServer.listen(this.port);

    this.wss.on('connection', (ws, req) => {
      // Console PC (boucle locale) ≠ téléphone : exclue du compteur de téléphones.
      ws.isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      this._handleConnection(ws);
    });

    // Relaie les évènements OBS et le chat Twitch vers tous les clients
    // authentifiés (dashboard, chat live, notifications).
    this.obs.on('event', (payload) => this._broadcast({ type: 'event', ...payload }));
    this.obs.on('status', (status) => this._broadcast({ type: 'event', name: 'obs.connection', ...status }));
    this.chat.on('message', (msg) => this._broadcast({ type: 'event', name: 'chat.message', ...msg }));
    this.chat.on('status', (status) => { this.twitchConnected = status.connected; });
    this.chat.on('status', (status) => this._broadcast({ type: 'event', name: 'twitch.connection', ...status }));
    this.chat.on('message-deleted', (payload) => this._broadcast({ type: 'event', name: 'chat.message_deleted', ...payload }));

    console.log(`[http+ws] public/ + serveur local en écoute sur le port ${this.port}`);
  }

  // État affiché par la page /desktop (icône de la zone de notification).
  getStatus() {
    return {
      version: this.service.version,
      obs: { connected: this.obs.connected, lastError: this.obs.lastError },
      twitch: { connected: this.twitchConnected },
      vbcable: { found: Boolean(this.pcmPlayer.device), label: this.pcmPlayer.device?.label ?? null },
      phones: [...this.authedClients].filter((ws) => !ws.isLocal).length,
    };
  }

  // Téléphones jumelés (avec état en ligne) + l'ancien jumelage par token
  // partagé s'il est encore utilisé par un téléphone connecté.
  listDevices() {
    const remote = [...this.authedClients].filter((ws) => !ws.isLocal);
    const list = this.devices.list().map((d) => ({ ...d, online: remote.some((ws) => ws.deviceId === d.id) }));
    const legacy = remote.filter((ws) => !ws.deviceId).length;
    if (legacy) list.push({ id: 'legacy', name: 'Ancien jumelage (token partagé)', legacy: true, online: true, lastSeenAt: Date.now() });
    return list;
  }

  revokeDevice(id) {
    if (id === 'legacy') return this._rotateSharedToken();
    const ok = this.devices.revoke(id);
    if (ok) this.disconnectDevice(id);
    return ok;
  }

  // Oublier l'ancien jumelage = changer le token partagé : les téléphones qui
  // l'utilisaient sont déconnectés, la console PC (boucle locale) le relit.
  _rotateSharedToken() {
    const token = randomBytes(24).toString('hex');
    try {
      let env = readFileSync(ENV_PATH, 'utf8');
      env = /^LOCAL_WS_TOKEN=.*$/m.test(env) ? env.replace(/^LOCAL_WS_TOKEN=.*$/m, `LOCAL_WS_TOKEN=${token}`) : `${env}
LOCAL_WS_TOKEN=${token}
`;
      writeFileSync(ENV_PATH, env);
    } catch (err) {
      console.error('[jumelage] persistance du nouveau token impossible:', err.message);
      return false;
    }
    this.token = token;
    config.localWs.token = token;
    for (const ws of this.authedClients) if (!ws.isLocal && !ws.deviceId) ws.close(4003, 'jumelage révoqué');
    return true;
  }

  // Ferme les connexions d'un téléphone dont le jumelage vient d'être révoqué.
  disconnectDevice(id) {
    for (const ws of this.authedClients) if (ws.deviceId === id) ws.close(4003, 'jumelage révoqué');
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
      this._closeMicReceiver(conn);
    });
  }

  _closeMicReceiver(conn) {
    if (!conn.micReceiver) return;
    conn.micReceiver.close();
    conn.micReceiver = null;
    this.activeMicCount--;
    if (this.activeMicCount <= 0) {
      this.activeMicCount = 0;
      this.pcmPlayer.stop().catch((err) => console.error('[audio] fermeture sortie micro échouée:', err.message));
    }
  }

  async _handleMessage(ws, raw, conn) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return ws.send(JSON.stringify({ type: 'error', error: 'JSON invalide' }));
    }

    if (!conn.authed) {
      // Token partagé historique (console PC, téléphones jumelés avant le
      // jumelage par code) ou token propre à un appareil jumelé.
      const device = msg.type === 'auth' && msg.token !== this.token ? this.devices.verify(msg.token) : null;
      if (msg.type === 'auth' && (msg.token === this.token || device)) {
        conn.authed = true;
        if (device) {
          ws.deviceId = device.id;
          this.devices.touch(device.id);
        }
        clearTimeout(conn.authTimer);
        this.authedClients.add(ws);
        ws.send(JSON.stringify({ type: 'welcome' }));
        try {
          const state = await this.obs.getState();
          ws.send(JSON.stringify({ type: 'state', ...state }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', error: `état OBS indisponible: ${err.message}` }));
        }
        // Sans ça, un client qui recharge la page perd tout le chat déjà
        // affiché (retour utilisateur Phase 3) — rejoué une fois à la
        // connexion, pas à chaque commande.
        ws.send(JSON.stringify({ type: 'chat-history', messages: this.chat.getHistory() }));
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
      this._closeMicReceiver(conn);

      try {
        await this.pcmPlayer.start();
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: `sortie audio indisponible: ${err.message}` }));
        return;
      }
      this.activeMicCount++;

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
        this._closeMicReceiver(conn);
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
      this._closeMicReceiver(conn);
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
      case 'obs.setMicVolume':
        return this.obs.setMicVolume(Number(payload.volume));
      case 'obs.getHealth':
        return this.obs.getHealth();
      case 'audio.setJitterBuffer': {
        const ms = Number(payload.ms);
        if (!Number.isFinite(ms) || ms < 10 || ms > 200) throw new Error('jitter buffer hors plage (10-200 ms)');
        this.pcmPlayer.jitterBufferMs = ms;
        return { ms };
      }
      case 'audio.getSettings':
        return { jitterBufferMs: this.pcmPlayer.jitterBufferMs };
      case 'obs.getScreenshot':
        return { dataUrl: await this.obs.getScreenshot(Math.min(Math.max(Number(payload?.width) || 480, 160), 1280)) };

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
