/**
 * capture-main-via-cdp.ts
 *
 * Se connecte au Chromium en cours via CDP (DevToolsActivePort),
 * attend la prochaine réponse /main/ sur la page Spain watcher,
 * sauvegarde le body brut JSONP dans /tmp/spain_main_live.js
 * et le HTML parsé dans /tmp/spain_main_live.html
 *
 * Usage : npx tsx src/scripts/capture-main-via-cdp.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function parseBookititJsonp(raw: string): string {
  const trimmed = raw.trim().replace(/;\s*$/, "");
  const openParen = trimmed.indexOf("(");
  const closeParen = trimmed.lastIndexOf(")");
  if (openParen === -1 || closeParen === -1) throw new Error("Pas de parenthèses JSONP");
  let inner = trimmed.slice(openParen + 1, closeParen).trim();
  if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
    inner = inner.slice(1, -1);
  }
  return inner
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

async function main() {
  // Lire le port CDP depuis DevToolsActivePort
  const devtoolsFile = "/tmp/spain-cf-profile/DevToolsActivePort";
  if (!fs.existsSync(devtoolsFile)) throw new Error(`DevToolsActivePort introuvable: ${devtoolsFile}`);
  const portContent = fs.readFileSync(devtoolsFile, "utf8").trim();
  const cdpPort = parseInt(portContent.split("\n")[0], 10);
  if (isNaN(cdpPort)) throw new Error(`Port CDP invalide: ${portContent}`);
  console.log(`[cdp] Connexion au Chrome sur port ${cdpPort}…`);

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${cdpPort}`,
    defaultViewport: null,
  });

  const pages = await browser.pages();
  console.log(`[cdp] ${pages.length} page(s) ouvertes:`);
  for (const p of pages) console.log(`  - ${p.url().slice(0, 100)}`);

  // Trouver la page Spain portal (citaconsular.es)
  const spainPage = pages.find((p) => p.url().includes("citaconsular.es")) ?? pages[0];
  if (!spainPage) throw new Error("Aucune page trouvée dans le browser");
  console.log(`[cdp] Page Spain: ${spainPage.url().slice(0, 100)}`);

  // Intercepter la prochaine réponse /main/ via CDP Network
  const cdp = await spainPage.createCDPSession();
  await cdp.send("Network.enable", {});

  console.log(`[cdp] En attente de la prochaine requête /main/ (max 30s)…`);

  const mainBody = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout 30s — /main/ non capturé")), 30_000);
    const pending = new Map<string, string>();

    cdp.on("Network.requestWillBeSent", (ev: any) => {
      const url: string = ev.request?.url ?? "";
      if (url.includes("onlinebookings/main")) {
        console.log(`[cdp] /main/ request: ${url.slice(0, 120)}`);
        pending.set(ev.requestId, url);
      }
    });

    cdp.on("Network.responseReceived", (ev: any) => {
      const url: string = ev.response?.url ?? "";
      if (url.includes("onlinebookings/main")) {
        console.log(`[cdp] /main/ response: HTTP ${ev.response.status} ${ev.response.mimeType} cf-ray=${ev.response.headers?.["cf-ray"] ?? "none"}`);
      }
    });

    cdp.on("Network.loadingFinished", async (ev: any) => {
      if (!pending.has(ev.requestId)) return;
      const url = pending.get(ev.requestId)!;
      pending.delete(ev.requestId);
      try {
        const { body, base64Encoded } = await cdp.send("Network.getResponseBody", {
          requestId: ev.requestId,
        });
        const decoded = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
        console.log(`[cdp] /main/ body: ${decoded.length}B url=${url.slice(0, 80)}`);
        clearTimeout(timeout);
        resolve(decoded);
      } catch (e) {
        // requestId peut expirer — essayer via page.evaluate fetch
        console.warn(`[cdp] getResponseBody échoué (${e}), fallback evaluate fetch…`);
      }
    });
  });

  await cdp.detach().catch(() => {});

  console.log(`[cdp] JSONP capturé: ${mainBody.length} bytes`);
  fs.writeFileSync("/tmp/spain_main_live.js", mainBody, "utf8");
  console.log("[cdp] Sauvegardé → /tmp/spain_main_live.js");

  let spainHtml: string;
  try {
    spainHtml = parseBookititJsonp(mainBody);
    console.log(`[cdp] HTML décodé: ${spainHtml.length} chars`);
  } catch (e) {
    spainHtml = mainBody;
    console.warn(`[cdp] Pas JSONP — utilisation brute`);
  }
  fs.writeFileSync("/tmp/spain_main_live.html", spainHtml, "utf8");
  console.log("[cdp] HTML sauvegardé → /tmp/spain_main_live.html");

  await browser.disconnect();
  console.log("[cdp] Déconnecté du Chrome");
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
