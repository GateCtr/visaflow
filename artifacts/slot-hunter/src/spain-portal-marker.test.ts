/**
 * spain-portal-marker.test.ts — Récupère le portail Citaconsular et affiche les marqueurs
 * utilisés par le scanner Spain HTTP.
 *
 * Usage : cd artifacts/slot-hunter && npx tsx src/spain-portal-marker.test.ts
 */

const PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/#services";

function findAllMatches(html: string, re: RegExp): string[] {
  const results: string[] = [];
  for (const m of html.matchAll(re)) {
    if (m[0]) results.push(m[0]);
  }
  return results;
}

function printMarker(name: string, html: string, re: RegExp): void {
  const matches = findAllMatches(html, re);
  console.log(`\n[marker] ${name}: ${matches.length}`);
  if (matches.length > 0) {
    for (const match of matches.slice(0, 10)) {
      console.log(`  • ${match.replace(/\s+/g, " ").trim()}`);
    }
  }
}

const MARKERS: Array<{ name: string; pattern: RegExp }> = [
  { name: "No hay horas disponibles visible", pattern: /<div\s+style=['"]text-align:\s*center;[^'"]*['"][^>]*>\s*No hay horas disponibles/i },
  { name: "No hay horas disponibles caché", pattern: /<div\s+style=['"]display:\s*none;[^'"]*['"][^>]*>\s*No hay horas disponibles/i },
  { name: "Modal Aceptar / bouton ACEPTAR", pattern: /Aceptar/i },
  { name: "idDivBktButtonContinueContainer", pattern: /idDivBktButtonContinueContainer/i },
  { name: "idBktDefaultCustomContainer", pattern: /idBktDefaultCustomContainer/i },
  { name: "idDivBktServicesContinueButton", pattern: /idDivBktServicesContinueButton/i },
  { name: "#selectservice rendered links", pattern: /#selectservice\/[\w-]+/i },
  { name: "#selectservice client-side templates", pattern: /#selectservice\/<%=\s*[\w.]+\s*%>/i },
  { name: "script template blocks", pattern: /<script\s+type=['"]text\/template['"][^>]*>[\s\S]*?<\/script>/gi },
  { name: "Widget container landmark", pattern: /idBktWidgetDefaultBodyContainer|idDivBktServicesContainer/i },
];

console.log(`[spain-portal-marker] Fetching ${PORTAL_URL}`);
const res = await fetch(PORTAL_URL, {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" +
      " (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
});

console.log(`[spain-portal-marker] HTTP ${res.status} ${res.statusText}`);

const html = await res.text();
console.log(`[spain-portal-marker] length: ${html.length}`);
console.log("[spain-portal-marker] first 4000 chars:\n" + html.slice(0, 4000).replace(/\s+/g, " ").trim());

for (const marker of MARKERS) {
  printMarker(marker.name, html, marker.pattern);
}

if (html.length < 1000) {
  console.warn("[spain-portal-marker] Warning: HTML is shorter than expected.");
}

console.log("[spain-portal-marker] Done.");
