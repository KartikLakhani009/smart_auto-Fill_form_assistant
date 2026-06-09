import { Type } from '@google/genai';

// ─── Shared dimension shape ───────────────────────────────────────────────────

const DIMENSION = {
  type: Type.OBJECT,
  properties: {
    score:    { type: Type.INTEGER },
    reason:   { type: Type.STRING },
    strength: { type: Type.STRING },
    weakness: { type: Type.STRING },
  },
  required: ['score', 'reason', 'strength', 'weakness'],
};

const GEMINI_DIMENSION_NAMES = [
  'type_detection',
  'field_coverage',
  'value_accuracy',
  'ocr_noise_handling',
  'json_output_reliability',
  'completeness',
  'confidence_calibration',
] as const;

// Local model only scores 4 dimensions — the other 3 are added as fixed defaults in code.
const LOCAL_DIMENSION_NAMES = [
  'type_detection',
  'field_coverage',
  'value_accuracy',
  'completeness',
] as const;

// ─── Gemini responseSchema ────────────────────────────────────────────────────

export const GEMINI_EVALUATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    document_type:            { type: Type.STRING },
    overall_score:            { type: Type.NUMBER },
    grade:                    { type: Type.STRING },
    dimensions: {
      type: Type.OBJECT,
      properties: Object.fromEntries(GEMINI_DIMENSION_NAMES.map((k) => [k, DIMENSION])),
      required: [...GEMINI_DIMENSION_NAMES],
    },
    missing_fields:           { type: Type.ARRAY, items: { type: Type.STRING } },
    recommended_improvements: { type: Type.ARRAY, items: { type: Type.STRING } },
    production_ready:         { type: Type.BOOLEAN },
  },
  required: [
    'document_type', 'overall_score', 'grade',
    'dimensions', 'missing_fields', 'recommended_improvements', 'production_ready',
  ],
};

// ─── Ollama format schema (local model, 4 dimensions only) ───────────────────
// Passed as `format` in Ollama /api/generate (v0.5+).
// Remaining 3 dimensions are merged in code after the model responds.

const DIMENSION_JSON = {
  type: 'object',
  properties: {
    score:    { type: 'integer', minimum: 0, maximum: 10 },
    reason:   { type: 'string' },
    strength: { type: 'string' },
    weakness: { type: 'string' },
  },
  required: ['score', 'reason', 'strength', 'weakness'],
};

export const OLLAMA_EVALUATION_SCHEMA = {
  type: 'object',
  properties: {
    document_type:            { type: 'string' },
    overall_score:            { type: 'number', minimum: 0, maximum: 10 },
    grade:                    { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'] },
    dimensions: {
      type: 'object',
      properties: Object.fromEntries(LOCAL_DIMENSION_NAMES.map((k) => [k, DIMENSION_JSON])),
      required: [...LOCAL_DIMENSION_NAMES],
    },
    missing_fields:           { type: 'array', items: { type: 'string' } },
    recommended_improvements: { type: 'array', items: { type: 'string' } },
    production_ready:         { type: 'boolean' },
  },
  required: [
    'document_type', 'overall_score', 'grade',
    'dimensions', 'missing_fields', 'recommended_improvements', 'production_ready',
  ],
};

// Fixed defaults merged into local evaluation results for the 3 un-scored dimensions.
export const LOCAL_FIXED_DIMENSIONS: Record<string, { score: number; reason: string; strength: string; weakness: string }> = {
  ocr_noise_handling:      { score: 5, reason: 'not evaluated by local model', strength: '', weakness: '' },
  json_output_reliability: { score: 8, reason: 'JSON schema enforced by Ollama', strength: '', weakness: '' },
  confidence_calibration:  { score: 5, reason: 'not evaluated by local model', strength: '', weakness: '' },
};
