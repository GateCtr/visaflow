/**
 * spain-http-scanner.ts — Scanner HTTP Espagne avec session navigateur préalable
 *
 * ARCHITECTURE :
 *   1. Obtient une session Cloudflare via Playwright par défaut
 *      (CapSolver reste un mode de compatibilité explicite)
 *   2. Charge la page widget citaconsular.es via impit pour extraire les params Bookitit
 *   3. Appelle les APIs JSONP Bookitit (getservices, getagendas, datetime) via impit
 *   4. Scanne en HTTP uniquement après établissement de la session
 *   5. Renouvelle la session navigateur quand le cookie expire
 *
 * Le navigateur n'est pas utilisé pour chaque scan, mais reste nécessaire pour
 * exécuter les scripts Cloudflare et établir une session authentique.
 *
 * PRÉREQUIS :
 *   - DECODO_PROXY_URL ou SOAX_PROXY_URL configuré
 *   - CAPSOLVER_API_KEY uniquement pour le mode de compatibilité explicite
 *   - SPAIN_SOAX_COUNTRY optionnel (défaut: "es")
 */

import {
  ensureSpainCfSession,
  spainCfFetch,
  invalidateSpainCfSession,
  isSpainCfSessionExpiringSoon,
  type SpainCfSession,
} from "./spain-soax-solver.js";
import {
  exploreAvailableSlots,
  type SlotExplorationResult,
} from "./spain-slot-explorer.js";
import type { ExtractedSlotInfo } from "./spain-http-booking.js";

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
  /** Raw HTML from /main/ when found — passed to auto-booking */
  _mainHtml?: string;
  /** Services returned by getservices/ after the widget's Aceptar step. */
  _services?: ExtractedSlotInfo[];
  /** Exact agendas + datetime/ result used to confirm availability. */
  _exploration?: SlotExplorationResult;
}

/**
 * Cloudflare présente le challenge interactif comme une page HTML, souvent
 * avec HTTP 403. Ce n'est pas une preuve que l'IP doit être changée :
 * l'utilisateur doit d'abord confirmer le challenge dans le navigateur.
 */
export function isCloudflareInteractiveChallenge(
  status: number,
  body: string,
): boolean {
  if (status !== 403) return false;
  return /just a moment|un instant|verifying you are human|challenge-platform|cdn-cgi\/challenge/i.test(
    body.slice(0, 12_000),
  );
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
    headers: {
      Referer: referer,
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
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

/**
 * Extrait les détails complets des services (ID + nom + durée) depuis le payload getservices/.
 * Utilisé pour le logging et le mapping visa → service.
 */
function extractServiceDetails(payload: unknown): Array<{ id: string; name: string; duration?: number }> {
  const results: Array<{ id: string; name: string; duration?: number }> = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          // Service-like object: has id + name/description
          const id = obj.id ?? obj.Id ?? obj.serviceId ?? obj.ServiceId ?? obj.idService ?? obj.IdService;
          const name = obj.name ?? obj.Name ?? obj.serviceName ?? obj.ServiceName
            ?? obj.description ?? obj.Description ?? obj.label ?? obj.Label;

          if (id && name) {
            results.push({
              id: String(id),
              name: String(name),
              duration: typeof obj.duration === "number" ? obj.duration
                : typeof obj.Duration === "number" ? obj.Duration
                : undefined,
            });
          } else {
            walk(item);
          }
        }
      }
    } else if (node && typeof node === "object") {
      for (const value of Object.values(node as Record<string, unknown>)) {
        if (value && typeof value === "object") walk(value);
      }
    }
  };

  walk(payload);
  return results;
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
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Upgrade-Insecure-Requests": "1",
    },
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

    try {
      const postRes = await spainCfFetch(postUrl, session, {
        method: "POST",
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "fr-FR,fr;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded",
          "Origin": "https://www.citaconsular.es",
          "Referer": portalUrl,
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
        },
        body: `token=${encodeURIComponent(token)}`,
      });

      if (!postRes) {
        console.warn(`[spain-http] ⚠️ POST retourné null — possible CF cookie expiré`);
        invalidateSpainCfSession();
        return null;
      }

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

  // ─── LOG DÉTAILLÉ: capturer les noms de services pour le mapping visa ───
  if (svcPayload && typeof svcPayload === "object") {
    const serviceDetails = extractServiceDetails(svcPayload);
    if (serviceDetails.length > 0) {
      console.log(`[spain-http] 📋 SERVICES BOOKITIT DÉTECTÉS :`);
      for (const svc of serviceDetails) {
        console.log(`[spain-http]    • "${svc.name}" → ID: ${svc.id}${svc.duration ? ` (${svc.duration}min)` : ""}`);
      }
    }
  }

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

// ─── Slot Confirmation via datetime/ API ────────────────────────────────────
//
// POURQUOI cette étape est obligatoire :
//   Après que l'utilisateur clique "Aceptar" sur le modal important,
//   le widget affiche la liste des services, dont "tramitacion de visas".
//   Ces liens #selectservice sont TOUJOURS présents dans /main/ après Aceptar,
//   même quand il n'y a aucun créneau disponible.
//   La disponibilité réelle se confirme UNIQUEMENT en appelant datetime/ pour
//   le service sélectionné : si datetime/ retourne des Slots avec times > 0 → créneau réel.

/**
 * Confirme la présence de créneaux réels via getagendas/ + datetime/.
 * Appelée quand le HTML de /main/ montre des services rendus (après Aceptar),
 * pour éviter les faux positifs.
 *
 * Flow : #selectservice links → getagendas/ → datetime/ (2 mois) → premier créneau
 */
