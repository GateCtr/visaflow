/**
 * test-cuba-dump-main.ts — Dump le HTML brut de /main/ Cuba via impit
 *
 * Reproduit exactement le flow HTTP du scanner (portal GET → POST token → JSD → /main/)
 * et sauvegarde le HTML décodé sur disque pour diagnostic du service ID pattern.
 *
 * Usage:  cd artifacts/slot-hunter && tsx test-cuba-dump-main.ts
 */

import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";

import {
  ensureSpainCfSession,
  spainCfFetch,
  invalidateSpainCfSession,
} from "./src/spain-soax-solver.js";

const CUBA_URL  = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const PUBLICKEY = "28330379fc95acafd31ee9e8938c278ff";
const BASE      = "https://www.citaconsular.es/onlinebookings/";
const REFERER   = CUBA_URL.replace(/\/?$/, "/");
const OUT       = "/tmp/cuba-main-dump";

function parseJsonp(raw: string): unknown {
  const m = raw.match(/^[^(]+\(([\s\S]*)\);?\s*$/);
  if (m) { try { return JSON.parse(m[1]); } catch { /* fall */ } }
  try { return JSON.parse(raw); } catch { return null; }
}

async function httpFlow(): Promise<{ html: string; cookies: Record<string, string>; cfClearance: string } | null> {
  // 1. Get fresh CF session
  console.log("\n─── CF solve ───");
  invalidateSpainCfSession(); // force fresh solve
  const session = await ensureSpainCfSession(CUBA_URL);
  if (!session) { console.error("❌ CF solve failed"); return null; }
  console.log(`   cf_clearance: ${session.cfClearance.slice(0, 40)}…`);
  console.log(`   cookies: ${session.allCookies.map(c => c.name).join(", ")}`);

  const cookieParts: string[] = [];
  const preferred = ["_ga", "_ga_F3TYSDL945", "PHPSESSID"];
  for (const n of preferred) {
    const c = session.allCookies.find(c => c.name === n);
    if (c) cookieParts.push(`${c.name}=${c.value}`);
  }
  for (const c of session.allCookies) {
    if (!preferred.includes(c.name) && c.name !== "cf_clearance") cookieParts.push(`${c.name}=${c.value}`);
  }
  cookieParts.push(`cf_clearance=${session.cfClearance}`);
  let cookieStr = cookieParts.join("; ");

  const cookies: Record<string, string> = {};
  for (const c of session.allCookies) cookies[c.name] = c.value;

  function mergeCookies(res: Response | null) {
    for (const sc of res?.headers?.getSetCookie?.() ?? []) {
      const [kv] = sc.split(";");
      const eq = kv.indexOf("=");
      if (eq <= 0) continue;
      const k = kv.slice(0, eq).trim();
      const v = kv.slice(eq + 1).trim();
      if (!v) continue;
      cookies[k] = v;
    }
    cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  const navHeaders = {
    Cookie: cookieStr,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Priority": "u=0, i",
  };

  // 2. GET portal
  console.log("\n─── GET portal ───");
  const entryRes = await spainCfFetch(CUBA_URL, session, { headers: { ...navHeaders, Cookie: cookieStr } });
  mergeCookies(entryRes);
  const entryBody = entryRes ? await entryRes.text() : "";
  const entryStatus = entryRes?.status ?? "null";
  const entryTitle = entryBody.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
  const tokenMatch = entryBody.match(/name="token"\s+value="([^"]+)"/)
    ?? entryBody.match(/<input[^>]+name=["']token["'][^>]+value=["']([^"']+)["']/i);
  console.log(`   GET → HTTP ${entryStatus} | bytes: ${entryBody.length} | title: "${entryTitle}"`);
  console.log(`   token: ${tokenMatch?.[1]?.slice(0, 20) ?? "NOT FOUND"}`);
  console.log(`   cookies after: ${Object.keys(cookies).join(", ")}`);

  if (!tokenMatch) {
    // Check if already on widget SPA
    const isWidget = /bkt_init_widget|idBktWidget|onlinebookings/i.test(entryBody);
    if (!isWidget) {
      console.warn("   ⚠️ No CSRF token and not on widget SPA");
      fs.writeFileSync(`${OUT}/portal-entry.html`, entryBody);
      console.log(`   Saved: portal-entry.html (${entryBody.length} chars)`);
    } else {
      console.log("   Already on widget SPA");
    }
  }

  // 3. POST Continue (if token found)
  let widgetHtml = tokenMatch ? "" : entryBody;
  if (tokenMatch) {
    console.log("\n─── POST Continue ───");
    cookieStr = Object.entries(cookies).map(([k,v]) => `${k}=${v}`).join("; ");
    const postRes = await spainCfFetch(REFERER, session, {
      method: "POST",
      headers: {
        Cookie: cookieStr,
        "Cache-Control": "max-age=0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://www.citaconsular.es",
        Referer: CUBA_URL,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        Priority: "u=0, i",
      },
      body: `token=${encodeURIComponent(tokenMatch[1])}`,
    });
    mergeCookies(postRes);
    widgetHtml = postRes ? await postRes.text() : "";
    const postStatus = postRes?.status ?? "null";
    const postTitle = widgetHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
    const hasBkt = /bkt_init_widget|idBktWidget/i.test(widgetHtml);
    console.log(`   POST → HTTP ${postStatus} | bytes: ${widgetHtml.length} | title: "${postTitle}" | bkt: ${hasBkt}`);
    console.log(`   cookies after: ${Object.keys(cookies).join(", ")}`);
    fs.writeFileSync(`${OUT}/widget-post.html`, widgetHtml);

    // 4. JSD Oneshot
    const jsdMatch = widgetHtml.match(
      /\/cdn-cgi\/challenge-platform\/h\/b\/jsd\/oneshot\/[a-f0-9]{10,14}\/[^'"<\s]{10,}\/[a-f0-9]{14,18}/
    );
    if (jsdMatch) {
      console.log(`\n─── JSD Oneshot → ${jsdMatch[0].slice(0, 70)} ───`);
      await new Promise(r => setTimeout(r, 4500 + Math.random() * 1000));
      cookieStr = Object.entries(cookies).map(([k,v]) => `${k}=${v}`).join("; ");
      const jsdRes = await spainCfFetch(`https://www.citaconsular.es${jsdMatch[0]}`, session, {
        method: "POST",
        headers: {
          Cookie: cookieStr,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": "0",
          Origin: "https://www.citaconsular.es",
          Referer: REFERER,
          Accept: "*/*",
          "Accept-Language": "fr-FR,fr;q=0.9",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          Priority: "u=1, i",
        },
        body: "",
      });
      mergeCookies(jsdRes);
      console.log(`   JSD → HTTP ${jsdRes?.status ?? "null"}`);
      console.log(`   cookies after: ${Object.keys(cookies).join(", ")}`);

      // Second POST widget
      cookieStr = Object.entries(cookies).map(([k,v]) => `${k}=${v}`).join("; ");
      const post2 = await spainCfFetch(REFERER, session, {
        method: "POST",
        headers: {
          Cookie: cookieStr,
          "Cache-Control": "max-age=0",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "Accept-Language": "fr-FR,fr;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://www.citaconsular.es",
          Referer: CUBA_URL,
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
          Priority: "u=0, i",
        },
        body: `token=${encodeURIComponent(tokenMatch[1])}`,
      });
      mergeCookies(post2);
      const p2bytes = post2 ? (await post2.clone().text()).length : 0;
      console.log(`   POST widget #2 → HTTP ${post2?.status ?? "null"} | bytes: ${p2bytes}`);
    } else {
      console.log("\n   ℹ️ No JSD Oneshot URL in widget HTML (IP may be trusted by CF)");
    }
  }

  // 5. GET /main/
  console.log("\n─── GET /main/ ───");
  const cbName = `jQuery21109${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  cookieStr = Object.entries(cookies).map(([k,v]) => `${k}=${v}`).join("; ");
  const mainQ = new URLSearchParams({
    callback: cbName, type: "default", publickey: PUBLICKEY,
    lang: "es", version: "4", src: REFERER, _: String(Date.now()),
  });
  const mainRes = await spainCfFetch(`${BASE}main/?${mainQ}`, session, {
    headers: {
      Cookie: cookieStr,
      Referer: REFERER,
      "X-Requested-With": "XMLHttpRequest",
      Accept: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      Priority: "u=1, i",
    },
  });
  const mainStatus = mainRes?.status ?? "null";
  const mainRaw = mainRes ? await mainRes.text() : "";
  console.log(`   /main/ → HTTP ${mainStatus} | bytes: ${mainRaw.length}`);

  if (mainRaw.length === 0) {
    console.warn("   ⚠️ Empty body");
    return null;
  }

  fs.writeFileSync(`${OUT}/main-raw.jsonp`, mainRaw);

  // Decode JSONP → HTML
  const jsonpM = mainRaw.match(/^[^(]+\("(.*)"\);?$/s);
  let html = mainRaw;
  if (jsonpM) { try { html = JSON.parse(`"${jsonpM[1]}"`); } catch { html = mainRaw; } }
  fs.writeFileSync(`${OUT}/main-decoded.html`, html);
  console.log(`   Decoded HTML: ${html.length} chars`);

  return { html, cookies, cfClearance: session.cfClearance };
}

async function analyze(html: string) {
  console.log("\n─── HTML Analysis ───");

  const noHorasVisible = /<div\s+style='text-align:\s*center;[^']*'[^>]*>\s*No hay horas disponibles/i.test(html);
  const noHorasHidden  = /<div\s+style='display:\s*none;[^']*'[^>]*>\s*No hay horas disponibles/i.test(html);
  const hasWidget      = /idBktWidgetDefaultBodyContainer|idDivBktServicesContainer/i.test(html);

  console.log(`   HTML length              : ${html.length}`);
  console.log(`   hasWidgetBody            : ${hasWidget}`);
  console.log(`   noHorasVisible           : ${noHorasVisible}`);
  console.log(`   noHorasHidden            : ${noHorasHidden}`);

  // Remove templates
  const rendered = html.replace(/<script\s+type=['"]text\/template['"][^>]*>[\s\S]*?<\/script>/gi, "");
  fs.writeFileSync(`${OUT}/main-rendered.html`, rendered);

  console.log(`   rendered length (no tmpl): ${rendered.length}`);

  // Service link patterns in both full html and rendered
  for (const [label, src] of [["full html", html], ["rendered (no tmpl)", rendered]] as const) {
    const svcNumeric = [...src.matchAll(/#selectservice\/(\d+)/gi)];
    const svcAlpha   = [...src.matchAll(/#selectservice\/([\w-]+)/gi)];
    const svcHref    = [...src.matchAll(/href=['"]#selectservice\/([^'"]+)['"]/gi)];
    const ids        = [...new Set(svcHref.map(m => m[1]))];
    console.log(`\n   [${label}]`);
    console.log(`     #selectservice numeric : ${svcNumeric.length} → ${[...new Set(svcNumeric.map(m=>m[1]))].join(", ") || "none"}`);
    console.log(`     #selectservice alpha   : ${svcAlpha.length} → ${[...new Set(svcAlpha.map(m=>m[1]))].join(", ") || "none"}`);
    console.log(`     href #selectservice IDs: ${ids.join(", ") || "none"}`);
  }

  // Snippet around first #selectservice occurrence in full html
  const svcIdx = html.indexOf("#selectservice");
  if (svcIdx >= 0) {
    console.log(`\n   ─ Snippet #selectservice (full html, ±250 chars) ─`);
    console.log(`   ${html.slice(Math.max(0, svcIdx-120), svcIdx+250).replace(/\s+/g, " ")}`);
  } else {
    console.log("\n   ⚠️ '#selectservice' not found anywhere in /main/ HTML");
    // Look for service-like links
    const anyLinks = [...html.matchAll(/href=['"][^'"]*service[^'"]*['"]/gi)].slice(0, 5);
    if (anyLinks.length > 0) {
      console.log("   Service-like hrefs found:");
      for (const m of anyLinks) console.log(`     ${m[0]}`);
    }
    // Look for service IDs in other forms
    const dataServiceMatch = [...html.matchAll(/data-service[^=]*=["']([^"']+)['"]/gi)].slice(0, 5);
    if (dataServiceMatch.length > 0) {
      console.log("   data-service attributes:");
      for (const m of dataServiceMatch) console.log(`     ${m[0]}`);
    }
    // Look for idListServices content
    const listSvcMatch = html.match(/id=['"]idListServices['"][^>]*>([\s\S]{0,2000})/i);
    if (listSvcMatch) {
      console.log(`\n   ─ idListServices content (2000 chars) ─`);
      console.log(`   ${listSvcMatch[1].replace(/\s+/g, " ").slice(0, 1500)}`);
    }
  }

  // Snippet around "No hay horas"
  const nhIdx = html.indexOf("No hay horas disponibles");
  if (nhIdx >= 0) {
    console.log(`\n   ─ Snippet "No hay horas" (±200 chars) ─`);
    console.log(`   ${html.slice(Math.max(0, nhIdx-100), nhIdx+200).replace(/\s+/g, " ")}`);
  }

  // Look for Bookitit-specific containers
  const containers = [
    "idBktWidgetDefaultBodyContainer",
    "idDivBktServicesContainer",
    "idListServices",
    "clsBktServiceDataContainer",
    "clsBktServiceAtt",
    "bktServiceName",
    "idBktDefault",
    "clsBktBookingTitle",
  ];
  console.log("\n   DOM landmarks present:");
  for (const c of containers) {
    console.log(`     ${c.padEnd(35)} : ${html.includes(c)}`);
  }
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  console.log(`\n${"═".repeat(66)}`);
  console.log("  Cuba /main/ HTTP Dump");
  console.log(`${"═".repeat(66)}\n`);

  const result = await httpFlow();
  if (!result) { process.exit(1); }

  await analyze(result.html);

  // Saved files
  console.log(`\n${"═".repeat(66)}`);
  console.log(`  Files in ${OUT}/`);
  for (const f of fs.readdirSync(OUT).sort()) {
    const sz = fs.statSync(`${OUT}/${f}`).size;
    console.log(`    ${f.padEnd(30)} ${(sz/1024).toFixed(1)} KB`);
  }
  console.log(`  Duration: ${Math.round((Date.now()-t0)/1000)}s`);
  console.log(`${"═".repeat(66)}\n`);
  process.exit(0);
}

run().catch(e => { console.error("❌", e); process.exit(1); });
