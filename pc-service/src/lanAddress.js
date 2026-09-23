import { networkInterfaces } from 'node:os';

// Adaptateurs à ignorer même s'ils exposent une IPv4 non-interne : VPN/virtuels,
// jamais le vrai LAN Wi-Fi maison. Trouvé en pratique sur cette machine :
// Tailscale expose une IPv4 100.64.0.0/10 (CGNAT) qui passait avant le vrai
// Ethernet 192.168.x.x dans l'ordre par défaut de networkInterfaces().
const IGNORED_ADAPTER_PATTERN = /tailscale|vmware|virtualbox|vethernet|docker|loopback|\btap\b|\btun\b|ppp/i;

function isCgnat(address) {
  // 100.64.0.0/10 — plage CGNAT utilisée par Tailscale et d'autres VPN,
  // jamais un vrai réseau local domestique.
  const m = address.match(/^100\.(\d+)\./);
  return m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

function isPrivateLan(address) {
  return /^192\.168\.\d+\.\d+$/.test(address)
    || /^10\.\d+\.\d+\.\d+$/.test(address)
    || /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(address);
}

// Meilleure estimation de l'IP LAN de ce PC, pour le QR de pairing (Phase 4).
// Pas de garantie de stabilité dans le temps (DHCP) — voir la note sur la
// réservation DHCP recommandée dans le vault mémoire (SUMMARY, Phase 2).
export function getLanAddress() {
  const nets = networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(nets)) {
    if (IGNORED_ADAPTER_PATTERN.test(name)) continue;
    for (const net of addrs || []) {
      if (net.family !== 'IPv4' || net.internal || isCgnat(net.address)) continue;
      candidates.push(net.address);
    }
  }
  // Priorité aux plages LAN privées standard ; à défaut, la première
  // candidate restante plutôt que rien.
  return candidates.find(isPrivateLan) || candidates[0] || null;
}
