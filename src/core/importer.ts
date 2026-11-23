// Parsing and writing word lists: CSV, TSV and plain pasted lists.
import { containsHangul, normalizeHangul } from './hangul';

export interface ImportRow {
  korean: string;
  meanings: string[];
  transcription?: string;
  example?: string;
  exampleTranslation?: string;
}

export interface ImportError {
  line: number;
  text: string;
  reason: 'too_few_columns' | 'empty_field';
}

export interface ImportResult {
  rows: ImportRow[];
  errors: ImportError[];
  delimiter: string;
}

/** Splits delimited text into records, honouring double-quoted fields. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (src.startsWith(delimiter, i)) {
      row.push(field);
      field = '';
      i += delimiter.length - 1;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const DELIMITERS = ['\t', ';', ',', ' — ', ' – ', ' - ', ' = '];

export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 20);
  for (const d of DELIMITERS) {
    const hits = lines.filter((l) => l.includes(d)).length;
    if (lines.length > 0 && hits >= Math.ceil(lines.length * 0.6)) return d;
  }
  return '\t';
}

const HEADER_WORDS = ['korean', 'word', 'корейск', 'слово', 'translation', 'перевод', '한국어', '단어'];

function looksLikeHeader(cells: string[]): boolean {
  const joined = cells.join(' ').toLowerCase();
  return !containsHangul(cells.slice(0, 2).join('').replace(/한국어|단어|번역|뜻/g, '')) && HEADER_WORDS.some((w) => joined.includes(w));
}

export function splitMeanings(text: string): string[] {
  return text
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Parses a word list. Columns: korean, translation, transcription, example,
 * example translation. If the Korean text is in the second column, the first
 * two columns are swapped.
 */
export function parseWordList(text: string, delimiter: string = detectDelimiter(text)): ImportResult {
  const records = parseDelimited(text, delimiter).map((r) => r.map((c) => c.trim()));
  const result: ImportResult = { rows: [], errors: [], delimiter };
  let start = 0;
  if (records.length > 0 && looksLikeHeader(records[0])) start = 1;
  const body = records.slice(start);
  const firstHangul = body.filter((r) => containsHangul(r[0] ?? '')).length;
  const secondHangul = body.filter((r) => containsHangul(r[1] ?? '') && !containsHangul(r[0] ?? '')).length;
  const swap = secondHangul > firstHangul;

  body.forEach((cells, idx) => {
    const line = idx + start + 1;
    if (cells.every((c) => c === '')) return;
    if (cells.length < 2) {
      result.errors.push({ line, text: cells.join(' '), reason: 'too_few_columns' });
      return;
    }
    const korean = normalizeHangul(swap ? cells[1] : cells[0]);
    const meanings = splitMeanings(swap ? cells[0] : cells[1]);
    if (korean === '' || meanings.length === 0) {
      result.errors.push({ line, text: cells.join(' | '), reason: 'empty_field' });
      return;
    }
    result.rows.push({
      korean,
      meanings,
      transcription: cells[2] || undefined,
      example: cells[3] || undefined,
      exampleTranslation: cells[4] || undefined,
    });
  });
  return result;
}

function quote(cell: string, delimiter: string): string {
  return cell.includes(delimiter) || /["\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function serializeWordList(rows: ImportRow[], delimiter: ',' | '\t'): string {
  const header = ['korean', 'translation', 'transcription', 'example', 'example_translation'];
  const lines = [header.join(delimiter)];
  for (const r of rows) {
    const cells = [r.korean, r.meanings.join('; '), r.transcription ?? '', r.example ?? '', r.exampleTranslation ?? ''];
    lines.push(cells.map((c) => quote(c, delimiter)).join(delimiter));
  }
  return lines.join('\n') + '\n';
}
