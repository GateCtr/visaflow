/**
 * cevHttpBooking.ts — Réservation CEV via HTTP pur (sans Playwright)
 *
 * Stratégie primaire quand un slot est détecté par le polling.
 * ~5-10s vs 2-3 min pour Playwright, zéro browser overhead.
 *
 * Flux :
 *  1. GET URL d'intégration → suit les redirections jusqu'à SelectSlot (HTML complet)
 *  2. Extraire __RequestVerificationToken + action du form + endpoints AJAX inline
 *  3. POST /Home/AvailableTimeSlots {month, year} → JSON slots dispo
 *  4. Parser le premier slot disponible → (date, timeSlotId / appointmentId)
 *  5. POST form de sélection → confirmation
 *  6. Extraire le code de confirmation depuis la page résultante
 *
 * Si un endpoint est inconnu ou si la réponse est inattendue, retourne
 * { needsPlaywright: true } pour déclencher le fallback Playwright.
 * Tous les états intermédiaires sont loggés via botLog pour analyse offline.
 */

import { botLog, saveCevBookingConfig, type CevDiscoveredConfig } from './convexClient.js';
import { cevImpitFetch, getCevBrowserHeaders, getCevSessionUa } from './cev-shared-impit.js';

const CEV_BASE = 'https://appointment.cloud.diplomatie.be';

// ─── Singleton de configuration auto-découverte ──────────────────────────────
// Chargé depuis Convex au démarrage du bot (via loadCevBookingConfig + setCevDiscoveredConfig).
// Mis à jour après chaque booking HTTP réussi, persisté dans Convex.
// Survit aux redémarrages Railway sans redéploiement du bot.
let _discoveredConfig: CevDiscoveredConfig | null = null;

/**
 * Injecter la configuration chargée depuis Convex au démarrage.
 * Appelé depuis index.ts après `loadCevBookingConfig()`.
 */
export function setCevDiscoveredConfig(config: CevDiscoveredConfig): void {
  _discoveredConfig = config;
  console.log(`[cevHttpBooking] ✅ Config auto-découverte chargée — endpoint=${config.submitEndpoint} successCount=${config.successCount} confirmedAt=${new Date(config.confirmedAt).toISOString()}`);
}

export function getCevDiscoveredConfig(): CevDiscoveredConfig | null {
  return _discoveredConfig;
}

export interface HttpBookingResult {
  success: boolean;
  confirmationCode?: string;
  bookedDate?: string;
  bookedTime?: string;
  error?: string;
  needsPlaywright?: boolean;
  screenshotStorageId?: string;
}

/** Entrée minimale quand le slot est déjà connu (détecté en amont). */
export interface SelectedSlotInput {
  date: string;   // ex: "2026-05-12" ou format renvoyé par l'API
  time: string;   // ex: "09:30"
  id?: string | number; // optionnel si requis par le portail
  raw?: unknown;  // optionnel, pour logs/auto-config
}

interface SiphonedCookies {
  f5CookieValue?: string;
  f5CookieName?: string;
  aspNetSessionId?: string;
  userAgent?: string;
  validUntil?: number;
  preferredCulture?: string;
}

// ─── Helpers réseau ───────────────────────────────────────────────────────────

/**
 * Construit la chaîne Cookie pour les appels CEV booking.
 * Gère : F5 BIG-IP (TS01*) en tête si valide, puis ASP.NET_SessionId + PreferredCulture.
 */
function buildCevCookieStr(sessionCookie: string, siphoned?: SiphonedCookies): string {
  const aspCookie = siphoned?.aspNetSessionId ?? sessionCookie;
  // FIX Faille #2 : fr-BE cohérent avec Accept-Language: fr-BE (siphoned garde sa valeur serveur)
  const culture = siphoned?.preferredCulture ?? "fr-BE";
  let cookieStr = `ASP.NET_SessionId=${aspCookie}; PreferredCulture=${culture}`;
  if (siphoned?.f5CookieValue && siphoned?.f5CookieName) {
    if (!siphoned.validUntil || Date.now() < siphoned.validUntil) {
      cookieStr = `${siphoned.f5CookieName}=${siphoned.f5CookieValue}; ${cookieStr}`;
    }
  }
  return cookieStr;
}

/** Accumule les Set-Cookie d'une réponse dans un cookie string existant. */
function accumulateCookies(existing: string, res: Response): string {
  // impit peut retourner les cookies soit via 'set-cookie' (multiple) soit via getSetCookie()
  const rawCookies: string[] = [];
  try {
    // Standard: getSetCookie() (Node 18+)
    const all = (res.headers as any).getSetCookie?.() as string[] | undefined;
    if (all?.length) rawCookies.push(...all);
  } catch { /* ignore */ }
  if (!rawCookies.length) {
    const single = res.headers.get('set-cookie');
    if (single) rawCookies.push(single);
  }

  let result = existing;
  for (const raw of rawCookies) {
    // "name=value; Path=/; HttpOnly; Secure; ..." → prendre seulement "name=value"
    const pair = raw.split(';')[0]?.trim();
    if (!pair) continue;
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 1) continue;
    const name = pair.slice(0, eqIdx).trim();
    // Remplacer si déjà présent, sinon ajouter
    const existingRe = new RegExp(`(?:^|;\\s*)${name}=[^;]*`, 'i');
    if (existingRe.test(result)) {
      result = result.replace(existingRe, (m) => m.startsWith(';') ? `; ${pair}` : pair);
    } else {
      result = result ? `${result}; ${pair}` : pair;
    }
  }
  return result;
}

async function fetchFollowRedirects(
  startUrl: string,
  sessionCookie: string,
  ua: string,
  siphoned?: SiphonedCookies,
  maxHops = 6,
): Promise<{ ok: boolean; url: string; html: string; status: number; responseHeaders?: Record<string, string>; accumulatedCookies?: string; error?: string }> {
  let url = startUrl;
  // Cookie string accumulé à travers toute la chaîne de redirects.
  // CRITIQUE : le cookie __RequestVerificationToken (anti-CSRF ASP.NET) est souvent émis par
  // le serveur via Set-Cookie lors du GET SelectSlot — il faut le capturer ici pour le POST.
  let accumulatedCookies = buildCevCookieStr(sessionCookie, siphoned);

  for (let hop = 0; hop < maxHops; hop++) {
    const res = await cevImpitFetch(url, {
      method: 'GET',
      // Document navigate — ordre exact Chrome 148 (getCevBrowserHeaders !isAjax branch)
      // Cache-Control: max-age=0 (pas no-cache), Upgrade-Insecure-Requests: 1 ✓
      headers: getCevBrowserHeaders({
        cookie: accumulatedCookies,
        userAgent: siphoned?.userAgent ?? ua,
        cacheControl: 'max-age=0',
        fetchSite: 'same-origin',
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    }, "[CEV-BOOKING]");

    // Accumuler les Set-Cookie de chaque hop (y compris les redirects 30x)
    accumulatedCookies = accumulateCookies(accumulatedCookies, res);

    if (res.status === 302 || res.status === 301) {
      const loc = res.headers.get('location');
      if (!loc) {
        return { ok: false, url, html: '', status: res.status, accumulatedCookies, error: 'Redirect sans Location header' };
      }
      url = loc.startsWith('http') ? loc : `${CEV_BASE}${loc}`;
      continue;
    }

    if (res.status === 200) {
      const html = await res.text().catch(() => '');
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { responseHeaders[k] = v; });
      return { ok: true, url, html, status: 200, responseHeaders, accumulatedCookies };
    }

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { responseHeaders[k] = v; });
    return { ok: false, url, html: '', status: res.status, error: `HTTP ${res.status}`, responseHeaders, accumulatedCookies };
  }

  return { ok: false, url, html: '', status: 0, error: 'Trop de redirections', accumulatedCookies };
}

