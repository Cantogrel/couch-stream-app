# Phase 6 — Installation et usage « zéro friction »

**Objectif** : quelqu'un qui n'y connaît rien installe l'app en quelques minutes ;
ensuite tout démarre tout seul. Cible immédiate : quelques amis. À prévoir dès
maintenant : ouverture possible au grand public plus tard (aucun secret embarqué,
signature de code, mises à jour, licences des composants tiers).

Constat de départ (fin Phase 5) : le service PC se relance à la main
(`npm start`), le `.env` se remplit à la main (mot de passe OBS, tokens Twitch),
VB-Cable s'installe à la main, l'app Twitch développeur se crée à la main, et le
QR de pairing s'obtient en tapant `http://<ip>:<port>/pair` dans un navigateur.

## Décisions techniques (actées)

1. **Format du service PC : coquille Tauri v2 + service Node en sidecar.**
   Léger (quelques Mo pour la coquille, WebView2 déjà présent sous Windows 11)
   et « produit fini » : installeur NSIS/MSI, icône dans la zone de
   notification, démarrage avec Windows (plugin autostart), mises à jour
   (plugin updater), signature de code possible plus tard. Le service Node
   actuel est conservé quasi tel quel (Node embarqué en sidecar), ce qui évite
   de tout réécrire. L'UI de l'assistant et du pairing est en web (réutilise
   `mobile-app/www`-style, sans framework).
   **Spike obligatoire en première étape** (1/2 journée) : vérifier la chaîne
   Rust + MSVC Build Tools sur cette machine et le chargement du binaire
   natif `node-web-audio-api` (`.node`) depuis le sidecar. **Repli décidé
   d'avance : Electron + electron-builder** (service Node en processus
   principal, `asarUnpack` pour le `.node`) si le spike échoue. Plus lourd
   (~80 Mo d'installeur) mais 100 % JS.
2. **Connexion Twitch : Device Code Grant Flow** (client public, sans secret
   client, sans serveur à héberger). L'utilisateur clique « Se connecter avec
   Twitch », le service affiche un code + ouvre la page d'autorisation Twitch,
   le token est stocké (refresh automatique déjà en place dans
   `tokenManager.js`). Une **app Twitch « publique » unique** (Client ID
   embarqué, pas un secret) est partagée par tous les utilisateurs : c'est le
   modèle normal de Twitch. Les tokens vivent dans un magasin local chiffré
   (DPAPI / trousseau Windows), plus dans un `.env` en clair.
3. **Distribution** : amis d'abord (installeur `.exe` + APK, publiés en
   GitHub Releases), mais conçue pour le public : aucun secret dans le binaire,
   nom/identité d'app propres, mises à jour signées, dossier de données
   utilisateur (`%APPDATA%`) séparé du programme, politique de confidentialité
   minimale (aucune télémétrie), et signature de code (Azure Trusted Signing
   ou certificat OV) à ajouter avant tout usage grand public (SmartScreen).

## 6.1 Le service PC devient une vraie app Windows
- Spike Tauri vs Electron (voir ci-dessus), puis packaging : installeur unique,
  Node embarqué, aucune dépendance à installer par l'utilisateur.
- Démarrage automatique avec Windows, en arrière-plan ; icône de zone de
  notification (état OBS/Twitch/téléphone, ouvrir l'app, afficher le QR,
  quitter). Instance unique.
- Reconnexion à OBS tout seul, même si OBS est lancé après le service
  (déjà en grande partie fait dans `obs.js`).
- Option : lancer OBS automatiquement au démarrage du service.
- Dossier de données utilisateur (`%APPDATA%\CouchStreamApp`) pour la config
  et les tokens ; migration depuis l'ancien `.env`.

## 6.2 Assistant de premier lancement (remplace le `.env`)
Petite fenêtre guidée, un test à chaque étape, reprise possible si interrompu :
1. **OBS** : détection d'obs-websocket, activation guidée s'il est coupé,
   saisie/lecture du mot de passe, test de connexion.
