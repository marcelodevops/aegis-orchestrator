/**
 * Aegis Orchestrator - Secrets Management & Redaction
 * 
 * Stores sensitive integration tokens in the durable SQLite settings store,
 * and redacts secrets from client-facing API responses.
 */

import { storage } from '../storage/db.js';

export interface SensitiveConfig {
  [key: string]: any;
}

const REDACTED_MASK = '••••••••';

const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /key/i,
  /credential/i,
  /auth/i,
  /private/i,
  /webhook/i,
];

/**
 * Deeply redacts sensitive keys from any configuration object before returning to client.
 */
export function redactSensitiveConfig<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveConfig(item)) as unknown as T;
  }

  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((pat) => pat.test(key));
    if (isSensitive && typeof value === 'string' && value.length > 0) {
      result[key] = REDACTED_MASK;
    } else if (typeof value === 'object') {
      result[key] = redactSensitiveConfig(value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

/**
 * Saves integration secret in SQLite settings table.
 */
export function saveSecret(category: string, secretData: Record<string, any>): void {
  const current = storage.getSetting(`secret:${category}`) || {};
  // If the incoming data contains masked values, preserve existing secret value
  const merged: Record<string, any> = { ...current };
  for (const [k, v] of Object.entries(secretData)) {
    if (v === REDACTED_MASK && current[k]) {
      // keep existing
      merged[k] = current[k];
    } else {
      merged[k] = v;
    }
  }
  storage.setSetting(`secret:${category}`, merged, true);
}

/**
 * Retrieves unredacted secret for server-side operations only.
 */
export function getSecret(category: string): Record<string, any> | null {
  return storage.getSetting(`secret:${category}`);
}
