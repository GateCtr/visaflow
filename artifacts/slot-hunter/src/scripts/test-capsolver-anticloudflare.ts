/**
 * test-capsolver-anticloudflare.ts — Test AntiCloudflareTask (CapSolver résout CF côté serveur)
 *
 * C'est l'ancienne méthode qui marchait : CapSolver lance son propre browser via TON proxy,
 * résout CF, et renvoie cf_clearance + cookies. Ensuite on utilise Impit avec ces cookies.
 *
 * USAGE :
 *   cd artifacts/slot-hunter
 *   npx tsx src/scripts/test-capsolver-anticloudflare.ts
 */

import "dotenv/config";
import { solveSpainCloudflare, spainCfFetch, type SpainCfSession } from "../spain-soax-solver.js";
import { getCurrentDecodoUrl } from "../spain-decodo-pool.js";

const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const BOOKITIT_BASE = "https://www.citaconsular.es/onlinebookings";

const T0 = Date.now();
function ts(): string { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function log(level: string, msg: string): void {
  const icons: Record<string, string> = { INFO: "ℹ️ ", OK: "✅", WARN: "⚠️ ", ERR: "❌", STEP: "▶️ " };
  console.log(`[${ts()}] ${icons[level] ?? "  "} ${msg}`);
}

async function main(): Promise<void> {
  console.log("═".repeat(72));
  console.log("  TEST AntiCloudflareTask (CapSolver server-side) → Impit Bookitit");
  console.log("═".repeat(72));

  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  if (!capsolverKey) {
    log("ERR", "CAPSOLVER_API_KEY manquante");
    process.exit(1);
  }

  const proxyUrl = process.env.SPAIN_ISP_PROXY_URL ?? getCurrentDecodoUrl() ?? process.env.DECODO_PROXY_URL;
  if (!proxyUrl) {
    log("ERR", "Proxy manquant (SPAIN_ISP_PROXY_URL / DECODO_PROXY_URL)");
    process.exit(1);
  }

  log("INFO", `Proxy    : ${proxyUrl.replace(/:([^@:]+)@/, ":***@").slice(0, 60)}`);
  log("INFO", `CapSolver: ${capsolverKey.slice(0, 8)}…`);
  log("INFO", `Cible    : ${SAOPOLO_URL.slice(0, 60)}`);

  // ── PHASE 1+2 : AntiCloudflareTask + session init (retry up to 3 times) ────
  let mainBody = "";
  let session: any = null;
  let UA = "";
  let jar: Record<string, string> = {};
  let srvsrc = "";
  let params: Record<string, string> = {};
  let callbackTs = 0;
  let CALLBACK_NAME = "";
  let impit: any;

  function buildCookie(): string {
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      log("STEP", `─── RETRY #${attempt} (re-solve CF) ───`);
      await new Promise(r => setTimeout(r, 2000));
    }

    log("STEP", `${attempt}) solveSpainCloudflare (AntiCloudflareTask via CapSolver)…`);
    const result = await solveSpainCloudflare(SAOPOLO_URL, capsolverKey, proxyUrl);

    if (!result.success || !result.session) {
      log("ERR", `Solve échoué : ${result.error}`);
      continue;
    }

    session = result.session;
    log("OK", `CF résolu en ${result.durationMs}ms !`);
    log("INFO", `cf_clearance : ${session.cfClearance.slice(0, 30)}…`);
    UA = session.userAgent;
    jar = { cf_clearance: session.cfClearance };
    for (const c of session.allCookies) {
      if (c.name !== "PHPSESSID") jar[c.name] = c.value;
    }

    const { Impit } = await import("impit");
    impit = new Impit({ browser: "chrome", proxyUrl: proxyUrl || undefined } as any);

    // ── 2a. GET portail avec cf_clearance → PHPSESSID + token ────────────────
    log("STEP", "2a) GET portail (cf_clearance → PHPSESSID + token)…");
    const r1 = await impit.fetch(SAOPOLO_URL, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Cookie": buildCookie(),
      },
    } as any) as unknown as Response;

    const body1 = await r1.text();
    log("INFO", `GET portail → HTTP ${r1.status} | ${body1.length}B`);

    if (body1.includes("Just a moment") || r1.status === 403) {
      log("WARN", "CF bloque (403) — retry…");
      continue;
    }

    const setCookie1 = r1.headers.get("set-cookie") ?? "";
    const phpMatch = setCookie1.match(/PHPSESSID=([^;]+)/);
    if (phpMatch) {
      jar["PHPSESSID"] = phpMatch[1];
      log("OK", `PHPSESSID obtenu : ${phpMatch[1].slice(0, 12)}…`);
    } else {
      log("WARN", "PHPSESSID absent");
      continue;
    }

    const tokenMatch = body1.match(/name="token"\s+value="([^"]+)"/i)
      ?? body1.match(/name='token'\s+value='([^']+)'/i);
    if (!tokenMatch) {
      log("WARN", "Token hidden non trouvé");
      continue;
    }
    const token = tokenMatch[1];
    log("OK", `Token extrait : ${token.slice(0, 25)}…`);

    // ── 2b. POST token (form submit navigation — NOT ajax) ─────────────────────
    log("STEP", "2b) POST token (Continuar form submit)…");
    const r2 = await impit.fetch(SAOPOLO_URL, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "es-ES",
        "Cache-Control": "max-age=0",
        "Cookie": buildCookie(),
        "Origin": "https://www.citaconsular.es",
        "Referer": SAOPOLO_URL,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
      body: `token=${encodeURIComponent(token)}`,
      redirect: "follow",
    } as any) as unknown as Response;

    const body2 = await r2.text();
    log("INFO", `POST token → HTTP ${r2.status} | ${body2.length}B`);

    const setCookie2 = r2.headers.get("set-cookie") ?? "";
    const php2 = setCookie2.match(/PHPSESSID=([^;]+)/);
    if (php2) jar["PHPSESSID"] = php2[1];

    const bktMatch = body2.match(/var\s+bkt_init_widget\s*=\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/);
    let bktWidget: Record<string, string> | null = null;
    if (bktMatch) {
      bktWidget = {};
      const pairRegex = /(\w+)\s*:\s*['"]([^'"]*)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = pairRegex.exec(bktMatch[1])) !== null) {
        bktWidget[m[1]] = m[2];
      }
      if (Object.keys(bktWidget).length > 0) {
        log("OK", `bkt_init_widget extrait : ${Object.keys(bktWidget).join(", ")}`);
      } else {
        bktWidget = null;
      }
    }
    if (!bktWidget) {
      log("WARN", "bkt_init_widget non trouvé — retry");
      continue;
    }

    // ── 2c. GET /main/ — FIRST call after CF solve (before GET portal/POST token)
    // Hypothesis: /main/ works if it's the FIRST request with the cf_clearance
    params = bktWidget ? { ...bktWidget } : { type: "default", publickey: "2d01502f12dc08400e22aea87fb00ae34", lang: "es" };
    srvsrc = params.srvsrc || "https://www.citaconsular.es";
    delete params.srvsrc;
    if (!params.src) params.src = SAOPOLO_URL;
    params.version = "4";
    callbackTs = Date.now();
    CALLBACK_NAME = "jQuery21104230673043030936_" + callbackTs;
    params.callback = CALLBACK_NAME;
    params._ = String(callbackTs + 1);

    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
      .join("&");
    const mainUrl = `${srvsrc}/onlinebookings/main/?${qs}`;

    log("STEP", "2c) GET /main/ JSONP…");
    log("INFO", `URL: ${mainUrl.slice(0, 150)}`);
    const r3 = await impit.fetch(mainUrl, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        "Accept": "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": SAOPOLO_URL,
        "Cookie": buildCookie(),
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
    } as any) as unknown as Response;

    mainBody = await r3.text();
    log("INFO", `/main/ → HTTP ${r3.status} | ${mainBody.length}B`);

    if (mainBody.length > 1000) {
      log("OK", `🎉 /main/ → ${mainBody.length}B — session valide !`);
      break; // SUCCESS — proceed to getservices
    } else {
      log("WARN", `/main/ → ${mainBody.length}B (insuffisant) — retry…`);
    }
  }

  if (mainBody.length <= 1000) {
    log("ERR", "Impossible d'obtenir /main/ après 3 tentatives");
    process.exit(1);
  }

  // ── PHASE 3 : Analyse du contenu /main/ et appels getservices/getagendas/datetime ──
  const jsonpMatch = mainBody.match(/^[^(]+\(([\s\S]+)\);?\s*$/);
  const innerContent = jsonpMatch ? jsonpMatch[1] : mainBody;
  
  const hasAceptar = /aceptar/i.test(innerContent);
  const hasServices = /selectservice/i.test(innerContent);
  
  console.log(`\n${"─".repeat(72)}`);
  console.log(`  CONTENU /main/ (${mainBody.length}B) — Détection`);
  console.log(`${"─".repeat(72)}`);
  console.log(`  Bouton "Aceptar" : ${hasAceptar ? "✅ OUI → CRÉNEAUX DISPO !" : "❌ NON"}`);
  console.log(`  Services (#selectservice) : ${hasServices ? "✅ OUI" : "❌ NON"}`);

  // Extraire les IDs de service directement depuis /main/ HTML
  const svcIds = innerContent.match(/bkt\d{5,}/g) ?? [];
  const uniqueSvcIds = Array.from(new Set(svcIds));
  if (uniqueSvcIds.length > 0) {
    console.log(`  IDs Bookitit détectés : ${uniqueSvcIds.join(", ")}`);
  }

    // ── 2c-bis. GET /getwidgetconfigurations/ (required before getservices) ───
    if (hasAceptar) {
      log("STEP", "2c-bis) GET /getwidgetconfigurations/ (init session pour getservices)…");
      const cfgParams: Record<string, string> = {};
      cfgParams.callback = CALLBACK_NAME;
      cfgParams.type = params.type ?? "default";
      cfgParams.publickey = params.publickey ?? "2d01502f12dc08400e22aea87fb00ae34";
      cfgParams.lang = params.lang ?? "es";
      cfgParams.version = "4";
      cfgParams.src = params.src ?? SAOPOLO_URL;
      cfgParams.srvsrc = srvsrc;
      cfgParams._ = String(callbackTs + 2);
      const cfgQs = Object.entries(cfgParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
        .join("&");
      const cfgUrl = `${srvsrc}/onlinebookings/getwidgetconfigurations/?${cfgQs}`;

      const rCfg = await impit.fetch(cfgUrl, {
        method: "GET",
        headers: {
          "User-Agent": UA,
          "Accept": "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": SAOPOLO_URL,
          "Cookie": buildCookie(),
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
        },
      } as any) as unknown as Response;

      const bodyCfg = await rCfg.text();
      log("INFO", `getwidgetconfigurations/ → HTTP ${rCfg.status} | ${bodyCfg.length}B`);
      if (bodyCfg.length > 0) {
        log("OK", `Config reçue : ${bodyCfg.slice(0, 120)}`);
      }
    }

    // ── 2d. GET /getservices/ ──────────────────────────────────────────────────
    if (hasAceptar) {
      log("STEP", "2d) GET /getservices/ JSONP…");
      // CRITICAL: getservices/ needs srvsrc in query string (unlike /main/ which doesn't)
      // Capture shows: /getservices/?callback=...&type=default&publickey=...&lang=es&version=4&src=...&srvsrc=https%3A%2F%2Fwww.citaconsular.es&_=...
      const svcParams: Record<string, string> = {};
      svcParams.callback = CALLBACK_NAME;
      svcParams.type = params.type ?? "default";
      svcParams.publickey = params.publickey ?? "2d01502f12dc08400e22aea87fb00ae34";
      svcParams.lang = params.lang ?? "es";
      svcParams.version = "4";
      svcParams.src = params.src ?? SAOPOLO_URL;
      svcParams.srvsrc = srvsrc;  // MUST be included for getservices/getagendas/datetime
      svcParams._ = String(callbackTs + 3);
      const svcQs = Object.entries(svcParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
        .join("&");
      const svcUrl = `${srvsrc}/onlinebookings/getservices/?${svcQs}`;
      log("INFO", `URL getservices: ${svcUrl.slice(0, 200)}`);

      const r4 = await impit.fetch(svcUrl, {
        method: "GET",
        headers: {
          "User-Agent": UA,
          "Accept": "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
          "Accept-Encoding": "gzip, deflate, br, zstd",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": SAOPOLO_URL,
          "Cookie": buildCookie(),
          "Priority": "u=1, i",
          "Sec-Ch-Ua": `"Chromium";v="138", "Not/A)Brand";v="24", "Google Chrome";v="138"`,
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Ch-Ua-Platform": `"Windows"`,
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
        },
      } as any) as unknown as Response;

      const body4 = await r4.text();
      log("INFO", `getservices/ → HTTP ${r4.status} | ${body4.length}B`);
      // Debug: afficher les headers de réponse
      const respHeaders4: Record<string, string> = {};
      r4.headers.forEach((v: string, k: string) => { respHeaders4[k] = v; });
      log("INFO", `getservices/ headers: ${JSON.stringify(respHeaders4).slice(0, 300)}`);

      // Parse JSONP
      const svcJsonpMatch = body4.match(/^[^(]+\(([\s\S]+)\);?\s*$/);
      if (svcJsonpMatch) {
        try {
          const svcData = JSON.parse(svcJsonpMatch[1]);
          const services = svcData.services ?? svcData.Services ?? [];
          log("OK", `Services trouvés : ${services.length}`);
          for (const svc of services.slice(0, 10)) {
            const name = svc.name ?? svc.Name ?? "?";
            const id = svc.id ?? svc.Id ?? "?";
            log("INFO", `  → ${id} : ${name}`);
          }

          // ── 2e. GET /getagendas/ pour le premier service ─────────────────────
          if (services.length > 0) {
            const firstSvc = services[0];
            const svcId = firstSvc.id ?? firstSvc.Id;
            log("STEP", `2e) GET /getagendas/ (service=${svcId})…`);

            const agParams: Record<string, string> = {};
            agParams.callback = CALLBACK_NAME;
            agParams.type = params.type ?? "default";
            agParams.publickey = params.publickey ?? "2d01502f12dc08400e22aea87fb00ae34";
            agParams.lang = params.lang ?? "es";
            agParams.version = "4";
            agParams["services[]"] = svcId;
            agParams.src = params.src ?? SAOPOLO_URL;
            agParams.srvsrc = srvsrc;
            agParams._ = String(callbackTs + 4);
            const agQs = Object.entries(agParams)
              .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
              .join("&");
            const agUrl = `${srvsrc}/onlinebookings/getagendas/?${agQs}`;

            const r5 = await impit.fetch(agUrl, {
              method: "GET",
              headers: {
                "User-Agent": UA,
                "Accept": "text/javascript, application/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": SAOPOLO_URL,
                "Cookie": buildCookie(),
              },
            } as any) as unknown as Response;

            const body5 = await r5.text();
            log("INFO", `getagendas/ → HTTP ${r5.status} | ${body5.length}B`);

            const agJsonp = body5.match(/^[^(]+\(([\s\S]+)\);?\s*$/);
            if (agJsonp) {
              const agData = JSON.parse(agJsonp[1]);
              const agendas = agData.agendas ?? agData.Agendas ?? [];
              log("OK", `Agendas : ${agendas.length}`);
              for (const ag of agendas.slice(0, 5)) {
                log("INFO", `  → ${ag.idAgenda ?? ag.id} : ${ag.agendaName ?? ag.name ?? "?"}`);
              }

              // ── 2f. GET /datetime/ ──────────────────────────────────────────────
              if (agendas.length > 0) {
                const agId = agendas[0].idAgenda ?? agendas[0].id;
                log("STEP", `2f) GET /datetime/ (service=${svcId}, agenda=${agId})…`);

                const dtParams: Record<string, string> = {};
                dtParams.callback = CALLBACK_NAME;
                dtParams.type = params.type ?? "default";
                dtParams.publickey = params.publickey ?? "2d01502f12dc08400e22aea87fb00ae34";
                dtParams.lang = params.lang ?? "es";
                dtParams.version = "4";
                dtParams["services[]"] = svcId;
                dtParams["agendas[]"] = agId;
                dtParams.src = params.src ?? SAOPOLO_URL;
                dtParams.srvsrc = srvsrc;
                dtParams._ = String(callbackTs + 5);
                const dtQs = Object.entries(dtParams)
                  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
                  .join("&");
                const dtUrl = `${srvsrc}/onlinebookings/datetime/?${dtQs}`;

                const r6 = await impit.fetch(dtUrl, {
                  method: "GET",
                  headers: {
                    "User-Agent": UA,
                    "Accept": "text/javascript, application/javascript, */*; q=0.01",
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": SAOPOLO_URL,
                    "Cookie": buildCookie(),
                  },
                } as any) as unknown as Response;

                const body6 = await r6.text();
                log("INFO", `datetime/ → HTTP ${r6.status} | ${body6.length}B`);

                const dtJsonp = body6.match(/^[^(]+\(([\s\S]+)\);?\s*$/);
                if (dtJsonp) {
                  const dtData = JSON.parse(dtJsonp[1]);
                  const slots = dtData.Slots ?? dtData.slots ?? [];
                  log("OK", `Jours avec données : ${slots.length}`);
                  let totalFree = 0;
                  for (const day of slots.slice(0, 5)) {
                    const date = day.date ?? "?";
                    const times = day.times ?? {};
                    const freeInDay = Object.entries(times)
                      .filter(([, info]: [string, any]) => Number(info.freeSlots ?? 0) > 0)
                      .length;
                    totalFree += freeInDay;
                    if (freeInDay > 0) {
                      log("OK", `  📅 ${date} → ${freeInDay} créneau(x) libre(s)`);
                      for (const [time, info] of Object.entries(times) as [string, any][]) {
                        if (Number(info.freeSlots ?? 0) > 0) {
                          log("INFO", `      🕐 ${time} (${info.freeSlots} place(s))`);
                        }
                      }
                    }
                  }
                  if (totalFree === 0) {
                    log("WARN", "Aucun créneau libre dans les 5 premiers jours");
                  } else {
                    log("OK", `🎉 ${totalFree} créneau(x) libre(s) détecté(s) via Impit pur !`);
                  }
                } else {
                  log("WARN", `datetime/ réponse non-JSONP : ${body6.slice(0, 150)}`);
                }
              }
            }
          }
        } catch (e) {
          log("WARN", `Parse getservices JSONP error : ${e}`);
          log("INFO", `Body[0:200] : ${body4.slice(0, 200)}`);
        }
      } else if (body4.length === 0) {
        log("ERR", "getservices/ → 0B");
      } else {
        log("WARN", `getservices/ non-JSONP : ${body4.slice(0, 150)}`);
      }
    }

  console.log("\n" + "═".repeat(72));
  process.exit(0);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
