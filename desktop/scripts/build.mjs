// Build de l'installeur. La clé de signature des mises à jour vit hors du dépôt
// (%USERPROFILE%\\.couchstream-signing) : si elle est présente, l'installeur est
// signé et le fichier de mise à jour (.sig) est produit ; sinon, build local
// sans artefacts de mise à jour.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const keyDir = join(homedir(), '.couchstream-signing');
const keyPath = join(keyDir, 'updater.key');
const env = { ...process.env };
const args = ['tauri', 'build'];

if (existsSync(keyPath)) {
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, 'utf8');
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = readFileSync(join(keyDir, 'updater.key.password'), 'utf8').trim();
} else {
  console.warn('Clé de mise à jour absente : build sans artefacts de mise à jour.');
  args.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
}

const stage = spawnSync('node', ['scripts/stage-sidecar.mjs'], { stdio: 'inherit' });
if (stage.status !== 0) process.exit(stage.status ?? 1);
process.exit(spawnSync('npx', args, { stdio: 'inherit', env, shell: true }).status ?? 1);