// ─── Parseurs HTML légers (regex — pas de DOM parser requis) ─────────────────

function extractAntiForgeryToken(html: string): string | null {
  const patterns = [
    /__RequestVerificationToken"[^>]*value="([^"]+)"/i,
    /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i,
    /value="([^"]+)"[^>]*name="__RequestVerificationToken"/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

function extractFormAction(html: string): string | null {
  // Cherche form[method="post"] (case-insensitive)
  const m = html.match(/<form[^>]+method=["']?post["']?[^>]*action="([^"]+)"/i)
         ?? html.match(/<form[^>]+action="([^"]+)"[^>]*method=["']?post["']?/i);
  if (!m?.[1]) return null;
  const action = m[1];
  return action.startsWith('http') ? action : `${CEV_BASE}${action}`;
}

/**
 * Extrait TOUS les <input type="hidden"> du HTML.
 * Ces champs sont requis pour les POST ASP.NET MVC (anti-forgery + state).
 */
function extractHiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const regex = /<input[^>]+type=["']?hidden["']?[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const tag = m[0];
    const nameM = tag.match(/name="([^"]+)"/i);
    const valM  = tag.match(/value="([^"]*)"?/i);
    if (nameM?.[1]) {
      out[nameM[1]] = valM?.[1] ?? '';
    }
  }
  return out;
}

/**
 * Extrait tous les endpoints AJAX trouvés dans les scripts inline du HTML.
 * Cherche les patterns : $.ajax, $.post, fetch, ajaxUrl, url: '...'
 * Permet de découvrir les vrais endpoints de booking sans lire le bundle.
 */
