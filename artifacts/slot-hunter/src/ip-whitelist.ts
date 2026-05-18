/**
 * Auto-whitelist de l'IP serveur Railway chez les fournisseurs de proxy.
 *
 * - IPRoyal : ajout automatique via REST API (POST /whitelist-entries)
 *   avec configuration résidentielle sticky : country-cd, city-kinshasa,
 *   session sticky (8 chars aléatoires), lifetime 12h.
 * - 2Captcha Proxy : ajout IMPOSSIBLE via API — log l'URL du dashboard pour ajout manuel
 *
 * Variables d'environnement requises :
 *   IPROYAL_API_TOKEN       — Bearer token (Settings > API dans le dashboard IPRoyal)
 *   IPROYAL_USER_HASH       — Hash utilisateur résidentiel (visible dans l'URL du dashboard)
 *   IPROYAL_WHITELIST_PORT  — Port souhaité (défaut: 12321)
 *   IPROYAL_WHITELIST_PROTO — "http|https" ou "socks5" (défaut: "http|https")
 *   IPROYAL_WHITELIST_CONFIG— Configuration proxy complète (override)
 *                              Défaut: "_country-cd_city-kinshasa_session-{random8}_lifetime-59m"
 *
 * Format IPRoyal configuration (dans le champ password ou whitelist) :
 *   _country-{iso2}           — Code pays ISO 2 lettres (cd = Congo RDC)
 *   _city-{city}              — Ville cible (kinshasa)
 *   _session-{alphanumeric8}  — ID session sticky (8 chars aléatoires, même IP pendant lifetime)
 *   _lifetime-{duration}      — Durée de la session sticky (ex: 59m, 2h, 1d). Max 7 jours.
 *                                Un seul format de durée autorisé (s/m/h/d).
 *   _streaming-1              — Pool haute qualité (optionnel, consomme plus de bande passante)
 *
 * Docs : https://docs.iproyal.com/proxies/residential/proxy/rotation
 *        https://docs.iproyal.com/proxies/residential/proxy/location
 *        https://docs.iproyal.com/proxies/residential/api/whitelists
 */

// ─── IPRoyal Whitelist API ──────────────────────────────────────────────────

/**
 * Génère un ID de session aléatoire alphanumérique de 8 caractères
 * (requis par IPRoyal pour les sessions sticky).
 */
function generateSessionId(length: number = 8): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Construit la configuration IPRoyal par défaut pour le whitelist :
 * _country-cd_city-kinshasa_session-{random8}_lifetime-12h
 *
 * Cette configuration assure :
 * - IP résidentielle depuis Kinshasa, RDC (géolocalisation cohérente avec le consulat)
 * - Session sticky : même IP pendant 12 heures (comportement WiFi résidentiel naturel)
 * - Lifetime 12h (même IP pour toute la demi-journée de scan)
 */
function buildDefaultIproyalConfig(): string {
  const sessionId = generateSessionId(8);
  return `_country-cd_city-kinshasa_session-${sessionId}_lifetime-12h`;
}

interface IProyalWhitelistEntry {
  hash: string;
  ip: string;
  port: string;
  type: string;
  configuration: string;
}

interface IProyalWhitelistResult {
  ok: boolean;
  entry?: IProyalWhitelistEntry;
  error?: string;
  alreadyExists?: boolean;
}

/**
 * Liste les entrées whitelist existantes chez IPRoyal.
 */
async function listIproyalWhitelistEntries(
  apiToken: string,
  userHash: string,
): Promise<IProyalWhitelistEntry[]> {
  const url = `https://resi-api.iproyal.com/v1/residential-users/${userHash}/whitelist-entries`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[ip-whitelist] IPRoyal GET whitelist failed: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json() as { data?: IProyalWhitelistEntry[] } | IProyalWhitelistEntry[];
    // L'API peut retourner { data: [...] } ou directement [...]
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    return [];
  } catch (err) {
    console.error(`[ip-whitelist] IPRoyal list whitelist error:`, err);
    return [];
  }
}

/**
 * Supprime une entrée whitelist chez IPRoyal par son hash.
 */
