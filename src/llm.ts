import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { EVALUATION_OUTPUT_STRUCTURE, EVALUATION_PROMPT_GEMINI, EVALUATION_PROMPT_LOCAL, UNIFIED_PROMPT, UNIFIED_PROMPT_LOCAL } from './prompts.js';
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

// gemini-2.0-flash was shut down on 2026-06-01 — flash-lite has the highest
// free-tier limits of the 2.5 family (15 RPM / 1,000 RPD).
const GEMINI_EXTRACT_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_EVAL_MODEL = 'gemini-2.5-flash';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'phi3';

const GROQ_BASE = process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1';
const GROQ_MODEL = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

// ─── Retry (429 rate limits — Gemini & Groq) ──────────────────────────────────

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
      // Groq embeds the wait in plain text: "Please try again in 7.66s"
      const groqWait = msg.match(/try again in ([\d.]+)s/i);
      if (groqWait) delayMs = Math.ceil(parseFloat(groqWait[1]) + 2) * 1000;

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

// ─── Groq (OpenAI-compatible chat completions) ────────────────────────────────

async function callGroq(system: string, prompt: string, maxTokens: number): Promise<string> {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY missing in .env — get a free key at https://console.groq.com');
  }
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq ${res.status}: ${body}`);
  }
  const data = await res.json() as {
    choices: { message: { content: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  console.log('Token usage:', {
    input: data.usage?.prompt_tokens ?? 0,
    output: data.usage?.completion_tokens ?? 0,
  });
  return data.choices[0]?.message?.content ?? '{}';
}

// ─── Extract ──────────────────────────────────────────────────────────────────

export async function extractFields(
  ocrText: string,
  provider: LlmProvider = 'local',
): Promise<ExtractionResult> {
  const cleaned = preprocessOcr(ocrText);

  if (provider === 'local') {
    console.log(`[local] extracting with ${OLLAMA_MODEL}…`);
    const rawResponse = await callOllama(UNIFIED_PROMPT_LOCAL, `OCR Text:\n\n${cleaned}`);
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

  if (provider === 'groq') {
    console.log(`[groq] extracting with ${GROQ_MODEL}…`);
    const rawResponse = await withRetry(
      () => callGroq(UNIFIED_PROMPT, `OCR Text:\n\n${cleaned}`, 1500),
      'extract',
    );
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

  if (provider === 'groq') {
    console.log(`[groq] evaluating with ${GROQ_MODEL}…`);
    const text = await withRetry(
      () => callGroq(
        '',
        EVALUATION_PROMPT_GEMINI(docType, cleanedOcr, extractedJson) + EVALUATION_OUTPUT_STRUCTURE,
        3000,
      ),
      'evaluate',
    );
    return extractJson(text) as unknown as LlmEvaluationResult;
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
