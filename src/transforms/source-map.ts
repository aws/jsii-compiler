/*
 * ---------------------------------------------------------------------------
 * Insert text into emitted `.js` and keep its source map right.
 *
 * TypeScript 7 has no transformer hook, so code jsii adds to the emitted `.js`
 * is spliced into the text after emit. The inserted text has no mappings (the
 * same as the synthesized nodes of a TypeScript 6 transformer); the mappings of
 * the code after it move with it.
 * ---------------------------------------------------------------------------
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Replace `length` characters (default 0) at `offset` (an index into the original text) with `text`. */
export interface Insertion {
  readonly offset: number;
  readonly length?: number;
  readonly text: string;
}

const SOURCE_MAPPING_URL = /\n\/\/# sourceMappingURL=([^\n]*)\s*$/;
const DATA_URL_PREFIX = 'data:application/json;base64,';

/**
 * Apply `insertions` to the `.js` text of `jsFile`, and update its source map:
 * the inline one (a `data:` URL) in the text, or the `.js.map` file it points
 * to (rewritten on disk). Returns the new `.js` text.
 */
export function insertIntoEmittedJs(jsFile: string, text: string, insertions: readonly Insertion[]): string {
  if (insertions.length === 0) {
    return text;
  }
  // From the last to the first; at the same offset, a deletion before an insertion.
  const sorted = [...insertions].sort((l, r) => r.offset - l.offset || (r.length ?? 0) - (l.length ?? 0));

  let result = text;
  for (const ins of sorted) {
    result = result.slice(0, ins.offset) + ins.text + result.slice(ins.offset + (ins.length ?? 0));
  }

  const url = SOURCE_MAPPING_URL.exec(text)?.[1]?.trim();
  if (url == null) {
    return result;
  }
  if (url.startsWith(DATA_URL_PREFIX)) {
    const json = Buffer.from(url.slice(DATA_URL_PREFIX.length), 'base64').toString('utf-8');
    const updated = Buffer.from(updateMapJson(json, text, sorted), 'utf-8').toString('base64');
    return result.replace(url, `${DATA_URL_PREFIX}${updated}`);
  }
  const mapFile = path.resolve(path.dirname(jsFile), url);
  if (fs.existsSync(mapFile)) {
    fs.writeFileSync(mapFile, updateMapJson(fs.readFileSync(mapFile, 'utf-8'), text, sorted));
  }
  return result;
}

/**
 * Replace the `mappings` of a source map JSON text, leaving the rest of the
 * text as it is.
 */
function updateMapJson(json: string, text: string, descending: readonly Insertion[]): string {
  const mappings: string = JSON.parse(json).mappings;
  const lineStarts = lineStartsOf(text);
  const lines = decodeMappings(mappings);

  // Edits are applied from the last to the first, so the position of each
  // edit is still valid (in original coordinates) when it is applied.
  for (const ins of descending) {
    const from = positionOf(lineStarts, ins.offset);
    const to = positionOf(lineStarts, ins.offset + (ins.length ?? 0));
    if (from.line >= lines.length) {
      continue;
    }
    const inserted = ins.text.split('\n');
    const addedLines = inserted.length - 1;
    const lastLength = inserted[inserted.length - 1].length;

    const keep = lines[from.line].filter((seg) => seg[0] < from.column);
    const rest = (lines[to.line] ?? [])
      .filter((seg) => seg[0] >= to.column)
      .map((seg) => [seg[0] - to.column + (addedLines === 0 ? from.column + lastLength : lastLength), ...seg.slice(1)]);
    const replaced: Segment[][] =
      addedLines === 0 ? [[...keep, ...rest]] : [keep, ...Array.from({ length: addedLines - 1 }, () => []), rest];
    lines.splice(from.line, to.line - from.line + 1, ...replaced);
  }

  return json.replace(`"mappings":${JSON.stringify(mappings)}`, `"mappings":${JSON.stringify(encodeMappings(lines))}`);
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function positionOf(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let line = 0;
  while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) {
    line++;
  }
  return { line, column: offset - lineStarts[line] };
}

/** A decoded segment, all fields absolute: [genColumn, source?, line?, column?, name?]. */
type Segment = number[];

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeMappings(mappings: string): Segment[][] {
  const state = [0, 0, 0, 0, 0];
  return mappings.split(';').map((line) => {
    state[0] = 0;
    if (line === '') {
      return [];
    }
    return line.split(',').map((segment) => {
      const values = decodeVlq(segment);
      return values.map((v, i) => (state[i] += v));
    });
  });
}

function encodeMappings(lines: readonly Segment[][]): string {
  const state = [0, 0, 0, 0, 0];
  return lines
    .map((line) => {
      state[0] = 0;
      return line
        .map((segment) =>
          segment
            .map((v, i) => {
              const delta = v - state[i];
              state[i] = v;
              return encodeVlq(delta);
            })
            .join(''),
        )
        .join(',');
    })
    .join(';');
}

function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

function encodeVlq(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  let result = '';
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) {
      digit |= 32;
    }
    result += BASE64[digit];
  } while (vlq > 0);
  return result;
}
