# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Type-check (no emit)
npx tsc --noEmit

# Run single file (interactive review)
npm run dev -- files/adhar_2.jpg

# Run batch evaluation over all files/ (writes batch_results.json)
npm run batch

# Build to dist/
npm run build

# Run compiled output
node dist/main.js files/adhar_2.jpg
```

Pass any file from `files/` as the argument. PDFs must be text-based (not scanned).

## Architecture

Two-phase pipeline: **OCR → LLM extraction → scoring → interactive review → final JSON**.

```
src/
  types.ts     — shared interfaces (OcrResult, ExtractedDocument, ScoringResult, …)
  prompts.ts   — UNIFIED_PROMPT (extraction) + EVALUATION_PROMPT (scoring)
  ocr.ts       — extractTextFromImage (Tesseract.js) | extractTextFromPdf (pdfjs-dist legacy)
  utils.ts     — extractJson, ID_PATTERNS, validateIdByPattern, findMissingFields
  llm.ts       — GoogleGenAI client, withRetry, extractFields, evaluateExtraction
  scoring.ts   — computeStaticScore, scoreExtraction
  main.ts      — single-file interactive flow (OCR → extract → score → review → JSON)
  batch.ts     — multi-file loop; edit the FILES array at the top to select documents
```

### Key design decisions

**JSON output**: Gemini's `responseMimeType: 'application/json'` forces clean JSON output — no markdown fences, no preamble. `extractJson` is kept as a safety fallback. No prefill pattern needed (Claude-specific, removed).

**Confidence scores**: `UNIFIED_PROMPT` instructs the model to return a top-level `"confidence"` object mapping each field key to 0.0–1.0. These are separate from Tesseract's per-image OCR confidence (0–100 stored in `OcrResult.confidence`).

**Scoring**: `computeStaticScore` checks section presence + regex ID validation (0–100). `evaluateExtraction` calls Gemini 2.5 Flash with `EVALUATION_PROMPT` for 7-dimension quality scoring (0–10). Final score = `((staticScore/10) + llmScore) / 2`.

**pdfjs-dist**: must import from `pdfjs-dist/legacy/build/pdf.mjs` — the standard build requires browser globals (`DOMMatrix`, etc.) that don't exist in Node.js.

**Scanned PDFs** (image-based) are not supported — `extractTextFromPdf` throws a clear error. Pass individual page images instead.

## Environment

`.env` requires:
```
GEMINI_API_KEY=...
```

Models used: `gemini-2.0-flash` (extraction, fast/cheap) and `gemini-2.5-flash` (evaluation, higher quality).
