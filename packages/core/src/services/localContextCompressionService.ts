/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { type Config } from '../config/config.js';
import type { Content, Part } from '@google/genai';
import { LlmRole } from '../telemetry/types.js';
import { debugLogger } from '../utils/debugLogger.js';
import { getResponseText } from '../utils/partUtils.js';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export type FileLevel = 'FULL' | 'PARTIAL' | 'SUMMARY' | 'EXCLUDED';

export interface FileRecord {
  level: FileLevel;
  cachedSummary?: string;
  contentHash?: string;
}

export class LocalContextCompressionService {
  private config: Config;
  private state: Map<string, FileRecord> = new Map();
  private stateFilePath: string;

  constructor(config: Config) {
    this.config = config;
    const dir = this.config.storage.getProjectTempDir();
    this.stateFilePath = path.join(dir, 'compression_state.json');
  }

  async loadState() {
    try {
      if (existsSync(this.stateFilePath)) {
        const data = await fs.readFile(this.stateFilePath, 'utf-8');
        const parsed = JSON.parse(data);
        for (const [k, v] of Object.entries(parsed)) {
            this.state.set(k, v as FileRecord);
        }
      }
    } catch (e) {
      debugLogger.warn(`Failed to load compression state: ${e}`);
    }
  }

  getState(): Record<string, FileRecord> {
    const obj: Record<string, FileRecord> = {};
    for (const [k, v] of this.state.entries()) {
        obj[k] = v;
    }
    return obj;
  }

  setState(stateData: Record<string, FileRecord>) {
    this.state.clear();
    for (const [k, v] of Object.entries(stateData)) {
      this.state.set(k, v);
    }
  }

