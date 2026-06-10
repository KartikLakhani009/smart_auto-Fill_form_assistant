import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

import { extractTextFromImage, extractTextFromPdf } from './ocr.js';
import { extractFields } from './llm.js';
import { scoreExtraction } from './scoring.js';
import { findMissingFields, detectOcrSignals, preprocessOcr } from './utils.js';
import { USE_MODEL_TYPE } from './config.js';
import type { OcrSignalResult } from './utils.js';
import type { DocumentType, ExtractedDocument, LlmEvaluationResult, LlmProvider } from './types.js';

// ─── Files to evaluate ────────────────────────────────────────────────────────

const FILES = [
  // 'files/adhar_2.jpg',
  'files/adhar1_2366193f.jpg',
  'files/pan_1.jpg',
  'files/Passport/2.jpg',
  'files/indianpp_passport.jpg',
  // 'files/Indianpassportbiopage2025.jpg',
  // 'files/Get-Indian-Passport-Online-300x300.jpg',
  'files/resume_sample_student8ea47e04a8fe67e6b7acff0000376a3b.pdf',
  // 'files/sample-pdf-invoice.pdf',
  'files/wordpress-pdf-invoice-plugin-sample.pdf',
  // 'files/Downloadable-PDF-Invoices-Add-On-Samples.pdf',
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface BatchEntry {
  file: string;
  modelDocType: string;     // raw type returned by the LLM
  effectiveDocType: string; // type used for scoring (OCR override when USE_MODEL_TYPE=false)
  staticScore: number;
  llmScore: number;
  finalScore: number;
  productionReady: boolean;
  missingFields: string[];
  lowConfidenceFields: string[];
  weaknesses: string[];
  improvements: string[];
  llmExtractionRaw: string;             // raw LLM text before JSON parsing
  extractedFields: ExtractedDocument;  // parsed extraction output
  llmEvaluation: LlmEvaluationResult;  // full LLM evaluation output
  ocrText: string;
  ocrLength: number;
  ocrCleaned: string;       // noise-stripped OCR sent to model
  ocrCleanedLength: number;
  ocrSignals: OcrSignalResult;
  classificationMatch: boolean;
  error?: string;
}

// ─── Fallback constants ───────────────────────────────────────────────────────

const EMPTY_SIGNALS: OcrSignalResult = {
  suggestedType: 'UNKNOWN', matchedKeywords: {}, signalCounts: {}, topCount: 0,
};

const EMPTY_EXTRACTED: ExtractedDocument = { type: 'UNKNOWN', confidence: {} };

const EMPTY_EVALUATION: LlmEvaluationResult = {
  document_type: 'UNKNOWN', overall_score: 0, grade: 'N/A',
  dimensions: {}, missing_fields: [],
  recommended_improvements: [], production_ready: false,
};

function emptyEntry(file: string, error: string): BatchEntry {
  return {
    file,
    modelDocType: 'ERROR',
    effectiveDocType: 'ERROR',
    staticScore: 0,
    llmScore: 0,
    finalScore: 0,
    productionReady: false,
    missingFields: [],
    lowConfidenceFields: [],
    weaknesses: [],
    improvements: [],
    llmExtractionRaw: '',
    extractedFields: EMPTY_EXTRACTED,
    llmEvaluation: EMPTY_EVALUATION,
    ocrText: '',
    ocrLength: 0,
    ocrCleaned: '',
    ocrCleanedLength: 0,
    ocrSignals: EMPTY_SIGNALS,
    classificationMatch: false,
    error,
  };
}

// ─── OCR dispatcher ───────────────────────────────────────────────────────────

async function runOcr(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const result = ext === '.pdf'
    ? await extractTextFromPdf(filePath)
    : await extractTextFromImage(filePath);
  return result.text;
}

// ─── Effective document type ──────────────────────────────────────────────────
// USE_MODEL_TYPE=false: trust OCR signals (safe for weak local models).
// USE_MODEL_TYPE=true:  trust the model's own classification.

function resolveDocType(
  extracted: ExtractedDocument,
  ocrSignals: OcrSignalResult,
): DocumentType {
  if (USE_MODEL_TYPE) return extracted.type;
  const signalType = ocrSignals.suggestedType !== 'UNKNOWN' ? ocrSignals.suggestedType : null;
  return signalType ?? extracted.type;
}

// ─── Per-file processor ───────────────────────────────────────────────────────

async function processFile(filePath: string, provider: LlmProvider): Promise<BatchEntry> {
  const file = path.basename(filePath);
  // ocrText is declared outside try so the catch block can include it in the error entry.
  let ocrText = '';

  try {
    ocrText = await runOcr(filePath);
    if (!ocrText.trim()) {
      return { ...emptyEntry(file, 'OCR returned empty text'), ocrText, ocrLength: 0 };
    }

    const ocrCleaned = preprocessOcr(ocrText);
    const ocrSignals = detectOcrSignals(ocrText);
    const { document: extracted, rawResponse: llmExtractionRaw } = await extractFields(ocrText, provider);
    const classificationMatch = extracted.type === ocrSignals.suggestedType;

    const effectiveType = resolveDocType(extracted, ocrSignals);

    if (!classificationMatch && ocrSignals.topCount >= 1) {
      const overrideNote = (!USE_MODEL_TYPE && effectiveType !== extracted.type)
        ? ' [scoring with OCR signal type]'
        : '';
      console.warn(
        `  ⚠ MISMATCH: OCR signals → ${ocrSignals.suggestedType} ` +
        `(${ocrSignals.topCount} kw: ${(ocrSignals.matchedKeywords[ocrSignals.suggestedType] ?? []).join(', ')}) ` +
        `| model → ${extracted.type}${overrideNote}`,
      );
    }

    const docForScoring: ExtractedDocument = effectiveType !== extracted.type
      ? { ...extracted, type: effectiveType }
      : extracted;

    const scoring = await scoreExtraction(docForScoring, ocrText, provider);

    const missingFields = [
      ...(scoring.evaluation.missing_fields ?? []),
      ...findMissingFields(extracted),
    ].filter(Boolean);

    const lowConfidenceFields = Object.entries(extracted.confidence)
      .filter(([, s]) => s < 0.7)
      .map(([f, s]) => `${f} (${Math.round(s * 100)}%)`);

    const weaknesses = Object.entries(scoring.evaluation.dimensions ?? {})
      .filter(([, d]) => d.weakness?.trim())
      .map(([dim, d]) => `[${dim}] ${d.weakness}`);

    return {
      file,
      modelDocType: extracted.type,
      effectiveDocType: effectiveType,
      staticScore: scoring.staticScore,
      llmScore: scoring.llmScore,
      finalScore: scoring.finalScore,
      productionReady: scoring.evaluation.production_ready ?? false,
      missingFields,
      lowConfidenceFields,
      weaknesses,
      improvements: scoring.evaluation.recommended_improvements ?? [],
      llmExtractionRaw,
      extractedFields: extracted,
      llmEvaluation: scoring.evaluation,
      ocrText,
      ocrLength: ocrText.length,
      ocrCleaned,
      ocrCleanedLength: ocrCleaned.length,
      ocrSignals,
      classificationMatch,
    };

  } catch (err) {
    return {
      ...emptyEntry(file, err instanceof Error ? err.message : String(err)),
      ocrText,
      ocrLength: ocrText.length,
      ocrCleaned: ocrText ? preprocessOcr(ocrText) : '',
      ocrCleanedLength: ocrText ? preprocessOcr(ocrText).length : 0,
      ocrSignals: ocrText ? detectOcrSignals(ocrText) : EMPTY_SIGNALS,
      classificationMatch: false,
    };
  }
}

// ─── Output ───────────────────────────────────────────────────────────────────

function printSummaryTable(results: BatchEntry[]): void {
  console.log('\n' + '═'.repeat(110));
  console.log(' BATCH EVALUATION SUMMARY');
  console.log('═'.repeat(110));
  console.log(
    ['File'.padEnd(52), 'Type'.padEnd(16), 'Static'.padEnd(8), 'LLM'.padEnd(6), 'Final'.padEnd(7), 'Ready'].join('  '),
  );
  console.log('─'.repeat(110));

  for (const r of results) {
    if (r.error) {
      const short = r.error.length > 50 ? r.error.slice(0, 47) + '...' : r.error;
      console.log(`${r.file.padEnd(52)}  ${'ERROR'.padEnd(16)}  ${short}`);
      continue;
    }
    console.log([
      r.file.slice(0, 50).padEnd(52),
      r.effectiveDocType.padEnd(16),
      `${r.staticScore.toFixed(1)}/100`.padEnd(8),
      `${r.llmScore}/10`.padEnd(6),
      `${r.finalScore.toFixed(2)}/10`.padEnd(7),
      r.productionReady ? '✓ YES' : '✗ NO',
    ].join('  '));
  }
  console.log('═'.repeat(110));
}

function printDetailedReport(results: BatchEntry[]): void {
  console.log('\n' + '═'.repeat(80));
  console.log(' DETAILED REPORT PER DOCUMENT');
  console.log('═'.repeat(80));

  for (const r of results) {
    console.log(`\n▸ ${r.file}`);
    if (r.error) { console.log(`  ERROR: ${r.error}`); continue; }

    const noisePct = r.ocrLength > 0
      ? Math.round(((r.ocrLength - r.ocrCleanedLength) / r.ocrLength) * 100)
      : 0;
    const typeLabel = r.effectiveDocType !== r.modelDocType
      ? `${r.effectiveDocType} (model: ${r.modelDocType}, overridden by OCR signals)`
      : r.effectiveDocType;

    console.log(`  Type: ${typeLabel}  |  Final: ${r.finalScore.toFixed(2)}/10  |  Production: ${r.productionReady ? 'YES' : 'NO'}`);
    console.log(`  OCR: ${r.ocrLength} chars raw → ${r.ocrCleanedLength} chars cleaned (${noisePct}% removed)`);
    console.log(`  ┌─ OCR CLEANED (sent to model) ${'─'.repeat(42)}`);
    r.ocrCleaned.split('\n').forEach((line) => console.log(`  │ ${line}`));
    console.log(`  └${'─'.repeat(62)}`);

    const sig = r.ocrSignals;
    if (sig.topCount > 0) {
      const sigSummary = Object.entries(sig.matchedKeywords)
        .map(([t, kws]) => `${t}(${kws.length})`).join(', ');
      const matchIcon = r.classificationMatch ? '✓' : '⚠';
      console.log(`  ${matchIcon} OCR signals: ${sigSummary}`);
      if (!r.classificationMatch) {
        const hitKws = (sig.matchedKeywords[sig.suggestedType] ?? []).join(', ');
        console.log(`  ⚠ MISMATCH: signals → ${sig.suggestedType} [${hitKws}] | model → ${r.modelDocType}`);
      }
    } else {
      console.log(`  OCR signals: none (OCR may be too garbled)`);
    }

    if (r.missingFields.length > 0) {
      console.log(`\n  Missing fields (${r.missingFields.length}):`);
      r.missingFields.slice(0, 10).forEach((f) => console.log(`    • ${f}`));
      if (r.missingFields.length > 10) console.log(`    … and ${r.missingFields.length - 10} more`);
    }
    if (r.lowConfidenceFields.length > 0) {
      console.log('\n  Low-confidence fields:');
      r.lowConfidenceFields.forEach((f) => console.log(`    • ${f}`));
    }
    if (r.weaknesses.length > 0) {
      console.log('\n  Weaknesses:');
      r.weaknesses.forEach((w) => console.log(`    • ${w}`));
    }
    if (r.improvements.length > 0) {
      console.log('\n  Recommended improvements:');
      r.improvements.forEach((imp, i) => console.log(`    ${i + 1}. ${imp}`));
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function runBatch(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const PROVIDERS: LlmProvider[] = ['gemini', 'groq', 'local'];
  const provider: LlmProvider = rawArgs
    .map((a) => a.replace(/^--/, '') as LlmProvider)
    .find((a) => PROVIDERS.includes(a)) ?? 'local';

  const resolved = FILES.map((f) => path.resolve(f));
  const missing = resolved.filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    console.warn('Files not found (skipped):');
    missing.forEach((f) => console.warn(`  ${f}`));
  }
  const files = resolved.filter((f) => fs.existsSync(f));
  if (files.length === 0) { console.error('No files to process.'); process.exit(1); }

  console.log(`Smart Auto-Fill Form Assistant — Batch Evaluation  [provider: ${provider}, USE_MODEL_TYPE: ${USE_MODEL_TYPE}]`);
  console.log(`Processing ${files.length} file(s)...\n`);

  const results: BatchEntry[] = [];
  for (const filePath of files) {
    process.stdout.write(`  [${results.length + 1}/${files.length}] ${path.basename(filePath)} ... `);
    const entry = await processFile(filePath, provider);
    process.stdout.write(
      entry.error
        ? `ERROR: ${entry.error.slice(0, 60)}\n`
        : `${entry.effectiveDocType}  ${entry.finalScore.toFixed(2)}/10\n`,
    );
    results.push(entry);
    if (results.length < files.length) await new Promise((r) => setTimeout(r, 3000));
  }

  printSummaryTable(results);
  printDetailedReport(results);

  const outPath = path.resolve('batch_results.json');
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
  console.log(`\nJSON written → ${outPath}`);
}

runBatch().catch((err: unknown) => {
  console.error('Batch error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
