// Runtime configuration and feature flags.
// Keep type definitions in types.ts — only tuneable values belong here.

// When false (default): OCR signal type overrides model classification for scoring.
// Keeps scores stable when using a small local model that often returns UNKNOWN.
// Set true only for a well-trained model whose document classification is reliable.
export const USE_MODEL_TYPE = true;
