import type { DocumentType, ExtractedDocument } from './types.js';

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

// ─── OCR noise pre-processor ─────────────────────────────────────────────────
// Strips lines that are clearly noise (random symbols, garbled short tokens)
// while guaranteeing all real data (names, IDs, dates, amounts) is preserved.

// Patterns that always indicate real content — never strip these lines
const ALWAYS_KEEP: RegExp[] = [
  /\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}/,  // dates: 12/05/2023, 11-04-1992
  /\b\d{4}[\s]\d{4}[\s]\d{4}\b/,         // aadhaar: 1234 5678 9012
  /\b[A-Z]{5}\d{4}[A-Z]\b/,              // PAN: ABCDE1234F
  /^P<[A-Z]{3}/,                          // MRZ line 1: P<IND...
  /^[A-Z0-9<]{15,}/,                      // MRZ line 2: long alphanumeric+<
];

function shouldKeepLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  if (t.length <= 2) return false;

  // Never strip lines with critical patterns (IDs, dates, MRZ)
  if (ALWAYS_KEEP.some((p) => p.test(t))) return true;

  // Strip lines where <40% of non-space chars are alphanumeric
  // e.g. "| = Ris =e] Fl", "TT TT SEER —————", "es ;"
  const noSpace = t.replace(/\s/g, '');
  if (noSpace.length === 0) return false;
  const alphaNum = (noSpace.match(/[a-zA-Z0-9]/g) ?? []).length;
  if (alphaNum / noSpace.length < 0.40) return false;

  // Keep lines with at least one word of 4+ alpha chars (names, keywords)
  // e.g. "KALE", "REPUBLIC", "Surname", "INCOME", "Signature"
  if (/[a-zA-Z]{4,}/.test(t)) return true;

  // Keep lines with a digit run of 4+ (amounts, years, IDs)
  // e.g. "U0307921", "1673.01", "2025"
  if (/\d{4,}/.test(t)) return true;

  // Everything else (short random tokens, isolated symbols) → strip
  return false;
}

export function preprocessOcr(raw: string): string {
  const lines = raw.split('\n');
  const kept = lines.filter(shouldKeepLine);
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── OCR signal detection ─────────────────────────────────────────────────────
// Keyword-based heuristic: tells you what signals are present in OCR text
// so you can compare against what the model actually returned.

const TYPE_KEYWORDS: Record<DocumentType, (string | RegExp)[]> = {
  RESUME:          ['career objective', 'work experience', 'key skills', 'education', 'references', 'resume', 'curriculum vitae', 'employment history', 'availability'],
  PASSPORT:        ['passport', 'republic of india', 'p<ind', 'nationality', 'place of birth', 'date of issue', /p<[a-z]{3}/i],
  AADHAAR:         ['aadhaar', 'uidai', 'unique identification', 'government of india', /\b\d{4}\s\d{4}\s\d{4}\b/],
  PAN:             ['income tax department', 'permanent account number', /\b[a-z]{5}\d{4}[a-z]\b/i],
  DRIVING_LICENSE: ['driving licence', 'driving license', 'transport dept', 'vehicle class', 'lmv', 'mcwg'],
  INVOICE:         ['invoice', 'tax invoice', 'amount due', 'subtotal', 'bill to', 'invoice number', 'invoice date'],
  INSURANCE:       ['policy no', 'insurance policy', 'sum insured', 'premium', 'nominee'],
  KYC:             ['kyc', 'know your customer'],
  UNKNOWN:         [],
};

export interface OcrSignalResult {
  suggestedType: DocumentType | 'UNKNOWN';
  matchedKeywords: Record<string, string[]>; // docType → keywords found
  signalCounts: Record<string, number>;      // docType → count
  topCount: number;
}

export function detectOcrSignals(ocrText: string): OcrSignalResult {
  const lower = ocrText.toLowerCase();
  const matchedKeywords: Record<string, string[]> = {};
  const signalCounts: Record<string, number> = {};

  for (const [docType, keywords] of Object.entries(TYPE_KEYWORDS) as [DocumentType, (string | RegExp)[]][]) {
    if (docType === 'UNKNOWN') continue;
    const hits: string[] = [];
    for (const kw of keywords) {
      if (typeof kw === 'string' ? lower.includes(kw) : kw.test(ocrText)) {
        hits.push(typeof kw === 'string' ? kw : kw.source);
      }
    }
    if (hits.length > 0) {
      matchedKeywords[docType] = hits;
      signalCounts[docType] = hits.length;
    }
  }

  const sorted = Object.entries(signalCounts).sort(([, a], [, b]) => b - a);
  const suggestedType = sorted.length > 0 ? (sorted[0][0] as DocumentType) : 'UNKNOWN';
  const topCount = sorted.length > 0 ? sorted[0][1] : 0;

  return { suggestedType, matchedKeywords, signalCounts, topCount };
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
