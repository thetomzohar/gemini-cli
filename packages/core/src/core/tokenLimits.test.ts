/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { tokenLimit, DEFAULT_TOKEN_LIMIT } from './tokenLimits.js';

describe('tokenLimit', () => {
  it('should return 2,097,152 for gemini-1.5-pro', () => {
    expect(tokenLimit('gemini-1.5-pro')).toBe(2_097_152);
  });

  it('should return 1,048,576 for gemini-1.5-flash', () => {
    expect(tokenLimit('gemini-1.5-flash')).toBe(1_048_576);
  });

  it('should return 1,048,576 for gemini-2.0-flash', () => {
    expect(tokenLimit('gemini-2.0-flash')).toBe(1_048_576);
  });

  it('should return 32,000 for gemini-2.0-flash-preview-image-generation', () => {
    expect(tokenLimit('gemini-2.0-flash-preview-image-generation')).toBe(32_000);
  });

  it('should return 1,048,576 for gemini-2.5-pro', () => {
    expect(tokenLimit('gemini-2.5-pro')).toBe(1_048_576);
  });

  it('should return DEFAULT_TOKEN_LIMIT for unknown models', () => {
    expect(tokenLimit('unknown-model')).toBe(DEFAULT_TOKEN_LIMIT);
  });

  it('should return DEFAULT_TOKEN_LIMIT for an empty string', () => {
    expect(tokenLimit('')).toBe(DEFAULT_TOKEN_LIMIT);
  });
});
