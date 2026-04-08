/**
 * Dynamic rule loader.
 *
 * Scans two directories:
 *   rules/code/  — CodeRule files (programmatic checks)
 *   rules/llm/   — LLMRule files (prompt instructions for the model)
 *
 * Also supports legacy flat rules/ files for backwards compatibility.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { logger } from '../logger.js';
import type { CodeRule, LLMRule } from './types.js';

const RULES_BASE = path.resolve(process.cwd(), 'rules');
const CODE_DIR = path.join(RULES_BASE, 'code');
const LLM_DIR = path.join(RULES_BASE, 'llm');

let cachedCodeRules: CodeRule[] | null = null;
let cachedLLMRules: LLMRule[] | null = null;

/* ------------------------------------------------------------------ */
/*  Code Rules                                                         */
/* ------------------------------------------------------------------ */

export async function loadCodeRules(): Promise<CodeRule[]> {
  if (cachedCodeRules) return cachedCodeRules;
  cachedCodeRules = await scanDir<CodeRule>(CODE_DIR, isValidCodeRule, 'code');
  return cachedCodeRules;
}

export function getCodeRules(): CodeRule[] {
  return cachedCodeRules ?? [];
}

export function getCodeRulesByCategory(category: string): CodeRule[] {
  return (cachedCodeRules ?? []).filter(
    (r) => r.category === category && r.enabled !== false,
  );
}

/* ------------------------------------------------------------------ */
/*  LLM Rules                                                          */
/* ------------------------------------------------------------------ */

export async function loadLLMRules(): Promise<LLMRule[]> {
  if (cachedLLMRules) return cachedLLMRules;
  cachedLLMRules = await scanDir<LLMRule>(LLM_DIR, isValidLLMRule, 'llm');
  return cachedLLMRules;
}

export function getLLMRules(): LLMRule[] {
  return cachedLLMRules ?? [];
}

/* ------------------------------------------------------------------ */
/*  Unified loaders                                                    */
/* ------------------------------------------------------------------ */

/** Load both code and LLM rules. Returns code rules for backwards compat. */
export async function loadRules(): Promise<CodeRule[]> {
  const [code, llm] = await Promise.all([loadCodeRules(), loadLLMRules()]);
  logger.info(
    { codeRules: code.length, llmRules: llm.length },
    'All rules loaded',
  );
  return code;
}

/** Force reload both rule sets from disk. */
export async function reloadRules(): Promise<CodeRule[]> {
  cachedCodeRules = null;
  cachedLLMRules = null;
  return loadRules();
}

/** Backwards compat — alias for getCodeRules(). */
export function getRules(): CodeRule[] {
  return getCodeRules();
}

/** Backwards compat — alias for getCodeRulesByCategory(). */
export function getRulesByCategory(category: string): CodeRule[] {
  return getCodeRulesByCategory(category);
}

/* ------------------------------------------------------------------ */
/*  Internal scanner                                                   */
/* ------------------------------------------------------------------ */

async function scanDir<T>(
  dir: string,
  validate: (obj: unknown) => obj is T,
  label: string,
): Promise<T[]> {
  if (!fs.existsSync(dir)) {
    logger.info({ dir }, `No ${label} rules directory — skipping`);
    return [];
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
    .sort();

  if (files.length === 0) {
    logger.info({ dir }, `No ${label} rule files found`);
    return [];
  }

  const all: T[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const fileUrl = pathToFileURL(filePath).href;
      const mod = await import(fileUrl);
      const items: unknown = mod.default ?? mod.rules;

      if (!Array.isArray(items)) {
        logger.warn({ file, label }, 'Rule file does not export a default array — skipped');
        continue;
      }

      let loaded = 0;
      for (const item of items) {
        if (validate(item)) {
          all.push(item);
          loaded++;
        } else {
          logger.warn(
            { file, label, ruleId: (item as { id?: string })?.id ?? 'unknown' },
            'Invalid rule shape — skipped',
          );
        }
      }

      logger.info({ file, label, count: loaded }, 'Rules loaded');
    } catch (err) {
      logger.error({ err, file, label }, 'Failed to load rule file');
    }
  }

  const enabled = all.filter((r) => (r as { enabled?: boolean }).enabled !== false).length;
  logger.info({ label, total: all.length, enabled }, `${label} rules ready`);
  return all;
}

/* ------------------------------------------------------------------ */
/*  Validators                                                         */
/* ------------------------------------------------------------------ */

function isValidCodeRule(obj: unknown): obj is CodeRule {
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

function isValidLLMRule(obj: unknown): obj is LLMRule {
  if (typeof obj !== 'object' || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.description === 'string' &&
    typeof r.category === 'string' &&
    typeof r.priority === 'string' &&
    typeof r.instruction === 'string'
  );
}
