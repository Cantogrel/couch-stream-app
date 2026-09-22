const API_BASE = 'https://api.twitch.tv/helix';

export class HelixClient {
  constructor({ clientId, tokenManager }) {
    this.clientId = clientId;
    this.tokenManager = tokenManager;
    this.broadcasterId = null;
    this.moderatorId = null; // même compte que le broadcaster ici (token du chaîne elle-même)
  }

  async _request(pathAndQuery, { method = 'GET', body } = {}, retry = true) {
    const res = await fetch(`${API_BASE}${pathAndQuery}`, {
      method,
      headers: {
        'Client-Id': this.clientId,
        Authorization: `Bearer ${this.tokenManager.accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && retry) {
      await this.tokenManager.refresh();
      return this._request(pathAndQuery, { method, body }, false);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Helix ${method} ${pathAndQuery} -> ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async init(channelLogin) {
    const data = await this._request(`/users?login=${encodeURIComponent(channelLogin)}`);
    const user = data.data[0];
    if (!user) throw new Error(`Compte Twitch introuvable: ${channelLogin}`);
    this.broadcasterId = user.id;
    this.moderatorId = user.id;
    return user;
  }

  async getStreamInfo() {
    const data = await this._request(`/streams?user_id=${this.broadcasterId}`);
    return data.data[0] || null; // null = hors ligne
  }

  async deleteChatMessage(messageId) {
    await this._request(
      `/moderation/chat?broadcaster_id=${this.broadcasterId}&moderator_id=${this.moderatorId}&message_id=${messageId}`,
      { method: 'DELETE' }
    );
  }

  async clearChat() {
    await this._request(
      `/moderation/chat?broadcaster_id=${this.broadcasterId}&moderator_id=${this.moderatorId}`,
      { method: 'DELETE' }
    );
  }

  // duration en secondes: présent = timeout, absent = ban permanent.
  async banUser(userId, { duration, reason } = {}) {
    await this._request(
      `/moderation/bans?broadcaster_id=${this.broadcasterId}&moderator_id=${this.moderatorId}`,
      {
        method: 'POST',
        body: { data: { user_id: userId, ...(duration ? { duration } : {}), ...(reason ? { reason } : {}) } },
      }
    );
  }

  async unbanUser(userId) {
    await this._request(
      `/moderation/bans?broadcaster_id=${this.broadcasterId}&moderator_id=${this.moderatorId}&user_id=${userId}`,
      { method: 'DELETE' }
    );
  }

  async getUserByLogin(login) {
    const data = await this._request(`/users?login=${encodeURIComponent(login)}`);
    return data.data[0] || null;
  }
}