2. **Audio — VB-Cable installé depuis l'assistant, sans lien externe** :
   détecter la présence de VB-Cable ; sinon proposer « Installer » qui
   lance l'installeur du pilote avec élévation administrateur (une seule
   invite UAC) et vérifie ensuite l'apparition des périphériques
   « CABLE Input/Output ». **Sources de l'installeur, dans cet ordre** :
   (a) installeur embarqué dans l'app *si la licence VB-Audio l'autorise* ;
   (b) sinon téléchargement automatique au moment de l'installation depuis
   la source officielle VB-Audio (vérification d'intégrité, l'utilisateur ne
   clique sur aucun lien) ; (c) en dernier recours seulement, lien manuel
   affiché comme secours. **Point à trancher tôt** : la licence VB-Cable
   (donationware) encadre la redistribution — à vérifier avant d'embarquer
   le pilote ; pour un usage grand public, contacter VB-Audio ou évaluer
   une alternative libre à pilote signé.
3. **Twitch** : « Se connecter avec Twitch » (device code, voir décision 2).
4. **Source micro OBS** : création automatique de « Micro Téléphone » (avec
   filtre/routage vers VB-Cable) via l'API obs-websocket, comme fait à la
   main en Phase 0 ; nom et périphérique deviennent des réglages avec détection.
5. **Pairing du téléphone** (voir 6.3), puis écran « tout est prêt ».

## 6.3 Pairing simplifié
- Le QR s'affiche **dans l'app PC** (fenêtre + entrée du menu de l'icône) ;
  plus aucune URL à taper. La page `/pair` reste disponible en secours.
- **Découverte automatique du PC sur le réseau** (mDNS/Bonjour) côté
  service et côté app Android : l'app trouve le PC sans IP saisie, ce qui
  règle aussi l'IP DHCP qui change.
- Le QR sert à échanger le **secret** (token) une seule fois ; ensuite
  l'app mémorise le PC et se reconnecte seule, même si l'IP change.
- Révocation : « oublier ce téléphone » côté PC (régénération du token).

## 6.4 Robustesse et portabilité
- Mises à jour de l'app PC (updater intégré) ; version affichée, message
  clair si le téléphone et le PC sont d'une version incompatible.
- APK téléchargeable depuis le PC (`/app.apk`) et depuis GitHub Releases.
- Aucun chemin/nom en dur (source micro, périphérique VB-Cable, port) :
  réglages avec détection.
- Journal de diagnostic exportable (« Copier le rapport ») pour aider un ami.
- Guide « Installation en 5 minutes » + vérification des prérequis dans
  l'assistant (OBS ≥ 28 avec obs-websocket, Windows 10/11).

## Ordre et critères de validation
1. Spike Tauri/Electron → décision confirmée. *Validé si* le sidecar joue de
   l'audio vers VB-Cable depuis l'app empaquetée.
2. 6.1 démarrage auto + tray + installeur. *Validé si* : redémarrage du PC →
   tout fonctionne sans rien lancer.
3. 6.3 pairing. *Validé si* : téléphone jumelé sans taper une URL, et
   toujours joignable après changement d'IP.
4. 6.2 assistant (dont VB-Cable intégré et Twitch device code). *Validé si* :
   installation propre sur une machine/VM vierge (ou compte Windows neuf)
   jusqu'au premier chat reçu, sans ouvrir de terminal.
5. 6.4 finitions. Chaque étape est testable et commitée à part.

## Risques
- Licence de redistribution de VB-Cable (voir 6.2).
- Chaîne Rust/MSVC absente (repli Electron).
- Binaire natif `node-web-audio-api` dans un sidecar/paquet.
- Élévation administrateur pour le pilote audio (une invite UAC inévitable).
- SmartScreen tant que l'installeur n'est pas signé (acceptable pour des amis,
  bloquant pour le grand public).
