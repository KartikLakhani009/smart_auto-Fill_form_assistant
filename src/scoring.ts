import { validateIdByPattern, ID_PATTERNS } from './utils.js';
import { evaluateExtraction } from './llm.js';
import type { ExtractedDocument, LlmEvaluationResult, LlmProvider, ScoringResult } from './types.js';

// Returned when the document type is UNKNOWN — no schema to evaluate against.
const UNKNOWN_EVALUATION: LlmEvaluationResult = {
  document_type: 'UNKNOWN',
  overall_score: 0,
  grade: 'N/A',
  dimensions: {},
  missing_fields: [],
  recommended_improvements: [],
  production_ready: false,
};

export function computeStaticScore(doc: ExtractedDocument, ocrText = ''): number {
  const has = (key: string): number => (doc[key] ? 1 : 0);
  const idField = (section: string, field: string): string | null =>
    ((doc[section] as Record<string, string> | undefined)?.[field]) ?? null;

  // When model returned UNKNOWN schema, fields land in raw_fields instead of proper sections.
  // Give partial section credit (0.5) if raw_fields has meaningful content.
  const rawFields = (doc.raw_fields ?? {}) as Record<string, unknown>;
  const rawHasData = Object.keys(rawFields).length >= 2;
  const sectionOrRaw = (key: string): number => has(key) || (rawHasData ? 0.5 : 0);

  // Three-tier ID search: proper section → raw_fields (values + keys) → OCR regex scan.
  // raw_fields keys are also checked because models sometimes put the ID as the key.
  // OCR scan uses an unanchored pattern so it matches within noisy lines.
  function findId(section: string, field: string, patternKey: string): string | null {
    const direct = idField(section, field);
    if (direct) return direct;
    const pattern = ID_PATTERNS[patternKey];
    if (!pattern) return null;
    const candidates = [
      ...Object.values(rawFields).map((v) => String(v ?? '')),
      ...Object.keys(rawFields),
    ];
    const fromRaw = candidates.find((v) => v && v !== 'null' && pattern.test(v.trim()));
    if (fromRaw) return fromRaw.trim();
    if (ocrText) {
      const unanchored = new RegExp(
        pattern.source.replace(/^\^/, '').replace(/\$$/, ''), pattern.flags,
      );
      const m = ocrText.match(unanchored);
      if (m) return m[0];
    }
    return null;
  }

  switch (doc.type) {
    case 'RESUME': {
      const present = has('personal') + has('skills') + has('experience') + has('education') + has('languages');
      return (present / 5) * 100;
    }
    case 'PASSPORT': {
      const idValid = validateIdByPattern(findId('document', 'passport_number', 'PASSPORT'), 'PASSPORT');
      return (sectionOrRaw('personal') + sectionOrRaw('document') + sectionOrRaw('mrz')) / 3 * 50 + (idValid ? 50 : 0);
    }
    case 'AADHAAR': {
      const idValid = validateIdByPattern(findId('id', 'aadhaar_number', 'AADHAAR'), 'AADHAAR');
      return (sectionOrRaw('personal') + sectionOrRaw('id') + sectionOrRaw('meta')) / 3 * 50 + (idValid ? 50 : 0);
    }
    case 'PAN': {
      const idValid = validateIdByPattern(findId('id', 'pan_number', 'PAN'), 'PAN');
      return (sectionOrRaw('personal') + sectionOrRaw('id')) / 2 * 50 + (idValid ? 50 : 0);
    }
    case 'DRIVING_LICENSE': {
      const idValid = validateIdByPattern(findId('id', 'license_number', 'DRIVING_LICENSE'), 'DRIVING_LICENSE');
      return (sectionOrRaw('personal') + sectionOrRaw('license') + sectionOrRaw('id')) / 3 * 50 + (idValid ? 50 : 0);
    }
    case 'INVOICE': {
      const idValid = validateIdByPattern(findId('document', 'invoice_number', 'INVOICE'), 'INVOICE');
      return (sectionOrRaw('document') + sectionOrRaw('parties') + sectionOrRaw('items') + sectionOrRaw('totals') + sectionOrRaw('payment')) / 5 * 50 + (idValid ? 50 : 0);
    }
    case 'INSURANCE': {
      const idValid = validateIdByPattern(findId('document', 'policy_number', 'INSURANCE'), 'INSURANCE');
      return (sectionOrRaw('document') + sectionOrRaw('insured') + sectionOrRaw('coverage') + sectionOrRaw('nominee') + sectionOrRaw('insurer')) / 5 * 50 + (idValid ? 50 : 0);
    }
    case 'KYC': {
      const present = has('personal') + has('ids') + has('contact') + has('financial') +
        has('documents_submitted') + has('verification_status');
      return (present / 6) * 100;
    }
    default:
      return 0;
  }
}

export async function scoreExtraction(
  doc: ExtractedDocument,
  ocrText: string,
  provider: LlmProvider,
): Promise<ScoringResult> {
  // UNKNOWN type means the document could not be classified — skip LLM evaluation entirely.
  // For USE_MODEL_TYPE=true this means the well-trained model couldn't identify it (trust that).
  // For USE_MODEL_TYPE=false this means OCR signals also found nothing useful.
  if (doc.type === 'UNKNOWN') {
    return { staticScore: 0, llmScore: 0, finalScore: 0, evaluation: UNKNOWN_EVALUATION };
  }

  const staticScore = computeStaticScore(doc, ocrText);
  const evaluation = await evaluateExtraction(doc.type, ocrText, doc, provider);
  const llmScore = evaluation.overall_score ?? 0;
  // staticScore 0–100, llmScore 0–10 → normalize both to 0–10 before averaging
  const finalScore = ((staticScore / 10) + llmScore) / 2;
  return { staticScore, llmScore, finalScore, evaluation };
}
