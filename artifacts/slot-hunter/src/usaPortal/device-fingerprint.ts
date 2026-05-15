/**
 * Device Fingerprint stable par compte — Anti-détection préventive Cognito.
 *
 * AWS Cognito Plus (si activé) utilise un `EncodedData` contenant un fingerprint
 * du navigateur. Même sans EncodedData, le portail peut tracker la cohérence des
 * métadonnées entre sessions (timezone, résolution, langues).
 *
 * Ce module génère un profil d'appareil STABLE par compte (persisté en mémoire)
 * pour éviter que chaque redéploiement Railway ressemble à un "nouvel appareil".
 *
 * Principe : un même compte → toujours le même "appareil" virtuel.
 */

import * as crypto from "crypto";

interface DeviceProfile {
  /** ID stable dérivé du username (déterministe) */
  deviceId: string;
  /** Résolution écran (choix parmi des résolutions courantes) */
  screenResolution: string;
  /** Timezone offset (minutes) */
  timezoneOffset: number;
  /** Timezone name (IANA) */
  timezoneName: string;
  /** Platform */
  platform: string;
  /** Nombre de CPU cores */
  hardwareConcurrency: number;
  /** Device memory (GB) */
  deviceMemory: number;
  /** Languages */
  languages: string[];
  /** Touch support */
  maxTouchPoints: number;
  /** Color depth */
  colorDepth: number;
  /** Pixel ratio */
  devicePixelRatio: number;
}

// Cache des profils par compte — stable pendant toute la durée du process
const deviceProfiles = new Map<string, DeviceProfile>();

// Pools de valeurs réalistes pour générer des profils cohérents
const SCREEN_RESOLUTIONS = [
  "1920x1080", "1366x768", "1536x864", "1440x900",
  "1600x900", "2560x1440", "1680x1050", "1280x720",
];

const TIMEZONES = [
  { offset: -60, name: "Africa/Kinshasa" },     // UTC+1 (Congo)
  { offset: -60, name: "Africa/Lagos" },         // UTC+1 (Nigeria)
  { offset: -120, name: "Africa/Johannesburg" }, // UTC+2 (Afrique du Sud)
  { offset: 0, name: "Africa/Abidjan" },         // UTC+0 (Côte d'Ivoire)
  { offset: -60, name: "Europe/Paris" },         // UTC+1 (France — diaspora)
  { offset: -60, name: "Europe/Brussels" },      // UTC+1 (Belgique — diaspora)
];

const CPU_CORES = [4, 8, 6, 12, 16];
const DEVICE_MEMORY = [4, 8, 16, 32];
const PIXEL_RATIOS = [1, 1.25, 1.5, 2];

const LANGUAGE_SETS = [
  ["fr-CD", "fr", "en-US", "en"],
  ["fr-FR", "fr", "en-US", "en"],
  ["fr", "en-US", "en"],
  ["fr-CD", "fr", "en"],
  ["fr-FR", "fr", "en-US", "en", "ln"],
];

/**
 * Génère un nombre déterministe à partir d'un hash (index dans un tableau).
 */
function deterministicIndex(hash: Buffer, offset: number, max: number): number {
  return hash.readUInt8(offset % hash.length) % max;
}

/**
 * Obtient ou crée un profil d'appareil STABLE pour un compte.
 * Le profil est déterministe : même username → même device profile (même après redéploiement).
 */
export function getDeviceProfile(username: string): DeviceProfile {
  const cacheKey = username.toLowerCase();

  if (deviceProfiles.has(cacheKey)) {
    return deviceProfiles.get(cacheKey)!;
  }

  // Générer un hash déterministe à partir du username
  // Ajout d'un sel fixe pour ne pas être trivial à inverser
  const salt = "joventy-visa-device-2026";
  const hash = crypto.createHash("sha256").update(`${salt}:${cacheKey}`).digest();

  // deviceId : 32 hex chars stable (comme un vrai deviceId navigateur)
  const deviceId = hash.subarray(0, 16).toString("hex");

  // Sélectionner des valeurs déterministes basées sur le hash
  const screenIdx = deterministicIndex(hash, 0, SCREEN_RESOLUTIONS.length);
  const tzIdx = deterministicIndex(hash, 1, TIMEZONES.length);
  const cpuIdx = deterministicIndex(hash, 2, CPU_CORES.length);
  const memIdx = deterministicIndex(hash, 3, DEVICE_MEMORY.length);
  const langIdx = deterministicIndex(hash, 4, LANGUAGE_SETS.length);
  const pixelIdx = deterministicIndex(hash, 5, PIXEL_RATIOS.length);

  // Platform cohérent avec l'UA (le UA pool est Windows/Mac)
  const isWindows = deterministicIndex(hash, 6, 10) < 7; // 70% Windows
  const platform = isWindows ? "Win32" : "MacIntel";

  const profile: DeviceProfile = {
    deviceId,
    screenResolution: SCREEN_RESOLUTIONS[screenIdx],
    timezoneOffset: TIMEZONES[tzIdx].offset,
    timezoneName: TIMEZONES[tzIdx].name,
    platform,
    hardwareConcurrency: CPU_CORES[cpuIdx],
    deviceMemory: DEVICE_MEMORY[memIdx],
    languages: LANGUAGE_SETS[langIdx],
    maxTouchPoints: 0, // Desktop = pas de touch
    colorDepth: 24,
    devicePixelRatio: PIXEL_RATIOS[pixelIdx],
  };

  deviceProfiles.set(cacheKey, profile);
  return profile;
}

/**
 * Génère un `X-Device-Id` header stable pour un compte.
 * Même format qu'un identifiant de session navigateur Angular.
 */
export function getStableDeviceId(username: string): string {
  return getDeviceProfile(username).deviceId;
}

/**
 * Retourne les headers supplémentaires cohérents avec le device profile.
 * Ces headers imitent les données qu'un vrai navigateur Chrome envoie
 * et que WAF/Cognito peuvent vérifier pour cohérence.
 */
export function getDeviceConsistencyHeaders(username: string): Record<string, string> {
  const profile = getDeviceProfile(username);
  return {
    // Sec-CH-UA-Platform est déjà dans getBrowserHeaders via USA_UA_POOL
    // On ajoute des headers optionnels que Chrome envoie parfois
    "Sec-CH-UA-Arch": profile.platform === "Win32" ? '"x86"' : '"arm"',
    "Sec-CH-UA-Bitness": '"64"',
  };
}

/**
 * Vérifie si le profil d'un compte est cohérent avec un UA donné.
 * Utile pour le debug — un Mac UA avec un Windows platform = incohérent.
 */
export function isProfileConsistentWithUa(username: string, ua: string): boolean {
  const profile = getDeviceProfile(username);
  const isMacUa = ua.includes("Macintosh");
  const isMacProfile = profile.platform === "MacIntel";
  return isMacUa === isMacProfile;
}
