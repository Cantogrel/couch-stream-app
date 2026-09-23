// Prépare desktop/sidecar/ : copie du service (pc-service + mobile-app/www,
// même arborescence relative que le dépôt, pour que staticServer.js résolve
// ses dossiers sans changement), dépendances de prod, et node.exe en
// externalBin de Tauri.
import { existsSync, cpSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'desktop', 'sidecar');
const svc = join(out, 'pc-service');

rmSync(out, { recursive: true, force: true });
mkdirSync(svc, { recursive: true });
for (const f of ['src', 'public', 'package.json', 'package-lock.json']) {
  cpSync(join(root, 'pc-service', f), join(svc, f), { recursive: true });
}
cpSync(join(root, 'mobile-app', 'www'), join(out, 'mobile-app', 'www'), { recursive: true });
// APK signé (release) de préférence : la clé de signature reste la même d'une
// version à l'autre, ce qui permet à Android de le mettre à jour sur place.
const apkDir = join(root, 'mobile-app', 'android', 'app', 'build', 'outputs', 'apk');
const apk = [join(apkDir, 'release', 'app-release.apk'), join(apkDir, 'debug', 'app-debug.apk')].find(existsSync) ?? '';
if (existsSync(apk)) copyFileSync(apk, join(out, 'app.apk'));
else console.warn("APK introuvable : l'installeur n'embarquera pas l'app téléphone (voir mobile-app/README.md pour la construire)");
execSync('npm ci --omit=dev', { cwd: svc, stdio: 'inherit' });

const bins = join(root, 'desktop', 'src-tauri', 'binaries');
mkdirSync(bins, { recursive: true });
copyFileSync(process.execPath, join(bins, 'node-x86_64-pc-windows-msvc.exe'));
console.log('sidecar prêt');
