# App mobile (Capacitor)

App Android empaquetée via Capacitor (UI web + plugin natif micro).

## Phase 3 (implémentée, à valider dans Chrome sur le téléphone)

`www/` — UI web pure, sans build step (cohérent avec les clients de test
`pc-service/public/test*.html`), servie par le service compagnon PC
(`pc-service/src/staticServer.js`, même port que le WebSocket, racine `/`
→ `index.html`). Deviendra `webDir` du projet Capacitor en Phase 4.

- **Tableau de bord** : statut stream (live/hors ligne, durée), frames
  perdues/totales, congestion, start/stop, grille de scènes, mute/unmute
  du micro OBS.
- **Chat** : lecture live, envoi de message, modération par message
  (supprimer / timeout 10 min / ban) en tapant le message pour révéler les
  actions.
- **Micro** : capture micro du téléphone → WebRTC/Opus → PC (même logique
  que `test-audio.html`, ptime forcé à 10ms), VU-mètre, indépendant du
  mute de la source OBS.
- **Réglages** : hôte/port/token (persistés en `localStorage`), reconnexion
  automatique ; notifications (pic de messages, mentions par mots-clés) via
  l'API `Notification` du navigateur.

Limitation connue, assumée jusqu'à la Phase 4 : les notifications et la
capture micro ne survivent pas de façon fiable à l'écran éteint / l'app en
arrière-plan tant qu'il n'y a pas de foreground service natif — c'est
exactement l'objet de la Phase 4.

## Phase 4 (à venir)

Empaquetage Capacitor, foreground service natif pour la capture micro
continue (écran éteint / app en arrière-plan), pairing par QR code, build
APK.
