/**
 * compare-main-burp-vs-spain.ts
 *
 * 1. Parse le JSONP Burp depuis /tmp/burp_main_raw.js
 * 2. Se connecte au Chrome Spain via CDP et capture la prochaine réponse /main/
 * 3. Compare les deux HTML (services, agendas, structure)
 *
 * Usage: cd artifacts/slot-hunter && npx tsx compare-main-burp-vs-spain.ts
 */

import * as fs from "fs";
import * as path from "path";
import puppeteer from "puppeteer";

// ─── Parser JSONP Bookitit ────────────────────────────────────────────────────

function parseBookititJsonp(raw: string): string {
  const trimmed = raw.trim().replace(/;\s*$/, "");
  // Support "callback=jQuery...({...})" format
  let src = trimmed;
  if (src.startsWith("callback=")) src = src.slice("callback=".length);
  const openParen = src.indexOf("(");
  const closeParen = src.lastIndexOf(")");
  if (openParen === -1 || closeParen === -1) throw new Error("Pas de parenthèses JSONP");
  let inner = src.slice(openParen + 1, closeParen).trim();
  // Dequote si string
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

// ─── Extraction des données du HTML Bookitit ──────────────────────────────────

interface ServiceInfo {
  id: string;
  name: string;
  duration?: string;
  price?: string;
}

interface AgendaInfo {
  id: string;
  name: string;
}

interface MainPageInfo {
  services: ServiceInfo[];
  agendas: AgendaInfo[];
  widgetPublicKey: string | null;
  bookititServer: string | null;
  captchaRequired: boolean;
  loginRequired: boolean;
  rawLength: number;
  // Structure templates
  hasServiceTemplate: boolean;
  hasAgendaTemplate: boolean;
  hasDatetimeTemplate: boolean;
  hasSigninTemplate: boolean;
  hasSummaryTemplate: boolean;
  // Scripts
  scriptSrcs: string[];
  // Liens CSS
  cssSrcs: string[];
}

function extractInfo(html: string): MainPageInfo {
  // Services: data-id dans les templates ou dans le DOM
  const serviceMatches = [...html.matchAll(/data-id="([^"]+)"[^>]*data-name="([^"]+)"/g)];
  const services: ServiceInfo[] = serviceMatches.map(m => ({
    id: m[1],
    name: m[2],
  }));

  // Agendas
  const agendaMatches = [...html.matchAll(/data-agenda-id="([^"]+)"[^>]*>([^<]+)</g)];
  const agendas: AgendaInfo[] = agendaMatches.map(m => ({
    id: m[1],
    name: m[2].trim(),
  }));

  // Widget public key
  const pkMatch = html.match(/publickey[=\s"]+([a-f0-9]{32})/i) || html.match(/publickey=([a-f0-9]{32})/i);
  const widgetPublicKey = pkMatch ? pkMatch[1] : null;

  // Bookitit server
  const serverMatch = html.match(/bookitit\.com\/onlinebookings\/([a-f0-9]+)\//);
  const bookititServer = serverMatch ? serverMatch[0] : null;

  // Captcha
  const captchaRequired = /captcha/i.test(html) && !/captcha.*false|captcha.*0/i.test(html);

  // Login
  const loginRequired = /class="[^"]*clsLogin[^"]*"|id="[^"]*clsLogin[^"]*"/i.test(html);

  // Templates
  const hasServiceTemplate = /type="text\/template"[^>]*id="[^"]*service/i.test(html) || /id="[^"]*service[^"]*"[^>]*type="text\/template"/i.test(html);
  const hasAgendaTemplate = /type="text\/template"[^>]*id="[^"]*agenda/i.test(html) || /id="[^"]*agenda[^"]*"[^>]*type="text\/template"/i.test(html);
  const hasDatetimeTemplate = /type="text\/template"[^>]*id="[^"]*datetime/i.test(html) || /id="[^"]*datetime[^"]*"[^>]*type="text\/template"/i.test(html);
  const hasSigninTemplate = /type="text\/template"[^>]*id="[^"]*signin/i.test(html) || /id="[^"]*signin[^"]*"[^>]*type="text\/template"/i.test(html);
  const hasSummaryTemplate = /type="text\/template"[^>]*id="[^"]*summary/i.test(html) || /id="[^"]*summary[^"]*"[^>]*type="text\/template"/i.test(html);

  // Scripts
  const scriptMatches = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)];
  const scriptSrcs = scriptMatches.map(m => m[1]);

  // CSS
  const cssMatches = [...html.matchAll(/<link[^>]+href="([^"]+\.css[^"]*)"/g)];
  const cssSrcs = cssMatches.map(m => m[1]);

  return {
    services,
    agendas,
    widgetPublicKey,
    bookititServer,
    captchaRequired,
    loginRequired,
    rawLength: html.length,
    hasServiceTemplate,
    hasAgendaTemplate,
    hasDatetimeTemplate,
    hasSigninTemplate,
    hasSummaryTemplate,
    scriptSrcs,
    cssSrcs,
  };
}

