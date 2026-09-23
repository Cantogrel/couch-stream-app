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

## Phase 4 (clôturée et validée sur téléphone réel, 2026-09-23)

Projet Capacitor (`capacitor.config.json`, `webDir: www`, platform `android`).

- **Permissions manifest** : `RECORD_AUDIO` seule ne suffit pas pour
  `getUserMedia({audio})` sous Capacitor — `BridgeWebChromeClient` exige
  aussi `MODIFY_AUDIO_SETTINGS` et refuse tout silencieusement (aucune
  popup) si elle manque au manifest, même si `RECORD_AUDIO` est accordée.
  Les deux sont déclarées dans `AndroidManifest.xml`. Validé en réel
  (2026-09-23) : micro fonctionnel une fois les deux présentes.
- **Foreground service natif** (`android/.../KeepAliveService.java` +
  `KeepAlivePlugin.java`) : notification persistante + wake lock partiel
  pendant que le process tourne, pour garder la WebView (donc le WebSocket
  et l'envoi micro WebRTC) vivante écran éteint / app en arrière-plan.
  Démarré une fois à l'authentification réussie (`app.js`, cas `welcome`).
- **Notifications natives** : posture finale validée en réel (2026-09-23).
  `www/app.js` détecte via `isNative()` et bascule automatiquement ; le
  chemin web (service worker) reste actif pour continuer à tester dans
  Chrome sans empaqueter.
  - Uniquement pendant le live (`app.obs.streaming`) — pas d'alerte sur un
    chat qui n'intéresse personne hors stream.
  - Permission demandée dès qu'on coche une case de notif dans Réglages
    (`ensureNotifPermission`), pas à la première notif réelle — sinon la
    popup système surgit en pleine réception d'un message.
  - IDs fixes par catégorie (`NOTIF_ID_CHAT`/`NOTIF_ID_MENTION`, pas
    `Date.now()`) : chaque nouvelle alerte remplace la précédente au lieu de
    s'empiler. Avec un id différent à chaque fois, Android auto-groupe après
    quelques notifs et n'alerte (son/vibration/bannière) plus que pour le
    groupe — bug constaté en test réel (12 notifs postées, une seule alerte
    perçue).
  - La notification n'est **pas** postée via `LocalNotifications.schedule()`
    mais via `KeepAlivePlugin.postAlert` (natif, `android/.../KeepAlivePlugin.java`) :
    `schedule()` appelle toujours `Builder.setSound(...)` avec un son par
    défaut, qui sur cet appareil écrase en pratique les `AudioAttributes` du
    canal (`USAGE_ALARM` mesuré comme retombant à `USAGE_NOTIFICATION` à la
    lecture effective). En ne posant jamais de son/vibration au niveau de la
    notification elle-même, seul le canal gouverne — comportement Android 8+
    correct, contrairement au chemin du plugin sur ce téléphone.
  - Canal dédié `chat-alerts-alarm` (créé nativement, pas via
    `LocalNotifications.createChannel` — son API ne permet ni
    `AudioAttributes.USAGE_ALARM` ni `setBypassDnd`) : importance max,
    vibration avec motif dédié, son sur le flux **alarme** plutôt que
    notification (bypass du mode vibreur — validé en réel), et
    `setBypassDnd(true)` pour Ne pas déranger (accès accordé via
    `adb shell settings put secure enabled_notification_policy_access_packages`,
    pas de dialogue runtime pour ça).
  - Limite acceptée, non résolue : le mode **silencieux strict** (sonnerie
    coupée, pas juste vibreur) reste muet malgré le flux alarme — la couche
    "Audio Hardening" propre à ColorOS (repérée dans les logs système :
    `AudioHardening ... would be muted for <app> ... level: full`) mute
    certains flux au-delà de ce qu'une app peut contourner depuis le SDK
    public. Vibreur fonctionne correctement, ce qui couvre l'usage réel visé.
- **Pairing par QR code** : le service PC sert une page `/pair` (voir
  `pc-service/src/staticServer.js`) qui affiche un QR encodant
  `{host, port, token}` (généré avec `qrcode`, IP LAN auto-détectée via
  `pc-service/src/lanAddress.js`). L'app scanne ce QR (bouton "Scanner le
  QR de pairing" dans Réglages, décodage `www/lib/jsQR.js`, pur JS, pas de
  plugin natif) et remplit hôte/port/token automatiquement — élimine la
  copie manuelle du token notée comme friction en Phase 2.
- **`usesCleartextTraffic="true"`** dans le manifest : le service PC parle
  `ws://`/`http://` en clair sur le LAN (jamais Internet — contrainte du
  projet), sans quoi Android ≥ 9 bloque silencieusement le trafic sortant
  en clair d'une app empaquetée.
- Contexte sécurisé résolu nativement : la WebView Capacitor sert l'app
  depuis un schéma local considéré sécurisé, donc `getUserMedia` (micro et
  caméra QR) fonctionne sans le contournement `chrome://flags` utilisé en
  Phase 2/3.

### Build

Nécessite un JDK 21 (le JDK système peut être différent — voir
`JAVA_HOME` ci-dessous) et le SDK Android (`ANDROID_HOME`/`ANDROID_SDK_ROOT`,
`android/local.properties` généré localement, non versionné).

```bash
cd android
JAVA_HOME="<chemin JDK 21>" ./gradlew assembleDebug
# APK : android/app/build/outputs/apk/debug/app-debug.apk
```

Après toute modification de `www/`, resynchroniser avant de rebuilder :

```bash
npx cap sync android
```

### Installer sur le téléphone

Brancher le téléphone en USB avec le débogage USB activé, puis :

```bash
cd android && JAVA_HOME="<chemin JDK 21>" ./gradlew installDebug
```

Ou transférer `app-debug.apk` sur le téléphone et l'installer manuellement
(autoriser l'installation depuis une source inconnue pour ce fichier).

### Pairing

1. Lancer le service PC (`cd pc-service && npm run start`).
2. Depuis un navigateur PC, ouvrir `http://<ip-pc>:<port>/pair` pour
   afficher le QR (ou le fallback texte hôte/port/token si aucune IP LAN
   n'est détectée).
3. Dans l'app : Réglages → "Scanner le QR de pairing", viser l'écran PC.

Friction restante notée en Phase 2 et non résolue ici (nécessite un accès
au routeur, hors de portée de l'app) : l'IP LAN du PC est attribuée par
DHCP et peut changer. Si la connexion casse après un redémarrage du
routeur/PC, re-scanner le QR suffit — une réservation DHCP sur le routeur
éliminerait le besoin de re-pairing.
