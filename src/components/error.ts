// Component syntax error. line is the 1-based line number inside the code block; render.ts converts it to a script line.
export class ComponentError extends Error {
  line: number;

  constructor(message: string, line = 0) {
    super(message);
    this.name = 'ComponentError';
    this.line = line;
  }
}

export type ContentLine = { raw: string; text: string; line: number };

// Split the code block body into non-empty lines and keep their relative line numbers. Lines starting with // are comments and are skipped.
export function contentLines(text: string): ContentLine[] {
  return String(text)
    .split('\n')
    .map((raw, i) => ({ raw, text: raw.trim(), line: i + 1 }))
    .filter((l) => l.text && !l.text.startsWith('//'));
}

// Split into fields at | and trim each one.
export function fields(text: string): string[] {
  return text.split('|').map((s) => s.trim());
}