function extractServicesList(html: string): { id: string; label: string }[] {
  // Format Bookitit: data-id sur les <li> de services ou input[value]
  const results: { id: string; label: string }[] = [];

  // Méthode 1: <li data-id="..."> ou <div data-id="...">
  const m1 = [...html.matchAll(/<(?:li|div|a)[^>]+data-id="(\d+)"[^>]*>.*?<span[^>]*class="[^"]*clsServiceName[^"]*"[^>]*>([^<]+)<\/span>/gs)];
  for (const m of m1) results.push({ id: m[1], label: m[2].trim() });

  // Méthode 2: dans les templates script
  const templateMatch = html.match(/type="text\/template"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const tmpl of templateMatch) {
    const m2 = [...tmpl.matchAll(/data-id="([^"]+)"[^>]*class="[^"]*service/gi)];
    for (const m of m2) results.push({ id: m[1], label: "(template)" });
  }

  // Méthode 3: value dans les selects ou hidden inputs
  const m3 = [...html.matchAll(/<option[^>]+value="(\d+)"[^>]*>([^<]+)<\/option>/g)];
  for (const m of m3) results.push({ id: m[1], label: m[2].trim() });

  return results;
}

// ─── Comparaison ──────────────────────────────────────────────────────────────

function compare(burpHtml: string, spainHtml: string): void {
  console.log("\n" + "═".repeat(70));
  console.log("  COMPARAISON BURP (navigateur réel) vs SPAIN WATCHER (bot)");
  console.log("═".repeat(70) + "\n");

  const burp = extractInfo(burpHtml);
  const spain = extractInfo(spainHtml);

  const row = (label: string, b: unknown, s: unknown) => {
    const match = JSON.stringify(b) === JSON.stringify(s);
    const icon = match ? "✅" : "❌";
    console.log(`${icon}  ${label.padEnd(28)} Burp: ${String(b).slice(0, 50).padEnd(52)} Spain: ${String(s).slice(0, 50)}`);
  };

  row("Taille HTML (chars)", burp.rawLength, spain.rawLength);
  row("Widget public key", burp.widgetPublicKey, spain.widgetPublicKey);
  row("Bookitit server URL", burp.bookititServer, spain.bookititServer);
  row("Captcha requis", burp.captchaRequired, spain.captchaRequired);
  row("Login requis", burp.loginRequired, spain.loginRequired);
  row("Template service", burp.hasServiceTemplate, spain.hasServiceTemplate);
  row("Template agenda", burp.hasAgendaTemplate, spain.hasAgendaTemplate);
  row("Template datetime", burp.hasDatetimeTemplate, spain.hasDatetimeTemplate);
  row("Template signin", burp.hasSigninTemplate, spain.hasSigninTemplate);
  row("Template summary", burp.hasSummaryTemplate, spain.hasSummaryTemplate);
  row("Nb services (DOM)", burp.services.length, spain.services.length);
  row("Nb agendas (DOM)", burp.agendas.length, spain.agendas.length);

  // Scripts
  const burpScripts = new Set(burp.scriptSrcs.map(s => s.replace(/\?v=\d+/, "")));
  const spainScripts = new Set(spain.scriptSrcs.map(s => s.replace(/\?v=\d+/, "")));
  const missingInSpain = [...burpScripts].filter(s => !spainScripts.has(s));
  const extraInSpain = [...spainScripts].filter(s => !burpScripts.has(s));

  console.log(`\n📜 Scripts (Burp: ${burp.scriptSrcs.length}, Spain: ${spain.scriptSrcs.length})`);
  if (missingInSpain.length) {
    console.log("  ❌ Manquants dans Spain:");
    missingInSpain.forEach(s => console.log(`     - ${s}`));
  }
  if (extraInSpain.length) {
    console.log("  ➕ En plus dans Spain:");
    extraInSpain.forEach(s => console.log(`     + ${s}`));
  }
  if (!missingInSpain.length && !extraInSpain.length) console.log("  ✅ Identiques");

  // CSS
  const burpCss = new Set(burp.cssSrcs.map(s => s.replace(/\?v=\d+/, "")));
  const spainCss = new Set(spain.cssSrcs.map(s => s.replace(/\?v=\d+/, "")));
  const missingCss = [...burpCss].filter(s => !spainCss.has(s));
  const extraCss = [...spainCss].filter(s => !burpCss.has(s));
  console.log(`\n🎨 CSS (Burp: ${burp.cssSrcs.length}, Spain: ${spain.cssSrcs.length})`);
  if (missingCss.length) missingCss.forEach(s => console.log(`  ❌ Manquant: ${s}`));
  if (extraCss.length) extraCss.forEach(s => console.log(`  ➕ Extra: ${s}`));
  if (!missingCss.length && !extraCss.length) console.log("  ✅ Identiques");

  // Diff textuel grossier (longueur et hash)
  const burpLines = burpHtml.split("\n").length;
  const spainLines = spainHtml.split("\n").length;
  console.log(`\n📏 Lignes: Burp=${burpLines}, Spain=${spainLines}, diff=${Math.abs(burpLines - spainLines)}`);

  // Sections présentes dans Burp mais absentes dans Spain
  const KEY_STRINGS = [
    ["clsMainContainer", "Div principal widget"],
    ["clsServices", "Section services"],
    ["clsAgendas", "Section agendas"],
    ["clsDatetime", "Section datetime"],
    ["clsSummary", "Section summary"],
    ["clsSignIn", "Section signin"],
    ["clsCaptcha", "Section captcha"],
    ["clsNextButton", "Bouton suivant"],
    ["loadermaec", "Script loadermaec"],
    ["requirejs", "RequireJS"],
    ["bookitit.com", "Référence bookitit.com"],
    ["publickey", "publickey param"],
    ["widgetdefault", "widgetdefault URL"],
  ];

  console.log("\n🔍 Présence des éléments clés:");
  for (const [key, label] of KEY_STRINGS) {
    const inBurp = burpHtml.includes(key);
    const inSpain = spainHtml.includes(key);
    const icon = inBurp === inSpain ? "✅" : (inBurp && !inSpain ? "❌ MANQUANT Spain" : "➕ EXTRA Spain");
    console.log(`  ${icon.padEnd(20)} ${label} ("${key}"): Burp=${inBurp} Spain=${inSpain}`);
  }

  // Résumé
  console.log("\n" + "─".repeat(70));
  if (burpHtml === spainHtml) {
    console.log("🎉 IDENTIQUES — Le Spain watcher reçoit exactement le même contenu qu'un navigateur réel.");
  } else {
    const similarity = Math.round(
      (2 * [...burpHtml].filter((c, i) => spainHtml[i] === c).length) /
      (burpHtml.length + spainHtml.length) * 100
    );
    console.log(`⚠️  DIFFÉRENTS — Similarité approximative: ~${similarity}%`);
    console.log("   → Voir /tmp/burp_main.html et /tmp/spain_main_live.html pour diff manuel");
  }
  console.log("─".repeat(70) + "\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Parse Burp
  const burpRaw = fs.readFileSync("/tmp/burp_main_raw.js", "utf8");
  const burpHtml = parseBookititJsonp(burpRaw);
  fs.writeFileSync("/tmp/burp_main.html", burpHtml, "utf8");
  console.log(`[burp] HTML parsé: ${burpHtml.length} chars → /tmp/burp_main.html`);

  // 2. Capture Spain via CDP
  const devtoolsFile = "/tmp/spain-cf-profile/DevToolsActivePort";
  if (!fs.existsSync(devtoolsFile)) throw new Error(`DevToolsActivePort introuvable: ${devtoolsFile}`);
  const portContent = fs.readFileSync(devtoolsFile, "utf8").trim();
  const cdpPort = parseInt(portContent.split("\n")[0], 10);
  console.log(`[cdp] Connexion Chrome port ${cdpPort}…`);

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${cdpPort}`,
    defaultViewport: null,
  });

  const pages = await browser.pages();
  console.log(`[cdp] ${pages.length} page(s):`);
  for (const p of pages) console.log(`  - ${p.url().slice(0, 100)}`);

  const spainPage = pages.find(p => p.url().includes("citaconsular.es")) ?? pages[0];
  if (!spainPage) throw new Error("Aucune page citaconsular.es trouvée");
  console.log(`[cdp] Page Spain: ${spainPage.url().slice(0, 100)}`);

  const cdp = await spainPage.createCDPSession();
  await cdp.send("Network.enable", {});

  console.log("[cdp] Attente prochaine requête /main/ (max 90s)…");
  console.log("[cdp] (Le Spain watcher en fera une au prochain cycle, ~2 min max)");

  const mainBody = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout 90s — /main/ non capturé")), 90_000);
    const pending = new Map<string, string>();

    cdp.on("Network.requestWillBeSent", (ev: any) => {
      const url: string = ev.request?.url ?? "";
      if (url.includes("onlinebookings/main")) {
        console.log(`[cdp] /main/ request → ${url.slice(0, 120)}`);
        pending.set(ev.requestId, url);
      }
    });

    cdp.on("Network.responseReceived", (ev: any) => {
      const url: string = ev.response?.url ?? "";
      if (url.includes("onlinebookings/main")) {
        console.log(`[cdp] /main/ response → HTTP ${ev.response.status} mime=${ev.response.mimeType} cf-ray=${ev.response.headers?.["cf-ray"] ?? "?"}`);
      }
    });

    cdp.on("Network.loadingFinished", async (ev: any) => {
      if (!pending.has(ev.requestId)) return;
      const url = pending.get(ev.requestId)!;
      pending.delete(ev.requestId);
      try {
        const { body, base64Encoded } = await cdp.send("Network.getResponseBody", { requestId: ev.requestId });
        const decoded = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
        console.log(`[cdp] /main/ body: ${decoded.length}B`);
        clearTimeout(timeout);
        resolve(decoded);
      } catch (e) {
        console.warn(`[cdp] getResponseBody échoué: ${e}`);
        // Pas de reject — attendre la prochaine requête
      }
    });
  });

  await cdp.detach().catch(() => {});
  await browser.disconnect();

  fs.writeFileSync("/tmp/spain_main_live.js", mainBody, "utf8");
  console.log("[cdp] JSONP sauvegardé → /tmp/spain_main_live.js");

  let spainHtml: string;
  if (mainBody.trim().length === 0) {
    console.error("[cdp] ⚠️  /main/ body VIDE — 0B reçus. Le Spain watcher a le même problème qu'en logs.");
    spainHtml = "";
  } else {
    try {
      spainHtml = parseBookititJsonp(mainBody);
      fs.writeFileSync("/tmp/spain_main_live.html", spainHtml, "utf8");
      console.log(`[cdp] HTML décodé: ${spainHtml.length} chars → /tmp/spain_main_live.html`);
    } catch (e) {
      console.warn(`[cdp] Pas JSONP — corps brut utilisé: ${e}`);
      spainHtml = mainBody;
      fs.writeFileSync("/tmp/spain_main_live.html", spainHtml, "utf8");
    }
  }

  // 3. Comparer
  if (spainHtml.length === 0) {
    console.log("\n❌ RÉSULTAT : Spain watcher reçoit un /main/ VIDE (0B) — le navigateur réel reçoit", burpHtml.length, "chars.");
    console.log("   Cela confirme que la session CF/PHPSESSID du bot est invalide ou l'IP est différente.");
  } else {
    compare(burpHtml, spainHtml);
  }
}

main().catch(e => { console.error("FATAL:", e.message ?? e); process.exit(1); });
