# Couch Stream App

App de pilotage de stream Twitch/OBS depuis le canapé, sans se lever.

## Contexte

Le PC de jeu est relié à la TV du salon (Sunshine/Moonlight + manette Xbox,
hors scope). Ce projet pilote le stream Twitch (OBS Studio, sur le même PC)
depuis un téléphone, en LAN uniquement — pas d'accès distant hors domicile.

Projet séparé du bot Discord "Sunday Stream Bot" (autre repo, aucun lien
technique).

## Fonctionnalités cibles

- Start/stop du stream depuis le téléphone.
- Changement de scène OBS, mute/unmute micro.
- Capture du micro du téléphone → envoi au PC → injection dans OBS (source
  micro) via VB-Audio Virtual Cable.
- Chat Twitch en direct : lecture, réponse, modération (suppression,
  timeout/ban).
- Notifications configurables sur l'activité du chat (pic de messages,
  mentions).
- Vue santé du stream (bitrate, frames perdues).

## Architecture

```
[Téléphone - app Android via Capacitor]
  Dashboard / Scènes / Chat / Toggle micro / Notifs
        │ WebSocket (contrôle + chat) + audio Opus/WebRTC, LAN
        ▼
[PC - service compagnon Node.js, à côté d'OBS]
  obs-websocket (contrôle OBS) · Twitch IRC (tmi.js) + Helix API
  (modération) · réception audio micro → VB-Audio Virtual Cable
  · serveur WebSocket local authentifié par token partagé
        │
        ▼
[OBS Studio] → source micro = VB-Cable → diffuse vers Twitch
```

Capacitor plutôt qu'une PWA pure : le micro doit rester actif écran éteint /
app en arrière-plan, ce qu'un foreground service Android natif garantit et
qu'une PWA ne garantit pas de façon fiable.

Stack 100% gratuite/open source : OBS, obs-websocket, Twitch API, VB-Audio
Virtual Cable, Node.js, Capacitor.

## Plan par phases

- **Phase 0 — Setup** : obs-websocket, VB-Cable, app Twitch développeur +
  OAuth (scopes chat + modération), IP fixe du PC.
- **Phase 1 — Service compagnon PC** : obs-websocket, Twitch IRC + Helix,
  serveur WebSocket local avec token (testable avant toute UI).
- **Phase 2 — Pipeline audio micro** : réception WebRTC/Opus, injection
  VB-Cable, validation latence.
- **Phase 3 — Interface web** (testée directement dans Chrome mobile).
- **Phase 4 — Empaquetage Capacitor** (clôturée et validée sur téléphone
  réel) : foreground service micro natif, notifications, pairing QR code,
  build APK. Voir `mobile-app/README.md`.
- **Phase 5 — Finitions** (clôturée et validée sur téléphone réel, 2026-09-23) : santé du
  stream (débit kb/s, fps, CPU OBS, frames perdues, congestion, polling 2s),
  règles de notification (alerte santé sur tendance 60s avec seuils
  réglables, alerte déconnexion OBS/Twitch en live, pseudos ignorés),
  réglages audio (gain d'entrée 0-300 %, limiteur, buffer de gigue PC
  réglable depuis le téléphone), bouton de restauration des valeurs par
  défaut. Le redémarrage du service PC est requis
  (nouvelles commandes `obs.getHealth`, `audio.setJitterBuffer`).
- **Phase 6 — Installation et usage zéro friction** (planifiée) : service PC
  en vraie app Windows (installeur, tray, démarrage auto), assistant de
  premier lancement (OBS, VB-Cable intégré, Twitch device code, source
  micro), pairing sans URL (QR dans l'app + découverte mDNS), robustesse.
  Voir `docs/PHASE6-PLAN.md`.

Voir aussi le graphe Graphify (`E:\Super IA\Graphify\Couch-Stream-App\graphify-out\`)
et le vault mémoire (`projects/couch-stream-app/` dans AI-Memory) pour l'état
détaillé et les décisions.
