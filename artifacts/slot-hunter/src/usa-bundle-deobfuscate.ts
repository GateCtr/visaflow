/**
 * usa-bundle-deobfuscate.ts — Résolution de la clé AES dans le bundle Angular OBFUSQUÉ du
 * portail USA (usvisaappt.com).
 *
 * CONTEXTE : depuis le bundle `main.65074217902e910c.js`, le portail est passé à
 * javascript-obfuscator : les chaînes (dont la clé AES `encSecKey`) ne sont plus en clair.
 * Elles vivent dans une table de strings réordonnée au chargement par un IIFE de shuffle,
 * puis décodées à la demande par une fonction `_0xXXXX(index)` (base64 + éventuel RC4).
 *
 * La config du portail fait : `config.N.encSecKey = _0x395d(0xc3c)`. L'ancien bundle-check,
 * qui faisait `bundleText.includes(cléEnClair)`, échouait donc en FAUX POSITIF (la clé réelle
 * est inchangée, mais elle n'apparaît plus littéralement) → alerte + mise en pause des dossiers.
 *
 * CE MODULE : extrait de façon robuste
 *   1. la fonction table de strings  `function _0x19cf(){const _0x..=[...]; ...}`
 *   2. la fonction décodeuse         `function _0x395d(a,b){...}`
 *   3. l'IIFE de shuffle             `(function(a,b){...}(_0x19cf,0x844a9))`
 * et les évalue dans un `vm` isolé (aucun accès réseau/FS/require) pour :
 *   - résoudre la valeur de `encSecKey` (via l'index trouvé dans `encSecKey:_0xDEC(0xIDX)`),
 *   - OU, à défaut d'index, scanner les chaînes décodées à la recherche d'une clé AES-256
 *     (base64 de 32 octets = 44 caractères).
 *
 * Zéro dépendance externe : parsing par appariement d'accolades + `vm.runInNewContext`.
 */
import { createContext, runInContext } from "node:vm";

/** Résultat de la déobfuscation du bundle. */
export interface BundleDeobResult {
  /** Clé AES résolue (base64 44 car.), ou null si introuvable. */
  aesKey: string | null;
  /** Comment la clé a été trouvée — pour le diagnostic/log. */
  method: "literal" | "encSecKey-index" | "scan-32bytes" | "none";
  /** Nombre de chaînes décodées scannées (diagnostic). */
  decodedCount?: number;
}

/** Extrait le corps `{...}` d'une fonction à partir de l'index de `function` (appariement d'accolades). */
function extractBracedFrom(src: string, fnStart: number): string | null {
  const open = src.indexOf("{", fnStart);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(fnStart, i + 1);
    }
  }
  return null;
}

/** Vrai si `s` est une base64 de 32 octets (clé AES-256) → 44 caractères finissant par '='. */
function isAes256Base64(s: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(s)) return false;
  try {
    return Buffer.from(s, "base64").length === 32;
  } catch {
    return false;
  }
}

/**
 * Déobfusque le bundle et tente de résoudre la clé AES `encSecKey`.
 *
 * Approche défensive et bornée (le bundle fait ~4 Mo) :
 *  - si la clé attendue est présente EN CLAIR → retour immédiat (`literal`) ;
 *  - sinon extraction table+décodeur+shuffle, évaluation en VM isolée, puis
 *    résolution par index `encSecKey:_0xDEC(0xIDX)`, ou scan des chaînes décodées.
 *
 * @param bundleText  texte complet du bundle Angular.
 * @param expectedKey clé AES connue (pour le court-circuit littéral + vérification).
 */
