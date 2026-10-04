# Publier une version

Tout est automatisé par GitHub Actions (`.github/workflows/release.yml`) :
**pousser un tag `vX.Y.Z` suffit**. Le workflow construit l'APK signé, l'installeur
Windows (avec sa signature de mise à jour) et le manifeste `latest.json`, puis
les publie dans une GitHub Release. Aucune clé n'est à manipuler à la main.

```bash
git tag v0.1.1
git push origin v0.1.1
```

Les applications déjà installées vérifient `latest.json` 60 s après leur
démarrage, toutes les 6 h et via « Rechercher une mise à jour » (menu de l'icône,
console, ou Réglages de l'app téléphone). **Rien ne s'installe sans accord** : une
version disponible est proposée par un bandeau dans la console PC et dans l'app
téléphone, et l'installation (qui ferme l'application Windows) est refusée en plein
live côté téléphone, confirmée côté console.

- **PC** : « Installer maintenant » télécharge l'installeur signé et le lance ;
  l'application redémarre seule. Possible depuis la console ou depuis le téléphone.
- **Téléphone** : dès que le PC est plus récent que l'app, un bandeau propose
  « Mettre à jour » ; l'app télécharge l'APK servi par le PC et lance l'installeur
  Android (confirmation système, et autorisation « applis inconnues » la 1re fois).
  Ordre naturel : mettre à jour le PC d'abord, puis le téléphone.

## Avant de tagger

Monter les versions : `pc-service/package.json`, `desktop/package.json`,
`desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, et
`versionName`/`versionCode` dans `mobile-app/android/app/build.gradle`.
Incrémenter `PROTOCOL` / `MIN_APP_PROTOCOL` (`pc-service/src/version.js`)
uniquement si le protocole PC ↔ téléphone change de façon incompatible : une
simple différence de version n'empêche jamais l'utilisation (l'app affiche au
plus un bandeau d'avertissement).

## Où sont les clés

| Clé | Rôle | Où elle vit |
|---|---|---|
| Keystore Android (`couchstream-release.keystore`) | Signature de l'APK. Perdue = plus de mise à jour possible de l'APK sur les téléphones déjà installés (Android refuse une autre signature). | Secrets Actions du dépôt (`ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`) **et** sauvegarde dans le dépôt privé `couch-stream-signing`. |
| Clé de mise à jour Tauri (`updater.key`) | Signature des mises à jour de l'application Windows. La clé **publique** est dans `desktop/src-tauri/tauri.conf.json`. | Secrets Actions (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) **et** sauvegarde dans `couch-stream-signing`. |

Une copie de travail existe aussi dans `%USERPROFILE%\.couchstream-signing\` sur
le PC de développement (jamais dans le dépôt public : `.gitignore` exclut
`keystore.properties`, `*.keystore`, `*.jks`).

Si le PC de développement disparaît : les releases continuent (les clés sont dans
les secrets Actions), et les clés se récupèrent depuis le dépôt privé
`couch-stream-signing` pour construire en local.

## Construire en local (sans GitHub)

1. APK signé (JDK 21 requis, voir `mobile-app/README.md`) :
   ```bash
   cd mobile-app && npx cap sync android
   cd android && ./gradlew assembleRelease
   ```
   Le fichier `mobile-app/android/keystore.properties` (hors dépôt) pointe vers le keystore.
2. Installeur Windows (embarque l'APK release trouvé ci-dessus) :
   ```bash
   cd desktop && npm run build
   ```
   La clé de mise à jour est lue dans `%USERPROFILE%\.couchstream-signing\`, ou dans la
   variable `TAURI_SIGNING_PRIVATE_KEY` ; sans clé, le build se fait sans mise à jour.
3. Manifeste : `node desktop/scripts/make-latest-json.mjs Cantogrel/couch-stream-app vX.Y.Z "notes"`.

## Limites connues

- L'installeur n'est pas signé par un certificat de code : SmartScreen affiche
  un avertissement (« Exécuter quand même »). Pour un usage grand public, prévoir
  Azure Trusted Signing ou un certificat OV.
- L'APK ne s'installe jamais sans l'écran de confirmation d'Android (imposé par le
  système). Comme la clé de signature reste la même, il s'installe **par-dessus**
  l'ancienne sans perdre les réglages.
- Une app téléphone antérieure à ces fonctions ne les propose pas : une dernière
  installation manuelle de l'APK (console → « Téléphone & infos » → « Installer
  l'app ») est nécessaire pour qu'elle sache ensuite se mettre à jour seule.
