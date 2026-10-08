/** A UTC timestamp with exactly six fraction digits, so timestamps sort as text. */
export function fixedTs(t: string): string {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(?:Z|\+00:00)$/.exec(t);
  return m ? `${m[1]}.${(m[2] ?? '').padEnd(6, '0').slice(0, 6)}Z` : t;
}
