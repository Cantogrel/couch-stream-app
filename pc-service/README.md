# Service compagnon PC

Service Node.js tournant à côté d'OBS Studio. Responsabilités (Phase 1+) :

- Connexion `obs-websocket` (contrôle scènes, start/stop, mute, stats).
- Connexion Twitch IRC (`tmi.js`, lecture chat) + Helix API (écriture,
  modération — nécessite un token OAuth avec scopes de modération).
- Réception audio micro (WebRTC/Opus) → injection dans VB-Audio Virtual
  Cable (Phase 2).
- Serveur WebSocket local authentifié par token partagé, LAN only.

Pas encore implémenté — en attente de la Phase 0 (setup obs-websocket,
VB-Cable, app Twitch développeur, IP fixe).
