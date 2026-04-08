import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../github/client.js', () => ({
  getIssueEvents: vi.fn().mockResolvedValue([]),
}));

import { analyzeEditHistory } from './edit-history.js';
import { getIssueEvents } from '../github/client.js';

describe('detection/edit-history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no edits -> fraudScore 0, not suspicious', async () => {
    vi.mocked(getIssueEvents).mockResolvedValue([]);
    const result = await analyzeEditHistory('owner', 'repo', 42001);
    expect(result.fraudScore).toBe(0);
    expect(result.suspicious).toBe(false);
    expect(result.edits).toHaveLength(0);
  });

  it('rapid edits (3+ in 5 min) -> high score', async () => {
    const baseTime = new Date('2025-01-01T12:00:00Z').getTime();
    const events = [
      { id: 1, event: 'edited', created_at: new Date(baseTime).toISOString(), actor: { login: 'user' } },
      { id: 2, event: 'edited', created_at: new Date(baseTime + 30_000).toISOString(), actor: { login: 'user' } },
      { id: 3, event: 'edited', created_at: new Date(baseTime + 60_000).toISOString(), actor: { login: 'user' } },
      { id: 4, event: 'edited', created_at: new Date(baseTime + 90_000).toISOString(), actor: { login: 'user' } },
    ];
    vi.mocked(getIssueEvents).mockResolvedValue(events);

    const result = await analyzeEditHistory('owner', 'repo', 42001);
    expect(result.fraudScore).toBeGreaterThanOrEqual(0.4);
  });

  it('title renames -> adds to score', async () => {
    const baseTime = new Date('2025-01-01T12:00:00Z').getTime();
    const events = [
      { id: 1, event: 'renamed', created_at: new Date(baseTime).toISOString(), actor: { login: 'user' } },
      { id: 2, event: 'renamed', created_at: new Date(baseTime + 3600_000).toISOString(), actor: { login: 'user' } },
    ];
    vi.mocked(getIssueEvents).mockResolvedValue(events);

    const result = await analyzeEditHistory('owner', 'repo', 42001);
    expect(result.fraudScore).toBeGreaterThanOrEqual(0.4); // 0.2 * 2 renames
  });

  it('many body edits -> adds to score', async () => {
    const baseTime = new Date('2025-01-01T12:00:00Z').getTime();
    const events = [
      { id: 1, event: 'edited', created_at: new Date(baseTime).toISOString(), actor: { login: 'user' } },
      { id: 2, event: 'edited', created_at: new Date(baseTime + 3600_000).toISOString(), actor: { login: 'user' } },
      { id: 3, event: 'edited', created_at: new Date(baseTime + 7200_000).toISOString(), actor: { login: 'user' } },
    ];
    vi.mocked(getIssueEvents).mockResolvedValue(events);

    const result = await analyzeEditHistory('owner', 'repo', 42001);
    expect(result.fraudScore).toBeGreaterThanOrEqual(0.2);
    expect(result.edits).toHaveLength(3);
  });

  it('score capped at 1.0', async () => {
    const baseTime = new Date('2025-01-01T12:00:00Z').getTime();
    // Many rapid edits + renames to exceed 1.0 raw score
    const events = [
      { id: 1, event: 'renamed', created_at: new Date(baseTime).toISOString(), actor: { login: 'user' } },
      { id: 2, event: 'renamed', created_at: new Date(baseTime + 10_000).toISOString(), actor: { login: 'user' } },
      { id: 3, event: 'renamed', created_at: new Date(baseTime + 20_000).toISOString(), actor: { login: 'user' } },
      { id: 4, event: 'edited', created_at: new Date(baseTime + 30_000).toISOString(), actor: { login: 'user' } },
      { id: 5, event: 'edited', created_at: new Date(baseTime + 40_000).toISOString(), actor: { login: 'user' } },
      { id: 6, event: 'edited', created_at: new Date(baseTime + 50_000).toISOString(), actor: { login: 'user' } },
      { id: 7, event: 'edited', created_at: new Date(baseTime + 60_000).toISOString(), actor: { login: 'user' } },
    ];
    vi.mocked(getIssueEvents).mockResolvedValue(events);

    const result = await analyzeEditHistory('owner', 'repo', 42001);
    expect(result.fraudScore).toBeLessThanOrEqual(1.0);
  });

  it('API failure -> graceful fallback (score 0)', async () => {
    vi.mocked(getIssueEvents).mockRejectedValue(new Error('API down'));
    const result = await analyzeEditHistory('owner', 'repo', 42001);
    expect(result.fraudScore).toBe(0);
    expect(result.suspicious).toBe(false);
  });
});