  async saveState() {
    try {
      const obj: Record<string, FileRecord> = {};
      for (const [k, v] of this.state.entries()) {
          obj[k] = v;
      }
      await fs.writeFile(this.stateFilePath, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (e) {
      debugLogger.warn(`Failed to save compression state: ${e}`);
    }
  }

  async compressHistory(history: Content[], userPrompt: string, abortSignal?: AbortSignal): Promise<Content[]> {
    const enabled = await this.config.getLocalContextCompression();
    if (!enabled) return history;

    const RECENT_TURNS_PROTECTED = 2;
    const cutoff = Math.max(0, history.length - RECENT_TURNS_PROTECTED * 2);

    // Pass 1: Find protected files
    const protectedFiles = new Set<string>();
    for (let i = 0; i < history.length; i++) {
      const turn = history[i];
      if (!turn.parts) continue;

      for (const part of turn.parts) {
        if (part.functionCall && (part.functionCall.name === 'read_file' || part.functionCall.name === 'read_many_files')) {
          const args = part.functionCall.args as any;
          if (args) {
            const filepath = args.filepath || (args.paths && args.paths[0]);
            if (filepath) {
              // If this read happened within the protected window, it's protected.
              if (i >= cutoff) {
                protectedFiles.add(filepath);
              }
            }
          }
        }
      }
    }

    // Pass 2: Compress old turns
    const result: Content[] = [];
    for (let i = 0; i < history.length; i++) {
      const turn = history[i];
      if (i >= cutoff || turn.role !== 'user' || !turn.parts) {
        result.push(turn);
        continue;
      }

      const newParts = await Promise.all(
        turn.parts.map((part: Part) => this.maybeCompressPart(part, protectedFiles, userPrompt, abortSignal))
      );
      result.push({ ...turn, parts: newParts });
    }

    // Check for invalid mixed-part turns (functionResponse combined with text parts).
    for (let i = 0; i < result.length; i++) {
      const turn = result[i];
      if (turn.role !== 'user' || !turn.parts) continue;
      const hasFunctionResponse = turn.parts.some(p => !!p.functionResponse);
      const hasNonFunctionResponse = turn.parts.some(p => !p.functionResponse);
      if (hasFunctionResponse && hasNonFunctionResponse) {
        debugLogger.warn('Compression produced a mixed-part turn. Restoring original turn.');
        result[i] = history[i];
      }
    }

    // Validate structural integrity: every functionCall MUST be followed by a functionResponse in the next turn.
    for (let i = 0; i < result.length; i++) {
      const turn = result[i];
      if (turn.parts) {
        for (const part of turn.parts) {
          if (part.functionCall) {
            // Check the very next turn
            const nextTurn = result[i + 1];
            if (!nextTurn || nextTurn.role !== 'user' || !nextTurn.parts) {
              debugLogger.warn('Compression broke functionCall/functionResponse adjacency invariant. Falling back to uncompressed history.');
              return history;
            }
            const hasMatchingResponse = nextTurn.parts.some(
              (p) => p.functionResponse && p.functionResponse.name === part.functionCall!.name
            );
            if (!hasMatchingResponse) {
              debugLogger.warn('Compression broke functionCall/functionResponse adjacency invariant. Falling back to uncompressed history.');
              return history;
            }
          }
        }
      }
    }

    return result;
  }

  private async maybeCompressPart(part: any, protectedFiles: Set<string>, userPrompt: string, abortSignal?: AbortSignal): Promise<any> {
    const resp = part.functionResponse;
    if (!resp) return part;
    if (resp.name !== 'read_file' && resp.name !== 'read_many_files') return part;

    const output = resp.response?.output as string;
    if (!output || typeof output !== 'string') return part;

    // Extract filepath from output format
    const match = output.match(/--- (.+?) ---\n/);
    let filepath = '';

    if (match) {
        filepath = match[1];
    } else {
        // Try another common format or fallback.
        // Note: For read_many_files, the output concatenates multiple files.
        // Currently, we just parse the very first file from the output. True multi-file
        // compression for read_many_files is a known limitation.
        const lines = output.split('\n');
        if (lines[0] && lines[0].includes('---')) {
            filepath = lines[0].replace(/---/g, '').trim();
        } else {
            return part; // Can't reliably parse
        }
    }

    if (protectedFiles.has(filepath)) {
      return part; // Skip compression for protected files
    }

    const compressed = await this.compressFileContent(filepath, output, userPrompt, abortSignal);
    if (compressed === output) return part; // nothing changed

    return {
      functionResponse: {
        ...resp,
        response: { ...resp.response, output: compressed },
      },
    };
  }

  async compressFileContent(
    filepath: string,
    rawContent: string,
    userPrompt: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const hash = crypto.createHash('sha256').update(rawContent).digest('hex').slice(0, 12);
    const record: FileRecord = this.state.get(filepath) ?? {
      level: 'FULL',
    };

    // Invalidate cached summary if file changed
    if (record.contentHash && record.contentHash !== hash) {
      record.cachedSummary = undefined;
    }
    record.contentHash = hash;

    // Strip standard headers from tool outputs so line numbers align correctly
    let contentToProcess = rawContent;
    if (contentToProcess.startsWith('--- ')) {
        const firstNewline = contentToProcess.indexOf('\n');
        if (firstNewline !== -1) {
            contentToProcess = contentToProcess.substring(firstNewline + 1);
        }
    }
    const lines = contentToProcess.split('\n');
    const preview = lines.slice(0, 30).join('\n');

    const decision = await this.queryLocalModel(filepath, lines.length, preview, userPrompt, abortSignal);
    record.level = decision.level;
    this.state.set(filepath, record);
    await this.saveState();

    if (decision.level === 'FULL') {
      return rawContent;
    }

    if (decision.level === 'PARTIAL' && decision.startLine && decision.endLine) {
      const start = Math.max(0, decision.startLine - 1);
      const end = Math.min(lines.length, decision.endLine);
      const snippet = lines
        .slice(start, end)
        .map((l, i) => `${start + i + 1} | ${l}`)
        .join('\n');
      return (
        `[Showing lines ${decision.startLine}–${decision.endLine} of ${lines.length} ` +
        `in ${path.basename(filepath)}. Full file available via read_file.]\n\n${snippet}`
      );
    }

    if (decision.level === 'SUMMARY') {
      if (!record.cachedSummary) {
        record.cachedSummary = await this.generateSummary(filepath, contentToProcess, abortSignal);
        this.state.set(filepath, record);
        await this.saveState();
      }
      return (
        `[Summary of ${path.basename(filepath)} (${lines.length} lines). ` +
        `Full file available via read_file.]\n\n${record.cachedSummary}`
      );
    }

    // EXCLUDED — return a one-liner stub
    return `[${path.basename(filepath)} omitted as not relevant to current query. ` +
           `Request via read_file if needed.]`;
  }

  getFileState(filepath: string): FileRecord | undefined {
    return this.state.get(filepath);
  }

  private async queryLocalModel(
    filepath: string,
    lineCount: number,
    preview: string,
    userPrompt: string,
    abortSignal?: AbortSignal,
  ): Promise<{ level: FileLevel; startLine?: number; endLine?: number }> {
    const systemPrompt = `You are a context routing agent for a coding AI session.
Decide what level of file content to send to the main model.
Levels: FULL, PARTIAL (with line range), SUMMARY, EXCLUDED.
Rules:
- FULL if the file is directly relevant to the query or small (<80 lines)
- PARTIAL if only a specific section is needed — provide start_line and end_line
- SUMMARY for background context files not directly needed
- EXCLUDED for completely unrelated files
Respond ONLY with JSON: {"level":"FULL"|"PARTIAL"|"SUMMARY"|"EXCLUDED","start_line":null,"end_line":null}`;

    const userMessage = `Query: "${userPrompt}"
File: ${filepath} (${lineCount} lines)
Preview (first 30 lines):
${preview}`;

    if (this.config.getCompressionMode() === 'cloud') {
      const client = this.config.getBaseLlmClient();
      try {
        const responseJson = await client.generateJson({
          modelConfigKey: { model: 'compressor-2.5-flash-lite' },
          contents: [{ role: 'user', parts: [{ text: userMessage }] }],
          systemInstruction: systemPrompt,
          schema: {
            properties: {
              level: { type: 'STRING' },
              start_line: { type: 'INTEGER' },
              end_line: { type: 'INTEGER' },
            },
            required: ['level'],
          },
          promptId: 'local-context-compression-query',
          role: LlmRole.UTILITY_COMPRESSOR,
          abortSignal: abortSignal ?? new AbortController().signal,
        });
        return {
          level: (responseJson['level'] as any) || 'FULL',
          startLine: responseJson['start_line'] as number || undefined,
          endLine: responseJson['end_line'] as number || undefined,
        };
      } catch (e) {
        debugLogger.warn(`Cloud model context routing failed for ${filepath}: ${e}. Defaulting to FULL.`);
        return { level: 'FULL' };
      }
    }

    const modelUrl = await this.config.getLocalContextCompressionModelUrl();
    const modelName = await this.config.getLocalContextCompressionModelName();

    try {
      const fetchFn = (globalThis as any).fetch;
      if (!fetchFn) return { level: 'FULL' };
      const resp = await fetchFn(modelUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortSignal ?? new AbortController().signal,
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          response_format: { type: 'json_object' },
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const raw = data.choices[0].message.content;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return {
        level: parsed.level ?? 'FULL',
        startLine: parsed.start_line ?? undefined,
        endLine: parsed.end_line ?? undefined,
      };
    } catch (e) {
      debugLogger.warn(`Local model routing failed for ${filepath}: ${e}. Defaulting to FULL.`);
      return { level: 'FULL' };
    }
  }

  private async generateSummary(filepath: string, content: string, abortSignal?: AbortSignal): Promise<string> {
    const promptMessage = `Summarize this file in 2-3 sentences. Be technical and specific about what it exports, its key functions, and dependencies. File: ${filepath}\n\n${content.slice(0, 4000)}`;

    if (this.config.getCompressionMode() === 'cloud') {
      const client = this.config.getBaseLlmClient();
      try {
        const response = await client.generateContent({
          modelConfigKey: { model: 'compressor-2.5-flash-lite' },
          contents: [{ role: 'user', parts: [{ text: promptMessage }] }],
          promptId: 'local-context-compression-summary',
          role: LlmRole.UTILITY_COMPRESSOR,
          abortSignal: abortSignal ?? new AbortController().signal,
        });
        const text = getResponseText(response) ?? '';
        return text.trim();
      } catch (e) {
        return `[Summary generation failed for ${filepath} (cloud error): ${e}]`;
      }
    }

    const modelUrl = await this.config.getLocalContextCompressionModelUrl();
    const modelName = await this.config.getLocalContextCompressionModelName();
    try {
      const fetchFn = (globalThis as any).fetch;
      if (!fetchFn) return `[Summary generation skipped - fetch unavailable]`;
      const resp = await fetchFn(modelUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortSignal ?? new AbortController().signal,
        body: JSON.stringify({
          model: modelName,
          messages: [{
            role: 'user',
            content: promptMessage,
          }],
        }),
      });
      const data = await resp.json();
      return data.choices[0].message.content.trim();
    } catch (e) {
      return `[Summary generation failed for ${filepath}: ${e}]`;
    }
  }
}
