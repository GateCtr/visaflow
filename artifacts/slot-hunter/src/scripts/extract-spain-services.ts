#!/usr/bin/env tsx
/**
 * extract-spain-services.ts — Extraire les services Bookitit de citaconsular.es
 *
 * Usage: npx tsx src/scripts/extract-spain-services.ts
 *
 * Ce script appelle directement l'API JSONP getservices/ de Bookitit
 * pour extraire les IDs et noms des services disponibles.
 *
 * NOTE: Nécessite une session CF active (SOAX_PROXY_URL + CAPSOLVER_API_KEY).
 * Si pas de proxy, tente un appel direct (peut être bloqué par CF).
 */

import * as dotenv from "dotenv";
dotenv.config();

const PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
const PUBLICKEY = "25028fcd7126544630b8da0c6e60722b5";
const BOOKITIT_BASE = "https://www.citaconsular.es/onlinebookings/";

// ─── JSONP parsing ──────────────────────────────────────────────────────────

function parseJsonp(text: string): unknown | null {
  const src = text.trim();
  if (!src) return null;
  const m = src.match(/^[\w$.]+\(([\s\S]*)\);?$/);
  if (!m) {
    try { return JSON.parse(src); } catch { return null; }
  }
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  EXTRACTION DES SERVICES BOOKITIT — citaconsular.es Kinshasa");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Portal: ${PORTAL_URL}`);
  console.log(`  Publickey: ${PUBLICKEY}`);
  console.log("");

  // ─── Méthode 1: Appel direct getservices/ (peut nécessiter CF cookie) ───
  console.log("▶ Tentative 1: Appel direct getservices/ (sans CF cookie)…");
  
  const cbName = `cb${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const params = new URLSearchParams({
    publickey: PUBLICKEY,
    lang: "es",
    selectedPeople: "1",
    callback: cbName,
    _: String(Date.now()),
  });

  const getServicesUrl = `${BOOKITIT_BASE}getservices/?${params}`;
  console.log(`  URL: ${getServicesUrl.slice(0, 120)}…`);

  try {
    const res = await fetch(getServicesUrl, {
      headers: {
        "Accept": "*/*",
        "Accept-Language": "es-ES,es;q=0.9",
        "Referer": PORTAL_URL + "/",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(15_000),
    });

    console.log(`  Status: ${res.status}`);

    if (res.ok) {
      const body = await res.text();
      console.log(`  Body length: ${body.length} chars`);
      console.log(`  Body preview: ${body.slice(0, 300)}`);

      const payload = parseJsonp(body);
      if (payload) {
        console.log("\n✅ PAYLOAD PARSÉ AVEC SUCCÈS :");
        console.log(JSON.stringify(payload, null, 2));
        extractAndDisplay(payload);
        return;
      } else {
        console.log("  ❌ Impossible de parser le JSONP");
        console.log(`  Raw: ${body.slice(0, 500)}`);
      }
    } else {
      const body = await res.text();
      console.log(`  ❌ HTTP ${res.status}`);
      console.log(`  Body: ${body.slice(0, 300)}`);
    }
  } catch (err) {
    console.log(`  ❌ Erreur: ${err}`);
  }

  // ─── Méthode 2: Via spain-soax-solver (nécessite SOAX_PROXY_URL + CAPSOLVER_API_KEY) ───
  console.log("\n▶ Tentative 2: Via SOAX proxy + CF cookie…");
  
  if (!process.env.SOAX_PROXY_URL || !process.env.CAPSOLVER_API_KEY) {
    console.log("  ⚠️ SOAX_PROXY_URL ou CAPSOLVER_API_KEY manquant — skip");
    console.log("  → Configure ces vars et relance le script");
    console.log("\n  Alternativement, tu peux capturer les services manuellement :");
    console.log("  1. Ouvre le portail dans un navigateur");
    console.log("  2. DevTools → Network → filtre 'getservices'");
    console.log("  3. Le payload JSONP contient les IDs et noms des services");
    return;
  }

  try {
    const { ensureSpainCfSession, getSpainImpit } = await import("../spain-soax-solver.js");
    
    console.log("  Obtention session CF…");
    const session = await ensureSpainCfSession(PORTAL_URL);
    if (!session) {
      console.log("  ❌ Impossible d'obtenir la session CF");
      return;
    }
    console.log(`  ✅ Session CF obtenue (expire: ${new Date(session.expiresAt).toISOString()})`);

    // Step 1: GET entry + POST token
    const impit = getSpainImpit(session);
    const cookieParts = [`cf_clearance=${session.cfClearance}`];
    for (const c of session.allCookies) {
      if (c.name !== "cf_clearance") cookieParts.push(`${c.name}=${c.value}`);
    }

    // GET entry page
    const entryRes = await impit.fetch(PORTAL_URL, {
      headers: {
        "User-Agent": session.userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cookie": cookieParts.join("; "),
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
    } as any) as any;

    const entryHtml = await entryRes.text();
    console.log(`  Entry page: ${entryHtml.length} chars`);

    // Extract token and POST
    const tokenMatch = entryHtml.match(/name="token"\s+value="([^"]+)"/);
    if (tokenMatch) {
      console.log(`  Token trouvé: ${tokenMatch[1].slice(0, 20)}…`);
      
      // Capture PHPSESSID from entry response
      for (const sc of (entryRes.headers?.getSetCookie?.() ?? [])) {
        const nv = sc.split(";")[0];
        if (nv) cookieParts.push(nv);
      }

      const postRes = await impit.fetch(PORTAL_URL.replace(/\/?$/, "/"), {
        method: "POST",
        headers: {
          "User-Agent": session.userAgent,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": cookieParts.join("; "),
          "Origin": "https://www.citaconsular.es",
          "Referer": PORTAL_URL,
        },
        body: `token=${encodeURIComponent(tokenMatch[1])}`,
      } as any) as any;

      console.log(`  POST Continue: ${postRes.status}`);
      
      // Capture new cookies
      for (const sc of (postRes.headers?.getSetCookie?.() ?? [])) {
        const nv = sc.split(";")[0];
        if (nv) cookieParts.push(nv);
      }
    }

    // Step 2: Call getservices/
    console.log("\n  Appel getservices/…");
    const svcParams = new URLSearchParams({
      publickey: PUBLICKEY,
      lang: "es",
      selectedPeople: "1",
      callback: `cb${Date.now()}`,
      _: String(Date.now()),
    });

    const svcRes = await impit.fetch(`${BOOKITIT_BASE}getservices/?${svcParams}`, {
      headers: {
        "User-Agent": session.userAgent,
        "Accept": "*/*",
        "Cookie": cookieParts.join("; "),
        "Referer": PORTAL_URL + "/",
        "X-Requested-With": "XMLHttpRequest",
      },
    } as any) as any;

    const svcBody = await svcRes.text();
    console.log(`  Response: ${svcRes.status}, ${svcBody.length} chars`);
    console.log(`  Preview: ${svcBody.slice(0, 400)}`);

    const svcPayload = parseJsonp(svcBody);
    if (svcPayload) {
      console.log("\n✅ SERVICES EXTRAITS :");
      console.log(JSON.stringify(svcPayload, null, 2));
      extractAndDisplay(svcPayload);
    } else {
      console.log("  ❌ Impossible de parser");
    }

    // Step 3: Also fetch /main/ to see all template content
    console.log("\n  Appel /main/ pour extraire les templates…");
    const mainParams = new URLSearchParams({
      type: "default",
      publickey: PUBLICKEY,
      lang: "es",
      version: "4",
      src: PORTAL_URL.replace(/\/?$/, "/"),
      callback: `jQuery${Date.now()}`,
      _: String(Date.now()),
    });

    const mainRes = await impit.fetch(`${BOOKITIT_BASE}main/?${mainParams}`, {
      headers: {
        "User-Agent": session.userAgent,
        "Accept": "*/*",
        "Cookie": cookieParts.join("; "),
        "Referer": PORTAL_URL + "/",
        "X-Requested-With": "XMLHttpRequest",
      },
    } as any) as any;

    const mainBody = await mainRes.text();
    console.log(`  /main/ response: ${mainRes.status}, ${mainBody.length} chars`);

    // Parse JSONP → HTML
    const jsonpMatch = mainBody.match(/^[^(]+\("(.*)"\);?$/s);
    let mainHtml: string;
    if (jsonpMatch) {
      try { mainHtml = JSON.parse(`"${jsonpMatch[1]}"`); } catch { mainHtml = mainBody; }
    } else {
      mainHtml = mainBody;
    }

    console.log(`  HTML extrait: ${mainHtml.length} chars`);

    // Extract service info from templates (even when no slots)
    // Templates contain the full service structure: <a href='#selectservice/<%= id %>'> etc.
    // But data-driven templates won't have real IDs
    // Look for any hardcoded service references
    const serviceRefs = [...mainHtml.matchAll(/selectservice\/(\d+)/g)].map(m => m[1]);
    const uniqueServiceIds = [...new Set(serviceRefs)];
    if (uniqueServiceIds.length > 0) {
      console.log(`\n  📋 Service IDs trouvés dans /main/ HTML: ${uniqueServiceIds.join(", ")}`);
    }

    // Look for service names in the rendered part (outside templates)
    const renderedHtml = mainHtml.replace(/<script\s+type=['"]text\/template['"][^>]*>[\s\S]*?<\/script>/gi, "");
    const serviceMatches = [...renderedHtml.matchAll(/<a[^>]+href=['"]#selectservice\/(\d+)['"][^>]*>([\s\S]*?)<\/a>/gi)];
    if (serviceMatches.length > 0) {
      console.log("\n  🎯 SERVICES RENDUS (créneaux disponibles !) :");
      for (const m of serviceMatches) {
        const id = m[1];
        const nameMatch = m[2].match(/clsBktServiceDataName[^>]*>([^<]+)/i);
        const name = nameMatch?.[1]?.trim() ?? "???";
        console.log(`    • ${name} → serviceId: ${id}`);
      }
    } else {
      console.log("\n  ℹ️ Pas de services rendus (pas de créneaux actuellement)");
      console.log("  → Les IDs ne sont visibles que quand des créneaux sont ouverts");
      console.log("  → Utiliser getservices/ JSONP à la place (ci-dessus)");
    }

  } catch (err) {
    console.error(`  ❌ Erreur: ${err}`);
  }
}

// ─── Helper: afficher les services de manière structurée ─────────────────────

function extractAndDisplay(payload: unknown) {
  if (!payload || typeof payload !== "object") return;

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║              SERVICES BOOKITIT — MAPPING                     ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");

  const walk = (node: unknown, depth = 0): void => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          // Look for service-like objects (have id + name/description)
          const id = obj.id ?? obj.Id ?? obj.serviceId ?? obj.ServiceId;
          const name = obj.name ?? obj.Name ?? obj.serviceName ?? obj.ServiceName ?? obj.description ?? obj.Description;

          if (id && name) {
            console.log(`║  [${i}] ID: ${id}`);
            console.log(`║      Name: ${name}`);
            if (obj.duration || obj.Duration) console.log(`║      Duration: ${obj.duration ?? obj.Duration}`);
            if (obj.people || obj.People) console.log(`║      People: ${obj.people ?? obj.People}`);
            if (obj.visible !== undefined) console.log(`║      Visible: ${obj.visible}`);
            console.log("║  ────────────────────────────────────────────");
          } else {
            walk(item, depth + 1);
          }
        }
      }
    } else if (typeof node === "object" && node !== null) {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          console.log(`║  ${key}: [${value.length} items]`);
          walk(value, depth + 1);
        } else if (value && typeof value === "object") {
          walk(value, depth + 1);
        }
      }
    }
  };

  walk(payload);
  console.log("╚══════════════════════════════════════════════════════════════╝");

  // Also dump raw for analysis
  console.log("\n  [RAW PAYLOAD pour analyse]:");
  const str = JSON.stringify(payload, null, 2);
  if (str.length < 5000) {
    console.log(str);
  } else {
    console.log(str.slice(0, 5000) + "\n… (tronqué)");
  }
}

main().catch(console.error);
