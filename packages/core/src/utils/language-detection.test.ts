/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getLanguageFromFilePath } from './language-detection.js';

describe('getLanguageFromFilePath', () => {
  it('detects language from simple extensions', () => {
    expect(getLanguageFromFilePath('test.ts')).toBe('TypeScript');
    expect(getLanguageFromFilePath('test.js')).toBe('JavaScript');
    expect(getLanguageFromFilePath('test.py')).toBe('Python');
    expect(getLanguageFromFilePath('test.go')).toBe('Go');
  });

  it('is case-insensitive for extensions', () => {
    expect(getLanguageFromFilePath('TEST.TS')).toBe('TypeScript');
    expect(getLanguageFromFilePath('test.JS')).toBe('JavaScript');
  });

  it('handles paths with multiple dots', () => {
    expect(getLanguageFromFilePath('test.spec.ts')).toBe('TypeScript');
    expect(getLanguageFromFilePath('archive.tar.gz')).toBeUndefined();
  });

  it('detects language from known filenames without extensions', () => {
    expect(getLanguageFromFilePath('Dockerfile')).toBe('Dockerfile');
    expect(getLanguageFromFilePath('dockerfile')).toBe('Dockerfile');
  });

  it('detects language from dotfiles', () => {
    expect(getLanguageFromFilePath('.gitignore')).toBe('Git');
    expect(getLanguageFromFilePath('.prettierrc')).toBe('Prettier');
    expect(getLanguageFromFilePath('.eslintrc')).toBe('ESLint');
  });

  it('returns undefined for unknown extensions', () => {
    expect(getLanguageFromFilePath('test.unknown')).toBeUndefined();
  });

  it('returns undefined for files without extensions or known names', () => {
    expect(getLanguageFromFilePath('README')).toBeUndefined();
    expect(getLanguageFromFilePath('test')).toBeUndefined();
  });

  it('handles paths with directories', () => {
    expect(getLanguageFromFilePath('src/index.ts')).toBe('TypeScript');
    expect(getLanguageFromFilePath('/usr/local/bin/.gitignore')).toBe('Git');
  });
});