function extractInlineAjaxEndpoints(html: string): string[] {
  const endpoints = new Set<string>();

  // Pattern 1 : url: '/path' ou url: "/path" dans les appels jQuery AJAX
  const urlPattern = /url\s*:\s*["']([^"']+(?:Slot|Book|Appoint|Select|Confirm|Submit|Reserve)[^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = urlPattern.exec(html)) !== null) {
    endpoints.add(m[1]);
  }

  // Pattern 2 : $.post('/path', ...) ou $.ajax({url:'/path',...})
  const postPattern = /\$\.(?:post|get|ajax)\(['"]([^'"]+)['"]/gi;
  while ((m = postPattern.exec(html)) !== null) {
    endpoints.add(m[1]);
  }

  // Pattern 3 : fetch('/path') ou fetch("https://...")
  const fetchPattern = /fetch\(['"]([^'"]*appointment\.cloud\.diplomatie\.be[^'"]*|\/[A-Z][^'"]*)['"]/gi;
  while ((m = fetchPattern.exec(html)) !== null) {
    endpoints.add(m[1]);
  }

  // Pattern 4 : ajaxUrl = '...' (variable globale CEV)
  const ajaxUrlPattern = /ajaxUrl\s*=\s*["']([^"']+)["']/gi;
  while ((m = ajaxUrlPattern.exec(html)) !== null) {
    endpoints.add(m[1]);
  }

  return [...endpoints].slice(0, 30); // max 30 pour éviter les logs trop volumineux
}

/**
 * Extrait les URLs de script bundles (<script src="...">) depuis le HTML de la page.
 * Retourne uniquement les bundles hébergés sur le même domaine CEV (pas CDN externe).
 */
function extractScriptBundleUrls(html: string, base: string): string[] {
  const urls: string[] = [];
  const regex = /<script[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const src = m[1];
    if (src.startsWith("/") || src.startsWith(base)) {
      const full = src.startsWith("http") ? src : `${base}${src}`;
      if (full.includes("appointment.cloud.diplomatie.be")) urls.push(full);
    }
  }
  return [...new Set(urls)].slice(0, 8); // max 8 bundles
}

/**
 * Scan les script bundles de la page SelectSlot pour découvrir l'endpoint de booking.
 * Cherche les patterns jQuery $.ajax / callPost / url: contenant Book, SelectSlot, Confirm, etc.
 * Log le résultat via botLog — ne modifie pas le flux de booking.
 *
 * Appelé uniquement en mode discovery (pas de knownConfig), pour ne pas ralentir le booking
 * quand l'endpoint est déjà connu.
 */
async function scanBundlesForBookingEndpoint(
  html: string,
  referer: string,
  sessionCookie: string,
  siphoned: SiphonedCookies | undefined,
  ua: string,
  clientId: string,
): Promise<{ endpoints: string[]; bundlesScanned: number }> {
  const bundleUrls = extractScriptBundleUrls(html, CEV_BASE);
  const allEndpoints = new Set<string>();

  // Patterns couvrant jQuery callPost, $.ajax url:, $.post, fetch
  const patterns = [
    /callPost\(["']([^"']+(?:slot|book|appoint|select|confirm|reserve|submit)[^"']*)["']/gi,
    /url\s*:\s*["']([^"']+(?:Slot|Book|Appoint|Select|Confirm|Submit|Reserve|Home\/)[^"']*)["']/gi,
    /\$\.(?:post|ajax)\(\s*["']([^"']+)["']/gi,
    /callPost\(\s*["']([^"'\/][^"']*)["']/gi, // callPost avec chemin relatif court
  ];

  for (const bundleUrl of bundleUrls) {
    try {
      const res = await cevImpitFetch(bundleUrl, {
        method: "GET",
        headers: getCevBrowserHeaders({
          cookie: buildCevCookieStr(sessionCookie, siphoned),
          userAgent: ua,
          referer,
          accept: "*/*",
          fetchSite: "same-origin",
        }),
        signal: AbortSignal.timeout(15_000),
      }, "[CEV-BUNDLE]");

      if (!res.ok) continue;
      const text = await res.text().catch(() => "");
      if (!text) continue;

      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(text)) !== null) {
          allEndpoints.add(m[1]);
        }
      }
    } catch {
      // Timeout ou erreur réseau — ignorer ce bundle
    }
  }

  const endpoints = [...allEndpoints].slice(0, 20);

  botLog({
    applicationId: clientId,
    step: "cev_http_bundle_scan",
    status: "ok",
    data: {
      bundlesScanned: bundleUrls.length,
      bundleUrls,
      endpointsFound: endpoints,
      bookingCandidates: endpoints.filter(e =>
        /book|select.*slot|confirm|submit/i.test(e)
      ),
    },
  });

  return { endpoints, bundlesScanned: bundleUrls.length };
}

/**
 * Extrait les marqueurs data-* qui identifient les slots cliquables dans le HTML.
 * Retourne les 5 premiers pour analyse.
 */
function extractSlotDataAttributes(html: string): Record<string, string>[] {
  const slots: Record<string, string>[] = [];
  const regex = /<[^>]+data-slot[^>]+>/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null && slots.length < 5) {
    const tag = m[0];
    const attrs: Record<string, string> = {};
    const attrRegex = /(\bdata-[a-z-]+)\s*=\s*["']([^"']*)["']/gi;
    let a: RegExpExecArray | null;
    while ((a = attrRegex.exec(tag)) !== null) {
      attrs[a[1]] = a[2];
    }
    if (Object.keys(attrs).length > 0) slots.push(attrs);
  }
  return slots;
}

// ─── Parse des slots (inline HTML + /Home/AvailableTimeSlots) ────────────────

interface ParsedSlot {
  date: string;
  time: string;
  id?: string | number;
  available: boolean;
  /** Nombre de places libres pour ce créneau (compté depuis le tableau availability[] inline) */
  free?: number;
  raw: unknown;
}

/**
 * Extrait les créneaux disponibles directement depuis le HTML de la page SelectSlot.
 *
 * Le portail CEV embed la variable JS `availability = [...]` avec des objets
 * AvailableSlotForPublic. Format :
 *   { "$type": "...AvailableSlotForPublic...", "fromTime": "2026-08-15T09:30:00",
 *     "scheduleLineId": "uuid-...", "toTime": "..." }
 *
 * IMPORTANT : chaque entrée du tableau correspond à UNE place disponible.
 * Plusieurs entrées avec la même fromTime = plusieurs places pour ce créneau.
 * La fonction groupe par (date, time) et calcule le nombre de places libres.
 *
 * Quand présents, ces slots sont préférés à un appel /Home/AvailableTimeSlots
 * (qui requiert officeId + visaCategories → HTTP 500 sans ces paramètres).
 */
export function extractInlineSlotsFromHtml(html: string): ParsedSlot[] {
  // Chercher la variable availability (avec ou sans var/let/const)
  const patterns = [
    /\bvar\s+availability\s*=\s*(\[[\s\S]*?\]);/,
    /\blet\s+availability\s*=\s*(\[[\s\S]*?\]);/,
    /\bconst\s+availability\s*=\s*(\[[\s\S]*?\]);/,
    /\bavailability\s*=\s*(\[[\s\S]*?\]);/,
  ];

  let rawJson: unknown = null;
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m?.[1]) {
      try { rawJson = JSON.parse(m[1]); break; } catch { continue; }
    }
  }

  if (!rawJson || !Array.isArray(rawJson) || rawJson.length === 0) return [];

  // Étape 1 : extraire tous les entrées brutes avec date+time+id
  //
  // Format réel CEV AvailableSlotForPublic (confirmé 2026-08-01) :
  //   { fromTime: "1900-01-01T13:30:00"  ← placeholder date, heure réelle
  //     datePart: "2026-12-22T00:00:00"  ← VRAIE date du RDV (prioritaire)
  //     timeSlot: "2026-12-22T14:20:00"  ← heure exacte du RDV (prioritaire)
  //     scheduleLineId: "uuid"           ← clé de réservation (1 par place libre) }
  //
  // Chaque entrée = 1 place disponible. Grouper par (datePart, heure) → free = count.
  interface RawEntry { date: string; time: string; id: string | undefined; raw: unknown }
  const allEntries: RawEntry[] = (rawJson as Record<string, unknown>[]).flatMap(item => {
    let date = '';
    let time = '';

    // Priorité 1 : datePart → vraie date du RDV
    const datePartRaw = String(item.datePart ?? item.DatePart ?? '');
    if (datePartRaw.includes('T')) {
      date = datePartRaw.split('T')[0] ?? '';       // "2026-12-22"
    } else if (datePartRaw.match(/^\d{4}-\d{2}-\d{2}/)) {
      date = datePartRaw.slice(0, 10);
    }

    // Priorité 2 : timeSlot → heure exacte du RDV
    const timeSlotRaw = String(item.timeSlot ?? item.TimeSlot ?? '');
    if (timeSlotRaw.includes('T')) {
      time = (timeSlotRaw.split('T')[1] ?? '').slice(0, 5); // "14:20"
    }

    // Fallback si datePart/timeSlot absents : fromTime (peut contenir "1900-01-01T13:30:00")
    if (!date || !time) {
      const fromTime = String(item.fromTime ?? item.FromTime ?? item.startTime ?? item.StartTime ?? '');
      if (fromTime) {
        const dotNetMs = fromTime.match(/\/Date\((-?\d+)\)\//);
        if (dotNetMs) {
          const d = new Date(parseInt(dotNetMs[1], 10));
          if (!date) date = d.toISOString().slice(0, 10);
          if (!time) time = d.toISOString().slice(11, 16);
        } else if (fromTime.includes('T')) {
          const parts = fromTime.split('T');
          const candidate = parts[0] ?? '';
          // Ignorer "1900-01-01" (placeholder CEV) si on a déjà une vraie date
          if (!date && candidate && candidate !== '1900-01-01') date = candidate;
          if (!time) time = (parts[1] ?? '').slice(0, 5);
        } else if (!date) {
          date = fromTime;
        }
      }
    }

    const id = (
      item.scheduleLineId ?? item.ScheduleLineId ??
      item.id ?? item.Id
    ) as string | undefined;

    if (!date && !id) return [];
    return [{ date, time, id, raw: item }];
  });

  // Étape 2 : grouper par (date, time) pour compter les places libres.
  // Chaque entrée du tableau = 1 place disponible pour ce créneau.
  const groups = new Map<string, { entries: RawEntry[]; free: number }>();
  for (const entry of allEntries) {
    const key = `${entry.date}|${entry.time}`;
    if (!groups.has(key)) groups.set(key, { entries: [], free: 0 });
    const g = groups.get(key)!;
    g.entries.push(entry);
    g.free++;
  }

  // Étape 3 : retourner un slot par (date, time), free = nombre de places
  // On garde le premier scheduleLineId du groupe pour le POST de réservation.
  return [...groups.values()].map(g => ({
    date:      g.entries[0].date,
    time:      g.entries[0].time,
    id:        g.entries[0].id,        // scheduleLineId du premier → utiliser pour le POST
    available: true,
    free:      g.free,
    raw:       g.entries[0].raw,
  }));
}

function parseAvailableSlots(raw: unknown): ParsedSlot[] {
  if (!raw) return [];
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown>).slots)
      ? (raw as Record<string, unknown>).slots as unknown[]
      : (raw as Record<string, unknown>).availableSlots
        ? (raw as Record<string, unknown>).availableSlots as unknown[]
        : [raw];

  return items.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      date:      String(r.date ?? r.Date ?? r.day ?? r.Day ?? ''),
      time:      String(r.time ?? r.Time ?? r.hour ?? r.Hour ?? r.startTime ?? ''),
      id:        (r.id ?? r.Id ?? r.slotId ?? r.appointmentId ?? r.uniqueId) as string | number | undefined,
      available: Boolean(r.available ?? r.Available ?? r.isAvailable ?? r.IsAvailable ?? true),
      raw: item,
    };
  });
}

