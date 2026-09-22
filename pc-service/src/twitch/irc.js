import { EventEmitter } from 'node:events';
import tmi from 'tmi.js';

export class TwitchChat extends EventEmitter {
  constructor({ channelLogin, tokenManager }) {
    super();
    this.channelLogin = channelLogin;
    this.tokenManager = tokenManager;
    this.client = null;

    // Le token peut être rafraîchi en cours de route (voir tokenManager) —
    // tmi.js ne relit pas le mot de passe tout seul, il faut reconnecter.
    tokenManager.on('refreshed', () => this._reconnectWithFreshToken());
  }

  _buildClient() {
    return new tmi.Client({
      options: { skipMembership: true },
      connection: { reconnect: true, secure: true },
      identity: {
        username: this.channelLogin,
        password: `oauth:${this.tokenManager.accessToken}`,
      },
      channels: [this.channelLogin],
    });
  }

  async connect() {
    this.client = this._buildClient();

    this.client.on('message', (channel, tags, text, self) => {
      if (self) return;
      this.emit('message', {
        id: tags.id,
        userId: tags['user-id'],
        username: tags.username,
        displayName: tags['display-name'] || tags.username,
        text,
        isMod: Boolean(tags.mod) || tags.badges?.broadcaster === '1',
        isBroadcaster: tags.badges?.broadcaster === '1',
        timestamp: Number(tags['tmi-sent-ts']) || Date.now(),
      });
    });

    this.client.on('disconnected', (reason) => {
      this.emit('status', { connected: false, reason });
    });

    await this.client.connect();
    this.emit('status', { connected: true });
  }

  async _reconnectWithFreshToken() {
    if (!this.client) return;
    try {
      await this.client.disconnect();
    } catch {
      // déjà déconnecté, sans importance
    }
    await this.connect();
    console.log('[twitch] IRC reconnecté avec le token rafraîchi');
  }

  async sendMessage(text) {
    if (!this.client) throw new Error('IRC non connecté');
    await this.client.say(this.channelLogin, text);
  }
}
