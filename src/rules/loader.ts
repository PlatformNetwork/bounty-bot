/**
 * Dynamic rule loader.
 *
 * Scans the rules/ directory for .ts files, imports them, and
 * validates that each exports a default array of Rule objects.
 * Rules are cached after first load.
 *
 * File naming convention: rules/<category>.ts
 * e.g. rules/validity.ts, rules/spam.ts, rules/media.ts
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { logger } from '../logger.js';
import type { Rule } from './types.js';

const RULES_DIR = path.resolve(process.cwd(), 'rules');

let cachedRules: Rule[] | null = null;

/**
 * Load all rules from the rules/ directory.
 * Caches results — call reloadRules() to force refresh.
 */
export async function loadRules(): Promise<Rule[]> {
  if (cachedRules) return cachedRules;
  cachedRules = await scanAndLoad();
  return cachedRules;
}

/** Force reload rules from disk (useful after hot-update). */
export async function reloadRules(): Promise<Rule[]> {
  cachedRules = null;
  return loadRules();
}

/** Get cached rules synchronously (empty if not yet loaded). */
export function getRules(): Rule[] {
  return cachedRules ?? [];
}

/** Get rules filtered by category. */
export function getRulesByCategory(category: string): Rule[] {
  return (cachedRules ?? []).filter(
    (r) => r.category === category && r.enabled !== false,
  );
}

async function scanAndLoad(): Promise<Rule[]> {
  if (!fs.existsSync(RULES_DIR)) {
    logger.info({ dir: RULES_DIR }, 'Rules directory not found — no rules loaded');
    return [];
  }

  const files = fs
    .readdirSync(RULES_DIR)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
    .sort();

  if (files.length === 0) {
    logger.info('No rule files found in rules/');
    return [];
  }

  const allRules: Rule[] = [];

  for (const file of files) {
    const filePath = path.join(RULES_DIR, file);
    try {
      const fileUrl = pathToFileURL(filePath).href;
      const mod = await import(fileUrl);
      const rules: unknown = mod.default ?? mod.rules;

      if (!Array.isArray(rules)) {
        logger.warn({ file }, 'Rule file does not export a default array — skipped');
        continue;
      }

      let loaded = 0;
      for (const rule of rules) {
        if (isValidRule(rule)) {
          allRules.push(rule);
          loaded++;
        } else {
          logger.warn(
            { file, ruleId: (rule as { id?: string })?.id ?? 'unknown' },
            'Invalid rule shape — skipped',
          );
        }
      }

      logger.info({ file, count: loaded }, 'Rules loaded from file');
    } catch (err) {
      logger.error({ err, file }, 'Failed to load rule file');
    }
  }

  const enabledCount = allRules.filter((r) => r.enabled !== false).length;
  logger.info(
    { total: allRules.length, enabled: enabledCount, files: files.length },
    'All rules loaded',
  );

  return allRules;
}

function isValidRule(obj: unknown): obj is Rule {
  if (typeof obj !== 'object' || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.description === 'string' &&
    typeof r.category === 'string' &&
    typeof r.severity === 'string' &&
    typeof r.evaluate === 'function'
  );
}
