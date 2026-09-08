/**
 * spain-captcha-detect — Détection ROBUSTE et DYNAMIQUE du hCaptcha d'un portail Bookitit.
 *
 * POURQUOI dynamique et pas le flag WidgetConfiguration.captcha :
 *   Constat terrain (2026-09) : Cuba affiche un hCaptcha visible sur le formulaire de
 *   connexion MAIS getwidgetconfigurations/ renvoie captcha=0. Le flag n'est donc PAS
 *   fiable. De plus, le sitekey varie potentiellement par portail — le coder en dur
 *   (celui de Cuba) risque un token invalide sur un autre portail.
 *
 *   → On extrait le sitekey directement du contenu réel du portail (HTML /main/,
 *     réponse getsigninfields/, ou config widget), avec plusieurs patterns.
 *
 * COMPORTEMENT SERVEUR CONFIRMÉ (test manuel Cuba, 2026-09) :
 *   Le serveur valide login/password AVANT le hCaptcha. Avec de mauvais identifiants,
 *   il renvoie « Usuario o contraseña incorrectos » SANS vérifier le captcha. Le token
 *   hCaptcha (gct) n'est réellement exigé qu'avec des identifiants valides — d'où le
 *   signin/ → 0B en prod (vrais credentials + captcha manquant) alors que les tests à
 *   faux credentials ne l'atteignent jamais.
 */

/** Sitekey hCaptcha = UUID v4-like (hex 8-4-4-4-12). */
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Patterns d'extraction du sitekey hCaptcha, du plus spécifique au plus large.
 * Chaque pattern capture le sitekey dans le groupe 1.
 */
const SITEKEY_PATTERNS: RegExp[] = [
  // data-sitekey="<uuid>" (rendu widget hCaptcha classique)
  new RegExp(`data-sitekey=["'](${UUID_RE})["']`, "i"),
  // "sitekey":"<uuid>" ou sitekey: '<uuid>' (config JS)
  new RegExp(`sitekey["'\\s:=]+["'](${UUID_RE})["']`, "i"),
  // hcaptcha.render(..., { sitekey: "<uuid>" }) — sitekey proche du mot hcaptcha
  new RegExp(`hcaptcha[\\s\\S]{0,200}?(${UUID_RE})`, "i"),
  // ?sitekey=<uuid> dans une URL d'iframe hCaptcha
  new RegExp(`sitekey=(${UUID_RE})`, "i"),
  // captcha_sitekey / captchaSitekey : "<uuid>" (clés de config Bookitit possibles)
  new RegExp(`captcha[_-]?sitekey["'\\s:=]+["']?(${UUID_RE})`, "i"),
];

/** Indices textuels de présence d'un hCaptcha (sans forcément le sitekey). */
const HCAPTCHA_MARKERS = [
  /hcaptcha\.com/i,
  /\bh-captcha\b/i,
  /hcaptcha/i,
  /js\.hcaptcha/i,
];

export interface CaptchaDetection {
  /** true si un hCaptcha a été détecté (marqueur textuel ou sitekey). */
  present: boolean;
  /** Sitekey extrait dynamiquement, ou null si introuvable. */
  sitekey: string | null;
  /** Source où le sitekey/marqueur a été trouvé (diagnostic). */
  source: string;
  /** Pattern qui a matché (diagnostic). */
  matchedBy: string;
}

/**
 * Tente d'extraire un sitekey hCaptcha depuis un bloc de texte (HTML ou JSONP).
 * @param text    contenu brut (HTML /main/, corps getsigninfields/, config widget…)
 * @param source  étiquette de la source pour le diagnostic
 */
export function extractHcaptchaSitekey(text: string, source: string): CaptchaDetection {
  if (!text) return { present: false, sitekey: null, source, matchedBy: "none" };

  for (let i = 0; i < SITEKEY_PATTERNS.length; i++) {
    const m = text.match(SITEKEY_PATTERNS[i]);
    if (m && m[1]) {
      return { present: true, sitekey: m[1].toLowerCase(), source, matchedBy: `pattern#${i}` };
    }
  }

  // Pas de sitekey trouvé, mais un marqueur hCaptcha peut être présent.
  for (const marker of HCAPTCHA_MARKERS) {
    if (marker.test(text)) {
      return { present: true, sitekey: null, source, matchedBy: `marker:${marker.source}` };
    }
  }

  return { present: false, sitekey: null, source, matchedBy: "none" };
}

/**
 * Cherche le sitekey dans plusieurs sources, dans l'ordre de fiabilité.
 * Retourne la PREMIÈRE détection avec sitekey ; à défaut, la première présence
 * (marqueur sans sitekey) ; sinon absent.
 *
 * @param sources  liste ordonnée { label, text } — ex. main HTML, getsigninfields, config
 */
export function detectHcaptcha(sources: Array<{ label: string; text: string }>): CaptchaDetection {
  let fallbackMarker: CaptchaDetection | null = null;
  for (const { label, text } of sources) {
    const d = extractHcaptchaSitekey(text, label);
    if (d.sitekey) return d;                 // sitekey trouvé → on prend
    if (d.present && !fallbackMarker) fallbackMarker = d; // marqueur sans sitekey → garde en secours
  }
  return fallbackMarker ?? { present: false, sitekey: null, source: "none", matchedBy: "none" };
}
