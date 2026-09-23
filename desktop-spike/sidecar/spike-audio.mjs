import { AudioContext, mediaDevices } from 'node-web-audio-api';
import { writeFileSync } from 'node:fs';
const out = process.argv[2];
const r = { node: process.version, cwd: process.cwd(), ok: false };
try {
  const devs = await mediaDevices.enumerateDevices();
  r.outputs = devs.filter(d => d.kind === 'audiooutput').map(d => d.label);
  const dev = devs.find(d => d.kind === 'audiooutput' && d.label.includes('CABLE Input'));
  r.cable = !!dev;
  if (dev) {
    const ctx = new AudioContext({ sinkId: dev.deviceId, sampleRate: 48000, latencyHint: 'interactive' });
    const osc = ctx.createOscillator(); const g = ctx.createGain(); g.gain.value = 0.05;
    osc.connect(g).connect(ctx.destination); osc.start();
    await new Promise(res => setTimeout(res, 1500));
    r.ctxState = ctx.state; r.currentTime = ctx.currentTime;
    osc.stop(); await ctx.close();
    r.ok = ctx.currentTime > 0.5;
  }
} catch (e) { r.error = String(e && e.stack || e); }
writeFileSync(out, JSON.stringify(r, null, 1));
process.exit(0);
