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

## Phase 2 (implémentée, à valider)

- `src/audio/micReceiver.js` — une `RTCPeerConnection` (werift) par client,
  reçoit l'offre WebRTC du téléphone, répond, relaie les paquets RTP Opus
  du track audio reçu.
- `src/audio/opusDecoder.js` — décodage Opus → PCM (opusscript, WASM, pas
  de compilation native).
- `src/audio/pcmPlayer.js` — planifie la lecture du PCM décodé vers le
  périphérique de sortie Windows `CABLE Input (VB-Audio Virtual Cable)`
  (`node-web-audio-api`, binaire NAPI précompilé, pas de compilation
  native), avec un petit buffer de gigue (60ms).
- Signalisation WebRTC ajoutée sur le serveur WebSocket local existant
  (mêmes port/token que Phase 1) : messages `webrtc-offer` / `webrtc-answer`
  / `webrtc-ice` / `webrtc-hangup`.
- Pas de serveur STUN/TURN (LAN only, candidats host suffisent).

Pas encore implémenté : réglage fin des niveaux (Phase 5).

## Phase 3 (implémentée, à valider sur téléphone)

- `src/staticServer.js` sert désormais `../mobile-app/www` en racine
  (`/` → `index.html`, l'app réelle : tableau de bord, scènes, chat avec
  modération, envoi micro WebRTC, réglages/notifications), avec repli sur
  `public/` pour les anciens clients de test (`/test.html`,
  `/test-audio.html`, toujours joignables par leur nom de fichier).
- Aucune commande/endpoint ajouté côté service : l'UI Phase 3 consomme le
  même protocole WebSocket que les clients de test (Phase 1/2).

### Tester la Phase 2 avant toute UI mobile

Ouvrir `public/test-audio.html` directement dans un navigateur (double-clic
ou glisser dans Chrome — pas via un outil d'automatisation, `file://`
suffit), renseigner port + `LOCAL_WS_TOKEN`, cliquer "Connecter", puis
"Démarrer l'envoi micro" (autoriser l'accès micro). Parler dans le micro et
comparer à l'oreille avec le moniteur audio OBS de la source "Micro
Téléphone (Couch Stream App)" pour juger la latence. Pour un test réaliste
de la contrainte "en LAN, téléphone → PC", ouvrir la page depuis le
navigateur du téléphone plutôt que depuis le PC lui-même.

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
