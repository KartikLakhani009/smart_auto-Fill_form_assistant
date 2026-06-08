import type { ExtractedDocument } from './types.js';

export function extractJson(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw); } catch { /* fall through */ }

  const start = raw.indexOf('{');
  if (start !== -1) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(raw.slice(start, i + 1)); } catch { /* fall through */ }
        }
      }
    }
  }

  try { return JSON.parse(raw.replace(/```json|```/gi, '').trim()); } catch { /* fall through */ }

  return {
    type: 'UNKNOWN',
    reason: 'Could not parse LLM response as JSON',
    possible_type: null,
    raw_fields: { raw_response: raw.slice(0, 500) },
    confidence: {},
  };
}

export const ID_PATTERNS: Record<string, RegExp> = {
  AADHAAR:         /^\d{4}\s?\d{4}\s?\d{4}$/,
  PAN:             /^[A-Z]{5}[0-9]{4}[A-Z]$/,
  PASSPORT:        /^[A-Z]\d{7}$/,
  GSTIN:           /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/,
  DRIVING_LICENSE: /^[A-Z]{2}\d{2}[\s-]?\d{4}[\s-]?\d{7}$/,
  INVOICE:         /^INV[-/]?\d+/i,
  INSURANCE:       /^[A-Z]{2,10}[-/]?\d{4,}[-/]?\d+/i,
};

export function validateIdByPattern(id: string | null | undefined, type: string): boolean {
  if (!id) return false;
  const pattern = ID_PATTERNS[type];
  return pattern ? pattern.test(id.trim()) : false;
}

export function findMissingFields(doc: ExtractedDocument): string[] {
  const missing: string[] = [];

  function walk(value: unknown, fieldPath: string): void {
    if (value === null || value === undefined || value === '') {
      missing.push(fieldPath);
    } else if (Array.isArray(value) && value.length === 0) {
      missing.push(`${fieldPath} (empty)`);
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k === 'confidence' || k === 'type') continue;
        walk(v, fieldPath ? `${fieldPath}.${k}` : k);
      }
    }
  }

  walk(doc, '');
  return missing;
}
