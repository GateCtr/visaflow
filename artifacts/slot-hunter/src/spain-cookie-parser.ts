/**
 * spain-cookie-parser — Parsing robuste de l'en-tête Set-Cookie (potentiellement
 * multi-cookies joints par virgule) SANS corrompre les valeurs contenant une virgule.
 *
 * PROBLÈME RÉSOLU
 *   L'ancien split `/,(?=[^ ])/` coupait sur TOUTE virgule non suivie d'espace.
 *   Or les PHPSESSID de certains portails Bookitit (ex. Kinshasa) contiennent une
 *   virgule littérale (ex. `PHPSESSID=Gn0w,I8x...`). Le split tronquait alors le
 *   PHPSESSID à `Gn0w` → cookie invalide envoyé à getsigninfields/ et signin/ →
 *   réponse 0B (session non reconnue). Les portails sans virgule (ex. Saopola)
 *   n'étaient pas affectés — d'où le comportement différent sur le MÊME code serveur.
 *
 * RÈGLE DE SÉPARATION
 *   Quand plusieurs Set-Cookie sont joints dans une seule chaîne, ils sont séparés par
 *   une virgule suivie du DÉBUT d'un nouveau cookie : `nom=`. On ne coupe donc QUE sur
 *   une virgule suivie (après espaces optionnels) d'un token de nom de cookie valide
 *   puis d'un `=`. Les virgules à l'intérieur d'une valeur (PHPSESSID), d'une valeur
 *   entre guillemets ou d'un attribut `Expires=...,` de date ne déclenchent pas de coupure.
 */

/** Nom de cookie valide (RFC 6265 token, jeu de caractères pragmatique). */
const COOKIE_NAME = "[A-Za-z0-9!#$%&'*+.^_`|~-]+";
const COOKIE_NAME_RE = new RegExp(`^${COOKIE_NAME}$`);

export type SetCookieDiagnosticEntry = {
  name: string;
  length: number;
  fingerprint: string;
  literalCommas: number;
  encodedCommas: number;
};

export type SetCookieDiagnostics = {
  rawLength: number;
  rawFingerprint: string;
  segmentCount: number;
  invalidSegmentCount: number;
  duplicateNames: string[];
  cookies: Record<string, string>;
  entries: SetCookieDiagnosticEntry[];
};

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function count(value: string, pattern: RegExp): number {
  return (value.match(pattern) ?? []).length;
}

/**
 * Sépare une chaîne Set-Cookie (éventuellement multi-cookies) en segments, un par
 * cookie, sans couper les virgules internes aux valeurs.
 */
function splitSetCookieHeader(raw: string): string[] {
  if (!raw) return [];
  // Certains runtimes joignent les Set-Cookie par des retours ligne : on les traite d'abord.
  const byLine = raw.split(/\r?\n/).filter((s) => s.trim() !== "");
  const out: string[] = [];
  for (const line of byLine) {
    // Ne pas utiliser un split global : certains portails renvoient une valeur
    // PHPSESSID non conforme contenant une virgule, et les valeurs entre guillemets
    // peuvent également contenir des virgules. On reconnaît donc les frontières
    // cookie par cookie, en ignorant les virgules entre guillemets.
    const boundary = new RegExp(`^\\s*(${COOKIE_NAME})=`);
    let start = 0;
    let quoted = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === "\"" && line[i - 1] !== "\\") {
        quoted = !quoted;
        continue;
      }
      if (char !== "," || quoted) continue;

      const candidate = line.slice(i + 1);
      if (!boundary.test(candidate)) continue;
      out.push(line.slice(start, i));
      start = i + 1;
    }
    out.push(line.slice(start));
  }
  return out;
}

function parseCookieSegment(segment: string): { name: string; value: string } | null {
  const trimmed = segment.trim();
  const separator = trimmed.indexOf("=");
  if (separator <= 0) return null;

  const name = trimmed.slice(0, separator).trim();
  if (!COOKIE_NAME_RE.test(name)) return null;

  // Un cookie peut être cité. Dans ce cas, un `;` à l'intérieur de la valeur
  // ne doit pas être confondu avec le début des attributs.
  let quoted = false;
  let valueEnd = trimmed.length;
  for (let i = separator + 1; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === "\"" && trimmed[i - 1] !== "\\") {
      quoted = !quoted;
      continue;
    }
    if (char === ";" && !quoted) {
      valueEnd = i;
      break;
    }
  }

  return {
    name,
    value: trimmed.slice(separator + 1, valueEnd),
  };
}

/**
 * Inspecte le contenu parsé sans jamais retourner une valeur sensible dans le
 * résumé destiné aux logs. `cookies` reste disponible pour le code de fusion ;
 * `entries` est la vue sûre à utiliser pour comparer raw et jar.
 */
export function inspectSetCookieHeader(
  raw: string | null | undefined,
): SetCookieDiagnostics {
  const source = raw ?? "";
  const segments = splitSetCookieHeader(source);
  const cookies: Record<string, string> = {};
  const entries: SetCookieDiagnosticEntry[] = [];
  const seen = new Set<string>();
  const duplicateNames = new Set<string>();
  let invalidSegmentCount = 0;

  for (const segment of segments) {
    const parsed = parseCookieSegment(segment);
    if (!parsed) {
      invalidSegmentCount++;
      continue;
    }
    if (seen.has(parsed.name)) duplicateNames.add(parsed.name);
    seen.add(parsed.name);
    cookies[parsed.name] = parsed.value;
    entries.push({
      name: parsed.name,
      length: parsed.value.length,
      fingerprint: fingerprint(parsed.value),
      literalCommas: count(parsed.value, /,/g),
      encodedCommas: count(parsed.value, /%2c/gi),
    });
  }

  return {
    rawLength: source.length,
    rawFingerprint: fingerprint(source),
    segmentCount: segments.length,
    invalidSegmentCount,
    duplicateNames: [...duplicateNames].sort(),
    cookies,
    entries,
  };
}

/**
 * Parse un en-tête Set-Cookie en map { nom: valeur }. Préserve les virgules internes
 * aux valeurs (ex. PHPSESSID contenant `,`). Ne conserve que la paire nom=valeur
 * (les attributs après `;` — path, expires, HttpOnly… — sont ignorés).
 *
 * @param raw  Valeur brute de l'en-tête `set-cookie` (peut être vide).
 * @returns    Map des cookies { nom: valeur }.
 */
export function parseSetCookies(raw: string | null | undefined): Record<string, string> {
  return inspectSetCookieHeader(raw).cookies;
}

/**
 * Variante prenant directement un objet `headers` (Fetch/impit Response).
 */
export function parseSetCookiesFromHeaders(
  headers: { get: (name: string) => string | null },
): Record<string, string> {
  return parseSetCookies(headers.get("set-cookie"));
}
