import { Bonjour, type Service } from 'bonjour-service';
import { getConfig } from '../lib/config.js';

const SERVICE_TYPE = 'think-sync';

export interface DiscoveredPeer {
  host: string;
  port: number;
  peerId: string;
  name: string;
}

let bonjourInstance: Bonjour | null = null;
let publishedService: Service | null = null;

function getInstance(): Bonjour {
  if (!bonjourInstance) {
    bonjourInstance = new Bonjour();
  }
  return bonjourInstance;
}

export function advertise(peerId: string, port: number): Service {
  const bonjour = getInstance();
  publishedService = bonjour.publish({
    name: `think-${peerId.slice(0, 8)}`,
    type: SERVICE_TYPE,
    port,
    txt: { peerId },
  });
  return publishedService;
}

export function discoverPeers(timeoutMs: number = 3000): Promise<DiscoveredPeer[]> {
  const config = getConfig();
  const ownPeerId = config.peerId;

  return new Promise((resolve) => {
    const bonjour = getInstance();
    const peers: DiscoveredPeer[] = [];
    const seen = new Set<string>();

    const browser = bonjour.find({ type: SERVICE_TYPE }, (service: Service) => {
      const peerId = service.txt?.peerId;
      if (!peerId || peerId === ownPeerId || seen.has(peerId)) return;
      seen.add(peerId);

      // Prefer IPv4 address, fall back to host
      const host =
        service.addresses?.find((a) => a.includes('.') && !a.includes(':')) ||
        service.host;

      peers.push({
        host,
        port: service.port,
        peerId,
        name: service.name,
      });
    });

    setTimeout(() => {
      browser.stop();
      resolve(peers);
    }, timeoutMs);
  });
}

export function stopDiscovery(): void {
  if (publishedService?.stop) {
    publishedService.stop();
    publishedService = null;
  }
  if (bonjourInstance) {
    bonjourInstance.destroy();
    bonjourInstance = null;
  }
}
