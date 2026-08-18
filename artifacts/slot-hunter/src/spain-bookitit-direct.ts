/**
 * spain-bookitit-direct.ts
 *
 * Expose les mêmes fonctions que test-bookitit-dynamic.ts sous forme exportable.
 *
 * Règle fondamentale : on appelle toujours impit.fetch() DIRECTEMENT avec le
 * même jar + callback que le dynamic test — jamais via callBookititEndpoint /
 * spainCfFetch qui introduisent des différences de headers causant 0B.
 *
 * Usage :
 *   const ds = buildDynamicSession(session);
 *   const cfg  = await callDirect(ds, "getwidgetconfigurations/");
 *   const svcs = await callDirect(ds, "getservices/");
 *   const ags  = await callDirect(ds, "getagendas/", { "services[]": svcId, selectedPeople: "1" });
 *   const dt   = await callDirect(ds, "datetime/",   { "services[]": svcId, "agendas[]": agId, start, end, selectedPeople });
 */

import type { SpainCfSession } from "./spain-soax-solver.js";
import { Impit } from "impit";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DynamicSession {
  /** Instance impit partagée — la même que dans initWorkerSession */
  impit: InstanceType<typeof Impit>;
  /** Cookie jar : toutes les paires name/value (cf_clearance, PHPSESSID, _ga…) */
  jar: Record<string, string>;
  /** User-Agent Chrome utilisé pour toute la session */
  userAgent: string;
  /** jQuery callback fixé pour la durée de la session */
  jqCallback: string;
  /** Compteur de requêtes (incrémenté par makeUrl) */
  reqCounter: number;
  /** publickey extraite de l'URL du portail */
  publickey: string;
  /** Version du loader Bookitit (ex : "4") */
  version: string;
  /** URL du portail (src Bookitit) — avec trailing slash */
  widgetUrl: string;
  /** srvsrc retourné par POST token */
  srvsrc: string;
  /** Base des endpoints Bookitit (ex : "https://www.citaconsular.es/onlinebookings") */
  bookititBase: string;
}

// ─── Constructeur ─────────────────────────────────────────────────────────────

/**
 * Construit un DynamicSession à partir d'un SpainCfSession établi par initWorkerSession.
 *
 * Toute la session PHP doit avoir été initialisée par initWorkerSession avant cet appel :
 *   probe → CF solve → GET portail → POST token → GET /main/
 */
export function buildDynamicSession(session: SpainCfSession): DynamicSession | null {
  const state = session.bookititState;
  const impit = session._ownImpit;

  if (!state || !impit) {
    console.warn("[bookitit-direct] buildDynamicSession: bookititState ou _ownImpit absent");
    return null;
  }

  // Construire le jar depuis session.allCookies (même ordre que le dynamic test)
  const jar: Record<string, string> = {};
  for (const c of session.allCookies) {
    jar[c.name] = c.value;
  }
  // cf_clearance vient de session.cfClearance (source de vérité)
  if (session.cfClearance) jar["cf_clearance"] = session.cfClearance;

  return {
    impit,
    jar,
    userAgent: session.userAgent,
    jqCallback: state.jqCallback,
    reqCounter: state.reqCounter,
    publickey: state.publickey,
    version: state.version,
    widgetUrl: state.widgetUrl,
    srvsrc: state.srvsrc,
    bookititBase: state.bookititBase,
  };
}

// ─── Helpers internes (identiques au dynamic test) ────────────────────────────

function buildCookieString(jar: Record<string, string>): string {
  return Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * Construit l'URL JSONP Bookitit.
 *
 * Ordre des paramètres : callback → type → publickey → lang →
 *   [services[]] → [agendas[]] → version → src → srvsrc →
 *   [autres extra] → _
 *
 * Bookitit peut être strict sur l'ordre (Cuba bkt897578 retourne 0B sinon).
 */
export function makeDirectUrl(ds: DynamicSession, endpoint: string, extra?: Record<string, string>): string {
  ds.reqCounter++;
  const params: Array<[string, string]> = [
    ["callback", ds.jqCallback],
    ["type",     "default"],
    ["publickey", ds.publickey],
    ["lang",     "es"],
  ];
  if (extra?.["services[]"]) params.push(["services[]", extra["services[]"]]);
  if (extra?.["agendas[]"])  params.push(["agendas[]",  extra["agendas[]"]]);
  params.push(["version", ds.version]);
  params.push(["src",     ds.widgetUrl]);
  params.push(["srvsrc",  ds.srvsrc]);
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (k !== "services[]" && k !== "agendas[]") params.push([k, v]);
  }
  params.push(["_", String(ds.reqCounter)]);
  const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `${ds.bookititBase}/${endpoint}?${qs}`;
}

