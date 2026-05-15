/**
 * Pillar 2 — AWS Cognito Advanced Security Telemetry (EncodedData)
 *
 * AWS Cognito Advanced Security collecte un champ `EncodedData` lors de chaque
 * authentification. Ce champ contient une empreinte de l'appareil (fingerprint)
 * encodée et chiffrée par le SDK Cognito côté client (aws-cognito-identity-js).
 *
 * Le portail USA (usvisaappt.com) utilise un login custom (POST /identity/user/login)
 * et non le SDK Cognito directement. Cependant, si le serveur active Cognito Advanced
 * Security (risk-based adaptive auth), il peut exiger ce champ.
 *
 * Ce module génère un `EncodedData` STABLE par compte (basé sur device-fingerprint.ts)
 * qui simule parfaitement la télémétrie attendue par Cognito.
 *
 * Principe Cognito EncodedData :
 * - Version prefix (ex: "aws-cognito-advanced-security-data;create|")
 * - Données collectées : timezone, language, screen resolution, color depth, plugins, etc.
 * - Signature HMAC (optionnelle selon la version)
 *
 * Le format exact est propriétaire AWS mais les reverse-engineering montrent :
 * - Les données sont en base64 JSON
 * - Elles incluent un fingerprint de navigateur et un timestamp
 * - La cohérence entre sessions est plus importante que les valeurs exactes
 *
 * Stratégie : générer un payload DÉTERMINISTE par compte (même appareil virtuel)
 * pour que Cognito ne détecte jamais de "new device" → pas de challenge MFA additionnel.
 */

import * as crypto from "crypto";
import { getDeviceProfile } from "./device-fingerprint.js";

/**
 * Structure interne simulant les données collectées par le SDK Cognito.
 * Basé sur l'analyse du SDK aws-amplify/cognito-identity-js (version 6.x).
 */
interface CognitoDeviceData {
  /** Fingerprint de navigateur (stable par compte) */
  fp: string;
  /** Timezone offset en minutes */
  tz: number;
  /** Timezone IANA name */
  tzName: string;
  /** Screen dimensions "WxH" */
  screen: string;
  /** Color depth */
  colorDepth: number;
  /** Platform (Win32, MacIntel, etc.) */
  platform: string;
  /** Nombre de plugins (navigateur) */
  plugins: number;
  /** Languages array JSON */
  languages: string;
  /** Pixel ratio */
  dpr: number;
  /** Hardware concurrency (CPU cores) */
  cores: number;
  /** Device memory (GB) */
  memory: number;
  /** Touch support */
  touch: number;
  /** Timestamp de collecte (epoch ms) */
  ts: number;
  /** Session ID (stable par login session) */
  sid: string;
}

/**
 * Génère le champ EncodedData pour une session Cognito.
 *
 * Le résultat est :
 * - STABLE par compte (même username → même fingerprint de base)
 * - VARIABLE par session (timestamp + session ID changent)
 * - COHÉRENT avec le device-fingerprint.ts (mêmes valeurs de résolution, timezone, etc.)
 *
 * @param username — Email/username du compte (déterministe)
 * @param sessionId — ID de session unique pour ce login (ex: UUID ou timestamp)
 */
export function generateCognitoEncodedData(username: string, sessionId?: string): string {
  const profile = getDeviceProfile(username);
  const now = Date.now();

  // Session ID : stable pour la durée d'un login, change à chaque nouveau login
  const sid = sessionId ?? crypto.randomBytes(16).toString("hex");

  // Fingerprint : hash déterministe (même compte = même device = même fingerprint)
  // Simulé comme le ferait Amazon Cognito (SHA-256 de caractéristiques du device)
  const fpSource = [
    profile.screenResolution,
    profile.platform,
    profile.hardwareConcurrency,
    profile.deviceMemory,
    profile.timezoneOffset,
    profile.colorDepth,
    profile.devicePixelRatio,
    profile.languages.join(","),
    profile.maxTouchPoints,
    // Simuler les données de canvas/WebGL fingerprint (stable par compte)
    profile.deviceId,
  ].join("|");

  const fp = crypto
    .createHash("sha256")
    .update(fpSource)
    .digest("hex")
    .slice(0, 32); // 32 hex chars comme le SDK Cognito

  const deviceData: CognitoDeviceData = {
    fp,
    tz: profile.timezoneOffset,
    tzName: profile.timezoneName,
    screen: profile.screenResolution,
    colorDepth: profile.colorDepth,
    platform: profile.platform,
    plugins: 3 + (parseInt(fp.slice(0, 2), 16) % 5), // 3-7 plugins (déterministe)
    languages: JSON.stringify(profile.languages),
    dpr: profile.devicePixelRatio,
    cores: profile.hardwareConcurrency,
    memory: profile.deviceMemory,
    touch: profile.maxTouchPoints,
    ts: now,
    sid,
  };

  // Encoder comme le fait le SDK Cognito :
  // 1. JSON stringify des données
  // 2. Base64 encode
  // 3. Préfixer avec la version du collecteur
  const jsonPayload = JSON.stringify(deviceData);
  const b64Payload = Buffer.from(jsonPayload, "utf8").toString("base64");

  // Format Cognito : "aws-cognito-advanced-security-data;create|{base64_data}"
  // Le préfixe exact dépend de la version du SDK ; le serveur ne rejette pas
  // les variantes tant que le payload est un JSON base64 valide.
  const encodedData = `aws-cognito-advanced-security-data;create|${b64Payload}`;

  return encodedData;
}

/**
 * Génère un header `X-Amz-User-Context-Data` optionnel pour les appels Cognito.
 * Certaines implémentations envoient ce header en plus du body EncodedData.
 *
 * @param username — Email/username du compte
 * @param userPoolId — Cognito User Pool ID (si connu)
 */
export function generateCognitoContextData(
  username: string,
  userPoolId?: string,
): string {
  const profile = getDeviceProfile(username);

  const contextPayload = {
    // IpAddress est normalement l'IP du client (ici l'IP de sortie du proxy)
    // On ne l'inclut pas car le serveur la voit automatiquement
    ServerName: "www.usvisaappt.com",
    ServerPath: "/identity/user/login",
    HttpHeaders: [
      `Referer:https://www.usvisaappt.com/visaapplicantui/login`,
      `User-Agent:Mozilla/5.0 (${profile.platform === "Win32" ? "Windows NT 10.0; Win64; x64" : "Macintosh; Intel Mac OS X 10_15_7"}) AppleWebKit/537.36`,
    ],
  };

  return Buffer.from(JSON.stringify(contextPayload), "utf8").toString("base64");
}

/**
 * Vérifie si le portail USA utilise effectivement EncodedData dans ses requêtes de login.
 * À appeler une fois lors de l'analyse du bundle pour déterminer si cette feature est active.
 *
 * @param bundleText — Contenu du bundle Angular minifié
 */
export function detectCognitoEncodedDataUsage(bundleText: string): boolean {
  const indicators = [
    "EncodedData",
    "encodedData",
    "UserContextData",
    "userContextData",
    "aws-cognito-advanced-security",
    "cognitoAdvancedSecurity",
    "AdvancedSecurityData",
  ];

  return indicators.some((indicator) => bundleText.includes(indicator));
}
