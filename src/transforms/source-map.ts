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

  const result = applyInsertions(text, sorted);

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
 * The text with the insertions (last to first) applied one after the other.
 * When no insertion reaches into the text of the one applied before it, that
 * is the same as joining the pieces between them in one pass, which does not
 * copy the whole text once per insertion.
 */
function applyInsertions(text: string, descending: readonly Insertion[]): string {
  for (let i = 1; i < descending.length; i++) {
    const ins = descending[i];
    if (ins.offset + (ins.length ?? 0) > descending[i - 1].offset) {
      let result = text;
      for (const each of descending) {
        result = result.slice(0, each.offset) + each.text + result.slice(each.offset + (each.length ?? 0));
      }
      return result;
    }
  }
  const pieces: string[] = [];
  let cursor = 0;
  for (let i = descending.length - 1; i >= 0; i--) {
    const ins = descending[i];
    pieces.push(text.slice(cursor, ins.offset), ins.text);
    cursor = ins.offset + (ins.length ?? 0);
  }
  pieces.push(text.slice(cursor));
  return pieces.join('');
}

/**
 * Replace the `mappings` of a source map JSON text, leaving the rest of the
 * text as it is.
 *
 * Only the lines the edits touch are decoded and encoded again; the others are
 * copied. The segments of the other lines are relative to the ones before them,
 * which an edit that keeps every segment does not change. When an edit removes
 * segments, the lines after it are decoded and encoded again up to the first
 * segment that points to a source (the next ones are relative to that one).
 */
function updateMapJson(json: string, text: string, descending: readonly Insertion[]): string {
  const mappings = mappingsOf(json);
  const lineStarts = lineStartsOf(text);
  const raw = mappings.split(';');

  // Edits are applied from the last to the first, so the position of each
  // edit is still valid (in original coordinates) when it is applied.
  const edits = descending
    .map((ins) => ({
      ins,
      from: positionOf(lineStarts, ins.offset),
      to: positionOf(lineStarts, ins.offset + (ins.length ?? 0)),
    }))
    .filter((edit) => edit.from.line < raw.length);

  // The lines that are edited together: edits that share a line go together.
  const groups: Array<{ first: number; last: number; edits: typeof edits }> = [];
  for (const edit of [...edits].reverse()) {
    const group = groups[groups.length - 1];
    if (group != null && edit.from.line <= group.last) {
      group.last = Math.max(group.last, edit.to.line);
      group.edits.unshift(edit);
    } else {
      groups.push({ first: edit.from.line, last: edit.to.line, edits: [edit] });
    }
  }

  // The lines are decoded from zero (not from the lines before them): what `shift` tracks is how far the state of
  // the output is from the state of the input after the segments that were removed, 0 when there were none.
  let shift = [0, 0, 0, 0, 0];
  const output: string[] = [];
  let line = 0;
  const recode = (lines: readonly string[], change?: (decoded: Segment[][]) => Segment[][]) => {
    const decoded = [0, 0, 0, 0, 0];
    const written = [...shift];
    const segments = decodeMappings(lines, decoded);
    output.push(...encodeMappings(change != null ? change(segments) : segments, written));
    shift = written.map((v, i) => v - decoded[i]);
  };
  while (line < raw.length) {
    const group = groups[0];
    if (group != null && group.first === line) {
      groups.shift();
      const end = Math.min(group.last, raw.length - 1);
      recode(raw.slice(line, end + 1), (lines) => {
        for (const { ins, from, to } of group.edits) {
          const inserted = ins.text.split('\n');
          const addedLines = inserted.length - 1;
          const lastLength = inserted[inserted.length - 1].length;

          const fromLine = from.line - group.first;
          const toLine = to.line - group.first;
          const keep = lines[fromLine].filter((seg) => seg[0] < from.column);
          const rest = (lines[toLine] ?? [])
            .filter((seg) => seg[0] >= to.column)
            .map((seg) => [
              seg[0] - to.column + (addedLines === 0 ? from.column + lastLength : lastLength),
              ...seg.slice(1),
            ]);
          const replaced: Segment[][] =
            addedLines === 0 ? [[...keep, ...rest]] : [keep, ...Array.from({ length: addedLines - 1 }, () => []), rest];
          lines.splice(fromLine, toLine - fromLine + 1, ...replaced);
        }
        return lines;
      });
      line = end + 1;
    } else if (shift.some((v) => v !== 0)) {
      recode([raw[line++]]);
    } else {
      const next = group?.first ?? raw.length;
      output.push(...raw.slice(line, next));
      line = next;
    }
  }
  return json.replace(`"mappings":${JSON.stringify(mappings)}`, `"mappings":${JSON.stringify(output.join(';'))}`);
}

/** The `mappings` of a source map JSON text. */
function mappingsOf(json: string): string {
  // The map of a file with its sources inlined is mostly the text of the sources: do not parse that.
  const found = /"mappings":"([A-Za-z0-9+/,;]*)"/.exec(json);
  return found != null ? found[1] : JSON.parse(json).mappings;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    starts.push(i + 1);
  }
  return starts;
}

function positionOf(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  // The last line that starts at or before `offset`.
  let line = 0;
  let high = lineStarts.length - 1;
  while (line < high) {
    const mid = (line + high + 1) >>> 1;
    if (lineStarts[mid] <= offset) {
      line = mid;
    } else {
      high = mid - 1;
    }
  }
  return { line, column: offset - lineStarts[line] };
}

/** A decoded segment, all fields absolute: [genColumn, source?, line?, column?, name?]. */
type Segment = number[];

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** The value of each base64 digit, by character code (-1 for other characters, as `BASE64.indexOf` gives). */
const BASE64_VALUES = Array.from({ length: 128 }, (_, code) => BASE64.indexOf(String.fromCharCode(code)));

/**
 * Decode lines of `mappings`. `state` is where the first of them starts and where it is after the last one.
 */
function decodeMappings(lines: readonly string[], state: number[]): Segment[][] {
  return lines.map((line) => {
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

/** Encode lines of `mappings`, from the `state` before the first, to the `state` after the last. */
function encodeMappings(lines: readonly Segment[][], state: number[]): string[] {
  return lines.map((line) => {
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
  });
}

function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (let i = 0; i < segment.length; i++) {
    const digit = BASE64_VALUES[segment.charCodeAt(i)] ?? -1;
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