// ─── Appel POST /Home/AvailableTimeSlots ─────────────────────────────────────

async function fetchAvailableTimeSlots(
  sessionCookie: string,
  referer: string,
  ua: string,
  siphoned?: SiphonedCookies,
  month?: number,
  year?: number,
): Promise<{ ok: boolean; slots: ParsedSlot[]; rawJson: unknown; error?: string; responseHeaders?: Record<string, string> }> {
  const now = new Date();
  const body = { month: month ?? now.getMonth() + 1, year: year ?? now.getFullYear() };

  try {
    const res = await cevImpitFetch(`${CEV_BASE}/Home/AvailableTimeSlots`, {
      method: 'POST',
      // AJAX POST JSON — jQuery $.ajax({contentType:"application/json"}) — ordre Chrome 148
      // Accept: jQuery $.ajax default, X-Requested-With: XMLHttpRequest ✓
      headers: getCevBrowserHeaders({
        cookie: buildCevCookieStr(sessionCookie, siphoned),
        userAgent: siphoned?.userAgent ?? ua,
        contentType: 'application/json',
        xRequestedWith: true,
        referer: referer,
        origin: CEV_BASE,
        accept: 'application/json, text/javascript, */*; q=0.01',
        fetchSite: 'same-origin',
      }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }, "[CEV-BOOKING]");

    if (!res.ok) {
      return { ok: false, slots: [], rawJson: null, error: `HTTP ${res.status}` };
    }

    const rawJson = await res.json().catch(() => null);
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { responseHeaders[k] = v; });
    const slots = parseAvailableSlots(rawJson);
    const available = slots.filter(s => s.available);
    return { ok: true, slots: available, rawJson, responseHeaders };
  } catch (err) {
    return { ok: false, slots: [], rawJson: null, error: String(err) };
  }
}

// ─── Soumission du formulaire de sélection de slot ───────────────────────────

/**
 * Tente de soumettre le formulaire de sélection de slot via HTTP.
 *
 * L'endpoint exact est inconnu sans avoir observé une session réelle.
 * On essaie par ordre de probabilité décroissante :
 *  1. L'action du form extrait du HTML (priorité absolue si présente)
 *  2. /Home/SelectSlot
 *  3. /Integration/VOW/SelectSlot
 *  4. /Home/BookAppointment
 *
 * Le corps est construit à partir des champs cachés du form + données du slot.
 * On log le résultat complet pour permettre la correction offline.
 */
async function submitSlotSelection(
  sessionCookie: string,
  referer: string,
  ua: string,
  formAction: string | null,
  hiddenInputs: Record<string, string>,
  slot: ParsedSlot,
  clientId: string,
  siphoned?: SiphonedCookies,
  preferredEndpoint?: string, // endpoint confirmé depuis la config auto-découverte (essayé en premier)
  /** Cookie string complet du setup (contient __RequestVerificationToken anti-CSRF ASP.NET) */
  selectSlotCookies?: string,
): Promise<{ success: boolean; html: string; finalUrl: string; confirmedEndpoint?: string; error?: string; needsPlaywright?: boolean }> {
  // Si on a un endpoint confirmé → le tester en premier, avant les guesses
  const candidates = [
    preferredEndpoint ?? null,
    formAction,
    `${CEV_BASE}/Home/SelectSlot`,
    `${CEV_BASE}/Integration/VOW/SelectSlot`,
    `${CEV_BASE}/Home/BookAppointment`,
    `${CEV_BASE}/Home/ConfirmAppointment`,
    `${CEV_BASE}/Home/Book`,
  ].filter(Boolean) as string[];

  // Dédupliquer (formAction peut être dans les candidates génériques)
  const uniqueCandidates = [...new Set(candidates)];

  // Corps du form : champs cachés + données du slot sélectionné
  const formFields: Record<string, string> = {
    ...hiddenInputs,
    // Noms probables du champ date (à confirmer via les logs)
    selectedDate:        slot.date,
    appointmentDate:     slot.date,
    date:                slot.date,
    SelectedDate:        slot.date,
    AppointmentDate:     slot.date,
    // Noms probables du champ heure
    selectedTime:        slot.time,
    appointmentTime:     slot.time,
    time:                slot.time,
    SelectedTime:        slot.time,
    AppointmentTime:     slot.time,
    // ID du créneau si disponible (CEV utilise scheduleLineId en priorité)
    ...(slot.id != null ? {
      slotId:         String(slot.id),
      appointmentId:  String(slot.id),
      SlotId:         String(slot.id),
      id:             String(slot.id),
      scheduleLineId: String(slot.id),  // champ natif CEV AvailableSlotForPublic
      ScheduleLineId: String(slot.id),
    } : {}),
  };

  botLog({
    applicationId: clientId,
    step: 'cev_http_submit_attempt',
    status: 'ok',
    data: {
      candidates: uniqueCandidates,
      slot: { date: slot.date, time: slot.time, id: slot.id },
      formFields: Object.fromEntries(
        Object.entries(formFields).filter(([k, v]) => !!v && k !== '__RequestVerificationToken')
      ),
      hiddenInputCount: Object.keys(hiddenInputs).length,
    },
  });

  for (const endpoint of uniqueCandidates) {
    try {
      const body = new URLSearchParams(formFields).toString();
      const res = await cevImpitFetch(endpoint, {
        method: 'POST',
        // Form POST (navigate → page confirmation) — ordre exact Chrome 148 isFormPost branch.
        // Cache-Control: max-age=0 ✓, Sec-Fetch-Mode: navigate ✓, Sec-Fetch-Dest: document ✓
        // X-Requested-With ABSENT — un vrai browser ne l'envoie pas sur un form navigate.
        // IMPORTANT : utiliser selectSlotCookies si disponible (contient __RequestVerificationToken anti-CSRF).
        // Sans ce cookie, ASP.NET MVC retourne HTTP 500 "anti-forgery cookie not present".
        headers: getCevBrowserHeaders({
          cookie: selectSlotCookies ?? buildCevCookieStr(sessionCookie, siphoned),
          userAgent: siphoned?.userAgent ?? ua,
          contentType: 'application/x-www-form-urlencoded',
          origin: CEV_BASE,
          referer: referer,
          isFormPost: true,
          fetchSite: 'same-origin',
        }),
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      }, "[CEV-BOOKING]");

      const html = await res.text().catch(() => '');
      const finalUrl = res.url;
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { responseHeaders[k] = v; });

      // Log console pour diagnostic (important pour identifier le bon endpoint)
      console.log(`[CEV-BOOKING] Submit ${endpoint} → HTTP ${res.status} | finalUrl=${finalUrl.slice(0, 100)}`);
      if (!res.ok) {
        console.log(`[CEV-BOOKING] Response preview: ${html.slice(0, 400).replace(/\s+/g, ' ')}`);
      }

      botLog({
        applicationId: clientId,
        step: 'cev_http_submit_response',
        status: res.ok ? 'ok' : 'warn',
        data: {
          endpoint,
          httpStatus: res.status,
          finalUrl,
          htmlPreview: html.slice(0, 2000),
          responseHeaders,
          isError: html.toLowerCase().includes('error') || html.toLowerCase().includes('erreur'),
          hasConfirmation: /confirm|référence|reference|booking.*id|rdv.*confirm/i.test(html),
        },
      });

      // Slot déjà pris (race condition) — Playwright ne peut rien y faire non plus
      if (finalUrl.includes('TimeSlotNoLongerAvailable') || finalUrl.includes('NoLongerAvailable')) {
        return { success: false, html, finalUrl, error: 'SLOT_TAKEN' };
      }

      // Succès si on arrive sur une page de confirmation (pas d'erreur, pas de redirect vers captcha)
      if (
        res.ok &&
        !finalUrl.includes('SessionExpired') &&
        !finalUrl.includes('Captcha') &&
        !finalUrl.toLowerCase().includes('error') &&
        (/confirm|référence|reference|booking.*id/i.test(html) || res.status === 200)
      ) {
        return { success: true, html, finalUrl, confirmedEndpoint: endpoint };
      }

      // 404/405 → mauvais endpoint, essayer le suivant
      if (res.status === 404 || res.status === 405) continue;

      // 500 → peut signifier champs incorrects ou mauvais endpoint — essayer les autres aussi
      if (res.status === 500) continue;

      // Autres erreurs (401, 403, etc.) → retourner directement
      return { success: false, html, finalUrl, error: `HTTP ${res.status} sur ${endpoint}` };
    } catch (err) {
      botLog({
        applicationId: clientId,
        step: 'cev_http_submit_error',
        status: 'warn',
        data: { endpoint, error: String(err) },
      });
    }
  }

  return { success: false, html: '', finalUrl: '', error: 'Tous les endpoints de booking ont échoué' };
}

