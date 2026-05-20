/**
 * cev-shared-impit.ts — Singleton impit partagé entre cevHttpSetup et cevPolling.
 * 
 * Évite l'import circulaire : setup ↔ polling.
 * Les deux modules importent depuis ce fichier commun.
 */

import { Impit } from "impit";

const IPROYAL_PROXY_URL = process.env.IPROYAL_PROXY_URL;

/** Singleton impit avec proxy (fingerprint TLS Chrome) */
let _proxyImpit: InstanceType<typeof Impit> | undefined;
export function getProxyImpit(): InstanceType<typeof Impit> {
  if (!_proxyImpit) {
    const opts: Record<string, unknown> = { browser: "chrome", ignoreTlsErrors: true };
    if (IPROYAL_PROXY_URL) opts.proxyUrl = IPROYAL_PROXY_URL;
    _proxyImpit = new Impit(opts as any);
  }
  return _proxyImpit;
}

/** Singleton impit direct (sans proxy) — partagé entre setup ET polling.
 *  Garantit que la même connexion TLS est réutilisée → session ASP.NET stable. */
let _directImpit: InstanceType<typeof Impit> | undefined;
export function getDirectImpit(): InstanceType<typeof Impit> {
  if (!_directImpit) {
    _directImpit = new Impit({ browser: "chrome", ignoreTlsErrors: true } as any);
  }
  return _directImpit;
}

/** Fetch CEV via impit (proxy → fallback direct si proxy down) */
export async function cevImpitFetch(url: string, options: RequestInit, logPrefix = "[CEV]"): Promise<Response> {
  if (IPROYAL_PROXY_URL) {
    try {
      return await getProxyImpit().fetch(url, options as any) as unknown as Response;
    } catch {
      console.log(`${logPrefix} ⚠️ impit+proxy failed → fallback impit direct`);
      return getDirectImpit().fetch(url, options as any) as unknown as Response;
    }
  }
  return getDirectImpit().fetch(url, options as any) as unknown as Response;
}
