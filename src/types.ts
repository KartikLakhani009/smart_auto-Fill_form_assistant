export type LlmProvider = 'gemini' | 'groq' | 'local';

export type DocumentType =
  | 'RESUME'
  | 'PASSPORT'
  | 'AADHAAR'
  | 'PAN'
  | 'DRIVING_LICENSE'
  | 'INVOICE'
  | 'INSURANCE'
  | 'KYC'
  | 'UNKNOWN';

export interface OcrResult {
  text: string;
  confidence: number; // 0–100, from Tesseract or 100 for text-based PDFs
  source: 'tesseract' | 'pdftext';
}

export type FieldConfidenceMap = Record<string, number>; // field key → 0.0–1.0

export interface ExtractedDocument {
  type: DocumentType;
  confidence: FieldConfidenceMap;
  [key: string]: unknown;
}

export interface DimensionScore {
  score: number;
  reason: string;
  strength: string;
  weakness: string;
}

export interface LlmEvaluationResult {
  document_type: string;
  overall_score: number;   // 0–10
  grade: string;
  dimensions: Record<string, DimensionScore>;
  missing_fields: string[];
  recommended_improvements: string[];
  production_ready: boolean;
}

export interface ScoringResult {
  staticScore: number; // 0–100
  llmScore: number;    // 0–10
  finalScore: number;  // 0–100
  evaluation: LlmEvaluationResult;
}

export interface ExtractionResult {
  document: ExtractedDocument;
  rawResponse: string; // raw LLM text before JSON parsing
}
