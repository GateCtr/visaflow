/**
 * spain-http-scanner.ts — Scanner Espagne 100% HTTP (sans Playwright)
 *
 * ARCHITECTURE :
 *   1. Obtient cf_clearance via spain-soax-solver (CapSolver + SOAX sticky)
 *   2. Charge la page widget citaconsular.es via impit pour extraire les params Bookitit
 *   3. Appelle les APIs JSONP Bookitit (getservices, getagendas, datetime) via impit
 *   4. Scanne en boucle toutes les 30-60s sans aucun navigateur
 *   5. Re-solve automatique quand le cookie expire (~2h)
 *
 * AVANTAGES vs Playwright :
 *   - 10x plus rapide (pas de rendu DOM, pas de JS)
 *   - 0 RAM navigateur (~500MB économisés)
 *   - Scan toutes les 30s au lieu de 3min
 *   - Détection + booking ultra-rapide
 *
 * PRÉREQUIS :
 *   - SOAX_PROXY_URL configuré
 *   - CAPSOLVER_API_KEY configuré
 *   - SPAIN_SOAX_COUNTRY optionnel (défaut: "es")
 */

import {
  ensureSpainCfSession,
  spainCfFetch,
  invalidateSpainCfSession,
  isSpainCfSessionExpiringSoon,
  rotateSpainSoaxSession,
  type SpainCfSession,
} from "./spain-soax-solver.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SpainSlotHttp {
  date: string;
  time: string;
  location: string;
  agendaId?: string;
}

export interface SpainHttpScanResult {
  status: "found" | "not_found" | "cf_blocked" | "session_expired" | "error";
  slot?: SpainSlotHttp;
  slotInfo?: string;
  errorMessage?: string;
  scanDurationMs: number;
}

/** Configuration Bookitit extraite de la page widget (persistée entre scans). */
interface BookititConfig {
  baseUrl: string;
  initParams: Record<string, string>;
  services: string[];
  agendas: string[];
  referer: string;
  extractedAt: number;
}

// ─── Bookitit Config Cache ──────────────────────────────────────────────────

/** TTL de la config Bookitit (30min — aligné sur PHPSESSID). */
const BOOKITIT_CONFIG_TTL_MS = 30 * 60_000;

const _bookititConfigCache = new Map<string, BookititConfig>();

function getCachedBookititConfig(portalUrl: string): BookititConfig | null {
  const entry = _bookititConfigCache.get(portalUrl);
  if (!entry) return null;
  if (Date.now() - entry.extractedAt > BOOKITIT_CONFIG_TTL_MS) {
    _bookititConfigCache.delete(portalUrl);
    return null;
  }
  return entry;
}

// ─── HTML Parsing Helpers ───────────────────────────────────────────────────

/**
 * Extrait les paramètres bkt_init_widget depuis le HTML de la page widget.
 * Le widget Bookitit intègre un script inline avec :
 *   var bkt_init_widget = {...};
 * ou
 *   bkt_init_widget = {...};
 */
