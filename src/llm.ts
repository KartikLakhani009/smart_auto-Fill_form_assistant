import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { EVALUATION_PROMPT, UNIFIED_PROMPT } from './prompts.js';
import { extractJson } from './utils.js';
import type {
  DocumentType,
  ExtractedDocument,
  FieldConfidenceMap,
  LlmEvaluationResult,
  LlmProvider,
} from './types.js';

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

async function callOllama(system: string, prompt: string): Promise<string> {
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
        format: 'json',
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
): Promise<ExtractedDocument> {
  if (provider === 'local') {
    console.log(`[local] extracting with ${OLLAMA_MODEL}…`);
    const text = await callOllama(UNIFIED_PROMPT, `OCR Text:\n\n${ocrText}`);
    const parsed = extractJson(text);
    return {
      type: (parsed.type as DocumentType) ?? 'UNKNOWN',
      confidence: (parsed.confidence as FieldConfidenceMap) ?? {},
      ...parsed,
    };
  }

  const response = await withRetry(
    () => ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: `OCR Text:\n\n${ocrText}`,
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
  const parsed = extractJson(response.text ?? '{}');
  return {
    type: (parsed.type as DocumentType) ?? 'UNKNOWN',
    confidence: (parsed.confidence as FieldConfidenceMap) ?? {},
    ...parsed,
  };
}

// ─── Evaluate ─────────────────────────────────────────────────────────────────

export async function evaluateExtraction(
  docType: string,
  ocrText: string,
  provider: LlmProvider = 'gemini',
): Promise<LlmEvaluationResult> {
  if (provider === 'local') {
    console.log(`[local] evaluating with ${OLLAMA_MODEL}…`);
    const text = await callOllama('', EVALUATION_PROMPT(docType, UNIFIED_PROMPT, ocrText));
    return extractJson(text) as unknown as LlmEvaluationResult;
  }

  const response = await withRetry(
    () => ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: EVALUATION_PROMPT(docType, UNIFIED_PROMPT, ocrText),
      config: {
        temperature: 0,
        maxOutputTokens: 3000,
        responseMimeType: 'application/json',
      },
    }),
    'evaluate',
  );
  return extractJson(response.text ?? '{}') as unknown as LlmEvaluationResult;
}
