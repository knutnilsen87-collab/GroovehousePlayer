import type { AccessTier, ListenEvent } from '@gv/shared/web';

/**
 * EKSEMPELDATA for fase 1. Erstattes av `drops`, `invites` og `listen_events` i Supabase i fase 2.
 * Assets refereres med slug; Command Center og drop-siden bruker nyeste versjon som er ingestet.
 */
export interface SeedRecipient {
  id: string;
  name: string;
  org: string;
  devices: number;
  device: string;
  /** Lyttehendelser per asset-slug */
  events: Record<string, ListenEvent[]>;
}

export interface SeedDrop {
  slug: string;
  title: string;
  tier: AccessTier;
  assetSlugs: string[];
  opensAt: string | null;
  expiresAt: string | null;
  maxDevices: number;
  recipients: SeedRecipient[];
}

const day = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const at = (minAgo: number, sec = 0) => new Date(Date.now() - minAgo * 60_000 + sec * 1000).toISOString();

export const SEED_DROPS: SeedDrop[] = [
  {
    slug: 'blue-fire-pitch',
    title: 'Blue Fire – pitch',
    tier: 'partner',
    assetSlugs: ['blue-fire', 'live-sett-demo'],
    opensAt: null,
    expiresAt: iso(6 * day),
    maxDevices: 2,
    recipients: [
      {
        id: 'r1',
        name: 'Jorrit',
        org: 'Snapchat',
        devices: 1,
        device: 'iPhone · Safari',
        events: {
          'blue-fire': [
            { event: 'open', positionMs: 0, at: at(62) },
            { event: 'play', positionMs: 0, at: at(62, 5) },
            { event: 'seek', positionMs: 40_000, toMs: 21_000, at: at(61, 50) },
            { event: 'ended', positionMs: 96_000, at: at(60, 30) }
          ]
        }
      },
      {
        id: 'r2',
        name: '[Navn]',
        org: 'Kurator',
        devices: 1,
        device: 'Desktop · Chrome',
        events: {
          'blue-fire': [
            { event: 'open', positionMs: 0, at: at(300) },
            { event: 'play', positionMs: 0, at: at(300, 3) },
            { event: 'heartbeat', positionMs: 31_000, at: at(299, 34) }
          ]
        }
      },
      { id: 'r3', name: '[Navn]', org: 'A&R', devices: 0, device: 'Ingen enhet registrert', events: {} },
      {
        id: 'r4',
        name: '[Navn]',
        org: 'Management',
        devices: 3,
        device: '3 enheter – over grensen på 2',
        events: {
          'blue-fire': [
            { event: 'open', positionMs: 0, at: at(30) },
            { event: 'play', positionMs: 0, at: at(30, 2) },
            { event: 'ended', positionMs: 96_000, at: at(28, 20) }
          ]
        }
      }
    ]
  },
  {
    slug: 'live-arkiv-inner',
    title: 'Live-arkiv – Inner Circle',
    tier: 'inner',
    assetSlugs: ['live-sett-demo'],
    opensAt: null,
    expiresAt: null,
    maxDevices: 3,
    recipients: []
  },
  {
    slug: 'supporter-preview',
    title: 'Supporter-preview',
    tier: 'supporter',
    assetSlugs: ['blue-fire'],
    opensAt: iso(2 * day),
    expiresAt: iso(9 * day),
    maxDevices: 2,
    recipients: []
  }
];

export function findDrop(slug: string): SeedDrop | undefined {
  return SEED_DROPS.find((d) => d.slug === slug);
}
