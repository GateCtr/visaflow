/**
 * compare-main-burp-vs-spain.ts
 *
 * Compare la réponse /main/ capturée via Burp (navigateur réel)
 * avec celle capturée par Spain watcher (persistent browser).
 *
 * Usage :  npx tsx src/scripts/compare-main-burp-vs-spain.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Décode une string JSONP Bookitit → HTML brut.
 *  Format : callbackName("<html escaped>")  */
function parseBookititJsonp(raw: string): string {
  const trimmed = raw.trim().replace(/;\s*$/, "");
  // Trouver la première "(" et la dernière ")"
  const openParen = trimmed.indexOf("(");
  const closeParen = trimmed.lastIndexOf(")");
  if (openParen === -1 || closeParen === -1) throw new Error("Pas de parenthèses JSONP trouvées");
  let inner = trimmed.slice(openParen + 1, closeParen).trim();
  // Retirer les guillemets englobants (optionnel : peut être entouré de " ou ')
  if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
    inner = inner.slice(1, -1);
  }
  // Déséchapper : \" → "  \/ → /  \n → newline  \r → cr  \t → tab  \\ → \
  return inner
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

/** Extraction d'un attribut HTML simple : cherche attr="val" ou attr='val' */
function extractAttr(html: string, tag: string, attr: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tag}[^>]+\\s${attr}=["']([^"']+)["']`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) results.push(m[1]);
  return results;
}

/** Extraire tous les textes visibles entre balises (grossier mais suffisant) */
function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Extraire les IDs et classes importants */
function extractIds(html: string): string[] {
  const re = /\bid="([^"]+)"/g;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) ids.push(m[1]);
  return ids;
}

function extractClasses(html: string): Set<string> {
  const re = /\bclass="([^"]+)"/g;
  const classes = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    m[1].split(/\s+/).forEach((c) => { if (c) classes.add(c); });
  }
  return classes;
}

/** Extraire les hrefs */
function extractHrefs(html: string): string[] {
  const re = /href="([^"]+)"/g;
  const hrefs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
  return hrefs;
}

/** Détecter les signaux Bookitit */
function extractSignals(html: string): Record<string, boolean | string> {
  return {
    hasServicesList:      html.includes("idBktDefaultServicesTextBeforeServicesList"),
    hasServicesContainer: html.includes("idBktDefaultServicesContainer"),
    hasContinueBtn:       html.includes("idDivBktCustomContinueButton"),
    hasSpaContainer:      html.includes("idBktWidgetDefaultBodyContainer"),
    hasTurnstile:         html.includes("cf-turnstile") || html.includes("challenges.cloudflare.com"),
    hasNoHay:             /no\s*hay\s*(horas|citas|disponib)/i.test(html),
    hasCalendar:          html.includes("ui-datepicker") || html.includes("fc-calendar"),
    hasSelectService:     html.includes("#selectservice/"),
    hasVisaService:       /tramitaci[oó]n.*visados?|visa/i.test(html),
    hasConfirmDialog:     html.includes("dialogConfirm") || html.includes("idBktDefaultConfirmContainer"),
    mainScriptSrc:        (html.match(/src="([^"]*mainv[0-9][^"]*)"/) ?? [])[1] ?? "absent",
    cssVersion:           (html.match(/template\/v1[^.]*\.css\?v=(\d+)/) ?? [])[1] ?? "?",
    htmlSize:             String(html.length),
  };
}

// ── Comparaison ───────────────────────────────────────────────────────────────

function compareHtmls(label1: string, html1: string, label2: string, html2: string): void {
  console.log("\n" + "=".repeat(72));
  console.log(`COMPARAISON : ${label1}  vs  ${label2}`);
  console.log("=".repeat(72));

  // Taille
  console.log(`\n📏 TAILLE`);
  console.log(`  ${label1} : ${html1.length.toLocaleString()} chars`);
  console.log(`  ${label2} : ${html2.length.toLocaleString()} chars`);
  const diff = html1.length - html2.length;
  console.log(`  Différence : ${diff > 0 ? "+" : ""}${diff} chars (${diff === 0 ? "✅ identique" : diff > 0 ? `${label1} plus grand` : `${label2} plus grand`})`);

  // Signaux Bookitit / état widget
  const s1 = extractSignals(html1);
  const s2 = extractSignals(html2);
  console.log(`\n🔑 SIGNAUX BOOKITIT`);
  const allKeys = new Set([...Object.keys(s1), ...Object.keys(s2)]);
  for (const k of allKeys) {
    const v1 = s1[k];
    const v2 = s2[k];
    const same = String(v1) === String(v2);
    const icon = same ? "✅" : "⚠️ ";
    console.log(`  ${icon} ${k.padEnd(28)} ${label1}=${String(v1).slice(0,40).padEnd(42)} ${label2}=${String(v2).slice(0,40)}`);
  }

  // IDs présents
  const ids1 = new Set(extractIds(html1));
  const ids2 = new Set(extractIds(html2));
  const onlyIn1 = [...ids1].filter((id) => !ids2.has(id));
  const onlyIn2 = [...ids2].filter((id) => !ids1.has(id));
  console.log(`\n🆔 IDs HTML`);
  console.log(`  ${label1} total: ${ids1.size}  ${label2} total: ${ids2.size}`);
  if (onlyIn1.length > 0) console.log(`  IDs uniquement dans ${label1}: ${onlyIn1.slice(0,20).join(", ")}`);
  if (onlyIn2.length > 0) console.log(`  IDs uniquement dans ${label2}: ${onlyIn2.slice(0,20).join(", ")}`);
  if (onlyIn1.length === 0 && onlyIn2.length === 0) console.log(`  ✅ Même ensemble d'IDs`);

  // Classes
  const cls1 = extractClasses(html1);
  const cls2 = extractClasses(html2);
  const clsOnly1 = [...cls1].filter((c) => !cls2.has(c));
  const clsOnly2 = [...cls2].filter((c) => !cls1.has(c));
  console.log(`\n🎨 CLASSES CSS`);
  console.log(`  ${label1} total: ${cls1.size}  ${label2} total: ${cls2.size}`);
  if (clsOnly1.length > 0) console.log(`  Classes uniquement dans ${label1}: ${clsOnly1.slice(0,20).join(", ")}`);
  if (clsOnly2.length > 0) console.log(`  Classes uniquement dans ${label2}: ${clsOnly2.slice(0,20).join(", ")}`);
  if (clsOnly1.length === 0 && clsOnly2.length === 0) console.log(`  ✅ Même ensemble de classes`);

  // hrefs #selectservice/
  const href1 = extractHrefs(html1).filter((h) => h.includes("selectservice"));
  const href2 = extractHrefs(html2).filter((h) => h.includes("selectservice"));
  console.log(`\n🔗 HREFS #selectservice/`);
  if (href1.length === 0 && href2.length === 0) {
    console.log("  Aucun lien #selectservice/ dans les deux ⚠️");
  } else {
    const set1 = new Set(href1);
    const set2 = new Set(href2);
    const same2 = [...set1].every((h) => set2.has(h)) && [...set2].every((h) => set1.has(h));
    console.log(`  ${label1}: ${href1.join(" | ") || "aucun"}`);
    console.log(`  ${label2}: ${href2.join(" | ") || "aucun"}`);
    console.log(`  ${same2 ? "✅ Identiques" : "⚠️  Différents"}`);
  }

  // Extrait de texte visible (500 premiers chars)
  const txt1 = extractText(html1).slice(0, 500);
  const txt2 = extractText(html2).slice(0, 500);
  console.log(`\n📝 TEXTE VISIBLE (500 premiers chars)`);
  console.log(`  [${label1}] ${txt1.replace(/\n/g," ").slice(0,500)}`);
  console.log(`  [${label2}] ${txt2.replace(/\n/g," ").slice(0,500)}`);

  // Scripts chargés
  const scripts1 = extractAttr(html1, "script", "src");
  const scripts2 = extractAttr(html2, "script", "src");
  const sc1 = new Set(scripts1.map((s) => s.replace(/\?.*/, "").replace(/.*\//, "")));
  const sc2 = new Set(scripts2.map((s) => s.replace(/\?.*/, "").replace(/.*\//, "")));
  const scOnly1 = [...sc1].filter((s) => !sc2.has(s));
  const scOnly2 = [...sc2].filter((s) => !sc1.has(s));
  console.log(`\n📦 SCRIPTS src`);
  console.log(`  ${label1}: ${[...sc1].join(", ")}`);
  console.log(`  ${label2}: ${[...sc2].join(", ")}`);
  if (scOnly1.length > 0) console.log(`  Scripts uniquement dans ${label1}: ${scOnly1.join(", ")}`);
  if (scOnly2.length > 0) console.log(`  Scripts uniquement dans ${label2}: ${scOnly2.join(", ")}`);

  // Conclusion
  const criticalMatch =
    String(s1.hasServicesList) === String(s2.hasServicesList) &&
    String(s1.hasServicesContainer) === String(s2.hasServicesContainer) &&
    String(s1.hasContinueBtn) === String(s2.hasContinueBtn) &&
    String(s1.hasSpaContainer) === String(s2.hasSpaContainer) &&
    String(s1.mainScriptSrc) === String(s2.mainScriptSrc);

  console.log(`\n${"=".repeat(72)}`);
  console.log(`🏁 VERDICT : ${criticalMatch ? "✅ Contenu structurellement IDENTIQUE" : "⚠️  Différences structurelles détectées"}`);
  console.log("=".repeat(72) + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── 1. Lire et parser le Burp JSONP ──────────────────────────────────────
  const burpFile = path.resolve(
    __dirname,
    "../../../../attached_assets/Pasted-HTTP-2-200-OK-Date-Tue-04-Aug-2026-20-08-23-GMT-Content_1785877409640.txt"
  );
  if (!fs.existsSync(burpFile)) throw new Error(`Fichier Burp introuvable : ${burpFile}`);
  const burpRaw = fs.readFileSync(burpFile, "utf8");

  // Séparer headers / body (Burp utilise CRLF : \r\n\r\n)
  let sep = burpRaw.indexOf("\r\n\r\n");
  let sepLen = 4;
  if (sep === -1) { sep = burpRaw.indexOf("\n\n"); sepLen = 2; }
  if (sep === -1) throw new Error("Pas de séparateur headers/body dans le fichier Burp");
  const burpJsonp = burpRaw.slice(sep + sepLen).trim();
  console.log(`[burp] Raw JSONP length: ${burpJsonp.length} bytes`);

  let burpHtml: string;
  try {
    burpHtml = parseBookititJsonp(burpJsonp);
    console.log(`[burp] HTML décodé: ${burpHtml.length} chars`);
  } catch (e) {
    throw new Error(`Erreur parsing Burp JSONP: ${e}`);
  }

  // Sauvegarder
  const outBurp = path.resolve("/tmp/compare_burp.html");
  fs.writeFileSync(outBurp, burpHtml, "utf8");
  console.log(`[burp] Sauvegardé → ${outBurp}`);

  // ── 2. Capturer /main/ via Spain persistent browser ───────────────────────
  console.log(`\n[spain] Capture /main/ via impit (même mécanisme que Spain watcher)…`);

  // Import dynamique pour éviter les side-effects au top-level
  const { Impit } = await import("impit");
  const { createClient } = await import("redis");

  // Récupérer la session CF depuis Redis (cf_clearance + PHPSESSID + cookies)
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const redis = createClient({ url: redisUrl });
  await redis.connect();

  const sessionKey = "visaflow:spain-cf:session";
  const raw = await redis.get(sessionKey);
  await redis.quit();

  if (!raw) throw new Error("Session Spain introuvable dans Redis (clé: " + sessionKey + ")");
  const session = JSON.parse(raw) as {
    cfClearance?: string;
    allCookies?: Array<{ name: string; value: string }>;
    userAgent?: string;
    soaxProxyUrl?: string;
    prefetchedMainHtml?: string;
  };

  const cookies = session.allCookies ?? [];
  console.log(`[spain] Session Redis — cookies: ${cookies.map((c) => c.name).join(", ")}`);

  // Si on a déjà un prefetchedMainHtml en cache → l'utiliser directement
  let spainJsonp: string;
  if (session.prefetchedMainHtml && session.prefetchedMainHtml.length > 100) {
    console.log(`[spain] Utilisation du prefetchedMainHtml en cache (${session.prefetchedMainHtml.length} chars)`);
    const outSpain = path.resolve("/tmp/compare_spain.html");
    fs.writeFileSync(outSpain, session.prefetchedMainHtml, "utf8");
    console.log(`[spain] Sauvegardé → ${outSpain}`);
    compareHtmls("Burp (navigateur réel)", burpHtml, "Spain Watcher (cache)", session.prefetchedMainHtml);
    return;
  }

  // Sinon, faire une vraie requête /main/ via impit avec les cookies de la session
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const ua = session.userAgent ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

  // Utiliser le même proxy que la session (cf_clearance est lié à l'IP proxy)
  const proxyUrl = session.soaxProxyUrl ?? process.env.DECODO_PROXY_URL;
  const impit = new Impit({ browser: "chrome", ...(proxyUrl ? { proxyUrl } : {}) } as any);

  const publickey = "25028fcd7126544630b8da0c6e60722b5";
  const portalUrl = `https://www.citaconsular.es/es/hosteds/widgetdefault/${publickey}/`;
  const cb = `jQuery_${Date.now()}`;
  const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?callback=${cb}&type=default&publickey=${publickey}&lang=es&version=4&src=${encodeURIComponent(portalUrl)}&_=${Date.now()}`;

  console.log(`[spain] GET ${mainUrl.slice(0, 100)}…`);
  const resp = await (impit.fetch(mainUrl, {
    headers: {
      "User-Agent": ua,
      "Accept": "*/*",
      "Accept-Language": "es-ES,es;q=0.9,fr;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Referer": portalUrl,
      "Cookie": cookieHeader,
      "Sec-Fetch-Dest": "script",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "same-origin",
    },
  } as any) as unknown as Response);

  console.log(`[spain] HTTP ${resp.status}  Content-Type: ${resp.headers.get("content-type")} cf-ray: ${resp.headers.get("cf-ray")}`);
  spainJsonp = await resp.text();
  console.log(`[spain] JSONP reçu: ${spainJsonp.length} bytes`);

  let spainHtml: string;
  try {
    spainHtml = parseBookititJsonp(spainJsonp);
    console.log(`[spain] HTML décodé: ${spainHtml.length} chars`);
  } catch (e) {
    // Peut être que la réponse est déjà du HTML brut (pas JSONP)
    if (spainJsonp.includes("<") && spainJsonp.length > 1000) {
      console.warn(`[spain] ⚠️ Réponse n'est pas du JSONP, utilisation brute`);
      spainHtml = spainJsonp;
    } else {
      console.error(`[spain] Réponse: ${spainJsonp.slice(0, 500)}`);
      throw new Error(`Erreur parsing Spain JSONP: ${e}`);
    }
  }

  const outSpain = path.resolve("/tmp/compare_spain.html");
  fs.writeFileSync(outSpain, spainHtml, "utf8");
  console.log(`[spain] Sauvegardé → ${outSpain}`);

  // ── 3. Comparer ──────────────────────────────────────────────────────────
  compareHtmls("Burp (navigateur réel)", burpHtml, "Spain Watcher (impit live)", spainHtml);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