export function deobfuscateUsaBundleAesKey(
  bundleText: string,
  expectedKey?: string,
): BundleDeobResult {
  // 0) Court-circuit : clé encore en clair (ancien format non obfusqué).
  if (expectedKey && bundleText.includes(expectedKey)) {
    return { aesKey: expectedKey, method: "literal" };
  }

  // 1) Localiser la fonction table (ex: `function _0x19cf()`) et le décodeur (`function _0x395d(`).
  const arrFnMatch = bundleText.match(/function (_0x[0-9a-f]+)\(\)\{const _0x[0-9a-f]+=\[/);
  const decFnMatch = bundleText.match(/function (_0x[0-9a-f]+)\(_0x[0-9a-f]+,_0x[0-9a-f]+\)\{_0x[0-9a-f]+=_0x[0-9a-f]+-0x[0-9a-f]+;/);
  if (!arrFnMatch || !decFnMatch) {
    return { aesKey: null, method: "none" };
  }
  const arrName = arrFnMatch[1];
  const decName = decFnMatch[1];

  const arrBody = extractBracedFrom(bundleText, arrFnMatch.index!);
  const decBody = extractBracedFrom(bundleText, decFnMatch.index!);
  if (!arrBody || !decBody) {
    return { aesKey: null, method: "none" };
  }

  // 2) IIFE de shuffle : `(function(a,b){...}(<arrName>,0x<magic>))`. Réordonne la table.
  //    On le cherche sur tout le bundle (il suit généralement le décodeur).
  const shuffleRe = new RegExp(
    `\\(function\\(_0x[0-9a-f]+,_0x[0-9a-f]+\\)\\{.*?\\}\\(${arrName},(0x[0-9a-f]+)\\)\\)`,
    "s",
  );
  const shuffleMatch = bundleText.match(shuffleRe);
  const shuffleSrc = shuffleMatch ? shuffleMatch[0] : "";

  // 3) Évaluation en VM ISOLÉE (pas de require/réseau/FS). Le script expose `__decode(i)`
  //    et `__all()` (toutes les chaînes décodées) à l'hôte via la valeur de retour.
  const script = `
    ${arrBody}
    ${decBody}
    ${shuffleSrc ? shuffleSrc + ";" : ""}
    (function(){
      var out = { decode: null, all: [] };
      try { out.decode = function(i){ try { return ${decName}(i); } catch(e){ return null; } }; } catch(e){}
      // Table brute (après shuffle) : on la relit pour un scan exhaustif des valeurs décodées.
      try {
        var raw = ${arrName}();
        for (var i = 0; i < raw.length; i++) {
          // Les index du décodeur sont décalés d'un offset (ex: i-0x6b) ; on scanne via l'offset
          // détecté dynamiquement en testant decode sur une plage d'index plausibles plus bas.
        }
      } catch(e){}
      return out;
    })()
  `;

  let decode: ((i: number) => string | null) | null = null;
  try {
    const sandbox: Record<string, unknown> = {};
    const ctx = createContext(sandbox);
    const result = runInContext(script, ctx, { timeout: 5000 }) as { decode: ((i: number) => string | null) | null };
    decode = result?.decode ?? null;
  } catch {
    return { aesKey: null, method: "none" };
  }
  if (!decode) return { aesKey: null, method: "none" };

  // 4a) Résolution directe par index : `encSecKey:_0xDEC(0xIDX)` ou `'encSecKey':_0xDEC(0xIDX)`.
  const idxMatch = bundleText.match(
    new RegExp(`encSecKey['"]?\\s*:\\s*${decName}\\((0x[0-9a-f]+)\\)`),
  );
  if (idxMatch) {
    const val = decode(parseInt(idxMatch[1], 16));
    if (val && isAes256Base64(val)) {
      return { aesKey: val, method: "encSecKey-index" };
    }
  }

  // 4b) Fallback : scanner une plage d'index et retenir la seule base64 AES-256 (32 octets).
  //     Le décodeur applique un offset interne (ex: index-0x6b) ; on balaie large et déduplique.
  const found = new Set<string>();
  let decodedCount = 0;
  for (let i = 0x6b; i < 0x6b + 20000; i++) {
    let v: string | null;
    try { v = decode(i); } catch { v = null; }
    if (typeof v === "string") {
      decodedCount++;
      if (isAes256Base64(v)) found.add(v);
    }
  }
  if (expectedKey && found.has(expectedKey)) {
    return { aesKey: expectedKey, method: "scan-32bytes", decodedCount };
  }
  if (found.size === 1) {
    return { aesKey: [...found][0], method: "scan-32bytes", decodedCount };
  }

  return { aesKey: null, method: "none", decodedCount };
}
