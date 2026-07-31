// ─── Germany RK-Termin — Captcha Resolution ────────────────────────────────
// Résolution d'image captcha via 2Captcha ou CapSolver (ImageToText).

// ─── Germany RK-Termin — Captcha Resolution ────────────────────────────────
// Résolution d'image captcha via 2Captcha ou CapSolver (ImageToText).

declare const process: { env: Record<string, string | undefined> };

import { RKTERMIN_PATTERNS } from "./config.js";
import type { ImageCaptchaResult, CaptchaProvider } from "./types.js";

const log = (level: string, msg: string) => console.log(`[${new Date().toISOString()}] [rktermin-captcha] [${level}] ${msg}`);

const TWOCAPTCHA_API_KEY = process.env["TWOCAPTCHA_API_KEY"] ?? "";
const CAPSOLVER_API_KEY = process.env["CAPSOLVER_API_KEY"] ?? "";
const ANTICAPTCHA_API_KEY = process.env["ANTICAPTCHA_API_KEY"] ?? "";

/** Extrait le captcha base64 depuis le HTML de la page. */
export function extractCaptchaBase64(html: string): string | null {
  const match = html.match(RKTERMIN_PATTERNS.captchaBase64);
  if (!match?.[1]) return null;
  // Nettoyer les espaces/sauts de ligne éventuels dans le HTML — base64 doit
  // être une chaîne continue pour que les solvers OCR le décodent correctement.
  const clean = match[1].replace(/\s/g, "");
  // Les 8 premiers chars du base64 révèlent le format:
  // JPEG = /9j/  |  PNG = iVBOR  |  GIF = R0lGO
  log("DEBUG", `Captcha extrait: ${clean.length} chars base64 (début: ${clean.slice(0, 8)})`);
  return clean;
}

/**
 * Résout un captcha image RK-Termin.
 * Stratégie : CapSolver (instant, ~$0.002) → 2Captcha (humain, ~$0.003) → Anti-Captcha
 */
