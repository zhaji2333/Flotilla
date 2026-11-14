import { createHash } from 'node:crypto';

// ── Traffic store ───────────────────────────────────────────
// Every target/internet exchange the plugin tools perform is recorded here.
// Findings may only cite these ids; the same ids and SHA-256 hashes are written
// into the task report for the control plane to persist as evidence.

export type TrafficKind = 'target' | 'internet';

export interface TrafficRecord {
  id: string;
  kind: TrafficKind;
  method: string;
  url: string;
  statusCode: number;
  requestText: string;
  responseText: string;
  requestSha256: string;
  responseSha256: string;
  requestBytes: number;
  responseBytes: number;
  untrusted: boolean;
}

export interface AssetRecord {
  type: string;
  value: string;
  notes?: string;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class TrafficStore {
  private seq = 0;
  readonly records: TrafficRecord[] = [];
  readonly assets: AssetRecord[] = [];

  record(input: {
    kind: TrafficKind;
    method: string;
    url: string;
    statusCode: number;
    requestText: string;
    responseText: string;
    untrusted?: boolean;
  }): TrafficRecord {
    this.seq += 1;
    const record: TrafficRecord = {
      id: `tr_${this.seq}`,
      kind: input.kind,
      method: input.method,
      url: input.url,
      statusCode: input.statusCode,
      requestText: input.requestText,
      responseText: input.responseText,
      requestSha256: sha256(input.requestText),
      responseSha256: sha256(input.responseText),
      requestBytes: Buffer.byteLength(input.requestText),
      responseBytes: Buffer.byteLength(input.responseText),
      untrusted: input.untrusted ?? input.kind === 'internet',
    };
    this.records.push(record);
    return record;
  }

  get(id: string): TrafficRecord | undefined {
    return this.records.find(record => record.id === id);
  }

  search(input: { host?: string; bodyContains?: string; limit?: number }): TrafficRecord[] {
    const host = input.host?.toLowerCase() ?? '';
    const needle = input.bodyContains?.toLowerCase() ?? '';
    return this.records
      .filter(record => !host || record.url.toLowerCase().includes(host))
      .filter(
        record =>
          !needle ||
          record.requestText.toLowerCase().includes(needle) ||
          record.responseText.toLowerCase().includes(needle),
      )
      .slice(-(input.limit ?? 8));
  }

  /** Restores a previous run's records so settlement/retry can cite existing ids. */
  restore(records: TrafficRecord[], assets: AssetRecord[]): void {
    for (const record of records) {
      if (!record?.id) continue;
      this.records.push(record);
      const numeric = Number.parseInt(record.id.replace(/^tr_/, ''), 10);
      if (Number.isFinite(numeric) && numeric > this.seq) this.seq = numeric;
    }
    this.insertAssets(assets);
  }

  insertAssets(items: AssetRecord[]): number {
    for (const item of items) {
      if (!this.assets.some(asset => asset.type === item.type && asset.value === item.value)) {
        this.assets.push(item);
      }
    }
    return this.assets.length;
  }

  listAssets(type?: string): AssetRecord[] {
    return this.assets.filter(asset => !type || asset.type === type);
  }
}