function extractConfirmationCode(html: string): string | null {
  // Pattern alphanumérique typique des codes de confirmation (ex: BEL-20260512-1234)
  const patterns = [
    /confirmation[^"<]*[:\s]+([A-Z0-9-]{6,20})/i,
    /référence[^"<]*[:\s]+([A-Z0-9-]{6,20})/i,
    /reference[^"<]*[:\s]+([A-Z0-9-]{6,20})/i,
    /booking[^"<]*id[^"<]*[:\s]+([A-Z0-9-]{6,20})/i,
    /\b([A-Z]{2,4}-?\d{4,10})\b/,
    /\b(RDV-?[A-Z0-9]{6,})\b/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

// ─── Fonction principale ──────────────────────────────────────────────────────

/**
 * Réservation CEV via HTTP pur — stratégie primaire.
 *
 * Avantages vs Playwright :
 *  - ~5-10s vs 2-3 min
 *  - Zéro browser, zéro overhead Playwright, zéro timing UI
 *  - S'exécute en parallèle avec d'autres sessions sans conflits
 *
 * Si `needsPlaywright: true`, le caller doit déclencher bookWithExistingSession() (fallback).
 */
export async function bookCevViaHttp(
  integrationUrl: string,
  sessionCookie: string,
  clientId: string,
  siphoned?: SiphonedCookies,
  sessionUa?: string,
  /** HTML de la page SelectSlot déjà capturé lors du setup — évite une 2ème requête (URL à usage unique) */
  preloadedHtml?: string,
  /** URL finale de la page SelectSlot capturée lors du setup */
  preloadedSelectSlotUrl?: string,
  /**
   * Cookie string complet après la chaîne de redirects du setup.
   * Doit inclure __RequestVerificationToken (anti-CSRF ASP.NET) capturé lors du GET SelectSlot.
   * Sans lui, le POST /Integration/VOW/SelectSlot retourne HTTP 500 "anti-forgery cookie not present".
   */
  selectSlotCookies?: string,
  /**
   * Nombre minimum de places libres requises sur un créneau pour le sélectionner.
   * Si undefined ou ≤ 1 → comportement par défaut (préférer ≥ 3 places, fallback au max dispo).
   * Si > 1 → ne sélectionner que les créneaux avec free ≥ groupSize.
   */
  groupSize?: number,
): Promise<HttpBookingResult> {
  // UA cohérent avec la session setup : priorité siphoned.userAgent > sessionUa > randomUserAgent()
  // Un UA différent entre setup et booking = red flag WAF dans les logs post-booking.
  const ua = siphoned?.userAgent ?? sessionUa ?? getCevSessionUa();

  botLog({
    applicationId: clientId,
    step: 'cev_http_booking_start',
    status: 'ok',
    data: {
      integrationUrlPreview: integrationUrl.slice(0, 80),
      ua: ua.slice(0, 60),
      usingPreloadedHtml: !!preloadedHtml,
      preloadedHtmlLen: preloadedHtml?.length ?? 0,
    },
  });

  try {
    let html: string;
    let selectSlotUrl: string;

    if (preloadedHtml && preloadedHtml.length > 500) {
      // ═══ FAST-PATH : HTML déjà capturé lors du setup ═══
      // L'integrationUrl est à usage unique — si le setup a déjà suivi la chaîne
      // captcha→SelectSlot, réutiliser le HTML capturé évite l'erreur SESSION_EXPIRED_OR_CAPTCHA.
      html = preloadedHtml;
      selectSlotUrl = preloadedSelectSlotUrl ?? integrationUrl;
      botLog({
        applicationId: clientId,
        step: 'cev_http_selectslot_preloaded',
        status: 'ok',
        data: { htmlLen: html.length, selectSlotUrl: selectSlotUrl.slice(0, 100) },
      });
    } else {
      // ═══ ÉTAPE 1 : GET SelectSlot page (suit les redirections) ═══
      const pageResult = await fetchFollowRedirects(integrationUrl, sessionCookie, ua, siphoned);

      botLog({
        applicationId: clientId,
        step: 'cev_http_selectslot_fetched',
        status: pageResult.ok ? 'ok' : 'warn',
        data: {
          finalUrl:    pageResult.url,
          httpStatus:  pageResult.status,
          htmlLen:     pageResult.html.length,
          responseHeaders: pageResult.responseHeaders ?? null,
          error:       pageResult.error ?? null,
          isNoSlot:    pageResult.url.includes('NoAvailability') || pageResult.html.toLowerCase().includes('noavailability'),
          isExpired:   pageResult.url.includes('SessionExpired') || pageResult.html.toLowerCase().includes('session expired'),
          isCaptcha:   pageResult.url.includes('Captcha') || pageResult.html.includes('SetCaptchaToken') || pageResult.html.includes('class="h-captcha"'),
        },
      });

      if (!pageResult.ok) {
        if (pageResult.error?.includes('Trop de redirections')) {
          return { success: false, error: 'TOO_MANY_REDIRECTS', needsPlaywright: true };
        }
        return { success: false, error: pageResult.error ?? 'FETCH_FAILED', needsPlaywright: true };
      }

      html = pageResult.html;
      selectSlotUrl = pageResult.url;
      // Utiliser les cookies accumulés (incluant __RequestVerificationToken anti-CSRF)
      // comme fallback si le caller n'a pas fourni de selectSlotCookies.
      if (!selectSlotCookies && pageResult.accumulatedCookies) {
        selectSlotCookies = pageResult.accumulatedCookies;
      }
    }

    if (selectSlotUrl.includes('NoAvailability') || html.toLowerCase().includes('noavailability')) {
      return { success: false, error: 'NO_AVAILABILITY' };
    }

    if (
      selectSlotUrl.includes('SessionExpired') ||
      html.toLowerCase().includes('session expired') ||
      selectSlotUrl.includes('/Captcha') ||
      // IMPORTANT : la page SelectSlot charge aussi js.hcaptcha.com comme librairie JS —
      // ne pas confondre "librairie hCaptcha chargée" avec "on est sur la page /Captcha".
      // Une vraie page captcha contient SetCaptchaToken (endpoint de soumission) ou
      // class="h-captcha" (le widget DOM réel), pas juste une balise <script> src hcaptcha.
      html.includes('SetCaptchaToken') ||
      html.includes('class="h-captcha"') ||
      html.includes("class='h-captcha'")
    ) {
      return { success: false, error: 'SESSION_EXPIRED_OR_CAPTCHA', needsPlaywright: false };
    }

    // ═══ ÉTAPE 2 : Extraire structure HTML (discovery complète ou fast-path) ═══
    // Si config auto-découverte connue → on extrait seulement le token antiforgery (request-specific).
    // La discovery complète (formAction, ajaxEndpoints, slotDataAttrs) est skippée.
    const knownConfig = _discoveredConfig;
    const antiForgeryToken = extractAntiForgeryToken(html);
    const formAction       = knownConfig ? null : extractFormAction(html);
    const hiddenInputs     = extractHiddenInputs(html);          // toujours nécessaire (token inclus)
    const ajaxEndpoints    = knownConfig ? {} : extractInlineAjaxEndpoints(html);
    const slotDataAttrs    = knownConfig ? {} : extractSlotDataAttributes(html);

    botLog({
      applicationId: clientId,
      step: 'cev_http_html_discovery',
      status: 'ok',
      data: {
        fastPath: !!knownConfig,
        knownEndpoint: knownConfig?.submitEndpoint ?? null,
        antiForgeryTokenFound: !!antiForgeryToken,
        antiForgeryTokenPreview: antiForgeryToken?.slice(0, 8) + '...',
        formAction,
        hiddenInputs: Object.fromEntries(
          Object.entries(hiddenInputs).map(([k, v]) => [k, k === '__RequestVerificationToken' ? v.slice(0, 8) + '...' : v])
        ),
        hiddenInputCount: Object.keys(hiddenInputs).length,
        ajaxEndpoints,
        slotDataAttrs,
        htmlPreview: knownConfig ? html.slice(0, 500) : html.slice(0, 3000),
      },
    });

    // ═══ ÉTAPE 2b : Extraction des créneaux inline depuis le HTML ═══
    // Le portail CEV embed `availability = [...]` dans le HTML de SelectSlot.
    // Ces slots sont préférés à un appel /Home/AvailableTimeSlots qui requiert
    // officeId + visaCategories (non disponibles sans la page HTML) → HTTP 500.
    const inlineSlots = extractInlineSlotsFromHtml(html);

    // Log console pour voir les créneaux et leur nombre de places libres
    if (inlineSlots.length > 0) {
      console.log(`[CEV-BOOKING] 📅 ${inlineSlots.length} créneau(x) trouvé(s) (source=${preloadedHtml ? 'preloaded' : 'fetched'}):`);
      for (const s of inlineSlots) {
        const bar = '█'.repeat(Math.min(s.free ?? 1, 10));
        console.log(`[CEV-BOOKING]   ${s.date} ${s.time}  free=${s.free ?? 1}  ${bar}`);
      }
    } else {
      console.log(`[CEV-BOOKING] ⚠️ Aucun créneau inline dans le HTML (source=${preloadedHtml ? 'preloaded' : 'fetched'})`);
    }

    botLog({
      applicationId: clientId,
      step: 'cev_http_inline_slots',
      status: inlineSlots.length > 0 ? 'ok' : 'warn',
      data: {
        count: inlineSlots.length,
        slots: inlineSlots.map(s => ({ date: s.date, time: s.time, free: s.free ?? 1, id: s.id })),
        source: preloadedHtml ? 'preloaded' : 'fetched',
      },
    });

    // ═══ ÉTAPE 2c : Scan des bundles JS (discovery — fire-and-forget) ═══
    // Exécuté uniquement en mode discovery (pas de knownConfig), ne bloque pas le flux.
    if (!knownConfig) {
      scanBundlesForBookingEndpoint(html, selectSlotUrl, sessionCookie, siphoned, ua, clientId)
        .catch(err => {
          botLog({
            applicationId: clientId,
            step: 'cev_http_bundle_scan_error',
            status: 'warn',
            data: { error: String(err).slice(0, 200) },
          });
        });
    }

    // ═══ ÉTAPE 3 : Résolution des créneaux disponibles ═══
    // Priorité : slots inline dans le HTML (évite le HTTP 500 de /Home/AvailableTimeSlots).
    // Fallback : appel AJAX /Home/AvailableTimeSlots si aucun slot inline.
    let availableSlots: ParsedSlot[];

    if (inlineSlots.length > 0) {
      // Fast-path : créneaux déjà extraits du HTML — pas d'appel réseau supplémentaire
      availableSlots = inlineSlots;
    } else {
      // Fallback AJAX — fonctionne pour les comptes où les slots ne sont pas inline
      const now = new Date();
      const slotsResult = await fetchAvailableTimeSlots(sessionCookie, selectSlotUrl, ua, siphoned, now.getMonth() + 1, now.getFullYear());

      botLog({
        applicationId: clientId,
        step: 'cev_http_available_slots',
        status: 'ok',
        data: {
          httpOk:       slotsResult.ok,
          slotCount:    slotsResult.slots.length,
          error:        slotsResult.error ?? null,
          responseHeaders: slotsResult.responseHeaders ?? null,
          rawJsonType:  Array.isArray(slotsResult.rawJson) ? 'array' : (slotsResult.rawJson === null ? 'null' : typeof slotsResult.rawJson),
          rawJsonPreview: JSON.stringify(slotsResult.rawJson).slice(0, 1500),
          firstSlots:   slotsResult.slots.slice(0, 3).map(s => ({ date: s.date, time: s.time, id: s.id })),
        },
      });

      // Si mois courant vide, essayer le mois suivant
      availableSlots = slotsResult.slots;
      if (slotsResult.ok && availableSlots.length === 0) {
        const now2 = new Date();
        const next = new Date(now2.getFullYear(), now2.getMonth() + 1, 1);
        const nextResult = await fetchAvailableTimeSlots(sessionCookie, selectSlotUrl, ua, siphoned, next.getMonth() + 1, next.getFullYear());
        botLog({
          applicationId: clientId,
          step: 'cev_http_available_slots_next_month',
          status: 'ok',
          data: { month: next.getMonth() + 1, year: next.getFullYear(), slotCount: nextResult.slots.length },
        });
        if (nextResult.ok) availableSlots = nextResult.slots;
      }

      if (!slotsResult.ok) {
        if (slotsResult.error === 'SESSION_EXPIRED') {
          return { success: false, error: 'SESSION_EXPIRED' };
        }
        return { success: false, error: slotsResult.error ?? 'SLOTS_FETCH_FAILED', needsPlaywright: true };
      }
    }

    if (availableSlots.length === 0) {
      return { success: false, error: 'NO_SLOTS_IN_RESPONSE' };
    }

    // ═══ ÉTAPE 4 : Sélectionner le meilleur slot ═══
    // Trier par free décroissant — préférer les créneaux avec le plus de places libres.
    // groupSize > 1 : ne sélectionner que les créneaux avec free ≥ groupSize.
    // groupSize ≤ 1 ou absent : préférer ≥ 3 places (comportement historique), fallback au max dispo.
    const minFree = groupSize && groupSize > 1 ? groupSize : 3;
    availableSlots.sort((a, b) => (b.free ?? 1) - (a.free ?? 1));
    const slotsWithMinFree = availableSlots.filter(s => (s.free ?? 1) >= minFree);
    if (groupSize && groupSize > 1 && slotsWithMinFree.length === 0) {
      botLog({
        applicationId: clientId,
        step: 'cev_http_group_size_no_match',
        status: 'ok',
        data: { groupSize, bestFree: availableSlots[0]?.free ?? 1, totalSlots: availableSlots.length },
      });
      return { success: false, error: 'NO_SLOT_WITH_ENOUGH_FREE_PLACES' };
    }
    const slot = (slotsWithMinFree.length > 0 ? slotsWithMinFree : availableSlots)[0];
    botLog({
      applicationId: clientId,
      step: 'cev_http_slot_selected',
      status: 'ok',
      data: {
        date: slot.date, time: slot.time, id: slot.id, free: slot.free ?? 1,
        groupSize: groupSize ?? null,
        minFreeRequired: minFree,
        totalSlots: availableSlots.length,
        slotsWithMinFree: slotsWithMinFree.length,
        allSlots: availableSlots.slice(0, 10).map(s => ({ date: s.date, time: s.time, free: s.free ?? 1 })),
      },
    });

    // Sans antiforgery token → Playwright peut lire le vrai DOM
    if (!antiForgeryToken) {
      botLog({
        applicationId: clientId,
        step: 'cev_http_no_antiforgery',
        status: 'warn',
        data: { hint: 'Token __RequestVerificationToken introuvable dans le HTML — fallback Playwright pour soumettre le form' },
      });
      return { success: false, error: 'NO_ANTIFORGERY_TOKEN', needsPlaywright: true };
    }

    // ═══ ÉTAPE 5 : Soumettre la sélection de slot ═══
    // Si on a un endpoint confirmé en mémoire → le passer en priorité (évite le multi-endpoint guess)
    const submitResult = await submitSlotSelection(
      sessionCookie,
      selectSlotUrl,
      ua,
      formAction,
      hiddenInputs,
      slot,
      clientId,
      siphoned,
      knownConfig?.submitEndpoint,    // preferredEndpoint — essayé en premier si connu
      selectSlotCookies,              // cookie complet (inclut __RequestVerificationToken anti-CSRF)
    );

    if (!submitResult.success) {
      const isSlotTaken = submitResult.error === 'SLOT_TAKEN';
      botLog({
        applicationId: clientId,
        step: 'cev_http_submit_failed',
        status: 'warn',
        data: {
          error: submitResult.error,
          finalUrl: submitResult.finalUrl,
          usedKnownEndpoint: !!knownConfig,
          isSlotTaken,
          hint: isSlotTaken
            ? 'Slot déjà pris (race condition) — réessayer avec le prochain créneau'
            : 'Endpoints de booking HTTP non confirmés — fallback Playwright recommandé',
        },
      });
      return { success: false, error: submitResult.error, needsPlaywright: !isSlotTaken };
    }

    // ═══ ÉTAPE 6 : Extraire le code de confirmation ═══
    const confirmationCode = extractConfirmationCode(submitResult.html);

    // ═══ AUTO-CONFIG : Persister la config découverte après le premier booking réussi ═══
    // Inférer les clés JSON depuis le slot.raw (pour AvailableTimeSlots future)
    const rawSlot = (slot.raw ?? {}) as Record<string, unknown>;
    const inferredDateKey = Object.keys(rawSlot).find((k) => rawSlot[k] === slot.date) ?? 'date';
    const inferredTimeKey = Object.keys(rawSlot).find((k) => rawSlot[k] === slot.time) ?? 'time';
    const inferredIdKey   = slot.id != null
      ? Object.keys(rawSlot).find((k) => String(rawSlot[k]) === String(slot.id))
      : undefined;

    const newConfig: CevDiscoveredConfig = {
      submitEndpoint:      submitResult.confirmedEndpoint!,
      availabilityDateKey: inferredDateKey,
      availabilityTimeKey: inferredTimeKey,
      availabilityIdKey:   inferredIdKey,
      confirmedAt:         Date.now(),
      successCount:        (knownConfig?.successCount ?? 0) + 1,
    };

    // Mettre à jour en mémoire immédiatement, puis persister dans Convex (fire-and-forget)
    _discoveredConfig = newConfig;
    saveCevBookingConfig(newConfig).catch((err) =>
      console.warn('[cevHttpBooking] saveCevBookingConfig error (non bloquant):', err)
    );

    botLog({
      applicationId: clientId,
      step: 'cev_http_booking_confirmed',
      status: 'ok',
      data: {
        finalUrl:            submitResult.finalUrl,
        confirmationCode:    confirmationCode ?? 'non extrait',
        date:                slot.date,
        time:                slot.time,
        confirmedEndpoint:   submitResult.confirmedEndpoint,
        autoConfigSaved:     true,
        successCount:        newConfig.successCount,
        htmlPreview:         submitResult.html.slice(0, 2000),
      },
    });

    return {
      success: true,
      confirmationCode: confirmationCode ?? undefined,
      bookedDate: slot.date,
      bookedTime: slot.time,
    };

  } catch (err) {
    botLog({
      applicationId: clientId,
      step: 'cev_http_booking_crash',
      status: 'fail',
      data: { error: String(err) },
    });
    return { success: false, error: String(err), needsPlaywright: true };
  }
}

/**
 * Réservation CEV en partant d'un slot DÉJÀ DÉTECTÉ (pas de polling/scan ici).
 * - Ouvre la page SelectSlot (redirections suivies)
 * - Extrait le token et les champs cachés
 * - Soumet directement la sélection avec le slot fourni
 * - Extrait le code de confirmation et persiste la config auto-découverte
 */
export async function bookCevSelectedSlotViaHttp(
  integrationUrl: string,
  sessionCookie: string,
  clientId: string,
  selected: SelectedSlotInput,
  siphoned?: SiphonedCookies,
  sessionUa?: string,
  /** Cookie string complet du setup (contient __RequestVerificationToken anti-CSRF ASP.NET) */
  selectSlotCookies?: string,
): Promise<HttpBookingResult> {
  const ua = siphoned?.userAgent ?? sessionUa ?? getCevSessionUa();

  botLog({
    applicationId: clientId,
    step: 'cev_http_booking_start_selected',
    status: 'ok',
    data: { integrationUrlPreview: integrationUrl.slice(0, 80), ua: ua.slice(0, 60), selected: { date: selected.date, time: selected.time, id: selected.id } },
  });

  try {
    // 1) Page SelectSlot
    const pageResult = await fetchFollowRedirects(integrationUrl, sessionCookie, ua, siphoned);

    botLog({
      applicationId: clientId,
      step: 'cev_http_selectslot_fetched_selected',
      status: pageResult.ok ? 'ok' : 'warn',
      data: {
        finalUrl: pageResult.url,
        httpStatus: pageResult.status,
        htmlLen: pageResult.html.length,
        error: pageResult.error ?? null,
      },
    });

    if (!pageResult.ok) {
      return { success: false, error: pageResult.error ?? 'FETCH_FAILED', needsPlaywright: true };
    }

    // Utiliser les cookies accumulés du GET comme fallback pour le POST anti-CSRF
    if (!selectSlotCookies && pageResult.accumulatedCookies) {
      selectSlotCookies = pageResult.accumulatedCookies;
    }

    const { html, url: selectSlotUrl } = pageResult;

    if (
      selectSlotUrl.includes('SessionExpired') ||
      html.toLowerCase().includes('session expired') ||
      selectSlotUrl.includes('/Captcha') ||
      html.includes('SetCaptchaToken') ||
      html.includes('class="h-captcha"') ||
      html.includes("class='h-captcha'")
    ) {
      return { success: false, error: 'SESSION_EXPIRED_OR_CAPTCHA', needsPlaywright: false };
    }

    // 2) Discovery minimale
    const knownConfig = _discoveredConfig;
    const antiForgeryToken = extractAntiForgeryToken(html);
    const formAction       = knownConfig ? null : extractFormAction(html);
    const hiddenInputs     = extractHiddenInputs(html);

    if (!antiForgeryToken) {
      botLog({ applicationId: clientId, step: 'cev_http_no_antiforgery_selected', status: 'warn' });
      return { success: false, error: 'NO_ANTIFORGERY_TOKEN', needsPlaywright: true };
    }

    // 3) Soumission directe avec le slot fourni
    const parsed: ParsedSlot = {
      date: selected.date,
      time: selected.time,
      id: selected.id,
      available: true,
      raw: selected.raw ?? { date: selected.date, time: selected.time, id: selected.id },
    };

    const submitResult = await submitSlotSelection(
      sessionCookie,
      selectSlotUrl,
      ua,
      formAction,
      hiddenInputs,
      parsed,
      clientId,
      siphoned,
      knownConfig?.submitEndpoint,
      selectSlotCookies,
    );

    if (!submitResult.success) {
      botLog({
        applicationId: clientId,
        step: 'cev_http_submit_failed_selected',
        status: 'warn',
        data: { error: submitResult.error, finalUrl: submitResult.finalUrl, usedKnownEndpoint: !!knownConfig },
      });
      return { success: false, error: submitResult.error, needsPlaywright: true };
    }

    // 4) Confirmation + auto-config
    const confirmationCode = extractConfirmationCode(submitResult.html);

    const rawSlot = (parsed.raw ?? {}) as Record<string, unknown>;
    const inferredDateKey = Object.keys(rawSlot).find((k) => rawSlot[k] === parsed.date) ?? 'date';
    const inferredTimeKey = Object.keys(rawSlot).find((k) => rawSlot[k] === parsed.time) ?? 'time';
    const inferredIdKey   = parsed.id != null
      ? Object.keys(rawSlot).find((k) => String(rawSlot[k]) === String(parsed.id))
      : undefined;

    const newConfig: CevDiscoveredConfig = {
      submitEndpoint:      submitResult.confirmedEndpoint!,
      availabilityDateKey: inferredDateKey,
      availabilityTimeKey: inferredTimeKey,
      availabilityIdKey:   inferredIdKey,
      confirmedAt:         Date.now(),
      successCount:        (knownConfig?.successCount ?? 0) + 1,
    };

    _discoveredConfig = newConfig;
    saveCevBookingConfig(newConfig).catch((err) =>
      console.warn('[cevHttpBooking] saveCevBookingConfig error (non bloquant):', err)
    );

    botLog({
      applicationId: clientId,
      step: 'cev_http_booking_confirmed_selected',
      status: 'ok',
      data: {
        finalUrl: submitResult.finalUrl,
        confirmationCode: confirmationCode ?? 'non extrait',
        date: parsed.date,
        time: parsed.time,
        confirmedEndpoint: submitResult.confirmedEndpoint,
        autoConfigSaved: true,
        successCount: newConfig.successCount,
      },
    });

    return {
      success: true,
      confirmationCode: confirmationCode ?? undefined,
      bookedDate: parsed.date,
      bookedTime: parsed.time,
    };
  } catch (err) {
    botLog({ applicationId: clientId, step: 'cev_http_booking_crash_selected', status: 'fail', data: { error: String(err) } });
    return { success: false, error: String(err), needsPlaywright: true };
  }
}
