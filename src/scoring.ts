import { validateIdByPattern } from './utils.js';
import { evaluateExtraction } from './llm.js';
import type { ExtractedDocument, LlmProvider, ScoringResult } from './types.js';

export function computeStaticScore(doc: ExtractedDocument): number {
  const has = (key: string): number => (doc[key] ? 1 : 0);
  const idField = (section: string, field: string): string | null =>
    ((doc[section] as Record<string, string> | undefined)?.[field]) ?? null;

  switch (doc.type) {
    case 'RESUME': {
      const present = has('personal') + has('skills') + has('experience') + has('education') + has('languages');
      return (present / 5) * 100;
    }
    case 'PASSPORT': {
      const idValid = validateIdByPattern(idField('document', 'passport_number'), 'PASSPORT');
      return (has('personal') + has('document') + has('mrz')) / 3 * 50 + (idValid ? 50 : 0);
    }
    case 'AADHAAR': {
      const idValid = validateIdByPattern(idField('id', 'aadhaar_number'), 'AADHAAR');
      return (has('personal') + has('id') + has('meta')) / 3 * 50 + (idValid ? 50 : 0);
    }
    case 'PAN': {
      const idValid = validateIdByPattern(idField('id', 'pan_number'), 'PAN');
      return (has('personal') + has('id')) / 2 * 50 + (idValid ? 50 : 0);
    }
    case 'DRIVING_LICENSE': {
      const idValid = validateIdByPattern(idField('id', 'license_number'), 'DRIVING_LICENSE');
      return (has('personal') + has('license') + has('id')) / 3 * 50 + (idValid ? 50 : 0);
    }
    case 'INVOICE': {
      const idValid = validateIdByPattern(idField('document', 'invoice_number'), 'INVOICE');
      return (has('document') + has('parties') + has('items') + has('totals') + has('payment')) / 5 * 50 + (idValid ? 50 : 0);
    }
    case 'INSURANCE': {
      const idValid = validateIdByPattern(idField('document', 'policy_number'), 'INSURANCE');
      return (has('document') + has('insured') + has('coverage') + has('nominee') + has('insurer')) / 5 * 50 + (idValid ? 50 : 0);
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
  provider: LlmProvider = 'gemini',
): Promise<ScoringResult> {
  const staticScore = computeStaticScore(doc);
  const evaluation = await evaluateExtraction(doc.type, ocrText, provider);
  const llmScore = evaluation.overall_score ?? 0;
  // staticScore 0–100, llmScore 0–10 → normalize both to 0–10 before averaging
  const finalScore = ((staticScore / 10) + llmScore) / 2;
  return { staticScore, llmScore, finalScore, evaluation };
}
