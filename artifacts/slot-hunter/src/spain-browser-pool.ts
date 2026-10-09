/**
 * spain-browser-pool.ts — Pool de navigateurs Chromium PAR DOSSIER (mode SPAIN_BROWSER_SESSION).
 *
 * CONTEXTE : le portail citaconsular.es (São Paulo, Kinshasa, Cuba…) sert un challenge
 * Cloudflare chl_page interactif que l'HTTP-pur (impit + CapSolver) ne peut pas franchir
 * (cf_clearance non rejouable hors du contexte TLS/JS qui l'a généré). Seul un vrai navigateur
 * franchit CF ET charge le widget. Validé (voir .agents/memory/cf-chl-page-mechanism-research.md).
 *
 * ARCHITECTURE : 1 Chromium par dossier (userDataDir distinct + proxy Decodo réservé du dossier),
 * instance isolée de SpainPersistentBrowserManager (classe rendue multi-instanciable). Chaque
 * instance franchit CF via la chorégraphie éprouvée (solveCfChallenge + clic Continuar + capture
 * /main/), garde la page chaude, et sert les appels Bookitit IN-PAGE via jQuery natif.
 *
 * Le worker (runDossierWorker) reste IDENTIQUE : on produit une SpainCfSession
 * { source:"playwright", _ownPageFetcher, bookititState } et callDirect route les appels
 * Bookitit vers la page quand source==="playwright" (voir spain-bookitit-direct.ts).
 *
 * Gated par SPAIN_BROWSER_SESSION=1 (OFF par défaut → prod HTTP capsolver-residential inchangée).
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Impit } from "impit";
import type { SpainCfSession } from "./spain-soax-solver.js";
import { SpainPersistentBrowserManager } from "./_legacy_spain-persistent-browser.js";

/** Mode navigateur activé ? (interrupteur global réversible, OFF par défaut). */
export function isBrowserSessionMode(): boolean {
  return process.env.SPAIN_BROWSER_SESSION === "1";
}

/** Nombre max de navigateurs simultanés (garde-fou mémoire). Railway Pro 32Go → défaut 12. */
const BROWSER_MAX = ((): number => {
  const v = Number(process.env.SPAIN_BROWSER_MAX ?? "12");
  return Math.max(1, Number.isFinite(v) ? Math.round(v) : 12);
})();

interface PoolEntry {
  manager: SpainPersistentBrowserManager;
  profileDir: string;
  createdAt: number;
}

const _pool = new Map<string, PoolEntry>();

function profileDirForDossier(dossierId: string): string {
  const safe = dossierId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return join(tmpdir(), `spain-cf-${safe}`);
}

/** Nombre de navigateurs actuellement ouverts dans le pool. */
export function browserPoolSize(): number {
  return _pool.size;
}

/**
 * Construit le bookititState déterministe pour un portail citaconsular.es.
 * widgetUrl = portalUrl (avec trailing slash), publickey extraite, srvsrc/version/bookititBase fixes.
 * jqCallback/reqCounter sont fournis mais NON utilisés par l'appel in-page (jQuery natif gère son
 * propre callback) — ils satisfont le type et servent au fallback impit éventuel.
 */
function buildBrowserBookititState(portalUrl: string): NonNullable<SpainCfSession["bookititState"]> {
  const widgetUrl = portalUrl.replace(/\/?$/, "/");
  const publickey = portalUrl.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
  return {
    jqCallback: `jQuery21109${Date.now()}_${Math.floor(Math.random() * 1e9)}`,
    reqCounter: Date.now(),
    srvsrc: "https://www.citaconsular.es",
    version: "4",
    widgetUrl,
    publickey,
    bookititBase: "https://www.citaconsular.es/onlinebookings",
  };
}

/**
 * Obtient (ou crée) la session navigateur d'un dossier : lance SON Chromium (userDataDir +
 * proxy dédiés), franchit CF, charge le widget, et renvoie une SpainCfSession prête pour le
 * worker avec source="playwright", _ownPageFetcher lié à SA page, et bookititState.
 *
 * @param dossierId  identifiant du dossier (→ userDataDir isolé).
 * @param portalUrl  URL du portail SANS fragment.
 * @param proxyUrl   proxy Decodo réservé du dossier (sticky).
 * @returns la session, ou null si le franchissement CF a échoué.
 */
