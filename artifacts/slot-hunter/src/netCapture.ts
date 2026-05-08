/**
 * netCapture.ts — Intercepteur réseau complet (style mitmproxy)
 *
 * Capture TOUT le trafic HTTP des domaines diplomatie.be depuis Playwright :
 *   - visaonweb.diplomatie.be      (VOWINT / AngularJS)
 *   - appointment.cloud.diplomatie.be  (CEV)
 *
 * Pour chaque requête → log Convex avec :
 *   method, url, requestHeaders, requestBody,
 *   responseStatus, responseHeaders, responseBody (2 000 chars max)
 *
 * Usage :
 *   const capture = attachNetCapture(context, applicationId);
 *   // ... navigation Playwright ...
 *   capture.dump();   // log récapitulatif final
 *   capture.entries() // accès aux données brutes
 */

import type { BrowserContext, Request, Response } from 'playwright';
import { botLog } from './convexClient.js';

const WATCHED_DOMAINS = [
  'visaonweb.diplomatie.be',
  'appointment.cloud.diplomatie.be',
];

// Types de ressources à capturer — on ignore les assets statiques (CSS, fonts, images, scripts).
// On garde uniquement les appels XHR/fetch (AJAX) et les navigations HTML (document).
// Cela réduit typiquement le bruit de ~100 entrées à ~10 appels exploitables pour le reversing.
const CAPTURED_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'document']);

const MAX_BODY_LEN = 2_000;

export interface NetEntry {
  id: number;
  timestamp: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  durationMs: number | null;
}

export interface NetCapture {
  entries: () => NetEntry[];
  dump: () => void;
}

function isWatched(url: string, resourceType: string): boolean {
  return (
    WATCHED_DOMAINS.some(d => url.includes(d)) &&
    CAPTURED_RESOURCE_TYPES.has(resourceType)
  );
}

function sanitizeHeaders(raw: Record<string, string>): Record<string, string> {
  const sensitive = new Set(['cookie', 'set-cookie', 'authorization']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = sensitive.has(k.toLowerCase())
      ? `[REDACTED len=${v.length}]`   // longueur visible, valeur masquée
      : v;
  }
  return out;
}

export function attachNetCapture(
  context: BrowserContext,
  applicationId: string,
): NetCapture {
  let seq = 0;
  const map = new Map<string, NetEntry>();
  const list: NetEntry[] = [];

  context.on('request', (req: Request) => {
    if (!isWatched(req.url(), req.resourceType())) return;

    const id = ++seq;
    const entry: NetEntry = {
      id,
      timestamp: Date.now(),
      method: req.method(),
      url: req.url(),
      requestHeaders: sanitizeHeaders(req.headers()),
      requestBody: req.postData() ?? null,
      responseStatus: null,
      responseHeaders: null,
      responseBody: null,
      durationMs: null,
    };

    // Clé de déduplication : méthode + URL + timestamp tronqué à la seconde
    const key = `${req.method()}|${req.url()}|${Math.floor(entry.timestamp / 1000)}`;
    map.set(key, entry);
    list.push(entry);

    // Log immédiat de la requête
    botLog({
      applicationId,
      step: 'net_request',
      status: 'ok',
      data: {
        id,
        method: entry.method,
        url: entry.url,
        body: entry.requestBody?.slice(0, MAX_BODY_LEN) ?? null,
        headers: entry.requestHeaders,
      },
    });
  });

  context.on('response', async (res: Response) => {
    if (!isWatched(res.url(), res.request().resourceType())) return;

    const now = Date.now();
    const key = `${res.request().method()}|${res.url()}|${Math.floor((now - 5_000) / 1000)}`;

    // Chercher l'entrée correspondante (dans les 5 dernières secondes)
    let entry: NetEntry | undefined;
    for (let t = 0; t <= 5; t++) {
      const k = `${res.request().method()}|${res.url()}|${Math.floor((now - t * 1000) / 1000)}`;
      if (map.has(k)) { entry = map.get(k)!; break; }
    }

    // Lire le corps de la réponse
    let body: string | null = null;
    try {
      const ct = res.headers()['content-type'] ?? '';
      if (ct.includes('json') || ct.includes('text') || ct.includes('html') || ct.includes('javascript')) {
        const raw = await res.text().catch(() => null);
        body = raw ? raw.slice(0, MAX_BODY_LEN) : null;
      } else {
        body = `[binary content-type: ${ct}]`;
      }
    } catch { body = '[unreadable]'; }

    if (entry) {
      entry.responseStatus = res.status();
      entry.responseHeaders = sanitizeHeaders(res.headers());
      entry.responseBody = body;
      entry.durationMs = now - entry.timestamp;
    }

    // Log de la réponse — toujours logué même si on n'a pas trouvé la requête
    botLog({
      applicationId,
      step: 'net_response',
      status: res.status() >= 400 ? 'warn' : 'ok',
      data: {
        id: entry?.id ?? null,
        method: res.request().method(),
        url: res.url(),
        status: res.status(),
        durationMs: entry?.durationMs ?? null,
        responseHeaders: sanitizeHeaders(res.headers()),
        body,
        // Clés importantes si c'est du JSON
        parsedKeys: (() => {
          try {
            const p = JSON.parse(body ?? 'null');
            return p && typeof p === 'object' && !Array.isArray(p) ? Object.keys(p) : null;
          } catch { return null; }
        })(),
      },
    });
  });

  return {
    entries: () => [...list],
    dump: () => {
      const summary = list.map(e => ({
        id: e.id,
        method: e.method,
        url: e.url.replace('https://', '').slice(0, 100),
        status: e.responseStatus ?? 'pending',
        durationMs: e.durationMs,
      }));
      botLog({
        applicationId,
        step: 'net_capture_summary',
        status: 'ok',
        data: { totalRequests: list.length, requests: summary },
      });
    },
  };
}
