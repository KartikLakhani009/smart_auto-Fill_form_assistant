import Tesseract from 'tesseract.js';
// Use legacy build — the standard build requires browser globals (DOMMatrix, etc.)
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { OcrResult } from './types.js';

// pdfjs v6 fake-worker does dynamic import(workerSrc) — must be a real file:// URL in Node.js
const _require = createRequire(import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = `file://${_require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')}`;
const STANDARD_FONT_DATA_URL = `file://${path.dirname(_require.resolve('pdfjs-dist/package.json'))}/standard_fonts/`;

export async function extractTextFromImage(filePath: string): Promise<OcrResult> {
  const { data } = await Tesseract.recognize(filePath, 'eng');
  const quality = data.confidence < 70 ? 'low — results may be inaccurate' : 'normal';
  console.log(`OCR confidence: ${data.confidence.toFixed(1)}% [${quality}]`);
  return {
    text: data.text.trim(),
    confidence: data.confidence,
    source: 'tesseract',
  };
}

async function detectPdfType(
  pdf: pdfjsLib.PDFDocumentProxy
): Promise<'text-based' | 'image-based'> {
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const text = content.items
    .map((item) => ('str' in item ? item.str : ''))
    .join('')
    .trim();
  return text.length > 50 ? 'text-based' : 'image-based';
}

async function ocrPdfPage(page: pdfjsLib.PDFPageProxy): Promise<{ text: string; confidence: number }> {
  // Scale 2× for better OCR accuracy
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.render({ canvas: canvas as any, viewport }).promise;
  const buffer = canvas.toBuffer('image/png');
  // Tesseract.js accepts Buffer in Node.js at runtime despite the TS type showing only HTMLImageElement/string
  const { data } = await Tesseract.recognize(buffer as unknown as string, 'eng');
  return { text: data.text.trim(), confidence: data.confidence };
}

export async function extractTextFromPdf(filePath: string): Promise<OcrResult> {
  const fileData = new Uint8Array(fs.readFileSync(filePath));
  const pdf = await pdfjsLib.getDocument({ data: fileData, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
  const pdfType = await detectPdfType(pdf);

  if (pdfType === 'image-based') {
    console.log(`Image-based PDF — running OCR on ${pdf.numPages} page(s)…`);
    const pageResults: Array<{ text: string; confidence: number }> = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const result = await ocrPdfPage(page);
      console.log(`  Page ${i} OCR confidence: ${result.confidence.toFixed(1)}%`);
      pageResults.push(result);
    }
    const avgConfidence =
      pageResults.reduce((sum, r) => sum + r.confidence, 0) / pageResults.length;
    return {
      text: pageResults.map((r) => r.text).join('\n\n').trim(),
      confidence: avgConfidence,
      source: 'tesseract',
    };
  }

  const pageTexts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .trim();
    pageTexts.push(text);
  }

  return {
    text: pageTexts.join('\n\n').trim(),
    confidence: 100,
    source: 'pdftext',
  };
}
