/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getLanguageFromFilePath } from './language-detection.js';

describe('getLanguageFromFilePath', () => {
  it('should detect language by standard extension', () => {
    expect(getLanguageFromFilePath('test.ts')).toBe('TypeScript');
    expect(getLanguageFromFilePath('main.py')).toBe('Python');
    expect(getLanguageFromFilePath('index.js')).toBe('JavaScript');
  });

  it('should be case insensitive for extensions', () => {
    expect(getLanguageFromFilePath('FILE.TS')).toBe('TypeScript');
    expect(getLanguageFromFilePath('Main.Py')).toBe('Python');
  });

  it('should handle multiple dots in filename', () => {
    expect(getLanguageFromFilePath('test.spec.js')).toBe('JavaScript');
    expect(getLanguageFromFilePath('archive.tar.gz')).toBeUndefined();
  });

  it('should return undefined for files with no extension', () => {
    expect(getLanguageFromFilePath('README')).toBeUndefined();
    expect(getLanguageFromFilePath('LICENSE')).toBeUndefined();
  });

  it('should detect language for filenames without extension but in map', () => {
    // Dockerfile is mapped as '.dockerfile'
    expect(getLanguageFromFilePath('Dockerfile')).toBe('Dockerfile');
  });

  it('should detect language for hidden files (dotfiles) in map', () => {
    expect(getLanguageFromFilePath('.gitignore')).toBe('Git');
    expect(getLanguageFromFilePath('.eslintrc')).toBe('ESLint');
  });

  it('should handle full paths correctly', () => {
    expect(getLanguageFromFilePath('src/utils/language-detection.ts')).toBe('TypeScript');
    expect(getLanguageFromFilePath('/absolute/path/to/main.py')).toBe('Python');
  });
});