async function deleteIproyalWhitelistEntry(
  apiToken: string,
  userHash: string,
  entryHash: string,
): Promise<boolean> {
  const url = `https://resi-api.iproyal.com/v1/residential-users/${userHash}/whitelist-entries/${entryHash}`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok || res.status === 204;
  } catch (err) {
    console.error(`[ip-whitelist] IPRoyal delete entry ${entryHash} failed:`, err);
    return false;
  }
}

/**
 * Ajoute l'IP à la whitelist IPRoyal via l'API REST.
 * Si l'IP est déjà whitelistée, retourne ok: true + alreadyExists: true.
 * Optionnellement nettoie les anciennes entrées (IPs précédentes Railway).
 */
async function addIproyalWhitelistEntry(
  ip: string,
  apiToken: string,
  userHash: string,
  port: number = 12321,
  proto: string = "http|https",
  configuration: string = "",
): Promise<IProyalWhitelistResult> {
  const url = `https://resi-api.iproyal.com/v1/residential-users/${userHash}/whitelist-entries`;

  try {
    // 1. Vérifier si l'IP est déjà whitelistée
    const existing = await listIproyalWhitelistEntries(apiToken, userHash);
    const alreadyExists = existing.find((e) => e.ip === ip);
    if (alreadyExists) {
      console.log(`[ip-whitelist] ✅ IPRoyal: IP ${ip} déjà whitelistée (hash: ${alreadyExists.hash})`);
      return { ok: true, entry: alreadyExists, alreadyExists: true };
    }

    // 2. Nettoyer les anciennes entrées (IPs Railway périmées)
    //    On garde seulement les entrées qui ont une note "railway" ou "auto"
    //    pour ne pas supprimer les entrées manuelles de l'utilisateur.
    const autoEntries = existing.filter(
      (e) => e.ip !== ip // pas la nôtre (au cas où)
    );
    // Note: On ne supprime PAS automatiquement les anciennes entrées
    // car l'utilisateur pourrait avoir d'autres serveurs légitimes.
    // On log juste les entrées existantes pour information.
    if (autoEntries.length > 0) {
      console.log(
        `[ip-whitelist] IPRoyal: ${autoEntries.length} entrée(s) whitelist existante(s): ${autoEntries.map((e) => e.ip).join(", ")}`,
      );
    }

    // 3. Ajouter la nouvelle IP
    const body: Record<string, unknown> = { ip, port };
    if (configuration) body.configuration = configuration;
    body.note = `railway-auto-${new Date().toISOString().slice(0, 10)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok || res.status === 201) {
      const entry = (await res.json()) as IProyalWhitelistEntry;
      console.log(`[ip-whitelist] ✅ IPRoyal: IP ${ip} ajoutée à la whitelist (hash: ${entry.hash}, port: ${entry.port})`);
      return { ok: true, entry, alreadyExists: false };
    }

    // Gérer le cas "déjà existante" retourné comme erreur
    if (res.status === 422 || res.status === 409) {
      const errBody = await res.text();
      console.log(`[ip-whitelist] ℹ️ IPRoyal: IP ${ip} probablement déjà whitelistée (${res.status}): ${errBody}`);
      return { ok: true, alreadyExists: true };
    }

    const errText = await res.text();
    console.error(`[ip-whitelist] ❌ IPRoyal: Erreur HTTP ${res.status}: ${errText}`);
    return { ok: false, error: `HTTP ${res.status}: ${errText}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ip-whitelist] ❌ IPRoyal: Erreur réseau: ${msg}`);
    return { ok: false, error: msg };
  }
}

// ─── BrightData Whitelist API ────────────────────────────────────────────────

/**
 * Extraie le nom de zone depuis l'URL du proxy BrightData (BRIGHTDATA_RESIDENTIAL_PROXY_URL).
 * Format: http://brd-customer-XXX-zone-ZONENAME:password@host:port
 * Retourne le nom de zone ou undefined si non parsable.
 */
function extractBrightDataZone(): string | undefined {
  const proxyUrl = process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL;
  if (!proxyUrl) return undefined;
  try {
    const parsed = new URL(proxyUrl);
    const username = decodeURIComponent(parsed.username);
    const match = username.match(/-zone-([a-zA-Z0-9_]+)/);
    return match?.[1] ?? undefined;
  } catch {
    return undefined;
  }
}

interface BrightDataWhitelistResult {
  ok: boolean;
  error?: string;
  alreadyExists?: boolean;
}

/**
 * Ajoute l'IP à la whitelist BrightData via l'API REST.
 * POST https://api.brightdata.com/zone/whitelist
 * Body: { zone: "zone_name", ip: "x.x.x.x" }
 * Auth: Bearer API_KEY
 *
 * Si zone est undefined/null, on ne passe pas le champ zone → whitelist sur toutes les zones.
 */
async function addBrightDataWhitelistEntry(
  ip: string,
  apiKey: string,
  zone?: string | null,
): Promise<BrightDataWhitelistResult> {
  const url = "https://api.brightdata.com/zone/whitelist";

  try {
    const body: Record<string, unknown> = { ip };
    if (zone) body.zone = zone;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok || res.status === 201) {
      console.log(`[ip-whitelist] ✅ BrightData: IP ${ip} ajoutée à la whitelist (zone: ${zone || "toutes"})`);
      return { ok: true, alreadyExists: false };
    }

    // Handle "already whitelisted" or "duplicate" responses
    if (res.status === 409 || res.status === 422) {
      const errBody = await res.text();
      // BrightData may return 422 if IP is already in allowlist
      if (errBody.toLowerCase().includes("already") || errBody.toLowerCase().includes("exist")) {
        console.log(`[ip-whitelist] ✅ BrightData: IP ${ip} déjà whitelistée (${res.status})`);
        return { ok: true, alreadyExists: true };
      }
      console.warn(`[ip-whitelist] ⚠️ BrightData: HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${res.status}: ${errBody.slice(0, 200)}` };
    }

    // Handle 200 response with body (some APIs return 200 even for "already exists")
    if (res.status === 200) {
      const respBody = await res.text();
      console.log(`[ip-whitelist] ✅ BrightData: IP ${ip} whitelist OK (200): ${respBody.slice(0, 100)}`);
      return { ok: true, alreadyExists: false };
    }

    const errText = await res.text();
    console.error(`[ip-whitelist] ❌ BrightData: Erreur HTTP ${res.status}: ${errText.slice(0, 200)}`);
    return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ip-whitelist] ❌ BrightData: Erreur réseau: ${msg}`);
    return { ok: false, error: msg };
  }
}

