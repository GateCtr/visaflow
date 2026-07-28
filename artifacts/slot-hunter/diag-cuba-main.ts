/**
 * diag-cuba-main.ts — Capture et sauvegarde le HTML brut de /main/ pour Cuba
 * Fait le flow complet via CapSolver puis dump le HTML pour inspection.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import { ensureSpainCfSession, spainCfFetch } from "./src/spain-soax-solver.js";

const CUBA_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const PUBLICKEY = "28330379fc95acafd31ee9e8938c278ff";
const BASE = "https://www.citaconsular.es/onlinebookings/";

function parseJsonp(raw: string): any {
  const m = raw.match(/^[^(]+\(([\s\S]*)\);?\s*$/);
  if (!m) { try { return JSON.parse(raw); } catch { return null; } }
  try { return JSON.parse(m[1]); } catch { return null; }
}

async function run() {
  console.log("[diag] Solve CF via CapSolver…");
  const session = await ensureSpainCfSession(CUBA_URL);
  if (!session) { console.error("❌ CF solve échoué"); process.exit(1); }
  console.log(`[diag] ✅ Session CF — cookies: ${session.allCookies.map(c=>c.name).join(", ")}`);

  const referer = CUBA_URL;
  const navHeaders = (extra: Record<string,string> = {}) => ({
    Cookie: [
      ...session.allCookies.filter(c=>c.name!=="cf_clearance").map(c=>`${c.name}=${c.value}`),
      `cf_clearance=${session.cfClearance}`,
    ].join("; "),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1", "Priority": "u=0, i",
    ...extra,
  });

  // Step 1: GET portal
  const entryRes = await spainCfFetch(CUBA_URL, session, { headers: navHeaders() });
  const entryBody = entryRes ? await entryRes.text() : "";
  console.log(`[diag] GET portail: ${entryRes?.status} | ${entryBody.length} bytes`);
  const token = entryBody.match(/name="token"\s+value="([^"]+)"/)
    ?? entryBody.match(/<input[^>]+name=["']token["'][^>]+value=["']([^"']+)["']/i);
  console.log(`[diag] Token CSRF: ${token?.[1]?.slice(0,20) ?? "ABSENT"}`);

  // Merge Set-Cookie
  for (const sc of entryRes?.headers?.getSetCookie?.() ?? []) {
    const [kv] = sc.split(";");
    const [k,v] = kv.split("=",2);
    if (k?.trim() && v !== undefined) {
      const idx = session.allCookies.findIndex(c=>c.name===k.trim());
      if (idx>=0) session.allCookies[idx].value = v.trim();
      else session.allCookies.push({name:k.trim(), value:v.trim()});
      if (k.trim()==="PHPSESSID") console.log(`[diag] PHPSESSID: ${v.trim().slice(0,15)}…`);
    }
  }

  if (!token) {
    console.error("❌ Pas de token — dump page entrée:");
    console.log(entryBody.slice(0,600));
    process.exit(1);
  }

  const cookieStr = () => [
    ...session.allCookies.filter(c=>c.name!=="cf_clearance").map(c=>`${c.name}=${c.value}`),
    `cf_clearance=${session.cfClearance}`,
  ].join("; ");

  // Step 2: POST with token
  const postRes = await spainCfFetch(CUBA_URL.replace(/\/?$/,"/"), session, {
    method: "POST",
    headers: {
      Cookie: cookieStr(),
      "Cache-Control": "max-age=0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9", "Accept-Encoding": "gzip, deflate, br",
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://www.citaconsular.es", Referer: CUBA_URL,
      "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin", "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1", "Priority": "u=0, i",
    },
    body: `token=${encodeURIComponent(token[1])}`,
  });
  const widgetHtml = postRes ? await postRes.text() : "";
  console.log(`[diag] POST widget: ${postRes?.status} | ${widgetHtml.length} bytes`);

  for (const sc of postRes?.headers?.getSetCookie?.() ?? []) {
    const [kv] = sc.split(";");
    const [k,v] = kv.split("=",2);
    if (k?.trim() && v !== undefined) {
      if (k.trim()==="cf_clearance") { session.cfClearance = v.trim(); continue; }
      const idx = session.allCookies.findIndex(c=>c.name===k.trim());
      if (idx>=0) session.allCookies[idx].value = v.trim();
      else session.allCookies.push({name:k.trim(), value:v.trim()});
    }
  }

  // Step 3: /main/ JSONP
  const cb = `jQCuba${Date.now()}`;
  const mainQ = new URLSearchParams({
    callback: cb, type: "default", publickey: PUBLICKEY,
    lang: "es", version: "4", src: CUBA_URL.replace(/\/?$/,"/"),
    _: String(Date.now()),
  });
  const jsonpHeaders = {
    Cookie: cookieStr(), Referer: CUBA_URL.replace(/\/?$/,"/"),
    "X-Requested-With": "XMLHttpRequest",
    Accept: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
    "Accept-Language": "fr-FR,fr;q=0.9", "Accept-Encoding": "gzip, deflate, br",
    "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin", "Priority": "u=1, i",
  };
  const mainRes = await spainCfFetch(`${BASE}main/?${mainQ}`, session, { headers: jsonpHeaders });
  const mainRaw = mainRes ? await mainRes.text() : "";
  console.log(`[diag] /main/: ${mainRes?.status} | ${mainRaw.length} bytes`);

  // Decode JSONP → HTML
  let mainHtml = "";
  const jsonpM = mainRaw.match(/^[^(]+\("([\s\S]*)"\);?\s*$/);
  if (jsonpM) { try { mainHtml = JSON.parse(`"${jsonpM[1]}"`); } catch { mainHtml = mainRaw; } }
  else { mainHtml = mainRaw; }

  console.log(`[diag] HTML décodé: ${mainHtml.length} chars`);

  // Save full HTML
  fs.writeFileSync("/tmp/cuba-main.html", mainHtml);
  fs.writeFileSync("/tmp/cuba-main-raw.jsonp", mainRaw);
  console.log("[diag] ✅ Sauvegardé: /tmp/cuba-main.html + /tmp/cuba-main-raw.jsonp");

  // Analyse services
  const svcMatches = [...mainHtml.matchAll(/<a[^>]+href=['"]#selectservice\/([\w]+)['"][^>]*>([\s\S]*?)<\/a>/gi)];
  console.log(`\n[diag] === Analyse services ===`);
  console.log(`   #selectservice links: ${svcMatches.length}`);

  // Also check alternate patterns
  const svcAlt1 = [...mainHtml.matchAll(/selectservice[/=]([\w]+)/gi)];
  const svcAlt2 = [...mainHtml.matchAll(/data-service[=\s"]+([bkt\d][\w]*)/gi)];
  const svcAlt3 = [...mainHtml.matchAll(/#selectservice(?:[/=])([\w]+)/gi)];
  console.log(`   selectservice mentions (any): ${svcAlt1.length}`);
  console.log(`   data-service attrs: ${svcAlt2.length}`);
  console.log(`   #selectservice exact: ${svcAlt3.length}`);

  // Check no-hay-horas
  const noHorasAll = mainHtml.match(/no hay horas/gi)?.length ?? 0;
  const noHorasVisible = mainHtml.match(/(?<!style="[^"]*display\s*:\s*none[^"]*")no hay horas/gi)?.length ?? 0;
  console.log(`   "no hay horas" occurrences: ${noHorasAll} (visible: ${noHorasVisible})`);

  // Show first 500 chars of decoded HTML
  console.log(`\n[diag] Début HTML /main/ (500 chars):`);
  console.log(mainHtml.slice(0, 500).replace(/\s+/g, " "));

  // Find list of services section
  const listMatch = mainHtml.match(/<div[^>]*id=["']idListServices["'][^>]*>([\s\S]{0,2000})/i);
  if (listMatch) {
    console.log(`\n[diag] #idListServices (2000 chars):`);
    console.log(listMatch[1].replace(/\s+/g, " ").slice(0, 2000));
  } else {
    console.log(`\n[diag] ⚠️ #idListServices non trouvé dans le HTML`);
    // Search for service-related divs
    const serviceSection = mainHtml.match(/(service|servicio)[^<]{0,200}/gi)?.slice(0,5) ?? [];
    console.log(`[diag] Mentions "service": ${serviceSection.join(" | ").slice(0,400)}`);
  }

  // getservices/ call for ground truth
  console.log(`\n[diag] === Appel getservices/ (vérité terrain) ===`);
  const cbSvc = `cbSvc${Date.now()}`;
  const svcQ = new URLSearchParams({
    callback: cbSvc, type: "default", publickey: PUBLICKEY,
    lang: "es", version: "4", src: CUBA_URL.replace(/\/?$/,"/"),
    srvsrc: "https://www.citaconsular.es", selectedPeople: "1",
    _: String(Date.now()),
  });
  const svcRes = await spainCfFetch(`${BASE}getservices/?${svcQ}`, session, { headers: jsonpHeaders });
  const svcRaw = svcRes ? await svcRes.text() : "";
  const svcData = parseJsonp(svcRaw);
  console.log(`   getservices/ status: ${svcRes?.status} | bytes: ${svcRaw.length}`);
  console.log(`   getservices/ parsed: ${JSON.stringify(svcData).slice(0, 600)}`);
}

run().catch(e => { console.error("❌", e); process.exit(1); });
