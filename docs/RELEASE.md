# Publier une version

Deux artefacts à publier ensemble sur une **GitHub Release** : l'installeur
Windows (avec sa signature de mise à jour) et l'APK Android signé.

## Secrets de signature (hors dépôt)

Tout est dans `%USERPROFILE%\.couchstream-signing\` :

| Fichier | Rôle |
|---|---|
| `couchstream-release.keystore` + `keystore.properties.backup` | Signature de l'APK. Une copie du `.properties` est lue par Gradle depuis `mobile-app/android/keystore.properties` (ignoré par git). |
| `updater.key`, `updater.key.password` | Signature des mises à jour de l'application Windows (Tauri updater). La clé **publique** est dans `desktop/src-tauri/tauri.conf.json`. |

> **À sauvegarder ailleurs (gestionnaire de mots de passe, disque externe).**
> Perdre le keystore = plus aucune mise à jour possible de l'APK sur les
> téléphones déjà installés (Android refuse une signature différente). Perdre
> `updater.key` = plus de mise à jour automatique de l'application Windows.
> Ne jamais les committer ni les publier.

## Avant la première publication

Remplacer `OWNER/REPO` dans `desktop/src-tauri/tauri.conf.json`
(`plugins.updater.endpoints`) par le dépôt GitHub réel.

## Procédure

1. Monter les versions : `pc-service/package.json`, `desktop/package.json`,
   `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, et
   `versionName`/`versionCode` dans `mobile-app/android/app/build.gradle`.
   Incrémenter `PROTOCOL` / `MIN_APP_PROTOCOL` (`pc-service/src/version.js`)
   uniquement si le protocole PC ↔ téléphone change de façon incompatible.
2. APK signé (JDK 21 requis, voir `mobile-app/README.md`) :
   ```bash
   cd mobile-app && npx cap sync android
   cd android && ./gradlew assembleRelease
   ```
3. Installeur Windows (embarque l'APK release trouvé ci-dessus) :
   ```bash
   cd desktop && npm run build
   ```
   Produit `src-tauri/target/release/bundle/nsis/Couch Stream App_x.y.z_x64-setup.exe`
   et son `.sig`.
4. Générer le manifeste de mise à jour :
   ```bash
   node desktop/scripts/make-latest-json.mjs OWNER/REPO vX.Y.Z "Notes de version"
   ```
5. Créer la release GitHub `vX.Y.Z` et y joindre : l'installeur `.exe`, le
   `latest.json`, et `app-release.apk` (renommé `CouchStream.apk`).

Les applications déjà installées vérifient `latest.json` 60 s après leur
démarrage (et via « Rechercher une mise à jour » dans le menu de l'icône), et
installent la mise à jour signée toute seule.

## Limites connues

- L'installeur n'est pas signé par un certificat de code : SmartScreen affiche
  un avertissement (« Exécuter quand même »). Pour un usage public, prévoir
  Azure Trusted Signing ou un certificat OV.
- L'APK n'est pas mis à jour automatiquement : l'application affiche un
  bandeau quand le PC est plus récent qu'elle, et la nouvelle version se
  télécharge depuis la console PC (« Téléphone & infos → Installer l'app »).
  Comme la clé de signature est la même, Android l'installe **par-dessus**
  l'ancienne sans perdre les réglages.
