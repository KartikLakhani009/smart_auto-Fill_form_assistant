import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { extractTextFromImage, extractTextFromPdf } from './ocr.js';
import { extractFields } from './llm.js';
import { scoreExtraction, computeStaticScore } from './scoring.js';
import { findMissingFields } from './utils.js';
import type { ExtractedDocument, LlmProvider } from './types.js';

// ─── Files to evaluate ────────────────────────────────────────────────────────
// Edit this list to add or remove documents for batch evaluation.

const FILES = [
  // 'files/adhar_2.jpg',
  'files/adhar1_2366193f.jpg',
  'files/pan_1.jpg',
  'files/Passport2.jpg',
  // 'files/indianpp_passport.jpg',
  // 'files/Indianpassportbiopage2025.jpg',
  // 'files/Get-Indian-Passport-Online-300x300.jpg',
  'files/resume_sample_student8ea47e04a8fe67e6b7acff0000376a3b.pdf',
  'files/sample-pdf-invoice.pdf',
  // 'files/wordpress-pdf-invoice-plugin-sample.pdf',
  // 'files/Downloadable-PDF-Invoices-Add-On-Samples.pdf',
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface BatchEntry {
  file: string;
  docType: string;
  staticScore: number;
  llmScore: number;
  finalScore: number;
  productionReady: boolean;
  missingFields: string[];
  lowConfidenceFields: string[];
  weaknesses: string[];
  improvements: string[];
  error?: string;
}

// ─── OCR dispatcher ───────────────────────────────────────────────────────────

async function runOcr(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const result = ext === '.pdf'
    ? await extractTextFromPdf(filePath)
    : await extractTextFromImage(filePath);
  return result.text;
}

// ─── Per-file processor ───────────────────────────────────────────────────────

async function processFile(filePath: string, provider: LlmProvider): Promise<BatchEntry> {
  const file = path.basename(filePath);
  try {
    const ocrText = await runOcr(filePath);
    if (!ocrText.trim()) {
      return emptyEntry(file, 'OCR returned empty text');
    }

    const extracted = await extractFields(ocrText, provider);
    const scoring = await scoreExtraction(extracted, ocrText, provider);

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
      docType: extracted.type,
      staticScore: scoring.staticScore,
      llmScore: scoring.llmScore,
      finalScore: scoring.finalScore,
      productionReady: scoring.evaluation.production_ready ?? false,
      missingFields,
      lowConfidenceFields,
      weaknesses,
      improvements: scoring.evaluation.recommended_improvements ?? [],
    };
  } catch (err) {
    return emptyEntry(file, err instanceof Error ? err.message : String(err));
  }
}

function emptyEntry(file: string, error: string): BatchEntry {
  return {
    file, docType: 'ERROR', staticScore: 0, llmScore: 0, finalScore: 0,
    productionReady: false, missingFields: [], lowConfidenceFields: [],
    weaknesses: [], improvements: [], error,
  };
}

// ─── Output ───────────────────────────────────────────────────────────────────

function printSummaryTable(results: BatchEntry[]): void {
  console.log('\n' + '═'.repeat(110));
  console.log(' BATCH EVALUATION SUMMARY');
  console.log('═'.repeat(110));
  console.log([
    'File'.padEnd(52), 'Type'.padEnd(16),
    'Static'.padEnd(8), 'LLM'.padEnd(6), 'Final'.padEnd(7), 'Ready',
  ].join('  '));
  console.log('─'.repeat(110));

  for (const r of results) {
    if (r.error) {
      const short = r.error.length > 50 ? r.error.slice(0, 47) + '...' : r.error;
      console.log(`${r.file.padEnd(52)}  ${'ERROR'.padEnd(16)}  ${short}`);
      continue;
    }
    console.log([
      r.file.slice(0, 50).padEnd(52),
      r.docType.padEnd(16),
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

    console.log(`  Type: ${r.docType}  |  Final: ${r.finalScore.toFixed(2)}/10  |  Production: ${r.productionReady ? 'YES' : 'NO'}`);

    if (r.missingFields.length > 0) {
      console.log(`\n  Missing fields (${r.missingFields.length}):`);
      r.missingFields.slice(0, 10).forEach((f) => console.log(`    • ${f}`));
      if (r.missingFields.length > 10) console.log(`    ... and ${r.missingFields.length - 10} more`);
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
  const useGemini = rawArgs.some((a) => a === '--gemini' || a === 'gemini');
  const provider: LlmProvider = useGemini ? 'gemini' : 'local';

  const resolved = FILES.map((f) => path.resolve(f));
  const missing = resolved.filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    console.warn('Files not found (skipped):');
    missing.forEach((f) => console.warn(`  ${f}`));
  }
  const files = resolved.filter((f) => fs.existsSync(f));
  if (files.length === 0) { console.error('No files to process.'); process.exit(1); }

  console.log(`Smart Auto-Fill Form Assistant — Batch Evaluation  [provider: ${provider}]`);
  console.log(`Processing ${files.length} file(s)...\n`);

  const results: BatchEntry[] = [];
  for (const filePath of files) {
    const file = path.basename(filePath);
    process.stdout.write(`  [${results.length + 1}/${files.length}] ${file} ... `);
    const entry = await processFile(filePath, provider);
    const suffix = entry.error
      ? `ERROR: ${entry.error.slice(0, 60)}\n`
      : `${entry.docType}  ${entry.finalScore.toFixed(2)}/10\n`;
    process.stdout.write(suffix);
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