function extractBktInitFromHtml(html: string): Record<string, string> | null {
  // Pattern 1: var bkt_init_widget = {...} — parse complet
  const m1 = html.match(/bkt_init_widget\s*=\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s);
  if (m1) {
    const block = m1[1];
    const params: Record<string, string> = {};

    // Extraire chaque propriété : key: 'value' ou key: "value" ou key: value
    const propMatches = block.matchAll(/(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|([\w.]+))/g);
    for (const pm of propMatches) {
      const key = pm[1];
      const value = pm[2] ?? pm[3] ?? pm[4] ?? "";
      if (key && value && value !== "undefined" && !value.startsWith("[")) {
        params[key] = value;
      }
    }

    if (Object.keys(params).length > 0) return params;
  }

  // Pattern 2: extraire les paires clé-valeur individuellement (fallback)
  const params: Record<string, string> = {};
  const patterns = [
    /["']?idCentre["']?\s*[:=]\s*["']?(\d+)["']?/,
    /["']?idService["']?\s*[:=]\s*["']?(\d+)["']?/,
    /["']?idWidget["']?\s*[:=]\s*["']?(\w+)["']?/,
    /["']?lang["']?\s*[:=]\s*["']?(\w+)["']?/,
    /["']?publickey["']?\s*[:=]\s*["']?([a-f0-9]+)["']?/,
    /["']?srvsrc["']?\s*[:=]\s*["']?(https?:\/\/[^"']+)["']?/,
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const key = p.source.match(/["']?(\w+)["']?\s*[:=]/)?.[1];
      if (key) params[key] = m[1];
    }
  }

  // Pattern 3: chercher l'URL Bookitit dans un iframe/script src
  const iframeSrc = html.match(/src=["'](https?:\/\/[^"']*bookitit[^"']*)/i);
  if (iframeSrc) {
    try {
      const url = new URL(iframeSrc[1]);
      for (const [k, v] of url.searchParams) {
        params[k] = v;
      }
    } catch {
      // ignore
    }
  }

  return Object.keys(params).length > 0 ? params : null;
}

/**
 * Extrait l'URL de base Bookitit depuis le HTML de la page widget.
 * Cherche les références au script/iframe bookitit.
 *
 * citaconsular.es pattern: bkt_init_widget.srvsrc = 'https://www.citaconsular.es'
 * → API base = srvsrc + '/onlinebookings/'
 */
function extractBookititBaseFromHtml(html: string): string | null {
  // Pattern 0: srvsrc dans bkt_init_widget (citaconsular.es pattern)
  // Le loader utilise: sServerUrl + '/onlinebookings/main'
  const srvsrcMatch = html.match(/srvsrc['":\s]+['"]?(https?:\/\/[^'"}\s,]+)/i);
  if (srvsrcMatch) {
    const base = srvsrcMatch[1].replace(/\/$/, "") + "/onlinebookings/";
    return base;
  }

  // Pattern 1: iframe src avec bookitit
  const iframeMatch = html.match(/src=["'](https?:\/\/[^"']*bookitit\.com[^"']*onlinebookings[^"']*)/i);
  if (iframeMatch) {
    const url = iframeMatch[1].split("?")[0];
    return url.endsWith("/") ? url : url + "/";
  }

  // Pattern 2: script src avec bookitit API
  const scriptMatch = html.match(/(https?:\/\/[^"'\s]*bookitit\.com[^"'\s]*onlinebookings\/)/i);
  if (scriptMatch) return scriptMatch[1];

  // Pattern 3: URL directe dans le code JS
  const jsMatch = html.match(/["'](https?:\/\/app\.bookitit\.com\/[^"'\s]*onlinebookings\/)/i);
  if (jsMatch) return jsMatch[1];

  // Pattern 4: Hosted widget — extraire depuis les appels JSONP
  const jsonpMatch = html.match(/(https?:\/\/[^"'\s]*bookitit[^"'\s]*?)(?:getwidget|getservice|datetime)/i);
  if (jsonpMatch) return jsonpMatch[1];

  return null;
}

// ─── JSONP HTTP Caller (via impit + cf_clearance) ───────────────────────────

function parseJsonpPayload(text: string): unknown | null {
  const src = text.trim();
  if (!src) return null;
  const m = src.match(/^[\w$.]+\(([\s\S]*)\);?$/);
  if (!m) {
    try { return JSON.parse(src); } catch { return null; }
  }
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

/**
 * Appelle un endpoint JSONP Bookitit via impit + session CF.
 * Retourne null si la réponse n'est pas du JSONP (CF challenge ou session expirée).
 */
async function callBookititJsonp(
  session: SpainCfSession,
  baseUrl: string,
  endpoint: string,
  params: Record<string, string>,
  referer: string,
): Promise<unknown | null> {
  const q = new URLSearchParams(params);
  q.set("callback", `cb${Date.now()}${Math.floor(Math.random() * 10_000)}`);
  q.set("_", String(Date.now()));
  const url = `${baseUrl}${endpoint}?${q.toString()}`;

  const res = await spainCfFetch(url, session, {
    Referer: referer,
    Origin: new URL(referer).origin,
    "X-Requested-With": "XMLHttpRequest",
  });

  if (!res) return null;
  if (!res.ok) {
    if (res.status === 403) {
      console.warn(`[spain-http] 403 sur ${endpoint} → CF cookie probablement expiré`);
      return null;
    }
    return null;
  }

  const body = await res.text();
  const trimmed = body.trim();

  // Détecter challenge CF ou HTML (pas JSONP)
  if (/<!DOCTYPE|<html|un instant|just a moment/i.test(trimmed.slice(0, 200))) {
    console.warn(`[spain-http] Réponse HTML au lieu de JSONP sur ${endpoint} → session CF morte`);
    return null;
  }

  const looksLikeJsonp = trimmed.startsWith("{") || trimmed.startsWith("[") || /^[\w$.]+\(/.test(trimmed);
  if (!looksLikeJsonp) return null;

  return parseJsonpPayload(body);
}

// ─── Slot Extraction ────────────────────────────────────────────────────────

function extractSlotFromBookititPayload(payload: unknown): SpainSlotHttp | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  if (Array.isArray(obj.Slots)) {
    for (const day of obj.Slots) {
      if (!day || typeof day !== "object") continue;
      const dayObj = day as Record<string, unknown>;
      const date = typeof dayObj.date === "string" ? dayObj.date : "";
      if (!date) continue;

      const agendaId =
        typeof dayObj.agenda === "string" ? dayObj.agenda
        : typeof dayObj.agenda === "number" ? String(dayObj.agenda)
        : typeof dayObj.agenda_id === "string" ? dayObj.agenda_id
        : typeof dayObj.agenda_id === "number" ? String(dayObj.agenda_id)
        : undefined;

      const location = agendaId ?? "citaconsular";
      const times = dayObj.times;
      if (!times || typeof times !== "object" || Array.isArray(times)) continue;
      const timesObj = times as Record<string, unknown>;
      if (Object.keys(timesObj).length === 0) continue;

      for (const v of Object.values(timesObj)) {
        if (!v || typeof v !== "object") continue;
        const t = v as Record<string, unknown>;
        const freeRaw = t.freeSlots ?? t.freeslots ?? t.free_slots;
        const totalRaw = t.totalSlots ?? t.totalslots ?? t.total_slots;
        const free = typeof freeRaw === "number" ? freeRaw : typeof freeRaw === "string" ? parseInt(freeRaw, 10) : -1;
        const total = typeof totalRaw === "number" ? totalRaw : typeof totalRaw === "string" ? parseInt(totalRaw, 10) : -1;
        const hasAvailability = (free > 0) || (total > 0) || (free === -1 && total === -1);
        if (!hasAvailability) continue;

        const time =
          typeof t.time === "string" ? t.time
          : typeof t.hour === "string" ? t.hour
          : "09:00";

        return { date, time, location, agendaId };
      }
    }
  }

  return null;
}

function collectIds(value: unknown, keyHint: RegExp): string[] {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (v && typeof v === "object") { walk(v); continue; }
      if ((typeof v === "string" || typeof v === "number") && keyHint.test(k)) {
        const s = String(v).trim();
        if (s.length > 0) out.add(s);
      }
    }
  };
  walk(value);
  return [...out];
}

function firstMonthDayYmd(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function lastMonthDayYmd(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
}

// ─── Bookitit Config Extraction (via HTTP) ──────────────────────────────────

/**
 * Récupère la configuration Bookitit depuis la page widget.
 * Fait un GET sur le portalUrl via impit+CF cookie, parse le HTML pour extraire les params.
 *
 * Flow citaconsular.es :
 *   1. GET portalUrl → page "Continue / Continuar" avec token hidden
 *   2. POST portalUrl/ avec token → widget Bookitit (page SPA avec JS)
 *   3. Le widget charge ses scripts puis fait des appels JSONP vers les APIs
 *      → On doit extraire la baseUrl Bookitit depuis les scripts/iframes
 */
async function fetchBookititConfig(
  session: SpainCfSession,
  portalUrl: string,
): Promise<BookititConfig | null> {
  console.log(`[spain-http] 📄 Fetch config Bookitit depuis ${portalUrl}`);

  // Step 1: GET la page d'entrée (bouton Continue + token)
  const entryRes = await spainCfFetch(portalUrl, session, {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
  });

  if (!entryRes) {
    console.error(`[spain-http] ❌ Pas de réponse pour ${portalUrl}`);
    return null;
  }

  if (entryRes.status === 403) {
    console.warn(`[spain-http] ⚠️ 403 sur portal page → CF cookie mort`);
    invalidateSpainCfSession();
    return null;
  }

  let html = await entryRes.text();

  // Vérifier qu'on n'a pas un challenge CF
  if (/un instant|just a moment|verifying you are human/i.test(html.slice(0, 2000))) {
    console.warn(`[spain-http] ⚠️ Challenge CF sur portal page → cookie invalide`);
    invalidateSpainCfSession();
    return null;
  }

  // Step 2: Détecter le formulaire "Continue / Continuar" et soumettre
  const tokenMatch = html.match(/<input[^>]+name=["']token["'][^>]+value=["']([^"']+)["']/i)
    ?? html.match(/name="token"\s+value="([^"]+)"/i);
  const formActionMatch = html.match(/<form[^>]+action=["']([^"']+)["'][^>]+method=["']POST["']/i)
    ?? html.match(/action="([^"]+)"\s+method="POST"/i);

  if (tokenMatch) {
    const token = tokenMatch[1];
    const formAction = formActionMatch ? formActionMatch[1] : portalUrl + "/";
    const postUrl = formAction.startsWith("http") ? formAction : `https://www.citaconsular.es${formAction}`;

    console.log(`[spain-http] 🔘 Bouton "Continue" détecté — POST avec token vers ${postUrl}`);

    // Soumettre le formulaire
    const { getSpainImpit } = await import("./spain-soax-solver.js");
    const impit = getSpainImpit(session);

    // Construire le cookie header
    const cookieParts = [`cf_clearance=${session.cfClearance}`];
    for (const c of session.allCookies) {
      if (c.name !== "cf_clearance") cookieParts.push(`${c.name}=${c.value}`);
    }

    const postHeaders: Record<string, string> = {
      "User-Agent": session.userAgent,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookieParts.join("; "),
      "Origin": "https://www.citaconsular.es",
      "Referer": portalUrl,
      "Sec-CH-UA": '"Chromium";v="136", "Not.A/Brand";v="99", "Google Chrome";v="136"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    };

    try {
      const postRes = await impit.fetch(postUrl, {
        method: "POST",
        headers: postHeaders,
        body: `token=${encodeURIComponent(token)}`,
      } as any) as unknown as Response;

      if (postRes.ok || postRes.status === 302 || postRes.status === 301) {
        html = await postRes.text();
        console.log(`[spain-http] ✅ POST réussi — ${html.length} chars reçus`);
      } else {
        console.warn(`[spain-http] ⚠️ POST status ${postRes.status}`);
        html = await postRes.text();
      }
    } catch (err) {
      console.error(`[spain-http] ❌ POST error: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // Step 3: Parser le HTML du widget Bookitit
  // Extraire la base URL Bookitit
  const baseUrl = extractBookititBaseFromHtml(html);

  // Si pas trouvé dans le HTML statique, chercher dans les scripts JS référencés
  if (!baseUrl) {
    // Chercher une URL d'API directement dans le HTML (inline scripts)
    const inlineApiMatch = html.match(/(https?:\/\/[^"'\s]*bookitit\.com[^"'\s]*)/i);
    if (inlineApiMatch) {
      const extractedBase = inlineApiMatch[1].replace(/(?:getwidget|getservice|datetime|getagenda).*$/, "");
      console.log(`[spain-http] 📍 Base URL trouvée dans inline script: ${extractedBase}`);
      return buildConfigFromBase(session, extractedBase, portalUrl, html);
    }

    // Chercher dans les scripts JS chargés par la page
    const scriptSrcs = [...html.matchAll(/src=["']([^"']+bookitit[^"']*)/gi)].map(m => m[1]);
    const widgetScriptSrcs = [...html.matchAll(/src=["']([^"']+(?:widget|bkt)[^"']*\.js[^"']*)/gi)].map(m => m[1]);
    const allScripts = [...new Set([...scriptSrcs, ...widgetScriptSrcs])];

    if (allScripts.length > 0) {
      console.log(`[spain-http] 🔍 Analyse de ${allScripts.length} scripts pour trouver la base URL…`);
      for (const scriptUrl of allScripts.slice(0, 3)) {
        const absUrl = scriptUrl.startsWith("http") ? scriptUrl : `https://www.citaconsular.es${scriptUrl}`;
        const scriptRes = await spainCfFetch(absUrl, session);
        if (scriptRes) {
          const scriptBody = await scriptRes.text();
          const apiInScript = scriptBody.match(/(https?:\/\/[^"'\s]*bookitit\.com[^"'\s]*onlinebookings\/)/i)
            ?? scriptBody.match(/(https?:\/\/app\.bookitit\.com\/[^"'\s]*\/)/i);
          if (apiInScript) {
            console.log(`[spain-http] 📍 Base URL trouvée dans script: ${apiInScript[1]}`);
            return buildConfigFromBase(session, apiInScript[1], portalUrl, html);
          }
        }
      }
    }

    // Fallback: construire l'URL de base depuis le domaine bookitit.com standard
    // Le widget citaconsular utilise webapp.bookitit.com/onlinebookings/
    const webappUrl = "https://webapp.bookitit.com/onlinebookings/";
    console.log(`[spain-http] 🔄 Fallback: essai avec ${webappUrl}`);
    return buildConfigFromBase(session, webappUrl, portalUrl, html);
  }

  return buildConfigFromBase(session, baseUrl, portalUrl, html);
}

// ─── Main Scan Function ─────────────────────────────────────────────────────

/**
 * Helper : Construit la config Bookitit à partir d'une base URL connue.
 */
async function buildConfigFromBase(
  session: SpainCfSession,
  baseUrl: string,
  portalUrl: string,
  html: string,
): Promise<BookititConfig | null> {
  // Extraire les params bkt_init_widget depuis le HTML
  const initParams = extractBktInitFromHtml(html);
  const params = initParams ?? {};

  // Bootstrap: appeler getwidgetconfigurations pour initialiser la session
  const cfgPayload = await callBookititJsonp(session, baseUrl, "getwidgetconfigurations/", params, portalUrl);
  if (cfgPayload === null) {
    console.warn(`[spain-http] ⚠️ getwidgetconfigurations null sur ${baseUrl} — session ou URL invalide`);
    // Ne pas retourner null immédiatement — essayer quand même les services
  }

  // Récupérer services
  const svcPayload = await callBookititJsonp(session, baseUrl, "getservices/", {
    ...params,
    selectedPeople: "1",
  }, portalUrl);
  const services = svcPayload
    ? collectIds(svcPayload, /(service.*id|services.*id|^id$)/i).slice(0, 3)
    : [];

  // Récupérer agendas
  let agendas: string[] = [];
  if (services.length > 0) {
    const agPayload = await callBookititJsonp(session, baseUrl, "getagendas/", {
      ...params,
      services: services.join(","),
      selectedPeople: "1",
    }, portalUrl);
    if (agPayload) {
      agendas = collectIds(agPayload, /(agenda.*id|agendas.*id|^id$)/i).slice(0, 5);
    }
  }

  const config: BookititConfig = {
    baseUrl,
    initParams: params,
    services,
    agendas,
    referer: portalUrl,
    extractedAt: Date.now(),
  };

  _bookititConfigCache.set(portalUrl, config);
  console.log(`[spain-http] ✅ Config extraite — base: ${baseUrl} | services: ${services.join(",") || "none"} | agendas: ${agendas.join(",") || "none"}`);
  return config;
}

/**
 * Effectue un scan HTTP-only des créneaux Espagne.
 *
 * Flow :
 *   1. ensureSpainCfSession() → obtient/réutilise le cookie CF
 *   2. getCachedBookititConfig() ou fetchBookititConfig() → params Bookitit
 *   3. Scan datetime/ sur 9 mois → détection créneaux
 *
 * @param portalUrl - URL du widget citaconsular.es
 */
export async function scanSpainHttp(portalUrl: string): Promise<SpainHttpScanResult> {
  const t0 = Date.now();

  // 1. Obtenir la session CF (solve si nécessaire)
  const session = await ensureSpainCfSession(portalUrl);
  if (!session) {
    return {
      status: "cf_blocked",
      errorMessage: "Impossible d'obtenir le cookie CF (SOAX ou CapSolver indisponible)",
      scanDurationMs: Date.now() - t0,
    };
  }

  // 2. Obtenir la config Bookitit (cache ou fetch)
  let config = getCachedBookititConfig(portalUrl);
  if (!config) {
    config = await fetchBookititConfig(session, portalUrl);
    if (!config) {
      return {
        status: "error",
        errorMessage: "Impossible d'extraire la config Bookitit depuis la page widget",
        scanDurationMs: Date.now() - t0,
      };
    }
  }

  // 3. Vérifier que les services/agendas sont disponibles
  if (config.services.length === 0 || config.agendas.length === 0) {
    // Re-fetch config pour tenter d'obtenir les services/agendas
    _bookititConfigCache.delete(portalUrl);
    config = await fetchBookititConfig(session, portalUrl);
    if (!config || config.services.length === 0 || config.agendas.length === 0) {
      return {
        status: "not_found",
        errorMessage: "Aucun service/agenda disponible (normal si pas de créneau possible)",
        scanDurationMs: Date.now() - t0,
      };
    }
  }

  // 4. Scan datetime sur 9 mois
  const baseDate = new Date();
  for (let i = 0; i < 9; i++) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth() + i, 1);
    const payload = await callBookititJsonp(session, config.baseUrl, "datetime/", {
      ...config.initParams,
      services: config.services.join(","),
      agendas: config.agendas.join(","),
      start: firstMonthDayYmd(d),
      end: lastMonthDayYmd(d),
      selectedPeople: "1",
    }, config.referer);

    // Si null → CF challenge mid-scan → session morte
    if (payload === null) {
      console.warn(`[spain-http] ⚠️ Session CF morte mid-scan (mois ${i})`);
      invalidateSpainCfSession();
      _bookititConfigCache.delete(portalUrl);
      return {
        status: "session_expired",
        errorMessage: "CF cookie expiré pendant le scan",
        scanDurationMs: Date.now() - t0,
      };
    }

    const slot = extractSlotFromBookititPayload(payload);
    if (slot) {
      const slotInfo = `${slot.date} à ${slot.time} — ${slot.location}`;
      console.log(`[spain-http] 🎉 CRÉNEAU TROUVÉ: ${slotInfo}`);
      return {
        status: "found",
        slot,
        slotInfo,
        scanDurationMs: Date.now() - t0,
      };
    }
  }

  return {
    status: "not_found",
    scanDurationMs: Date.now() - t0,
  };
}

/**
 * Variante probe pour le watcher (compatible avec SpainWatcherProbeResult).
 * Drop-in replacement pour runSpainWatcherProbe() quand SPAIN_HTTP_MODE=1.
 *
 * STRATÉGIE HYBRIDE :
 *   - Si une session Bookitit est déjà cachée (par un passage Playwright précédent) :
 *     → Scan direct via HTTP (impit + SOAX + cf_clearance) — ultra-rapide
 *   - Si pas de session cachée :
 *     → Le CF bypass est prêt, mais Bookitit nécessite un init JS
 *     → Retourne "error" pour que la boucle fallback sur Playwright
 *
 * L'avantage principal : une fois la session Bookitit établie (25min TTL),
 * les scans suivants sont 100% HTTP avec le cookie CF pré-résolu.
 * Le CF bypass réduit le temps Playwright de 120s (attente passive) → 10s.
 */
export async function runSpainHttpProbe(portalUrl: string): Promise<{
  status: "found" | "not_found" | "error";
  slotInfo?: string;
  screenshotBase64?: string;
  errorMessage?: string;
}> {
  const result = await scanSpainHttp(portalUrl);

  switch (result.status) {
    case "found":
      return { status: "found", slotInfo: result.slotInfo };
    case "not_found":
      return { status: "not_found" };
    case "cf_blocked":
    case "session_expired":
    case "error":
      return { status: "error", errorMessage: result.errorMessage };
  }
}
