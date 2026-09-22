import { WebSocketServer } from 'ws';

const AUTH_TIMEOUT_MS = 5000;

export class LocalWsServer {
  constructor({ port, token, obs, chat, helix }) {
    this.port = port;
    this.token = token;
    this.obs = obs;
    this.chat = chat;
    this.helix = helix;
    this.wss = null;
    this.authedClients = new Set();
  }

  start() {
    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on('connection', (ws) => this._handleConnection(ws));

    // Relaie les évènements OBS et le chat Twitch vers tous les clients
    // authentifiés (dashboard, chat live, notifications).
    this.obs.on('event', (payload) => this._broadcast({ type: 'event', ...payload }));
    this.obs.on('status', (status) => this._broadcast({ type: 'event', name: 'obs.connection', ...status }));
    this.chat.on('message', (msg) => this._broadcast({ type: 'event', name: 'chat.message', ...msg }));
    this.chat.on('status', (status) => this._broadcast({ type: 'event', name: 'twitch.connection', ...status }));

    console.log(`[ws] serveur local en écoute sur le port ${this.port}`);
  }

  _broadcast(payload) {
    const raw = JSON.stringify(payload);
    for (const ws of this.authedClients) {
      if (ws.readyState === ws.OPEN) ws.send(raw);
    }
  }

  _handleConnection(ws) {
    const authTimer = setTimeout(() => {
      ws.close(4001, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    let authed = false;

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return ws.send(JSON.stringify({ type: 'error', error: 'JSON invalide' }));
      }

      if (!authed) {
        if (msg.type === 'auth' && msg.token === this.token) {
          authed = true;
          clearTimeout(authTimer);
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
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      this.authedClients.delete(ws);
    });
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
