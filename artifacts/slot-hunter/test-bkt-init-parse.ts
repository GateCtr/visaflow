import { readFileSync } from "fs";

function extractBktInitArraysFromHtml(html: string) {
  const blockMatch = html.match(/bkt_init_widget\s*=\s*\{([\s\S]*?)\}\s*;/);
  if (!blockMatch) return null;
  const block = blockMatch[1];
  function parseJsStringArray(field: string): string[] | undefined {
    const m = block.match(new RegExp(`${field}\\s*:\\s*\\[([^\\]]*)\\]`));
    if (!m) return undefined;
    const inner = m[1].trim();
    if (!inner) return [];
    return [...inner.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
  }
  return {
    services: parseJsStringArray("services"),
    agendas: parseJsStringArray("agendas"),
    dates: parseJsStringArray("dates"),
  };
}

const html = readFileSync("src/spain-portal-capture-2026-08-02T09-34-53-712Z.html", "utf8");
const arrays = extractBktInitArraysFromHtml(html);
console.log(JSON.stringify(arrays, null, 2));
console.log("no slots:", arrays?.dates?.length === 0);

const withDates = html.replace("dates: []", 'dates: ["2026-09-04", "2026-09-11"]');
const arrays2 = extractBktInitArraysFromHtml(withDates);
console.log("with dates:", arrays2?.dates);
