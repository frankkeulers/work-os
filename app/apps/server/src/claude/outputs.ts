import type { z } from 'zod';

// Model answers are JSON checked with zod (CL-7). The answer may come wrapped in a code fence or
// with a sentence around it; the outermost object or array is taken. Issues name paths and
// problems only, never values, so they can be logged and sent back to the model.

export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: string };

export function extractJson(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) return undefined;
  const close = body[start] === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  return end > start ? body.slice(start, end + 1) : undefined;
}

export function parseJsonOutput<T>(text: string, schema: z.ZodType<T>): Parsed<T> {
  const json = extractJson(text);
  if (!json) return { ok: false, issues: 'no JSON object in the answer' };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, issues: 'the JSON does not parse' };
  }
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, value: r.data };
  const issues = r.error.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, issues };
}
