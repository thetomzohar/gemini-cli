/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContextCompressionService } from './contextCompressionService.js';
import type { Config } from '../config/config.js';
import type { Content } from '@google/genai';
import * as fsSync from 'node:fs';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

describe('ContextCompressionService', () => {
  let mockConfig: Partial<Config>;
  let service: ContextCompressionService;
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: any;

  beforeEach(() => {
    mockConfig = {
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue('/mock/temp/dir'),
      } as any,
      isContextCompressionEnabled: vi.fn().mockResolvedValue(true),
      getLocalContextCompressionModelUrl: vi
        .fn()
        .mockResolvedValue('http://mock'),
      getLocalContextCompressionModelName: vi
        .fn()
        .mockResolvedValue('mock-model'),
      getCurrentPrompt: vi.fn().mockReturnValue('mock prompt'),
      getCompressionMode: vi.fn().mockReturnValue('local'),
    };

    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    vi.mocked(fsSync.existsSync).mockReturnValue(false);

    service = new ContextCompressionService(mockConfig as Config);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe('compressHistory', () => {
    it('bypasses compression if feature flag is false', async () => {
      mockConfig.isContextCompressionEnabled = vi.fn().mockResolvedValue(false);
      const history: Content[] = [{ role: 'user', parts: [{ text: 'hello' }] }];

      const res = await service.compressHistory(history, 'test prompt');
      expect(res).toBe(history); // Reference equality, no work done
    });

    it('protects files that were read within the RECENT_TURNS_PROTECTED window', async () => {
      const history: Content[] = [
        // Turn 0 & 1 (Old)
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'read_file',
                args: { filepath: 'src/app.ts' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read_file',
                response: {
                  output: '--- src/app.ts ---\nLine 1\nLine 2\nLine 3',
                },
              },
            },
          ],
        },

        // Padding (Turns 2 & 3)
        { role: 'model', parts: [{ text: 'res 1' }] },
        { role: 'user', parts: [{ text: 'res 2' }] },

        // Padding (Turns 4 & 5)
        { role: 'model', parts: [{ text: 'res 3' }] },
        { role: 'user', parts: [{ text: 'res 4' }] },

        // Recent Turn (Turn 6 & 7, inside window, cutoff is Math.max(0, 8 - 4) = 4)
        // Here the model explicitly reads the file again
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'read_file',
                args: { filepath: 'src/app.ts' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read_file',
                response: {
                  output: '--- src/app.ts ---\nLine 1\nLine 2\nLine 3',
                },
              },
            },
          ],
        },
      ];

      const res = await service.compressHistory(history, 'test prompt');

      // Because src/app.ts was re-read recently (index 6 is >= 4), the OLD response at index 1 is PROTECTED.
      // It should NOT be compressed.
      const compressedOutput =
        res[1].parts![0].functionResponse!.response!['output'];
      expect(compressedOutput).toBe(
        '--- src/app.ts ---\nLine 1\nLine 2\nLine 3',
      );
      // Verify mockFetch wasn't called because it bypassed the LLM routing
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('compresses files read outside the protected window', async () => {
      const history: Content[] = [
        // Turn 0: The original function call to read the file
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'read_file',
                args: { filepath: 'src/old.ts' },
              },
            },
          ],
        },
        // Turn 1: The tool output response
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read_file',
                response: {
                  output: '--- src/old.ts ---\nLine 1\nLine 2\nLine 3\nLine 4',
                },
              },
            },
          ],
        },
        // Padding turns to push it out of the recent window
        { role: 'model', parts: [{ text: 'msg 2' }] },
        { role: 'user', parts: [{ text: 'res 2' }] },
        { role: 'model', parts: [{ text: 'msg 3' }] },
        { role: 'user', parts: [{ text: 'res 3' }] },
        { role: 'model', parts: [{ text: 'msg 4' }] },
        { role: 'user', parts: [{ text: 'res 4' }] },
      ];

      // Mock the routing request to return PARTIAL
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  'src/old.ts': {
                    level: 'PARTIAL',
                    start_line: 2,
                    end_line: 3,
                  },
                }),
              },
            },
          ],
        }),
      });

      const res = await service.compressHistory(history, 'test prompt');
      const compressedOutput =
        res[1].parts![0].functionResponse!.response!['output'];

      expect(compressedOutput).toContain('[Showing lines 2–3 of 4 in old.ts.');
      expect(compressedOutput).toContain('2 | Line 2');
      expect(compressedOutput).toContain('3 | Line 3');
    });

    it('returns SUMMARY and hits cache on subsequent requests', async () => {
      const history1: Content[] = [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'read_file',
                args: { filepath: 'src/index.ts' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read_file',
                response: {
                  output: `--- src/index.ts ---\nVery long content here...`,
                },
              },
            },
          ],
        },
        { role: 'model', parts: [{ text: 'p1' }] },
        { role: 'user', parts: [{ text: 'p2' }] },
        { role: 'model', parts: [{ text: 'p3' }] },
        { role: 'user', parts: [{ text: 'p4' }] },
        { role: 'model', parts: [{ text: 'p5' }] },
        { role: 'user', parts: [{ text: 'p6' }] },
      ];

      // 1st request: routing says SUMMARY
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  'src/index.ts': { level: 'SUMMARY' },
                }),
              },
            },
          ],
        }),
      });
      // 2nd request: the actual summarization call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'This is a cached summary.' } }],
        }),
      });

      await service.compressHistory(history1, 'test query');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Time passes, we get a new query. The file is still old.
      const history2: Content[] = [
        ...history1,
        { role: 'model', parts: [{ text: 'p7' }] },
        { role: 'user', parts: [{ text: 'p8' }] },
      ];

      // 3rd request: routing says SUMMARY again.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  'src/index.ts': { level: 'SUMMARY' },
                }),
              },
            },
          ],
        }),
      });

      const res = await service.compressHistory(history2, 'new query');

      // It should NOT make a 3rd fetch call for routing, since content has not changed and state is cached.
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const compressedOutput =
        res[1].parts![0].functionResponse!.response!['output'];
      expect(compressedOutput).toContain('This is a cached summary.');
    });
    it('returns unmodified history if structural validation fails', async () => {
      // Creating a broken history where functionCall is NOT followed by user functionResponse
      const brokenHistory: Content[] = [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'read_file',
                args: { filepath: 'src/index.ts' },
              },
            },
          ],
        },
        // Missing user functionResponse!
        { role: 'model', parts: [{ text: 'Wait, I am a model again.' }] },
        { role: 'user', parts: [{ text: 'This is invalid.' }] },
        { role: 'model', parts: [{ text: 'Yep.' }] },
        { role: 'user', parts: [{ text: 'Padding.' }] },
        { role: 'model', parts: [{ text: 'Padding.' }] },
      ];

      const res = await service.compressHistory(brokenHistory, 'test query');

      // Because it's broken, it should return the exact same array by reference.
      expect(res).toBe(brokenHistory);
    });
  });
});
