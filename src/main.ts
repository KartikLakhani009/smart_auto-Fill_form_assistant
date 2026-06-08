import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';
import { extractTextFromImage, extractTextFromPdf } from './ocr.js';
import { extractFields } from './llm.js';
import { scoreExtraction } from './scoring.js';
import { findMissingFields } from './utils.js';
import type { ExtractedDocument, LlmProvider, OcrResult } from './types.js';

// ─── OCR dispatcher ───────────────────────────────────────────────────────────

async function runOcr(filePath: string): Promise<OcrResult> {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.pdf' ? extractTextFromPdf(filePath) : extractTextFromImage(filePath);
}

// ─── Interactive review ───────────────────────────────────────────────────────

async function reviewAndEdit(doc: ExtractedDocument): Promise<ExtractedDocument> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n=== EXTRACTED FIELDS ===');
    console.log(JSON.stringify(doc, null, 2));

    const missing = findMissingFields(doc);
    if (missing.length > 0) {
      console.log('\nMissing / empty fields:');
      missing.forEach((f) => console.log(`  • ${f}`));
    }

    const lowConfidence = Object.entries(doc.confidence)
      .filter(([, score]) => score < 0.7)
      .map(([field, score]) => `  • ${field}: ${(score * 100).toFixed(0)}%`);
    if (lowConfidence.length > 0) {
      console.log('\nLow-confidence fields:');
      lowConfidence.forEach((l) => console.log(l));
    }

    console.log('\nEdit format: field.path=value  (comma-separate multiple)');
    console.log('Example:   personal.name=John Doe, id.aadhaar_number=1234 5678 9012');
    const answer = await rl.question('Edits (or Enter to skip): ');
    if (!answer.trim()) return doc;

    const updated = JSON.parse(JSON.stringify(doc)) as ExtractedDocument;
    for (const edit of answer.split(',').map((e) => e.trim())) {
      const eqIdx = edit.indexOf('=');
      if (eqIdx === -1) continue;
      const parts = edit.slice(0, eqIdx).trim().split('.');
      const value = edit.slice(eqIdx + 1).trim();
      let cursor: Record<string, unknown> = updated as Record<string, unknown>;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') break;
        cursor = cursor[parts[i]] as Record<string, unknown>;
      }
      cursor[parts[parts.length - 1]] = value;
      updated.confidence[parts[parts.length - 1]] = 1.0;
    }
    return updated;
  } finally {
    rl.close();
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function run(filePath: string, provider: LlmProvider): Promise<void> {
  console.log('Smart Auto-Fill Form Assistant');
  console.log(`Processing: ${filePath}  [provider: ${provider}]\n`);

  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const ocr = await runOcr(filePath);
  console.log(`Extracted ${ocr.text.length} chars via ${ocr.source}`);

  console.log('\nExtracting fields...');
  const extracted = await extractFields(ocr.text, provider);
  console.log(`Document type: ${extracted.type}`);

  console.log('\nScoring extraction quality...');
  const scoring = await scoreExtraction(extracted, ocr.text, provider);
  console.log(
    `Scores — Static: ${scoring.staticScore.toFixed(1)}/100  ` +
    `LLM: ${scoring.llmScore}/10  Final: ${scoring.finalScore.toFixed(2)}/10`,
  );
  if (!scoring.evaluation.production_ready) {
    console.log('\nImprovements needed:');
    scoring.evaluation.recommended_improvements?.forEach((item, i) => console.log(`  ${i + 1}. ${item}`));
  }

  const reviewed = await reviewAndEdit(extracted);

  const finalOutput = {
    ...reviewed,
    _meta: {
      source_file: path.basename(filePath),
      ocr_confidence: ocr.confidence,
      static_score: Number(scoring.staticScore.toFixed(1)),
      llm_score: scoring.llmScore,
      final_score: Number(scoring.finalScore.toFixed(2)),
      production_ready: scoring.evaluation.production_ready,
      missing_fields: scoring.evaluation.missing_fields ?? [],
    },
  };

  console.log('\n=== FINAL STRUCTURED JSON OUTPUT ===');
  console.log(JSON.stringify(finalOutput, null, 2));
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const useGemini = rawArgs.some((a) => a === '--gemini' || a === 'gemini');
const provider: LlmProvider = useGemini ? 'gemini' : 'local';
const inputFile = rawArgs.find((a) => a !== '--gemini' && a !== 'gemini' && a !== '--local' && a !== 'local');

if (!inputFile) {
  console.error('Usage:   npm run dev -- <path-to-file> [gemini|local]');
  console.error('Example: npm run dev -- files/adhar_2.jpg gemini');
  process.exit(1);
}

run(path.resolve(inputFile), provider).catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