async function confirmSlotsViaDatetime(
  session: SpainCfSession,
  renderedHtml: string,
  publickey: string,
  cookieStr: string,
  referer: string,
): Promise<{ serviceId: string; serviceName: string; date: string; time: string } | null> {
  const base = "https://www.citaconsular.es/onlinebookings/";
  const headers = {
    Cookie: cookieStr,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: referer,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Priority: "u=1, i",
  };

  // Extraire les services rendus (liens #selectservice hors templates)
  // ID peut être numérique (ex: 897578) ou préfixé bkt (ex: bkt897578) selon la version Bookitit.
  const svcMatches = [...renderedHtml.matchAll(/<a[^>]+href=['"]#selectservice\/([\w]+)['"][^>]*>([\s\S]*?)<\/a>/gi)];
  if (svcMatches.length === 0) {
    console.log("[spain-http] ⚠️ confirmSlotsViaDatetime: aucun #selectservice dans renderedHtml → not_found");
    return null;
  }

  const services = svcMatches.map((m) => {
    const serviceId = m[1];
    const inner = m[2];
    const nameM = inner.match(/clsBktServiceDataName[^>]*>([^<]+)/i) ?? inner.match(/>([^<]{5,})</);
    return { serviceId, serviceName: nameM?.[1]?.trim() ?? "Service" };
  });

  const cbBase = `cb${Date.now()}`;
  const now = new Date();
  const srvsrc = "https://www.citaconsular.es";

  for (const svc of services.slice(0, 3)) {
    console.log(`[spain-http] 🔍 Vérif datetime/ → "${svc.serviceName}" (ID: ${svc.serviceId})`);

    // 1. getagendas/ pour ce service
    // Params confirmés par capture Burp réelle Chrome 150 (portail Cuba 2026-07-27).
    // Universels Bookitit : services[] notation tableau, type, version, src, srvsrc requis.
    let agendaId = "";
    try {
      const agQ = new URLSearchParams();
      agQ.append("callback",       `${cbBase}ag`);
      agQ.append("type",           "default");
      agQ.append("publickey",      publickey);
      agQ.append("lang",           "es");
      agQ.append("version",        "4");
      agQ.append("src",            referer);
      agQ.append("srvsrc",         srvsrc);
      agQ.append("services[]",     svc.serviceId);
      agQ.append("selectedPeople", "1");
      agQ.append("_",              String(Date.now()));
      const agRes = await spainCfFetch(`${base}getagendas/?${agQ}`, session, { headers });
      if (agRes?.ok) {
        const agData = parseJsonpPayload(await agRes.text());
        const ids = collectIds(agData, /(agenda.*id|agendas.*id|^id$)/i);
        agendaId = ids[0] ?? "";
        if (agendaId) console.log(`[spain-http]    agenda: ${agendaId}`);
      }
    } catch { /* non-fatal */ }

    // 2. datetime/ sur 2 mois
    // Params confirmés par Burp : start/end (pas date_from/date_to), services[]/agendas[].
    for (let mo = 0; mo < 2; mo++) {
      const tgt   = new Date(now.getFullYear(), now.getMonth() + mo, 1);
      const start = tgt.toISOString().slice(0, 10);
      const end   = new Date(tgt.getFullYear(), tgt.getMonth() + 1, 0).toISOString().slice(0, 10);
      try {
        const dtQ = new URLSearchParams();
        dtQ.append("callback",       `${cbBase}dt${mo}`);
        dtQ.append("type",           "default");
        dtQ.append("publickey",      publickey);
        dtQ.append("lang",           "es");
        dtQ.append("version",        "4");
        dtQ.append("src",            referer);
        dtQ.append("srvsrc",         srvsrc);
        dtQ.append("services[]",     svc.serviceId);
        if (agendaId) dtQ.append("agendas[]", agendaId);
        dtQ.append("selectedPeople", "1");
        dtQ.append("start",          start);
        dtQ.append("end",            end);
        dtQ.append("_",              String(Date.now()));
        const dtRes = await spainCfFetch(`${base}datetime/?${dtQ}`, session, { headers });
        if (dtRes?.ok) {
          const slot = extractSlotFromBookititPayload(parseJsonpPayload(await dtRes.text()));
          if (slot) {
            console.log(`[spain-http] ✅ datetime/ CONFIRMÉ: ${slot.date} ${slot.time} — "${svc.serviceName}"`);
            return { serviceId: svc.serviceId, serviceName: svc.serviceName, date: slot.date, time: slot.time };
          }
        }
      } catch { /* non-fatal */ }
    }
    console.log(`[spain-http] ⛔ datetime/ vide pour "${svc.serviceName}" (${dateFrom(now)} → ${dateFrom(new Date(now.getFullYear(), now.getMonth() + 2, 0))})`);
  }
  return null;
}

function dateFrom(d: Date): string { return d.toISOString().slice(0, 10); }

/**
 * Scan rapide via /onlinebookings/main/ — le serveur pré-rend la disponibilité.
 *
 * DÉCOUVERTE CLÉ : citaconsular.es intègre le résultat de disponibilité directement
 * dans le HTML retourné par /onlinebookings/main/. Quand pas de créneaux :
 *   <div style='text-align: center;...'>No hay horas disponibles</div>
 * Quand créneaux dispo : ce message est en display:none et le calendrier est rendu.
 *
 * COOKIES (ordre confirmé par Burp 2026-06-25) :
 *   _ga=GA1.1.<clientId>.<ts>; _ga_F3TYSDL945=GS2.1.s<ts>...; PHPSESSID=<id>; cf_clearance=<token>
 *
 * Les appels JSD/RUM Cloudflare ne sont pas rejoués par ce scanner HTTP.
 * Le mode navigateur doit avoir établi cette partie de la session avant son
 * transfert au scanner.
 */
async function scanViaMainEndpoint(
  session: SpainCfSession,
  portalUrl: string,
): Promise<SpainHttpScanResult | null> {
  const t0 = Date.now();

  // Preserve the browser cookie jar when the session came from Playwright.
  // Never replace real browser cookies with generated Analytics values.
  const browserCookies = session.allCookies.filter((c) => c.name !== "cf_clearance");
  const sessionGa = browserCookies.find((c) => c.name === "_ga")?.value;
  if (session.source === "playwright") {
    console.log(
      `[spain-http] 🍪 Jar navigateur réutilisée: ${browserCookies.length} cookies` +
      `${sessionGa ? ` | _ga=${sessionGa.slice(0, 20)}…` : ""}`,
    );
  }

  // CapSolver compatibility mode is explicitly opt-in. Its session has no
  // browser jar, so keep a stable fallback profile rather than changing values
  // on every request.
  if (session.source !== "playwright" && !browserCookies.some((c) => c.name === "_ga")) {
    const seedBase = session.createdAt;
    browserCookies.push({
      name: "_ga",
      value: `GA1.1.${100_000_000 + (seedBase % 900_000_000)}.${Math.floor(seedBase / 1000) - 15 * 24 * 3600}`,
    });
  }
  if (session.source !== "playwright" && !browserCookies.some((c) => c.name === "_ga_F3TYSDL945")) {
    const sessionTs = String(Math.floor(session.createdAt / 1000));
    browserCookies.push({
      name: "_ga_F3TYSDL945",
      value: `GS2.1.s${sessionTs}$o1$g0$t${sessionTs}$j60$l0$h0`,
    });
  }

  // Current cf_clearance (may be updated by a browser-established session).
  let activeCfClearance = session.cfClearance;

  // PHPSESSID : pré-initialisé depuis session.allCookies si la session a été établie
  // via Playwright (solveSpainWidgetSession) — dans ce cas PHPSESSID est déjà valide
  // côté serveur et on n'a pas besoin d'attendre le Set-Cookie du GET entry.
  // Si le GET entry retourne un nouveau PHPSESSID, il sera mis à jour ci-dessous.
  let phpSessId =
    session.allCookies.find((c) => c.name === "PHPSESSID")?.value ?? "";
  if (phpSessId) {
    console.log(
      `[spain-http] 🍪 PHPSESSID pré-initialisé (session Playwright): ${phpSessId.slice(0, 12)}…`
    );
  }

  /**
   * Keep the browser cookie jar and place cf_clearance last, matching the
   * observed request order while retaining any other site cookies.
   */
  function buildCookieStr(): string {
    const preferredNames = ["_ga", "_ga_F3TYSDL945", "PHPSESSID"];
    const parts: string[] = [];
    for (const name of preferredNames) {
      const value = name === "PHPSESSID"
        ? phpSessId
        : browserCookies.find((c) => c.name === name)?.value;
      if (value) parts.push(`${name}=${value}`);
    }
    for (const cookie of browserCookies) {
      if (!preferredNames.includes(cookie.name)) {
        parts.push(`${cookie.name}=${cookie.value}`);
      }
    }
    if (activeCfClearance) parts.push(`cf_clearance=${activeCfClearance}`);
    return parts.join("; ");
  }

  /**
   * Fusionne les Set-Cookie du serveur dans la jar de cette exécution.
   * Les attributs de cookie (Path, Secure, Max-Age...) ne doivent jamais être
   * renvoyés dans l'en-tête Cookie : seule la paire name=value est conservée.
   */
  function mergeSetCookies(response: Response | null, source: string): void {
    for (const setCookie of response?.headers?.getSetCookie?.() ?? []) {
      const firstPart = setCookie.split(";", 1)[0] ?? "";
      const separator = firstPart.indexOf("=");
      if (separator <= 0) continue;

      const name = firstPart.slice(0, separator).trim();
      const value = firstPart.slice(separator + 1).trim();
      if (!name) continue;

      if (name === "cf_clearance") {
        if (value) {
          activeCfClearance = value;
          console.log(`[spain-http] 🔑 cf_clearance mis à jour depuis ${source}`);
        }
        continue;
      }

      const existingIndex = browserCookies.findIndex((cookie) => cookie.name === name);
      if (!value) {
        if (existingIndex >= 0) browserCookies.splice(existingIndex, 1);
        continue;
      }

      const cookie = { name, value };
      if (existingIndex >= 0) browserCookies[existingIndex] = cookie;
      else browserCookies.push(cookie);

      if (name === "PHPSESSID") {
        phpSessId = value;
        console.log(`[spain-http] 🍪 PHPSESSID mis à jour depuis ${source}: ${value.slice(0, 12)}…`);
      }
    }

    // Keep the shared session in sync as well. Other Bookitit helpers may use
    // spainCfFetch without this request-local Cookie override later in the
    // same scan cycle.
    session.allCookies = [
      ...browserCookies,
      ...(activeCfClearance ? [{ name: "cf_clearance", value: activeCfClearance }] : []),
    ];
    session.cfClearance = activeCfClearance;
  }

  // ─── Step 1: GET entry page → PHPSESSID + CSRF token ───────────────────
  // IMPORTANT: Use full Chrome header set — Cloudflare validates the fingerprint
  // Sec-Fetch-Site: none because it's a direct navigation (no Referer)
  //
  // skipPortalFlow: set to true when CF blocks the portal HTML page via impit
  // but the session already has a valid PHPSESSID from Playwright navigation.
  // In that case we skip Steps 1–2b entirely and call /main/ directly (the
  // Decodo ISP is trusted by CF for JSONP API endpoints).
  let skipPortalFlow = false;
  const entryRes = await spainCfFetch(portalUrl, session, {
    headers: {
      "Cookie": buildCookieStr(),
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      "Priority": "u=0, i",
    },
  });

  if (!entryRes) {
    console.warn("[spain-http] ⚠️ GET portail sans réponse (erreur réseau ou proxy)");
    invalidateSpainCfSession();
    return null;
  }

  const entryStatus = entryRes.status;
  const entryContentType = entryRes.headers.get("content-type") ?? "";
  const entryBody = await entryRes.clone().text();
  const entryTitle = entryBody.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
  const entryHasToken = /name=["']token["']/i.test(entryBody);
  const entryHasCfChallenge = /un instant|just a moment|verifying you are human|_cf_chl_opt/i.test(entryBody.slice(0, 5000));
  console.log(
    `[spain-http] GET portail → HTTP ${entryStatus} | ` +
    `type=${entryContentType.split(";")[0] || "unknown"} | bytes=${entryBody.length} | ` +
    `token=${entryHasToken ? "oui" : "non"} | cf-interstitiel=${entryHasCfChallenge ? "OUI ⚠️" : "non"} | ` +
    `title="${entryTitle.slice(0, 100)}"`,
  );

  if (isCloudflareInteractiveChallenge(entryStatus, entryBody)) {
    // ── Playwright fast-path bypass ──────────────────────────────────────
    // The portal HTML page (/es/hosteds/widgetdefault/...) has a stricter CF
    // rule than the JSONP API (/onlinebookings/main/).  impit satisfies the
    // JSONP endpoint with a valid cf_clearance but CF rejects the HTML page
    // navigation even with the same cookie.
    //
    // When the session was established by the persistent browser (Puppeteer),
    // the browser already navigated the portal and set a fresh server-side
    // PHPSESSID in /main/.  We can skip Steps 1-2b entirely and call /main/
    // directly — CF trusts the Decodo ISP for JSONP endpoints.
    if (session.source === "playwright" && phpSessId) {
      console.log(
        `[spain-http] ⏩ CF 403 portail (impit) — session Playwright avec PHPSESSID ` +
        `pré-initialisé → skipPortalFlow=true, appel /main/ direct`,
      );
      skipPortalFlow = true;
    } else {
      invalidateSpainCfSession();
      console.warn(
        "[spain-http] ⏸️ Challenge Cloudflare interactif détecté (HTTP 403 + " +
        "\"Just a moment\") — aucune rotation proxy; résolution humaine requise",
      );
      return {
        status: "cf_blocked",
        errorMessage:
          "Challenge Cloudflare interactif en attente de résolution humaine; " +
          "la session n'est pas réutilisée tant que le JSD Oneshot n'est pas capturé.",
        scanDurationMs: Date.now() - t0,
      };
    }
  }

  if (!skipPortalFlow) {
    if (entryStatus === 403) {
      invalidateSpainCfSession();
      console.warn("[spain-http] ⚠️ HTTP 403 sans page challenge → session invalidée");
      return null;
    }

    // Capture every server-side cookie before constructing the next request.
    mergeSetCookies(entryRes, "GET portail");
    if (phpSessId) {
      console.log(`[spain-http] 🍪 PHPSESSID capturé: ${phpSessId.slice(0, 12)}…`);
    }
  }

  const entryHtml = skipPortalFlow ? "" : entryBody;

  if (!skipPortalFlow) {
    // Check CF challenge in HTML body (HTTP 200 but CF interstitial)
    // NOTE: ne PAS inclure "challenge-platform" ici — l'URL du script JSD Oneshot
    // (/cdn-cgi/challenge-platform/.../jsd/oneshot/...) est présente dans le HTML
    // du vrai widget (HTTP 200). Seuls les textes d'interstitiel CF réels sont des
    // marqueurs fiables en cas de 200.
    if (/un instant|just a moment|verifying you are human/i.test(entryHtml.slice(0, 12_000))) {
      invalidateSpainCfSession();
      console.warn(
        "[spain-http] ⏸️ Challenge Cloudflare interactif détecté dans le HTML — " +
        "aucune rotation proxy; résolution humaine requise",
      );
      return {
        status: "cf_blocked",
        errorMessage:
          "Challenge Cloudflare interactif en attente de résolution humaine; " +
          "JSD Oneshot requis avant reprise.",
        scanDurationMs: Date.now() - t0,
      };
    }
  }

  // ─── Extract token for POST (with structural monitoring) ──────────────
  // The entry page must contain a <form method="POST"> with a hidden input name="token".
  // If the structure changes (CF update, site redesign), this is the breakpoint.
  // We use multiple extraction strategies and report anomalies.
  // Skipped entirely when skipPortalFlow=true (no entry HTML was fetched).

  const tokenMatch = skipPortalFlow ? null
    : (entryHtml.match(/name="token"\s+value="([^"]+)"/)
    ?? entryHtml.match(/<input[^>]+name=["']token["'][^>]+value=["']([^"']+)["']/i)
    ?? entryHtml.match(/<input[^>]+value=["']([a-f0-9]{20,})["'][^>]+name=["']token["']/i));

  if (!skipPortalFlow) {
    // ─── "Already on widget SPA" fast path ──────────────────────────────
    // When the persistent-browser session carries a valid PHPSESSID, Bookitit
    // skips the "Continue/Continuar" intermediary page and serves the widget
    // SPA directly on the GET — so there is no CSRF token form. Detect this
    // by looking for Bookitit widget markers in the entry response (and the
    // absence of a real CF challenge).
    const entryIsWidgetSpa =
      !entryHasCfChallenge &&
      (/bkt_init_widget|idBktWidget|onlinebookings/i.test(entryHtml) ||
       /BOOKITIT/i.test(entryTitle));

    if (!tokenMatch) {
      if (entryIsWidgetSpa) {
        console.log(
          `[spain-http] ✅ Portail déjà en mode widget SPA (PHPSESSID valide) — ` +
          `POST Continue ignoré, JSD Oneshot analysé depuis le GET entry`,
        );
      } else {
        // ─── STRUCTURAL ANOMALY DETECTION ────────────────────────────────
        // The token is missing and we are not on the widget SPA. Diagnose WHY.
        const hasForm = /<form[^>]*method=["']POST["']/i.test(entryHtml);
        const hasAnyHiddenInput = /<input[^>]+type=["']hidden["']/i.test(entryHtml);
        const hiddenInputNames = [...entryHtml.matchAll(/<input[^>]+type=["']hidden["'][^>]+name=["']([^"']+)["']/gi)].map(m => m[1]);
        const hasButton = /idCaptchaButton|[Cc]ontinue|[Cc]ontinuar/i.test(entryHtml);
        const pageTitle = entryHtml.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "unknown";
        const bodyPreview = entryHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);

        console.error(`[spain-http] 🚨 ALERTE STRUCTURELLE — Token CSRF non trouvé !`);
        console.error(`[spain-http]    Page title: "${pageTitle}"`);
        console.error(`[spain-http]    Has <form POST>: ${hasForm}`);
        console.error(`[spain-http]    Has hidden inputs: ${hasAnyHiddenInput} (names: ${hiddenInputNames.join(", ") || "none"})`);
        console.error(`[spain-http]    Has Continue button: ${hasButton}`);
        console.error(`[spain-http]    Body preview: ${bodyPreview}`);
        console.error(`[spain-http]    → Le formulaire d'entrée a peut-être changé de structure`);
        console.error(`[spain-http]    → Vérifier: nouveau nom de champ? Token généré par JS? Nouveau challenge?`);

        // Report the structural change via scan result (will trigger admin email)
        return {
          status: "error" as const,
          errorMessage: `ALERTE STRUCTURELLE: Token CSRF absent. Form=${hasForm}, HiddenInputs=${hiddenInputNames.join(",") || "none"}, Title="${pageTitle}". La page d'entrée citaconsular a peut-être changé.`,
          scanDurationMs: Date.now() - t0,
        };
      }
    }
  }

  // ─── Step 2: POST Continue (Burp row 15) ─────────────────────────────
  // Skipped when already on widget SPA (entryIsWidgetSpa path above).
  // Skipped entirely when skipPortalFlow=true (portal GET was CF-blocked).
  const widgetReferer = portalUrl.replace(/\/?$/, "/");
  let widgetHtml1: string;

  if (!skipPortalFlow && tokenMatch) {
    // Cache-Control: max-age=0 + Priority: u=0, i confirmés par Burp
    const postRes = await spainCfFetch(widgetReferer, session, {
      method: "POST",
      headers: {
        "Cookie": buildCookieStr(),
        "Cache-Control": "max-age=0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://www.citaconsular.es",
        "Referer": portalUrl,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        "Priority": "u=0, i",
      },
      body: `token=${encodeURIComponent(tokenMatch[1])}`,
    });

    // Monitor POST response for structural changes
    if (postRes && postRes.status !== 200) {
      console.warn(`[spain-http] ⚠️ POST Continue status ${postRes.status} (attendu: 200) — possible changement serveur`);
    }

    // Read the widget HTML — needed to extract the JSD oneshot URL embedded by CF.
    widgetHtml1 = postRes ? await postRes.text() : "";

    // Capture every cookie returned by the widget POST before JSONP requests.
    mergeSetCookies(postRes, "POST widget");

    const widgetTitle = widgetHtml1.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
    const widgetHasBkt = /bkt_init_widget|idBktWidget|onlinebookings/i.test(widgetHtml1);
    const widgetHasCfChallenge = /un instant|just a moment|verifying you are human|_cf_chl_opt/i.test(widgetHtml1.slice(0, 3000));
    const widgetBodyPreview = widgetHtml1.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    console.log(
      `[spain-http] 📄 POST widget → HTTP ${postRes?.status ?? "no response"} | ` +
      `bytes=${widgetHtml1.length} | title="${widgetTitle.slice(0, 100)}" | ` +
      `bkt=${widgetHasBkt ? "oui" : "non"} | cf-interstitiel=${widgetHasCfChallenge ? "OUI ⚠️" : "non"}`,
    );
    console.log(`[spain-http] 📄 POST widget body preview: ${widgetBodyPreview}`);
    if (!postRes || !postRes.ok || widgetHtml1.length === 0) {
      console.warn("[spain-http] ⚠️ POST widget sans réponse HTML exploitable");
      return null;
    }
  } else {
    // Two cases:
    //  a) skipPortalFlow=true  → portal was CF-blocked; widgetHtml1="" so that
    //     jsdOneshotPathMatch returns null and Step 2b is skipped automatically.
    //  b) Already on widget SPA → the GET entry page IS the widget HTML
    //     (mergeSetCookies(entryRes) was already called above).
    widgetHtml1 = entryHtml; // "" for skipPortalFlow, entryHtml for widget-SPA
    if (skipPortalFlow) {
      console.log(`[spain-http] ⏩ skipPortalFlow — widgetHtml1 vide, JSD Oneshot ignoré, /main/ direct`);
    } else {
      console.log(`[spain-http] 📄 Widget SPA direct (GET entry) | bytes=${widgetHtml1.length}`);
    }
  }

  // ─── Step 2b: JSD Oneshot (Burp row 22) ─────────────────────────────────────
  // When Cloudflare challenges the configured proxy IP (non-trusted ISP), it
  // embeds a one-time JSD oneshot URL in the first widget POST response. The
  // browser fires a POST to this URL ~5s after the page loads; without it,
  // Bookitit's /main/ endpoint returns an empty body (HTTP 200, 0 bytes).
  //
  // We cannot reproduce the exact JS-computed telemetry body, but a best-effort
  // POST (empty body) is sufficient for CF to issue cf_clearance #2 in most
  // cases. We capture the updated cf_clearance and proceed.
  //
  // Previously Decodo ISP was trusted (no CF challenge), so this step was never
  // reached. Now that CF challenges Decodo, this step is mandatory.
  const jsdOneshotPathMatch = widgetHtml1.match(
    /\/cdn-cgi\/challenge-platform\/h\/b\/jsd\/oneshot\/[a-f0-9]{10,14}\/[^'"<\s]{10,}\/[a-f0-9]{14,18}/,
  );

  if (jsdOneshotPathMatch) {
    const jsdUrl = `https://www.citaconsular.es${jsdOneshotPathMatch[0]}`;
    console.log(`[spain-http] 🔑 JSD Oneshot → POST best-effort: ${jsdOneshotPathMatch[0].slice(0, 80)}`);
    try {
      // ~5s delay observed in real Chrome traffic (row 21 RUM ping + small gap)
      await new Promise<void>((r) => setTimeout(r, 4_500 + Math.floor(Math.random() * 1_000)));
      const jsdRes = await spainCfFetch(jsdUrl, session, {
        method: "POST",
        headers: {
          "Cookie": buildCookieStr(),
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": "0",
          "Origin": "https://www.citaconsular.es",
          "Referer": widgetReferer,
          "Accept": "*/*",
          "Accept-Language": "fr-FR,fr;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          "Priority": "u=1, i",
        },
        body: "",
      });
      mergeSetCookies(jsdRes, "JSD oneshot");
      console.log(`[spain-http] ✅ JSD Oneshot → HTTP ${jsdRes?.status ?? "no response"}`);
    } catch (err) {
      console.warn(
        `[spain-http] ⚠️ JSD Oneshot POST échoué (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
    }

    // ─── Step 2c: Second widget POST (Burp row 23) ───────────────────────────
    // After JSD oneshot, the browser re-POSTs the widget with the same token
    // and the updated cf_clearance. This is required for /main/ to return content.
    // Skipped in the "already on widget SPA" path (no CSRF token available).
    if (tokenMatch) {
      const postRes2 = await spainCfFetch(widgetReferer, session, {
        method: "POST",
        headers: {
          "Cookie": buildCookieStr(),
          "Cache-Control": "max-age=0",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "Accept-Language": "fr-FR,fr;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Content-Type": "application/x-www-form-urlencoded",
          "Origin": "https://www.citaconsular.es",
          "Referer": portalUrl,
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
          "Priority": "u=0, i",
        },
        body: `token=${encodeURIComponent(tokenMatch[1])}`,
      });
      mergeSetCookies(postRes2, "POST widget #2");
      const w2bytes = postRes2 ? (await postRes2.clone().text()).length : 0;
      console.log(
        `[spain-http] 📄 POST widget #2 → HTTP ${postRes2?.status ?? "no response"} | bytes=${w2bytes}`,
      );
    } else {
      console.log(`[spain-http] ℹ️ POST widget #2 ignoré (widget SPA direct — pas de token CSRF)`);
    }
  } else {
    // No JSD oneshot URL in widget HTML: either CF trusts this IP (direct path)
    // or the HTML structure changed. Log so we can diagnose.
    console.log(`[spain-http] ℹ️ JSD Oneshot absent du HTML widget — IP probablement de confiance CF`);
  }

  // ─── Step 3: JSONP calls (Bookitit) ─────────────────────────────────
  // Le vrai navigateur fire main/ puis getwidgetconfigurations/ + getservices/ ~3s plus tard
  // (via GTM callback). même cbName jQuery, _ incrémenté de 1ms par endpoint.
  const tWidget = Date.now();
  const cbName = `jQuery21109${tWidget}_${Math.floor(Math.random() * 1e9)}`;

  // Extract publickey from portalUrl (override le defaut)
  const pkMatch = portalUrl.match(/\/([a-f0-9]{30,})(?:\/|$)/);
  const publickey = pkMatch?.[1] ?? "25028fcd7126544630b8da0c6e60722b5";
  const referer = widgetReferer;
  const srvsrc = "https://www.citaconsular.es";
  const baseBookititUrl = "https://www.citaconsular.es/onlinebookings/";

  const jsonpHeaders = {
    "Cookie": buildCookieStr(),
    "Referer": referer,
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Priority": "u=1, i",
  };

  const mainParams = new URLSearchParams({
    callback: cbName,
    type: "default",
    publickey,
    lang: "es",
    version: "4",
    src: referer,
    _: String(tWidget),
  });

  const companionParams = new URLSearchParams({
    callback: cbName,
    type: "default",
    publickey,
    lang: "es",
    version: "4",
    src: referer,
    srvsrc,
    _: String(tWidget + 1),
  });

  const servicesParams = new URLSearchParams({
    callback: cbName,
    type: "default",
    publickey,
    lang: "es",
    version: "4",
    src: referer,
    srvsrc,
    _: String(tWidget + 2),
  });

  // Séquence applicative observée :
  //   main/                → t+0      (response immédiate, détection depuis ce body)
  //   GTM script load      → t+2914ms (déclencheur des companions)
  //   getwidgetconfs/      → t+3046ms (132ms après GTM — callback GTM)
  //   getservices/         → t+3633ms (9ms après getwidgetconfs — same callback)
  // Les companions NE SONT PAS simultanées avec main/ — elles arrivent ~3s plus tard
  // via le callback Google Tag Manager. On les fire en fire-and-forget avec le bon délai.
  const mainRes = await spainCfFetch(`${baseBookititUrl}main/?${mainParams}`, session, { headers: jsonpHeaders });

  // Fire companions after the main response. These are application JSONP
  // calls; no synthetic Cloudflare telemetry is generated.
  void (async () => {
    await new Promise<void>((r) => setTimeout(r, 2800 + Math.floor(Math.random() * 800)));
    const tNow = Date.now();
    const wcfgParams = new URLSearchParams({ ...Object.fromEntries(companionParams), _: String(tNow) });
    const svcParams  = new URLSearchParams({ ...Object.fromEntries(servicesParams),  _: String(tNow + 9) });
    await Promise.all([
      spainCfFetch(`${baseBookititUrl}getwidgetconfigurations/?${wcfgParams}`, session, { headers: jsonpHeaders }).catch(() => null),
      spainCfFetch(`${baseBookititUrl}getservices/?${svcParams}`, session, { headers: jsonpHeaders }).catch(() => null),
    ]);
  })();

  const mainStatus = mainRes?.status ?? null;
  const mainContentType = mainRes?.headers.get("content-type") ?? "";
  const mainContentLength = mainRes?.headers.get("content-length") ?? "";
  const mainCfRay = mainRes?.headers.get("cf-ray") ?? "";
  const mainLocation = mainRes?.headers.get("location") ?? "";
  const mainResponseUrl = mainRes?.url ?? "";
  let mainBody = "";
  let mainBodyReadError = "";
  if (mainRes) {
    try {
      mainBody = await mainRes.text();
    } catch (error) {
      mainBodyReadError = error instanceof Error ? error.message : String(error);
    }
  }
  const rawPreview = mainBody
    ? mainBody.replace(/\s+/g, " ").slice(0, 240)
    : "<empty body>";

  if (!mainRes || mainStatus !== 200) {
    console.warn(
      `[spain-http] ⚠️ /onlinebookings/main/ réponse réelle: ` +
      `status=${mainStatus ?? "no response"} rawChars=${mainBody.length} ` +
      `type=${mainContentType.split(";")[0] || "unknown"} ` +
      `contentLength=${mainContentLength || "absent"} ` +
      `cfRay=${mainCfRay || "absent"} ` +
      `location=${mainLocation || "absent"} ` +
      `bodyReadError=${mainBodyReadError || "none"} ` +
      `url=${mainResponseUrl || "unknown"} preview="${rawPreview}"`,
    );
    return null;
  }

  // Parse JSONP → HTML
  const jsonpMatch = mainBody.match(/^[^(]+\("(.*)"\);?$/s);
  let html: string;
  if (jsonpMatch) {
    try { html = JSON.parse(`"${jsonpMatch[1]}"`); } catch { html = mainBody; }
  } else {
    html = mainBody;
  }

  // ─── STRUCTURAL MONITORING: /main/ response ────────────────────────────
  // Monitor that the response is valid and contains expected landmarks

  // Cas body vide (HTTP 200, 0 chars) : le JSD Cloudflare "oneshot" n'a pas été
  // complété — CapSolver fournit uniquement cf_clearance, pas l'état JSD.
  // Ce n'est PAS un blocage IP → ne pas rôter le proxy.
  // On invalide la session pour forcer un nouveau solve au prochain cycle.
  if (mainBody.length === 0) {
    console.warn(
      `[spain-http] ⚠️ /main/ body vide (HTTP 200, cf-ray: ${mainCfRay || "absent"}) ` +
      `→ JSD oneshot non complété — session invalidée (retry sans rotation proxy)`,
    );
    invalidateSpainCfSession();
    return null; // déclenche le retry dans scanSpainHttp, sans rotation proxy
  }

  if (html.length < 1000) {
    console.error(
      `[spain-http] 🚨 /main/ réponse courte: ` +
      `status=${mainStatus} rawChars=${mainBody.length} decodedChars=${html.length} ` +
      `type=${mainContentType.split(";")[0] || "unknown"} ` +
      `contentLength=${mainContentLength || "absent"} ` +
      `cfRay=${mainCfRay || "absent"} ` +
      `bodyReadError=${mainBodyReadError || "none"} ` +
      `url=${mainResponseUrl || "unknown"} preview="${rawPreview}"`,
    );
    return {
      status: "error" as const,
      errorMessage:
        `ALERTE: /onlinebookings/main/ décodé à ${html.length} chars ` +
        `(brut: ${mainBody.length}, HTTP ${mainStatus}, type: ${mainContentType.split(";")[0] || "inconnu"}, ` +
        `cf-ray: ${mainCfRay || "absent"}, ` +
        `lecture: ${mainBodyReadError || "OK"}, aperçu: ${rawPreview.slice(0, 160)})`,
      scanDurationMs: Date.now() - t0,
    };
  }

  const hasWidgetBody = /idBktWidgetDefaultBodyContainer|idDivBktServicesContainer/i.test(html);
  if (!hasWidgetBody) {
    console.error(`[spain-http] 🚨 /main/ ne contient pas les landmarks attendus (idBktWidgetDefaultBodyContainer)`);
    console.error(`[spain-http]    Preview: ${html.slice(0, 500)}`);
    return {
      status: "error" as const,
      errorMessage: `ALERTE: /onlinebookings/main/ structure HTML inattendue (pas de idBktWidgetDefaultBodyContainer). Le widget Bookitit a peut-être changé.`,
      scanDurationMs: Date.now() - t0,
    };
  }

  console.log(`[spain-http] 📊 /main/ retourné ${html.length} chars`);

  // Supprimer les templates Underscore.js — utilisé dans toute la détection
  const renderedHtml = html.replace(/<script\s+type=['"]text\/template['"][^>]*>[\s\S]*?<\/script>/gi, "");

  // ─── DÉTECTION DE DISPONIBILITÉ ──────────────────────────────────────────
  //
  // Flux UI réel observé :
  //   1. /main/ charge → modal "Important / Aceptar" affiché
  //   2. Utilisateur clique Aceptar → liste des services apparaît
  //      (dont "tramitacion de visas" → lien #selectservice/ID)
  //   3. Utilisateur clique sur le service → datetime/ appelé → créneaux affichés
  //
  // Conséquence : les liens #selectservice dans /main/ signifient UNIQUEMENT que
  // l'étape Aceptar est passée — PAS que des créneaux existent.
  // Un appel datetime/ est OBLIGATOIRE pour confirmer la disponibilité réelle.
  //
  // Signal négatif fiable (pas de datetime/ nécessaire) :
  //   → div "No hay horas disponibles" VISIBLE (display sans none en début de style)
  // ─────────────────────────────────────────────────────────────────────────

  const VISIBLE_NO_SLOTS_RE = /<div\s+style='text-align:\s*center;[^']*'[^>]*>\s*No hay horas disponibles/i;
  const HIDDEN_NO_SLOTS_RE  = /<div\s+style='display:\s*none;[^']*'[^>]*>\s*No hay horas disponibles/i;

  const hasVisibleNoSlots = VISIBLE_NO_SLOTS_RE.test(html);
  const hasHiddenNoSlots  = HIDDEN_NO_SLOTS_RE.test(html);

  // Signal négatif fiable → pas besoin d'appel API
  if (hasVisibleNoSlots) {
    console.log(`[spain-http] 📋 "No hay horas disponibles" VISIBLE → pas de créneau`);
    return { status: "not_found", scanDurationMs: Date.now() - t0 };
  }

  // ─── Tous les signaux positifs passent par confirmSlotsViaDatetime ────────
  //   → Seule réponse datetime/ avec des Slots réels = "found"

  // Cas 1 : "No hay horas" masquée + services rendus (après Aceptar)
  if (hasHiddenNoSlots && !hasVisibleNoSlots) {
    const hasServices = /#selectservice\/\d+/i.test(renderedHtml);
    if (!hasServices) {
      console.log(`[spain-http] ⚠️ "No hay horas" masquée MAIS 0 service rendu → not_found`);
      return { status: "not_found", scanDurationMs: Date.now() - t0 };
    }
    console.log(`[spain-http] 🔍 "No hay horas" masquée + services visibles — vérification datetime/…`);
    const confirmed = await confirmSlotsViaDatetime(session, renderedHtml, publickey, buildCookieStr(), referer);
    if (!confirmed) {
      console.log(`[spain-http] ⛔ "tramitacion de visas" présent MAIS datetime/ vide → pas de créneau réel`);
      return { status: "not_found", scanDurationMs: Date.now() - t0 };
    }
    return {
      status: "found",
      slotInfo: `Créneau confirmé via datetime/: ${confirmed.date} ${confirmed.time} — "${confirmed.serviceName}"`,
      slot: { date: confirmed.date, time: confirmed.time, location: confirmed.serviceName },
      scanDurationMs: Date.now() - t0,
      _mainHtml: html,
    };
  }

  // Cas 2 : Liens #selectservice ou containers de service rendus (hors templates)
  const hasRenderedServices = /#selectservice\/\d+/i.test(renderedHtml);
  const hasRenderedServiceContainers = /clsBktServiceDataContainer\s+clsBktServiceAtt/i.test(renderedHtml);

  if (hasRenderedServices || hasRenderedServiceContainers) {
    console.log(`[spain-http] 🔍 Services RENDUS (hors template) — vérification datetime/…`);
    const confirmed = await confirmSlotsViaDatetime(session, renderedHtml, publickey, buildCookieStr(), referer);
    if (!confirmed) {
      console.log(`[spain-http] ⛔ Services rendus MAIS datetime/ vide → pas de créneau réel`);
      return { status: "not_found", scanDurationMs: Date.now() - t0 };
    }
    return {
      status: "found",
      slotInfo: `Créneau confirmé via datetime/: ${confirmed.date} ${confirmed.time} — "${confirmed.serviceName}"`,
      slot: { date: confirmed.date, time: confirmed.time, location: confirmed.serviceName },
      scanDurationMs: Date.now() - t0,
      _mainHtml: html,
    };
  }

  // Cas 3 : #idListServices non-vide
  const listServicesMatch = renderedHtml.match(/id=['"]?idListServices['"]?[^>]*>([\s\S]*?)<\/div>/i);
  if (listServicesMatch && listServicesMatch[1].trim().length > 10) {
    console.log(`[spain-http] 🔍 #idListServices non-vide — vérification datetime/…`);
    const confirmed = await confirmSlotsViaDatetime(session, renderedHtml, publickey, buildCookieStr(), referer);
    if (!confirmed) {
      return { status: "not_found", scanDurationMs: Date.now() - t0 };
    }
    return {
      status: "found",
      slotInfo: `Créneau confirmé via datetime/: ${confirmed.date} ${confirmed.time} — "${confirmed.serviceName}"`,
      slot: { date: confirmed.date, time: confirmed.time, location: confirmed.serviceName },
      scanDurationMs: Date.now() - t0,
      _mainHtml: html,
    };
  }

  // Cas 4 : Calendrier datetime directement rendu (cas rare — l'utilisateur est déjà sur le picker)
  const hasRenderedDatetime = /clsDivDatetimeSlot|clsDivBktDatetime|type=['"]radio['"][^>]*name=['"]datetime/i.test(renderedHtml);
  if (hasRenderedDatetime) {
    console.log(`[spain-http] 🎉 Créneaux datetime RENDUS directement dans le HTML (calendrier visible)`);
    return {
      status: "found",
      slotInfo: "Créneau détecté via /main/ HTML (datetime slots rendus — calendrier visible)",
      scanDurationMs: Date.now() - t0,
      _mainHtml: html,
    };
  }

  // Cas 5 : Absence de "No hay horas" dans le container services
  const servicesContainer = renderedHtml.match(/id=['"]?idDivBktServicesContainer['"]?[^>]*>([\s\S]*?)(?=<div\s+id=['"]?idBktDefault)/i);
  const containerHtml = servicesContainer?.[1] ?? "";
  const hasNoHorasInContainer = /No hay horas disponibles/i.test(containerHtml);
  if (!hasNoHorasInContainer && containerHtml.length > 100) {
    console.log(`[spain-http] 🔍 Pas de "No hay horas" dans le container — vérification datetime/…`);
    const confirmed = await confirmSlotsViaDatetime(session, renderedHtml, publickey, buildCookieStr(), referer);
    if (!confirmed) {
      return { status: "not_found", scanDurationMs: Date.now() - t0 };
    }
    return {
      status: "found",
      slotInfo: `Créneau confirmé via datetime/: ${confirmed.date} ${confirmed.time} — "${confirmed.serviceName}"`,
      slot: { date: confirmed.date, time: confirmed.time, location: confirmed.serviceName },
      scanDurationMs: Date.now() - t0,
      _mainHtml: html,
    };
  }

  console.log(`[spain-http] 📋 Pas de signal positif → not_found`);
  return { status: "not_found", scanDurationMs: Date.now() - t0 };
}

/**
 * Effectue un scan HTTP-only des créneaux Espagne.
 *
 * Flow HTTP après établissement de session :
 *   1. ensureSpainCfSession() → obtient/réutilise la session navigateur
 *   2. GET portal → POST Continue → GET /onlinebookings/main/
 *   3. Parse le HTML retourné pour détecter "No hay horas disponibles"
 *   4. Si pas de "No hay horas" visible → créneaux potentiels !
 *
 * Les appels Cloudflare restent exécutés par le navigateur lors du bootstrap ;
 * ce scanner ne rejoue que les requêtes applicatives Bookitit observées.
 *
 * @param portalUrl - URL du widget citaconsular.es
 */
export async function scanSpainHttp(portalUrl: string): Promise<SpainHttpScanResult> {
  const t0 = Date.now();

  // 1. Obtenir la session CF (solve si nécessaire)
  let session = await ensureSpainCfSession(portalUrl);
  if (!session) {
    return {
      status: "cf_blocked",
      errorMessage: "Impossible d'obtenir le cookie CF (SOAX ou CapSolver indisponible)",
      scanDurationMs: Date.now() - t0,
    };
  }

  // 2. Scan via /onlinebookings/main/ (méthode optimisée — 1 seul appel)
  let mainResult = await scanViaMainEndpoint(session, portalUrl);
  if (!mainResult) {
    // Après invalidation, une nouvelle session navigateur est demandée avec
    // le même proxy, puis le scan est rejoué une seule fois.
    console.warn("[spain-http] ♻️ Premier scan refusé — renouvellement de session CF puis retry unique");
    session = await ensureSpainCfSession(portalUrl);
    if (session) {
      mainResult = await scanViaMainEndpoint(session, portalUrl);
    }
  }
  if (mainResult) {
    return mainResult;
  }

  // 3. Les deux tentatives ont échoué.
  // Si c'était un vrai blocage CF (403 / challenge), la rotation a déjà été
  // déclenchée dans scanViaMainEndpoint au moment de la détection.
  // Si c'était un body vide (JSD manquant), la session a été invalidée — pas de rotation.
  return {
    status: "error",
    errorMessage: "Scan /main/ échoué après retry (session invalidée pour le prochain cycle)",
    scanDurationMs: Date.now() - t0,
  };
}

/**
 * Variante probe pour le watcher (compatible avec SpainWatcherProbeResult).
 * Drop-in replacement pour runSpainWatcherProbe() quand SPAIN_HTTP_MODE=1.
 *
 * STRATÉGIE :
 *   - Une session navigateur doit d'abord établir l'état Cloudflare.
 *   - Les scans suivants utilisent HTTP avec cette même session et ce même proxy.
 *     → Retourne "error" pour que la boucle fallback sur Playwright
 *
 * L'avantage principal : une fois la session navigateur établie, les scans
 * suivants sont HTTP avec la même jar de cookies et le même proxy.
 */
export async function runSpainHttpProbe(portalUrl: string): Promise<{
  status: "found" | "not_found" | "error";
  slotInfo?: string;
  screenshotBase64?: string;
  errorMessage?: string;
  /** Raw HTML from /main/ when status=found (used for auto-booking extraction) */
  _mainHtml?: string;
}> {
  const result = await scanSpainHttp(portalUrl);

  switch (result.status) {
    case "found":
      return { status: "found", slotInfo: result.slotInfo, _mainHtml: result._mainHtml };
    case "not_found":
      return { status: "not_found" };
    case "cf_blocked":
    case "session_expired":
    case "error":
      return { status: "error", errorMessage: result.errorMessage };
  }
}
