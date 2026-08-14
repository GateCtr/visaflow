/**
 * Résolution hCaptcha via NoneCap (https://nonecap.com).
 * Prioritaire pour CEV — sitekey gouvernementale non supportée par CapSolver.
 */

const NONECAP_BASE = "https://api.nonecap.com/v1";

export async function solveHcaptchaViaNonecap(
  apiKey: string,
  sitekey: string,
  pageUrl: string,
  logPrefix = "[nonecap]",
): Promise<string | null> {
  const t0 = Date.now();
  console.log(`${logPrefix} Envoi solve hCaptcha → NoneCap (sitekey ${sitekey.slice(0, 8)}…)`);

  try {
    const createRes = await fetch(`${NONECAP_BASE}/solves?wait=60`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "hcaptcha", sitekey, url: pageUrl }),
      signal: AbortSignal.timeout(70_000),
    });

    const data = await createRes.json() as {
      id?: string;
      status?: string;
      token?: string | null;
      error?: { code?: string; message?: string } | null;
    };

    if (data.token) {
      console.log(`${logPrefix} ✅ NoneCap token (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return data.token;
    }

    if (data.id && (data.status === "pending" || data.status === "solving")) {
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        const pollRes = await fetch(`${NONECAP_BASE}/solves/${data.id}?wait=10`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15_000),
        });
        const pollData = await pollRes.json() as typeof data;
        if (pollData.token) {
          console.log(`${logPrefix} ✅ NoneCap token poll #${i + 1} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
          return pollData.token;
        }
        if (pollData.status === "failed" || pollData.status === "expired" || pollData.status === "cancelled") {
          console.warn(`${logPrefix} ❌ NoneCap ${pollData.status}: ${pollData.error?.code ?? "unknown"}`);
          return null;
        }
      }
      console.warn(`${logPrefix} ❌ NoneCap timeout 120s`);
      return null;
    }

    if (data.error) {
      console.warn(`${logPrefix} ❌ NoneCap erreur: ${data.error.code} — ${data.error.message}`);
    }
    return null;
  } catch (err) {
    console.warn(`${logPrefix} ❌ NoneCap exception: ${err}`);
    return null;
  }
}
