# Spike Tauri (Phase 6, étape 1)

Résultat : validé. Installeur NSIS de ~33 Mo, sidecar `node.exe` + `node-web-audio-api`
joue vers « CABLE Input » depuis l'app installée (1,5 s d'oscillateur, contexte `running`).

Gotcha : `resource_dir()` renvoie un chemin préfixé `\?\` que Node ne sait pas
utiliser comme `cwd`/script (`EISDIR lstat 'C:'`) — retirer le préfixe avant le spawn.

Rebuild : copier `node.exe` vers `src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`,
`npm install` (racine et `sidecar/`), puis `npx tauri build`.
