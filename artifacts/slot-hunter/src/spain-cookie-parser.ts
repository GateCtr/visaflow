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

/**
 * Parse un en-tête Set-Cookie en map { nom: valeur }. Préserve les virgules internes
 * aux valeurs (ex. PHPSESSID contenant `,`). Ne conserve que la paire nom=valeur
 * (les attributs après `;` — path, expires, HttpOnly… — sont ignorés).
 *
 * @param raw  Valeur brute de l'en-tête `set-cookie` (peut être vide).
 * @returns    Map des cookies { nom: valeur }.
 */
export function parseSetCookies(raw: string | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw) return result;
  for (const segment of splitSetCookieHeader(raw)) {
    // Première paire `nom=valeur` du segment, valeur = tout jusqu'au premier `;`.
    const m = segment.trim().match(/^([^=;]+)=([^;]*)/);
    if (m) result[m[1].trim()] = m[2];
  }
  return result;
}

/**
 * Variante prenant directement un objet `headers` (Fetch/impit Response).
 */
export function parseSetCookiesFromHeaders(
  headers: { get: (name: string) => string | null },
): Record<string, string> {
  return parseSetCookies(headers.get("set-cookie"));
}