export async function solveImageCaptcha(base64Image: string): Promise<ImageCaptchaResult> {
  const startMs = Date.now();
  
  // Stratégie 1 : CapSolver (résolution instantanée par AI)
  if (CAPSOLVER_API_KEY) {
    try {
      const result = await solveWithCapSolver(base64Image);
      if (result) {
        log("INFO", `CapSolver résolu en ${Date.now() - startMs}ms: "${result}"`);
        return { status: "solved", text: result, solveTimeMs: Date.now() - startMs, provider: "capsolver" };
      }
    } catch (err) {
      log("WARN", `CapSolver échoué: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  
  // Stratégie 2 : 2Captcha (résolution humaine — plus lent mais plus précis)
  if (TWOCAPTCHA_API_KEY) {
    try {
      const result = await solveWith2Captcha(base64Image);
      if (result) {
        log("INFO", `2Captcha résolu en ${Date.now() - startMs}ms: "${result}"`);
        return { status: "solved", text: result, solveTimeMs: Date.now() - startMs, provider: "2captcha" };
      }
    } catch (err) {
      log("WARN", `2Captcha échoué: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  
  // Stratégie 3 : Anti-Captcha (fallback)
  if (ANTICAPTCHA_API_KEY) {
    try {
      const result = await solveWithAntiCaptcha(base64Image);
      if (result) {
        log("INFO", `Anti-Captcha résolu en ${Date.now() - startMs}ms: "${result}"`);
        return { status: "solved", text: result, solveTimeMs: Date.now() - startMs, provider: "anticaptcha" };
      }
    } catch (err) {
      log("WARN", `Anti-Captcha échoué: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  
  log("ERROR", "Tous les providers captcha ont échoué");
  return { status: "failed", solveTimeMs: Date.now() - startMs, provider: "capsolver" };
}

// ─── CapSolver (résolution AI instantanée) ──────────────────────────────────

async function solveWithCapSolver(base64Image: string): Promise<string | null> {
  const createRes = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: CAPSOLVER_API_KEY,
      task: {
        type: "ImageToTextTask",
        body: base64Image,
        // Diplo.de RK-Termin : JPEG ~5KB, texte distordu 4-6 chars alphanumériques.
        // Aucun module CapSolver n'est spécifiquement calibré pour ce style ;
        // le modèle par défaut donne ~10-20% de réussite.
        // Pour 100% de fiabilité, ajouter une clé 2Captcha (TWOCAPTCHA_API_KEY).
      },
    }),
  });
  
  const createData = await createRes.json() as {
    errorId: number;
    errorDescription?: string;
    status?: string;
    solution?: { text?: string };
    taskId?: string;
  };
  
  if (createData.errorId !== 0) {
    throw new Error(`CapSolver error: ${createData.errorDescription ?? `errorId=${createData.errorId}`}`);
  }
  
  // CapSolver retourne souvent le résultat directement dans createTask (AI instantanée)
  if (createData.status === "ready" && createData.solution?.text) {
    return createData.solution.text;
  }
  
  // Sinon poll (rare pour ImageToText)
  if (createData.taskId) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      
      const getRes = await fetch("https://api.capsolver.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: CAPSOLVER_API_KEY, taskId: createData.taskId }),
      });
      
      const getData = await getRes.json() as { status?: string; solution?: { text?: string }; errorId?: number };
      if (getData.status === "ready" && getData.solution?.text) {
        return getData.solution.text;
      }
      if (getData.errorId && getData.errorId !== 0) break;
    }
  }
  
  return null;
}

// ─── 2Captcha (résolution humaine) ─────────────────────────────────────────

async function solveWith2Captcha(base64Image: string): Promise<string | null> {
  // Soumettre
  const submitParams = new URLSearchParams({
    key: TWOCAPTCHA_API_KEY,
    method: "base64",
    body: base64Image,
    json: "1",
  });
  
  const submitRes = await fetch(`https://2captcha.com/in.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: submitParams.toString(),
  });
  
  const submitData = await submitRes.json() as { status: number; request: string };
  
  if (submitData.status !== 1) {
    throw new Error(`2Captcha submit error: ${submitData.request}`);
  }
  
  const requestId = submitData.request;
  log("DEBUG", `2Captcha soumis, ID: ${requestId}`);
  
  // Poller le résultat (humains prennent 10-20s)
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 4000));
    
    const getRes = await fetch(
      `https://2captcha.com/res.php?key=${TWOCAPTCHA_API_KEY}&action=get&id=${requestId}&json=1`
    );
    const getData = await getRes.json() as { status: number; request: string };
    
    if (getData.status === 1) {
      return getData.request;
    }
    
    if (getData.request !== "CAPCHA_NOT_READY") {
      throw new Error(`2Captcha poll error: ${getData.request}`);
    }
  }
  
  log("WARN", "2Captcha timeout (60s)");
  return null;
}

// ─── Anti-Captcha ──────────────────────────────────────────────────────────

async function solveWithAntiCaptcha(base64Image: string): Promise<string | null> {
  const createRes = await fetch("https://api.anti-captcha.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: ANTICAPTCHA_API_KEY,
      task: {
        type: "ImageToTextTask",
        body: base64Image,
        case: false,
      },
    }),
  });
  
  const createData = await createRes.json() as { errorId: number; taskId?: number; errorDescription?: string };
  
  if (createData.errorId !== 0) {
    throw new Error(`Anti-Captcha error: ${createData.errorDescription}`);
  }
  
  // Poll
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 3000));
    
    const getRes = await fetch("https://api.anti-captcha.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: ANTICAPTCHA_API_KEY, taskId: createData.taskId }),
    });
    
    const getData = await getRes.json() as { status: string; solution?: { text?: string }; errorId: number };
    
    if (getData.status === "ready" && getData.solution?.text) {
      return getData.solution.text;
    }
    if (getData.errorId !== 0) break;
  }
  
  return null;
}
