import { fault } from './workspace.mjs';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
// Same logical stream ordering and UTF-8 byte cursor semantics as native capture.
export class Capture {
  constructor(limit) { this.limit = limit; this.bytes = 0; this.lines = []; this.nextLine = 1; this.cursor = { line: 1, column: 0 }; this.truncated = false; }
  append(channel, bytes) {
    const text = decoder.decode(bytes);
    for (const char of text) {
      const width = encoder.encode(char).byteLength;
      if (this.bytes + width > this.limit) { this.truncated = true; throw fault('limit', 'Browser output quota exceeded'); }
      let line = this.lines.at(-1);
      if (!line || line.complete || line.channel !== channel) {
        if (line) line.complete = true;
        line = { number: this.nextLine++, channel, text: '', complete: false }; this.lines.push(line);
      }
      line.text += char; line.complete = char === '\n'; this.bytes += width;
    }
  }
  finish() { const line = this.lines.at(-1); if (line) line.complete = true; }
  end() { const line = this.lines.at(-1); return line && !line.complete ? { line: line.number, column: encoder.encode(line.text).byteLength } : { line: this.nextLine, column: 0 }; }
  counts() { const values = { stdout: 0, stderr: 0 }; for (const line of this.lines) values[line.channel] += encoder.encode(line.text).byteLength; return values; }
  read(from = this.cursor) {
    const end = this.end();
    if (!Number.isSafeInteger(from.line) || from.line < 1 || !Number.isSafeInteger(from.column) || from.column < 0 || from.line > end.line || from.line === end.line && from.column > end.column)
      throw fault('conflict', 'Invalid browser capture cursor');
    if (from.line < this.cursor.line || from.line === this.cursor.line && from.column < this.cursor.column)
      return { ...this.read(this.cursor), expired: { through_line: this.cursor.line - 1 } };
    const output = { stdout: '', stderr: '', next: end, cursor: { ...this.cursor }, expired: null, truncated: this.truncated };
    for (const line of this.lines) {
      if (line.number < from.line) continue;
      const bytes = encoder.encode(line.text), offset = line.number === from.line ? from.column : 0;
      if (offset > bytes.byteLength) throw fault('conflict', 'Invalid browser capture column');
      try { output[line.channel] += decoder.decode(bytes.slice(offset)); }
      catch { throw fault('conflict', 'Capture cursor splits UTF-8'); }
    }
    return output;
  }
  drain(maxBytes) {
    if (this.bytes > maxBytes) throw fault('conflict', 'Capture exceeds drain byte limit');
    const result = this.read(this.cursor);
    this.lines = []; this.bytes = 0; this.cursor = { ...result.next }; return result;
  }
}