export async function getBrowserDossierSession(
  dossierId: string,
  portalUrl: string,
  proxyUrl: string,
): Promise<SpainCfSession | null> {
  let entry = _pool.get(dossierId);
  if (!entry) {
    if (_pool.size >= BROWSER_MAX) {
      console.warn(`[browser-pool] ⚠️ Pool plein (${_pool.size}/${BROWSER_MAX}) — dossier ${dossierId} refusé ce cycle`);
      return null;
    }
    const profileDir = profileDirForDossier(dossierId);
    const manager = new SpainPersistentBrowserManager({
      profileDir,
      proxyUrl,
      syncGlobalSession: false, // CRITIQUE multi-instances : ne pas écraser le slot session global
    });
    entry = { manager, profileDir, createdAt: Date.now() };
    _pool.set(dossierId, entry);
    console.log(`[browser-pool] 🆕 Navigateur dossier ${dossierId} (${_pool.size}/${BROWSER_MAX}) — profile ${profileDir}`);
  }

  const base = await entry.manager.ensureSession(portalUrl);
  if (!base) {
    console.warn(`[browser-pool] ❌ ensureSession échoué pour ${dossierId}`);
    return null;
  }

  // Impit « fantôme » : JAMAIS utilisé pour fetch en mode navigateur (callDirect route
  // tout IN-PAGE via _ownPageFetcher avant de toucher ds.impit). Il existe uniquement pour
  // que buildDynamicSession() (qui exige _ownImpit) construise la DynamicSession sans null.
  // On lui donne quand même le proxy du dossier par cohérence si un chemin impit était pris.
  const phantomImpit = base._ownImpit ?? new Impit({ browser: "chrome", proxyUrl, timeout: 120_000 } as any);

  // Attacher le fetcher in-page de CETTE instance + un bookititState déterministe.
  const session: SpainCfSession = {
    ...base,
    source: "playwright",
    portalKey: portalUrl.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? base.portalKey,
    bookititState: base.bookititState ?? buildBrowserBookititState(portalUrl),
    _ownImpit: phantomImpit,
    _ownPageFetcher: (url: string) => entry!.manager.callBookititJqOnPage(url).then((s) => s || null),
  };

  // Rafraîchisseur PHP : imite le parcours complet du navigateur (comme le flux HTTP qui
  // refait GET widget → POST token → nouveau PHPSESSID à chaque cycle). refreshPhpSession()
  // supprime PHPSESSID + localStorage, re-navigue le widget SANS re-solver le CF (cf_clearance
  // conservé) et capture un PHPSESSID FRAIS. On resynchronise ensuite le nouveau PHPSESSID
  // (+ cf_clearance éventuellement renouvelé par CF) dans la session du worker, pour que
  // buildDynamicSession reconstruise un jar à jour au scan suivant.
  session._ownPhpRefresher = async (): Promise<boolean> => {
    // 1) Voie LÉGÈRE (~0.3-0.6s) : simple GET widget in-page → PHPSESSID frais via Set-Cookie,
    //    sans recharger le widget ni re-cliquer Continuar (prouvé suffisant par le shortscan HTTP).
    const light = await entry!.manager.refreshPhpSessionLight();
    if (light) {
      const refreshed = entry!.manager.getSession();
      if (refreshed) {
        session.allCookies = refreshed.allCookies;
        session.cfClearance = refreshed.cfClearance;
        session.phpSessionCreatedAt = refreshed.phpSessionCreatedAt;
      }
      return true;
    }
    // 2) Fallback LOURD (~8-21s) : parcours widget complet (delete + re-nav + Continuar + /main/).
    //    N'arrive que si le GET léger a échoué (CF re-challenge / PHPSESSID absent).
    console.warn(`[browser-pool] ⚠️ ${dossierId} refresh léger échoué → parcours widget complet (refreshPhpSession)`);
    const heavy = await entry!.manager.refreshPhpSession();
    if (!heavy) return false;
    const refreshed = entry!.manager.getSession();
    if (refreshed) {
      session.allCookies = refreshed.allCookies;
      session.cfClearance = refreshed.cfClearance;
      session.prefetchedMainHtml = refreshed.prefetchedMainHtml;
      session.phpSessionCreatedAt = refreshed.phpSessionCreatedAt;
    }
    return true;
  };

  return session;
}

/** Ferme et retire le navigateur d'un dossier (fin de worker). Idempotent. */
export async function closeBrowserDossierSession(dossierId: string): Promise<void> {
  const entry = _pool.get(dossierId);
  if (!entry) return;
  _pool.delete(dossierId);
  try {
    await entry.manager.close();
  } catch (e) {
    console.warn(`[browser-pool] ⚠️ close ${dossierId} (non-fatal): ${e}`);
  }
  console.log(`[browser-pool] 🧹 Navigateur dossier ${dossierId} fermé (${_pool.size} restants)`);
}
