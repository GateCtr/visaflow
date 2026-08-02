export function buildBookititQueryString(params: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) q.append(key, String(item));
      }
      continue;
    }
    q.append(key, String(value));
  }

  return q.toString();
}
