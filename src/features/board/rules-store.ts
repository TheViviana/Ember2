/**
 * CR-20261123-69 / S3：标签 → 八维映射规则。
 *
 * 规则按库隔离存在 localStorage：`ember2:board:dimension-rules:v1:<vaultId>`。
 * 只用于「预填」：文档没有任何显式标注时，命中标签的规则决定雷达归属；
 * 用户在分类面板勾选后写入覆盖层，显式标注永远优先于规则。
 *
 * pattern 支持 `*` 通配（如 `方法/*`），匹配不区分大小写。
 */
import {
  isBoardDimensionId,
  normalizeDimensions,
  type BoardDimensionId,
} from './model.ts';

export const BOARD_RULES_STORAGE_PREFIX = 'ember2:board:dimension-rules:v1:';
export const BOARD_RULES_SCHEMA_VERSION = 1;
export const BOARD_RULES_MAX = 50;
export const BOARD_RULE_PATTERN_MAX = 100;

export function rulesStorageKey(vaultId: string): string {
  return `${BOARD_RULES_STORAGE_PREFIX}${vaultId}`;
}

export interface BoardDimensionRule {
  readonly pattern: string;
  readonly dimension: BoardDimensionId;
}

export interface RulesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LoadedDimensionRules {
  readonly rules: readonly BoardDimensionRule[];
  readonly warning: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function patternKey(pattern: string): string {
  return pattern.trim().toLowerCase();
}

function parseRule(value: unknown): BoardDimensionRule | null {
  if (!isRecord(value)) return null;
  const pattern = value['pattern'];
  const dimension = value['dimension'];
  if (typeof pattern !== 'string' || !isBoardDimensionId(dimension)) return null;
  const trimmed = pattern.trim();
  if (trimmed === '' || trimmed.length > BOARD_RULE_PATTERN_MAX) return null;
  return Object.freeze({ pattern: trimmed, dimension });
}

export function loadDimensionRules(
  storage: RulesStorage,
  vaultId: string,
): LoadedDimensionRules {
  let raw: string | null;
  try {
    raw = storage.getItem(rulesStorageKey(vaultId));
  } catch {
    return { rules: [], warning: '标签规则读取失败，本次不预填维度' };
  }
  if (raw === null) return { rules: [], warning: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rules: [], warning: '标签规则无法解析，已忽略' };
  }
  if (!isRecord(parsed) || parsed['version'] !== BOARD_RULES_SCHEMA_VERSION) {
    return { rules: [], warning: '标签规则格式无效，已忽略' };
  }
  const items = parsed['rules'];
  if (!Array.isArray(items)) {
    return { rules: [], warning: '标签规则格式无效，已忽略' };
  }

  const rules: BoardDimensionRule[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const value of items) {
    const rule = parseRule(value);
    if (rule === null) {
      invalid += 1;
      continue;
    }
    const key = `${patternKey(rule.pattern)}\u0000${rule.dimension}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (rules.length < BOARD_RULES_MAX) rules.push(rule);
  }
  return {
    rules,
    warning: invalid === 0 ? null : `标签规则含 ${invalid} 条无效记录，已忽略`,
  };
}

export function saveDimensionRules(
  storage: RulesStorage,
  vaultId: string,
  rules: readonly BoardDimensionRule[],
): string | null {
  try {
    storage.setItem(
      rulesStorageKey(vaultId),
      JSON.stringify({ version: BOARD_RULES_SCHEMA_VERSION, rules }),
    );
    return null;
  } catch {
    return '标签规则保存失败，本次更改未持久化';
  }
}

export function addDimensionRule(
  rules: readonly BoardDimensionRule[],
  pattern: string,
  dimension: BoardDimensionId,
): readonly BoardDimensionRule[] {
  const trimmed = pattern.trim();
  if (trimmed === '' || trimmed.length > BOARD_RULE_PATTERN_MAX) return rules;
  if (rules.length >= BOARD_RULES_MAX) return rules;
  const key = `${patternKey(trimmed)}\u0000${dimension}`;
  if (rules.some((rule) => `${patternKey(rule.pattern)}\u0000${rule.dimension}` === key)) {
    return rules;
  }
  return [...rules, Object.freeze({ pattern: trimmed, dimension })];
}

export function removeDimensionRule(
  rules: readonly BoardDimensionRule[],
  index: number,
): readonly BoardDimensionRule[] {
  if (index < 0 || index >= rules.length) return rules;
  return rules.filter((_, current) => current !== index);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternRegExp(pattern: string): RegExp {
  const source = escapeRegExp(patternKey(pattern)).replace(/\\\*/g, '.*');
  return new RegExp(`^${source}$`);
}

/** 命中标签的规则维度；顺序固定为八维顺序，重复维度只保留一个。 */
export function matchDimensionRules(
  tags: readonly string[],
  rules: readonly BoardDimensionRule[],
): readonly BoardDimensionId[] {
  if (tags.length === 0 || rules.length === 0) return [];
  const matched = new Set<BoardDimensionId>();
  for (const rule of rules) {
    const expression = patternRegExp(rule.pattern);
    if (tags.some((tag) => expression.test(tag.trim().toLowerCase()))) {
      matched.add(rule.dimension);
    }
  }
  return normalizeDimensions([...matched]);
}
