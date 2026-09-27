/**
 * Persistent search query store.
 *
 * Manages two things:
 *  1. The user's seed keywords (e.g. "dentist, derma, cricketer")
 *  2. The derived long-tail expansion generated each run
 *
 * Round-robin rotation:
 *   - Run 1:  seed queries  (dentist, derma, cricketer …)
 *   - Run 2:  expanded set  (dentist in USA, derma in USA …)
 *   - Run 3:  seed again
 *   … and so on, alternating
 *
 * Max 6 queries are executed per run (configurable).
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

export interface QueryStoreData {
  /** Original seed keywords entered by user */
  seeds: string[];
  /** Expanded long-tail variants generated on previous run */
  expanded: string[];
  /** 0 = use seeds next run, 1 = use expanded next run */
  nextRound: 0 | 1;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** Platform this store is for */
  platform: 'instagram' | 'linkedin';
}

const LONG_TAIL_SUFFIXES = [
  'in USA',
  'in India',
  'in UK',
  'in Canada',
  'in Australia',
  'online',
  'coach',
  'expert',
  'professional',
  'founder',
  'consultant',
];

export class QueryStore {
  private filePath: string;
  private data: QueryStoreData;

  constructor(filePath: string, platform: 'instagram' | 'linkedin') {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.data = this.load(platform);
  }

  private load(platform: 'instagram' | 'linkedin'): QueryStoreData {
    if (!fs.existsSync(this.filePath)) {
      return { seeds: [], expanded: [], nextRound: 0, updatedAt: new Date().toISOString(), platform };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<QueryStoreData>;
      const merged: QueryStoreData = {
        seeds:     raw.seeds     ?? [],
        expanded:  raw.expanded  ?? [],
        nextRound: (raw.nextRound === 1 ? 1 : 0) as 0 | 1,
        updatedAt: raw.updatedAt ?? new Date().toISOString(),
        platform,
      };
      return merged;
    } catch (err) {
      logger.warn(`Could not parse query store at ${this.filePath}: ${String(err)}`);
      return { seeds: [], expanded: [], nextRound: 0, updatedAt: new Date().toISOString(), platform };
    }
  }

  private save(): void {
    this.data.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  // ── Seeds ─────────────────────────────────────────────────────────────────────

  getSeeds(): string[] { return [...this.data.seeds]; }

  setSeeds(csv: string): void {
    const seeds = csv
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    this.data.seeds    = seeds;
    this.data.expanded = [];       // clear old expansion; will be regenerated
    this.data.nextRound = 0;       // start fresh with seeds
    this.save();
    logger.info(`[QueryStore:${this.data.platform}] Seeds updated: ${seeds.join(', ')}`);
  }

  // ── Long-tail expansion ───────────────────────────────────────────────────────

  /**
   * Generate expanded long-tail queries from seeds.
   * Each seed gets paired with a rotating suffix, giving at most
   * seeds.length × 1 variant (one unique suffix per seed per expansion round).
   */
  private generateExpanded(seeds: string[]): string[] {
    if (!seeds.length) return [];
    const result: string[] = [];
    seeds.forEach((seed, idx) => {
      const suffix = LONG_TAIL_SUFFIXES[idx % LONG_TAIL_SUFFIXES.length];
      result.push(`${seed} ${suffix}`);
    });
    return result;
  }

  // ── Active query list for next run ────────────────────────────────────────────

  /**
   * Returns the queries to use for the next agent run (max `limit`).
   * Also advances the round counter so the next call returns the other set.
   */
  getQueriesForRun(limit = 6): string[] {
    const seeds = this.data.seeds;

    if (!seeds.length) return [];

    let pool: string[];

    if (this.data.nextRound === 0) {
      // Round A — use seeds
      pool = seeds;
      // Pre-compute expansion for the NEXT round
      this.data.expanded  = this.generateExpanded(seeds);
      this.data.nextRound = 1;
    } else {
      // Round B — use expanded variants (or seeds if expansion is empty)
      pool = this.data.expanded.length ? this.data.expanded : seeds;
      this.data.nextRound = 0;
    }

    this.save();

    // Clamp to limit
    return pool.slice(0, limit);
  }

  /**
   * Preview what the NEXT run would use without advancing the counter.
   */
  previewNextRun(limit = 6): { round: 'seed' | 'expanded'; queries: string[] } {
    const seeds = this.data.seeds;
    if (!seeds.length) return { round: 'seed', queries: [] };

    if (this.data.nextRound === 0) {
      return { round: 'seed', queries: seeds.slice(0, limit) };
    }
    const exp = this.data.expanded.length ? this.data.expanded : seeds;
    return { round: 'expanded', queries: exp.slice(0, limit) };
  }

  getData(): QueryStoreData { return { ...this.data }; }
}
