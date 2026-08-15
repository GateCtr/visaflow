/**
 * spain-portal-browser-capture.ts — Ouvre un navigateur Playwright pour navigation
 * manuelle et capture le HTML + marqueurs de la page Citaconsular.
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx src/spain-portal-browser-capture.ts [URL]
 *
 * Exemple :
 *   npx tsx src/spain-portal-browser-capture.ts \
 *     https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/#services
 */

import { chromium } from "playwright";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DEFAULT_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/#services";
const url = process.argv[2] ?? process.env.PORTAL_URL ?? DEFAULT_URL;

const markerDefinitions: Array<{ name: string; regex: RegExp }> = [
  { name: "No hay horas disponibles visible", regex: /<div\s+style=['\"]text-align:\s*center;[^'\"]*['\"][^>]*>\s*No hay horas disponibles/i },
  { name: "No hay horas disponibles caché", regex: /<div\s+style=['\"]display:\s*none;[^'\"]*['\"][^>]*>\s*No hay horas disponibles/i },
  { name: "Bouton ACEPTAR / Aceptar", regex: /Aceptar/i },
  { name: "idDivBktButtonContinueContainer", regex: /idDivBktButtonContinueContainer/i },
  { name: "idBktDefaultCustomContainer", regex: /idBktDefaultCustomContainer/i },
  { name: "idDivBktServicesContinueButton", regex: /idDivBktServicesContinueButton/i },
  { name: "#selectservice rendered links", regex: /#selectservice\/[\w-]+/i },
  { name: "#selectservice client-side templates", regex: /#selectservice\/<%=\s*[\w.]+\s*%>/i },
  { name: "Widget container landmark", regex: /idBktWidgetDefaultBodyContainer|idDivBktServicesContainer/i },
];

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\nAppuyez sur Entrée pour capturer le HTML et les marqueurs...\n", () => {
      rl.close();
      resolve();
    });
  });
}

function findMatches(html: string, regex: RegExp): string[] {
  const globalRegex = regex.flags.includes("g") ? regex : new RegExp(regex.source, regex.flags + "g");
  const results: string[] = [];
  for (const match of html.matchAll(globalRegex)) {
    results.push(match[0]);
  }
  return results;
}

async function main(): Promise<void> {
  console.log("[spain-portal-browser-capture] Lancement du navigateur...");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" +
      " (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    },
  });

  const page = await context.newPage();
  console.log(`[spain-portal-browser-capture] Ouverture de l'URL : ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  console.log("[spain-portal-browser-capture] Navigateur ouvert. Vous pouvez interagir avec la page.");
  console.log("[spain-portal-browser-capture] Une fois prêt, revenez au terminal et appuyez sur Entrée.");

  await waitForEnter();

  console.log("[spain-portal-browser-capture] Capture en cours...");
  const title = await page.title();
  const currentUrl = page.url();
  const content = await page.content();
  const bodyHtml = await page.evaluate(() => document.documentElement.outerHTML);

  const markers = markerDefinitions.map((marker) => {
    const matches = findMatches(bodyHtml, marker.regex);
    return { name: marker.name, count: matches.length, sample: matches.slice(0, 5) };
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = dirname(fileURLToPath(import.meta.url));
  const outHtmlPath = join(outDir, `spain-portal-capture-${timestamp}.html`);
  const outJsonPath = join(outDir, `spain-portal-capture-${timestamp}.json`);

  await writeFile(outHtmlPath, bodyHtml, "utf-8");
  await writeFile(outJsonPath, JSON.stringify({
    url: currentUrl,
    title,
    htmlLength: bodyHtml.length,
    markers,
    extractedAt: new Date().toISOString(),
  }, null, 2), "utf-8");

  console.log(`\n[spain-portal-browser-capture] Titre: ${title}`);
  console.log(`[spain-portal-browser-capture] URL finale: ${currentUrl}`);
  console.log(`[spain-portal-browser-capture] HTML length: ${bodyHtml.length}`);

  for (const marker of markers) {
    console.log(`\n[marker] ${marker.name}: ${marker.count}`);
    for (const sample of marker.sample) {
      console.log(`  • ${sample.replace(/\s+/g, " ").trim()}`);
    }
  }

  console.log(`\n[spain-portal-browser-capture] HTML sauvegardé dans: ${outHtmlPath}`);
  console.log(`[spain-portal-browser-capture] Résumé JSON sauvegardé dans: ${outJsonPath}`);
  console.log("[spain-portal-browser-capture] Fermeture du navigateur...");

  await browser.close();
}

main().catch((error) => {
  console.error("[spain-portal-browser-capture] Erreur:", error);
  process.exit(1);
});