// ─── Orchestrateur ──────────────────────────────────────────────────────────

export interface WhitelistResult {
  ip: string;
  iproyal: { ok: boolean; message: string };
  brightdata: { ok: boolean; message: string };
  twocaptcha: { ok: boolean; message: string };
}

/**
 * Auto-whitelist l'IP Railway chez tous les fournisseurs configurés.
 * Appelé au démarrage du slot-hunter après détection de l'IP.
 */
export async function autoWhitelistIp(serverIp: string): Promise<WhitelistResult> {
  const result: WhitelistResult = {
    ip: serverIp,
    iproyal: { ok: false, message: "non configuré" },
    brightdata: { ok: false, message: "non configuré" },
    twocaptcha: { ok: false, message: "non configuré" },
  };

  // ── IPRoyal ────────────────────────────────────────────────────────────────
  const iproyalToken = process.env.IPROYAL_API_TOKEN;
  const iproyalHash = process.env.IPROYAL_USER_HASH;

  if (iproyalToken && iproyalHash) {
    const port = parseInt(process.env.IPROYAL_WHITELIST_PORT || "12321", 10);
    const proto = process.env.IPROYAL_WHITELIST_PROTO || "http|https";
    // Configuration par défaut : sticky session depuis Kinshasa, RDC, 59 min
    // Override possible via IPROYAL_WHITELIST_CONFIG
    const config = process.env.IPROYAL_WHITELIST_CONFIG || buildDefaultIproyalConfig();

    console.log(`[ip-whitelist] 🌐 IPRoyal: Ajout IP ${serverIp} à la whitelist...`);
    console.log(`[ip-whitelist]    Config: ${config}`);
    const iproyalResult = await addIproyalWhitelistEntry(
      serverIp,
      iproyalToken,
      iproyalHash,
      port,
      proto,
      config,
    );

    if (iproyalResult.ok) {
      result.iproyal = {
        ok: true,
        message: iproyalResult.alreadyExists
          ? `IP déjà whitelistée`
          : `IP ajoutée (hash: ${iproyalResult.entry?.hash})`,
      };
    } else {
      result.iproyal = { ok: false, message: iproyalResult.error || "Erreur inconnue" };
    }
  } else {
    const missing = [];
    if (!iproyalToken) missing.push("IPROYAL_API_TOKEN");
    if (!iproyalHash) missing.push("IPROYAL_USER_HASH");
    result.iproyal = { ok: false, message: `Variable(s) manquante(s): ${missing.join(", ")}` };
    console.log(`[ip-whitelist] ⚠️ IPRoyal: auto-whitelist désactivée (${missing.join(" + ")} absent)`);
  }

  // ── BrightData ──────────────────────────────────────────────────────────────
  // API: POST https://api.brightdata.com/zone/whitelist
  // Body: { zone: "residential_proxy1", ip: "x.x.x.x" }
  // Auth: Bearer BRIGHTDATA_API_KEY
  const brightdataApiKey = process.env.BRIGHTDATA_API_KEY;
  const brightdataZone = process.env.BRIGHTDATA_ZONE_NAME || extractBrightDataZone();

  if (brightdataApiKey) {
    console.log(`[ip-whitelist] 🌐 BrightData: Ajout IP ${serverIp} à la whitelist (zone: ${brightdataZone || "toutes"})...`);
    const bdResult = await addBrightDataWhitelistEntry(serverIp, brightdataApiKey, brightdataZone);
    if (bdResult.ok) {
      result.brightdata = {
        ok: true,
        message: bdResult.alreadyExists
          ? `IP déjà whitelistée`
          : `IP ajoutée à la zone ${brightdataZone || "(toutes)"}`,
      };
    } else {
      result.brightdata = { ok: false, message: bdResult.error || "Erreur inconnue" };
    }
  } else {
    result.brightdata = { ok: false, message: "BRIGHTDATA_API_KEY absent" };
    console.log(`[ip-whitelist] ⚠️ BrightData: auto-whitelist désactivée (BRIGHTDATA_API_KEY absent)`);
  }

  // ── 2Captcha Proxy ─────────────────────────────────────────────────────────
  // Mode gateway (eu.proxy.2captcha.com:2334) : auth par user:pass, PAS de whitelist IP.
  // On vérifie simplement que la clé API est présente.
  const twoCaptchaKey = process.env.TWOCAPTCHA_API_KEY;

  if (twoCaptchaKey) {
    result.twocaptcha = {
      ok: true,
      message: `Gateway mode ✅ — auth user:pass via eu.proxy.2captcha.com:2334 (whitelist IP NON requise)`,
    };
    console.log(`[ip-whitelist] ✅ 2Captcha: Mode gateway — whitelist IP non requise (auth credentials)`);
  } else {
    result.twocaptcha = { ok: false, message: "TWOCAPTCHA_API_KEY absent" };
  }

  return result;
}