/**
 * Headers identiques au dynamic test — X-Requested-With, Accept, Sec-Fetch-*, Cookie.
 */
export function makeDirectHeaders(ds: DynamicSession): Record<string, string> {
  return {
    "User-Agent":        ds.userAgent,
    "Accept":            "text/javascript, application/javascript, */*; q=0.01",
    "X-Requested-With":  "XMLHttpRequest",
    "Sec-Fetch-Site":    "same-origin",
    "Sec-Fetch-Mode":    "cors",
    "Sec-Fetch-Dest":    "empty",
    "Referer":           ds.widgetUrl,
    "Cookie":            buildCookieString(ds.jar),
  };
}

/**
 * Parse une réponse JSONP Bookitit.
 * Compatible avec les préfixes `jQuery...({...})` et `callback={...}`.
 */
export function parseDirectJsonp(raw: string): unknown | null {
  let src = raw.trim();
  if (!src) return null;
  if (src.startsWith("callback=")) src = src.slice("callback=".length);
  const m = src.match(/^[\w$.]+\(([\s\S]*)\);?$/);
  if (!m) {
    try { return JSON.parse(src); } catch { return null; }
  }
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

// ─── Appel direct ─────────────────────────────────────────────────────────────

/**
 * Appelle un endpoint Bookitit directement via impit.fetch — exactement comme le
 * dynamic test.  Retourne le payload parsé, ou null si réponse vide / erreur réseau.
 *
 * @param ds        DynamicSession (impit + jar + état jQuery)
 * @param endpoint  Ex : "getservices/", "datetime/"
 * @param extra     Paramètres supplémentaires (services[], agendas[], start, end…)
 * @param tag       Préfixe worker pour les logs (ex: "[WORKER:RANIA GHOUL]")
 */
/** Timeout par défaut pour les appels Bookitit (120s — protège contre les blocages
 *  infinis tout en laissant le temps au serveur de répondre sous forte charge). */
const CALL_DIRECT_TIMEOUT_MS = 120_000;

/** Codes HTTP retryables (erreurs serveur sous charge) */
const RETRYABLE_HTTP_CODES = new Set([502, 503, 504]);
/** Nombre de retries sur 502/503/504 */
const CALL_DIRECT_MAX_RETRIES = 2;
/** Backoff exponentiel : 2s, 4s */
const CALL_DIRECT_RETRY_BASE_MS = 2_000;

export async function callDirect(
  ds: DynamicSession,
  endpoint: string,
  extra?: Record<string, string>,
  tag?: string,
): Promise<unknown | null | typeof CALL_DIRECT_NETWORK_ERROR> {
  const url = makeDirectUrl(ds, endpoint, extra);
  const headers = makeDirectHeaders(ds);
  const prefix = tag ? `[bookitit-direct] ${tag}` : "[bookitit-direct]";

  for (let attempt = 0; attempt <= CALL_DIRECT_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CALL_DIRECT_TIMEOUT_MS);
      const res = await (ds.impit.fetch(url, { headers, signal: controller.signal } as any) as unknown as Promise<Response>);
      clearTimeout(timeout);
      if (!res.ok) {
        // P3 — Retry sur 502/503/504 (serveur surchargé sous publication)
        if (RETRYABLE_HTTP_CODES.has(res.status) && attempt < CALL_DIRECT_MAX_RETRIES) {
          const backoff = CALL_DIRECT_RETRY_BASE_MS * (2 ** attempt);
          console.warn(`${prefix} ${endpoint} → HTTP ${res.status} — retry ${attempt + 1}/${CALL_DIRECT_MAX_RETRIES} dans ${backoff}ms`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        console.warn(`${prefix} ${endpoint} → HTTP ${res.status}`);
        return null;
      }
      const body = await res.text();
      return parseDirectJsonp(body);
    } catch (e) {
      console.warn(`${prefix} ${endpoint} → erreur réseau: ${e}`);
      // Distinguer l'erreur réseau d'une réponse vide légitime : retourner le symbole
      // CALL_DIRECT_NETWORK_ERROR pour que l'appelant puisse détecter un proxy cassé.
      return CALL_DIRECT_NETWORK_ERROR;
    }
  }
  // Épuisement des retries (ne devrait jamais arriver grâce au return dans la boucle)
  return null;
}

/**
 * Sentinel retourné par callDirect() quand l'appel échoue à cause d'une erreur
 * réseau (ProxyTunnelError, TimeoutError, etc.), à distinguer d'une réponse HTTP
 * vide légitime (null retourné par parseDirectJsonp sur corps vide).
 */
export const CALL_DIRECT_NETWORK_ERROR: unique symbol = Symbol("CALL_DIRECT_NETWORK_ERROR");
