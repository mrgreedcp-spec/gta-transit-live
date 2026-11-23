import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface FeedSnapshot {
  agency_id: string;
  retrieved_at?: string | null;
  source_modified_at?: string | null;
  valid_from?: string | null;
  valid_until?: string | null;
  status?: string;
  route_count?: number;
  stop_count?: number;
  input_kind?: string;
}

// Optional build-time snapshot. Absence means unknown, never "fresh" or "live".
export function getFeedSnapshot(): { generated_at: string | null; feeds: FeedSnapshot[] } {
  const file = process.env.GTFS_STATUS_FILE || path.resolve(process.cwd(), 'web/generated/feed-status.json');
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    const feeds = value.feeds ?? value.rows;
    if (!Array.isArray(feeds)) throw new Error('GTFS snapshot must contain a feeds array.');
    return { generated_at: typeof value.generated_at === 'string' ? value.generated_at : null, feeds };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { generated_at: null, feeds: [] };
    throw error;
  }
}
