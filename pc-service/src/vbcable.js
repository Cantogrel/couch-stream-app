import { execFile } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Source officielle uniquement : l'installeur n'est pas embarqué (voir la
// licence VB-Audio, https://vb-audio.com/Services/licensing.htm — donationware,
// redistribution en bundle soumise à conditions). L'utilisateur ne clique sur
// aucun lien : le pilote est téléchargé ici, vérifié, puis installé.
const PACK_URL = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip';
const SIGNER = /BUREL VINCENT/; // certificat Authenticode de VB-Audio (Vincent Burel)
const SETUP_EXE = 'VBCABLE_Setup_x64.exe';

const ps = (command, timeout = 120_000) =>
  new Promise((resolve, reject) =>
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout }, (err, out, errOut) =>
      err ? reject(new Error(errOut?.trim() || err.message)) : resolve(out.trim())));

export class VbCableInstaller {
  constructor({ pcmPlayer }) {
    this.pcmPlayer = pcmPlayer;
    this.state = { step: 'idle', message: '' }; // idle | downloading | verifying | installing | waiting | done | error
    this._running = false;
  }

  status() {
    return this.state;
  }

  async isInstalled() {
    try {
      await this.pcmPlayer.resolveDevice();
      return true;
    } catch {
      return false;
    }
  }

  _set(step, message = '') {
    this.state = { step, message };
  }

  async install() {
    if (this._running) return;
    this._running = true;
    const dir = join(tmpdir(), `couchstream-vbcable-${Date.now()}`);
    try {
      mkdirSync(dir, { recursive: true });

      this._set('downloading', 'Téléchargement depuis vb-audio.com…');
      const res = await fetch(PACK_URL);
      if (!res.ok) throw new Error(`téléchargement refusé (HTTP ${res.status})`);
      const zip = join(dir, 'pack.zip');
      await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
      await ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}\\pack' -Force`);

      // Signature Authenticode valide ET émise à VB-Audio : protège d'un
      // fichier altéré sans figer un hash qui casserait à chaque mise à jour.
      this._set('verifying', 'Vérification de la signature du pilote…');
      const exe = join(dir, 'pack', SETUP_EXE);
      const sig = await ps(`$s = Get-AuthenticodeSignature -LiteralPath '${exe}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`);
      const [status, subject] = sig.split('|');
      if (status !== 'Valid' || !SIGNER.test(subject || '')) throw new Error(`signature invalide (${status}) — installation annulée par sécurité`);

      // Une seule invite UAC : le pilote exige les droits administrateur.
      this._set('installing', "Installation du pilote — accepte la fenêtre Windows « Contrôle de compte d'utilisateur »…");
      try {
        await ps(`Start-Process -FilePath '${exe}' -ArgumentList '-i','-h' -Verb RunAs -Wait`, 300_000);
      } catch (err) {
        throw new Error(/annul|cancel|refus|denied/i.test(err.message) ? "L'autorisation administrateur a été refusée." : err.message);
      }

      this._set('waiting', 'Vérification de l’apparition des périphériques CABLE…');
      for (let i = 0; i < 20; i++) {
        if (await this.isInstalled()) return this._set('done', 'VB-Cable est installé.');
        await new Promise((r) => setTimeout(r, 1500));
      }
      this._set('error', "Le pilote est installé mais Windows ne l'affiche pas encore : redémarre le PC puis relance l'assistant.");
    } catch (err) {
      this._set('error', err.message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      this._running = false;
    }
  }
}
