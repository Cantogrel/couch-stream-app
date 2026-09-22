# Service compagnon PC

Service Node.js tournant à côté d'OBS Studio.

## Phase 1 (implémentée)

- `src/obs.js` — connexion `obs-websocket` : scènes, start/stop stream,
  mute/unmute micro (source `Micro Téléphone (Couch Stream App)`, voir
  `MIC_INPUT_NAME`), stats (frames perdues, congestion).
- `src/twitch/irc.js` — connexion IRC (`tmi.js`) : lecture + envoi de
  messages chat.
- `src/twitch/helix.js` — API Helix : suppression de message, timeout/ban
  utilisateur.
- `src/twitch/tokenManager.js` — rafraîchissement automatique du token
  Twitch (le token d'accès expire ~4h10), persisté dans `.env`.
- `src/wsServer.js` — serveur WebSocket local (`LOCAL_WS_PORT`,
  authentifié par `LOCAL_WS_TOKEN`), LAN only. Relaie les évènements OBS et
  chat, et route les commandes (`obs.*`, `chat.*`).

Pas encore implémenté : réception audio micro téléphone → VB-Cable
(Phase 2), UI mobile (Phase 3+).

## Lancer le service

```
npm run start
```

Nécessite OBS Studio lancé et `.env` rempli (voir `.env.example`).

## Tester avant toute UI

- Au clavier : `npm run test-ws` (REPL avec commandes `state`, `scene`,
  `start`, `stop`, `mute`, `say`, `timeout`, `ban`, `help`...).
- Au navigateur : ouvrir `public/test.html` directement (double-clic ou
  glisser dans Chrome), renseigner le port et `LOCAL_WS_TOKEN` (copié
  depuis `.env`), cliquer "Connecter".

## Commandes de diagnostic

```
npm run check-obs      # vérifie la connexion obs-websocket, liste scènes/sources
```
