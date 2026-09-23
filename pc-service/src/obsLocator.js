import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './paths.js';

const SAVED_PATH_FILE = join(DATA_DIR, 'obs-path.txt');
const EXE = 'obs64.exe';

function fromRegistry() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKLM\SOFTWARE\OBS Studio', '/ve'], { windowsHide: true }, (err, out) => {
      const dir = !err && /REG_SZ\s+(.+)/.exec(out)?.[1]?.trim();
      resolve(dir ? join(dir, 'bin', '64bit', EXE) : null);
    });
  });
}

// OBS déjà lancé (installation portable/personnalisée, ni registre ni
// Program Files) : son chemin réel est celui du processus.
function fromRunningProcess() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', '(Get-Process obs64 -ErrorAction SilentlyContinue | Select-Object -First 1).Path'], { windowsHide: true }, (err, out) => {
      resolve(!err && out.trim() ? out.trim() : null);
    });
  });
}

// Ordre : OBS_PATH explicite, chemin appris quand OBS tournait, registre,
// emplacements standards.
export async function findObs() {
  const candidates = [process.env.OBS_PATH];
  try {
    candidates.push(readFileSync(SAVED_PATH_FILE, 'utf8').trim());
  } catch {
    // pas encore appris
  }
  candidates.push(await fromRegistry());
  candidates.push(await fromRunningProcess());
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base) candidates.push(join(base, 'obs-studio', 'bin', '64bit', EXE));
  }
  return candidates.find((p) => p && existsSync(p)) || null;
}

// À appeler quand OBS est connecté : mémorise l'emplacement réel de l'exe
// (installation portable/personnalisée) pour pouvoir le relancer plus tard.
export function learnObsPath() {
  execFile(
    'powershell',
    ['-NoProfile', '-Command', `(Get-Process obs64 -ErrorAction SilentlyContinue | Select-Object -First 1).Path`],
    { windowsHide: true },
    (err, out) => {
      const p = !err && out.trim();
      if (p && existsSync(p)) {
        try {
          writeFileSync(SAVED_PATH_FILE, p);
        } catch {
          // dossier de données non inscriptible : on retombera sur le registre
        }
      }
    },
  );
}

export async function launchObs() {
  const exe = await findObs();
  if (!exe) return { ok: false, error: "OBS est introuvable sur ce PC. Lance-le une fois à la main (le chemin sera mémorisé) ou renseigne OBS_PATH dans le fichier .env du dossier de données." };
  // cwd = dossier de l'exe : OBS charge ses fichiers de locale/plugins relativement.
  spawn(exe, [], { cwd: dirname(exe), detached: true, stdio: 'ignore' }).unref();
  return { ok: true, path: exe };
}
