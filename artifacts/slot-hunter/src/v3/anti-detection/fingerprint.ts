/**
 * Fingerprint V3 — Cycling UA + headers cohérents par session.
 *
 * RESPONSABILITÉ UNIQUE :
 *   Assigner un profil fingerprint (UA, Accept-Language, Sec-CH-UA, platform)
 *   cohérent pour toute la durée d'un token JWT (60 min).
 *   Le profil change à chaque nouveau login (nouvelle session = nouveau fingerprint).
 *
 * RÈGLES :
 *   - Un compte garde le MÊME fingerprint pendant toute sa session (sticky)
 *   - Le fingerprint change au prochain login (pas au prochain scan)
 *   - Les profils sont basés sur un utilisateur Kinshasa (RDC) : français, Chrome/Edge
 *   - 7 profils cyclés par jour de la semaine (déterministe par username + date)
 *
 * ANTI-DÉTECTION :
 *   - Sec-CH-UA DOIT correspondre exactement à la version Chrome dans le UA
 *   - Accept-Language fixé par session (un vrai Chrome ne change jamais mid-session)
 *   - Accept-Encoding fixé (gzip, deflate, br, zstd)
 *   - Pas de randomisation par requête = pas de signal bot
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BrowserFingerprint {
  /** User-Agent complet. */
  ua: string;
  /** Sec-CH-UA header (doit matcher la version Chrome dans le UA). */
  secChUa: string;
  /** Sec-CH-UA-Platform (ex: "Windows", "macOS"). */
  platform: string;
  /** Accept-Language (ex: "fr-CD,fr;q=0.9,en;q=0.8"). */
  acceptLanguage: string;
  /** Accept-Encoding (fixe). */
  acceptEncoding: string;
}

// ─── Profils (7 jours, Kinshasa) ────────────────────────────────────────────

const PROFILES: BrowserFingerprint[] = [
  { // Jour 1 : Chrome 151 Windows — français générique
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="151", "Google Chrome";v="151", "Not-A.Brand";v="8"',
    platform: '"Windows"',
    acceptLanguage: "fr,fr-FR;q=0.9,en;q=0.8",
    acceptEncoding: "gzip, deflate, br, zstd",
  },
  { // Jour 2 : Chrome 151 Windows — français Congo
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="151", "Google Chrome";v="151", "Not-A.Brand";v="8"',
    platform: '"Windows"',
    acceptLanguage: "fr-CD,fr;q=0.9,en;q=0.8,ln;q=0.7",
    acceptEncoding: "gzip, deflate, br, zstd",
  },
  { // Jour 3 : Edge 151 Windows — Kinshasa
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
    secChUa: '"Chromium";v="151", "Microsoft Edge";v="151", "Not-A.Brand";v="8"',
    platform: '"Windows"',
    acceptLanguage: "fr,fr-CD;q=0.9,en;q=0.8",
    acceptEncoding: "gzip, deflate, br",
  },
  { // Jour 4 : Chrome 150 Windows
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="150", "Google Chrome";v="150", "Not-A.Brand";v="8"',
    platform: '"Windows"',
    acceptLanguage: "fr,en;q=0.9,fr-FR;q=0.8",
    acceptEncoding: "gzip, deflate, br, zstd",
  },
  { // Jour 5 : Chrome 150 macOS
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="150", "Google Chrome";v="150", "Not-A.Brand";v="8"',
    platform: '"macOS"',
    acceptLanguage: "fr,fr-FR;q=0.9,en-US;q=0.8,en;q=0.7",
    acceptEncoding: "gzip, deflate, br",
  },
  { // Jour 6 : Chrome 149 Windows — avec lingala
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="149", "Google Chrome";v="149", "Not-A.Brand";v="8"',
    platform: '"Windows"',
    acceptLanguage: "fr,fr-CD;q=0.9,ln;q=0.8,en;q=0.7",
    acceptEncoding: "gzip, deflate, br, zstd",
  },
  { // Jour 7 : Chrome 149 Windows — simple
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="149", "Google Chrome";v="149", "Not-A.Brand";v="8"',
    platform: '"Windows"',
    acceptLanguage: "fr-FR,fr;q=0.9,en;q=0.8",
    acceptEncoding: "gzip, deflate, br",
  },
];

// ─── État (per-account, sticky par session) ─────────────────────────────────

/** Map username → fingerprint assigné pour cette session. */
const sessionFingerprints = new Map<string, BrowserFingerprint>();

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Retourne le fingerprint assigné à un compte pour aujourd'hui.
 * Déterministe par (username + date) → même profil toute la journée.
 * Change au login du lendemain.
 */
export function getFingerprintForToday(username: string): BrowserFingerprint {
  const key = username.toLowerCase();
  
  // Si déjà assigné pour cette session → réutiliser
  if (sessionFingerprints.has(key)) {
    return sessionFingerprints.get(key)!;
  }

  // Calculer l'index basé sur le hash (username + date du jour)
  const today = new Date().toISOString().slice(0, 10);
  const seed = `${key}:${today}`;
  let hash = 0;
  for (const ch of seed) hash = ((hash << 5) - hash + ch.charCodeAt(0)) & 0x7fffffff;
  const index = hash % PROFILES.length;

  const fp = PROFILES[index];
  sessionFingerprints.set(key, fp);
  return fp;
}

/**
 * Force un fingerprint spécifique pour un compte (override admin).
 */
export function setFingerprint(username: string, fp: BrowserFingerprint): void {
  sessionFingerprints.set(username.toLowerCase(), fp);
}

/**
 * Efface le fingerprint assigné (au logout ou fin de session).
 * Le prochain appel à getFingerprintForToday() en assignera un nouveau.
 */
export function clearFingerprint(username: string): void {
  sessionFingerprints.delete(username.toLowerCase());
}

/**
 * Construit les headers HTTP complets à partir d'un fingerprint.
 * Utilisé par usaFetch pour chaque requête de la session.
 */
export function buildHeadersFromFingerprint(fp: BrowserFingerprint, referer: string): Record<string, string> {
  return {
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": fp.acceptEncoding,
    "Accept-Language": fp.acceptLanguage,
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Origin": "https://www.usvisaappt.com",
    "Referer": referer,
    "Sec-CH-UA": fp.secChUa,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": fp.platform,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": fp.ua,
  };
}

/**
 * Retourne tous les profils (pour debug/admin).
 */
export function getAllProfiles(): readonly BrowserFingerprint[] {
  return PROFILES;
}