/**
 * Nettoie les anciennes IPs Railway de la whitelist IPRoyal.
 * Garde uniquement l'IP actuelle, supprime les entrées avec note "railway-auto-*".
 */
export async function cleanupOldIproyalWhitelistEntries(
  currentIp: string,
): Promise<{ removed: number; kept: number }> {
  const iproyalToken = process.env.IPROYAL_API_TOKEN;
  const iproyalHash = process.env.IPROYAL_USER_HASH;

  if (!iproyalToken || !iproyalHash) {
    return { removed: 0, kept: 0 };
  }

  const entries = await listIproyalWhitelistEntries(iproyalToken, iproyalHash);
  let removed = 0;
  let kept = 0;

  for (const entry of entries) {
    if (entry.ip === currentIp) {
      kept++;
      continue;
    }
    // On ne supprime que les entrées qui n'ont pas l'IP actuelle
    // Pour être safe, on ne supprime PAS automatiquement — juste un log
    // Décommenter la ligne ci-dessous pour activer le nettoyage automatique :
    // const deleted = await deleteIproyalWhitelistEntry(iproyalToken, iproyalHash, entry.hash);
    // if (deleted) removed++;
    console.log(`[ip-whitelist] ℹ️ IPRoyal: ancienne entrée ${entry.ip}:${entry.port} (hash: ${entry.hash}) — non supprimée (sécurité)`);
    kept++;
  }

  return { removed, kept };
}
