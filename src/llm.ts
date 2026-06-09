import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { EVALUATION_PROMPT_GEMINI, EVALUATION_PROMPT_LOCAL, UNIFIED_PROMPT } from './prompts.js';
import { GEMINI_EVALUATION_SCHEMA, LOCAL_FIXED_DIMENSIONS, OLLAMA_EVALUATION_SCHEMA } from './schemas.js';
import { extractJson, preprocessOcr } from './utils.js';
import type {
  DocumentType,
  ExtractedDocument,
  ExtractionResult,
  FieldConfidenceMap,
  LlmEvaluationResult,
  LlmProvider,
} from './types.js';

const GEMINI_EXTRACT_MODEL = 'gemini-2.0-flash';
const GEMINI_EVAL_MODEL = 'gemini-2.5-flash';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'phi3';

// ─── Retry (Gemini 429 only) ──────────────────────────────────────────────────

export async function withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 4): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const is429 = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
      if (!is429 || attempt === maxRetries) throw err;

      let delayMs = 65_000;
      try {
        const parsed = JSON.parse(msg) as { error?: { details?: { retryDelay?: string }[] } };
        const detail = parsed.error?.details?.find((d) => d.retryDelay);
        if (detail?.retryDelay) delayMs = (parseInt(detail.retryDelay) + 5) * 1000;
      } catch { /* use default */ }

      console.warn(`[${label}: 429 — waiting ${Math.round(delayMs / 1000)}s, attempt ${attempt + 1}/${maxRetries}]`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Max retries exceeded');
}

// ─── Ollama ───────────────────────────────────────────────────────────────────

async function callOllama(system: string, prompt: string, schema?: object): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        system: system || undefined,
        prompt,
        stream: false,
        // schema object = structured output (Ollama v0.5+); string 'json' = generic JSON mode
        format: schema ?? 'json',
        options: { temperature: 0 },
      }),
    });
  } catch (err) {
    throw new Error(
      `Ollama unreachable at ${OLLAMA_BASE} — is it running? (${err instanceof Error ? err.message : err})`
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama ${res.status}: ${body}`);
  }
  const data = await res.json() as { response: string };
  return data.response;
}

// ─── Extract ──────────────────────────────────────────────────────────────────

export async function extractFields(
  ocrText: string,
  provider: LlmProvider = 'local',
): Promise<ExtractionResult> {
  const cleaned = preprocessOcr(ocrText);

  if (provider === 'local') {
    console.log(`[local] extracting with ${OLLAMA_MODEL}…`);
    const rawResponse = await callOllama(UNIFIED_PROMPT, `OCR Text:\n\n${cleaned}`);
    const parsed = extractJson(rawResponse);
    return {
      rawResponse,
      document: {
        type: (parsed.type as DocumentType) ?? 'UNKNOWN',
        confidence: (parsed.confidence as FieldConfidenceMap) ?? {},
        ...parsed,
      },
    };
  }

  const response = await withRetry(
    () => ai.models.generateContent({
      model: GEMINI_EXTRACT_MODEL,
      contents: `OCR Text:\n\n${cleaned}`,
      config: {
        systemInstruction: UNIFIED_PROMPT,
        temperature: 0,
        maxOutputTokens: 1500,
        responseMimeType: 'application/json',
      },
    }),
    'extract',
  );
  console.log('Token usage:', {
    input: response.usageMetadata?.promptTokenCount ?? 0,
    output: response.usageMetadata?.candidatesTokenCount ?? 0,
  });
  const rawResponse = response.text ?? '{}';
  const parsed = extractJson(rawResponse);
  return {
    rawResponse,
    document: {
      type: (parsed.type as DocumentType) ?? 'UNKNOWN',
      confidence: (parsed.confidence as FieldConfidenceMap) ?? {},
      ...parsed,
    },
  };
}

// ─── Evaluate ─────────────────────────────────────────────────────────────────

export async function evaluateExtraction(
  docType: string,
  ocrText: string,
  extracted: ExtractedDocument,
  provider: LlmProvider = 'local',
): Promise<LlmEvaluationResult> {
  const extractedJson = JSON.stringify(extracted, null, 2);
  const cleanedOcr = preprocessOcr(ocrText);

  if (provider === 'local') {
    console.log(`[local] evaluating with ${OLLAMA_MODEL}…`);
    const text = await callOllama(
      '',
      EVALUATION_PROMPT_LOCAL(docType, cleanedOcr, extractedJson),
      OLLAMA_EVALUATION_SCHEMA,
    );
    const result = extractJson(text) as unknown as LlmEvaluationResult;
    // Merge in the 3 fixed dimensions not scored by small models
    result.dimensions = { ...result.dimensions, ...LOCAL_FIXED_DIMENSIONS };
    return result;
  }

  const response = await withRetry(
    () => ai.models.generateContent({
      model: GEMINI_EVAL_MODEL,
      contents: EVALUATION_PROMPT_GEMINI(docType, cleanedOcr, extractedJson),
      config: {
        temperature: 0,
        maxOutputTokens: 3000,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_EVALUATION_SCHEMA,
      },
    }),
    'evaluate',
  );
  return extractJson(response.text ?? '{}') as unknown as LlmEvaluationResult;
}
