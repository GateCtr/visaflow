/**
 * Joventy — OTP Email Router (Cloudflare Email Worker)
 *
 * Reçoit les emails entrants sur otp+{appId}@otp.joventy.cd
 * et les transmet à l'endpoint Convex /hunter/otp/ingest.
 *
 * Variables d'environnement (Cloudflare dashboard → Worker → Settings → Variables) :
 *   CONVEX_SITE_URL     — ex: https://famous-albatross-420.convex.site
 *   OTP_INGEST_SECRET   — même valeur que dans les secrets Convex
 */

export default {
  async email(message, env, _ctx) {
    const to = message.to ?? "";

    // Lecture du contenu brut de l'email (headers + body)
    let rawText = "";
    try {
      rawText = await new Response(message.raw).text();
    } catch {
      // Fallback : lire uniquement le body texte si raw non disponible
      const reader = message.text;
      if (reader) {
        rawText = await new Response(reader).text();
      }
    }

    if (!rawText && !to) {
      console.error("[OTP Router] Email vide — ignoré");
      return;
    }

    const siteUrl = (env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
    const secret  = env.OTP_INGEST_SECRET ?? "";

    if (!siteUrl || !secret) {
      console.error("[OTP Router] CONVEX_SITE_URL ou OTP_INGEST_SECRET manquant");
      return;
    }

    const url = `${siteUrl}/hunter/otp/ingest?secret=${encodeURIComponent(secret)}`;

    const body = JSON.stringify({
      raw_text: rawText,
      to: [to],              // Convex extrait l'appId depuis otp+{appId}@otp.joventy.cd
      flow: "spain",
    });

    let attempt = 0;
    while (attempt < 3) {
      attempt++;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

        if (res.ok) {
          const json = await res.json();
          console.log(`[OTP Router] ✅ Ingest OK (tentative ${attempt})`, JSON.stringify(json));
          return;
        }

        const text = await res.text();
        console.warn(`[OTP Router] HTTP ${res.status} (tentative ${attempt}):`, text);

        if (res.status < 500) break; // Erreur client → pas la peine de retry
      } catch (err) {
        console.error(`[OTP Router] Erreur réseau (tentative ${attempt}):`, err);
      }

      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }

    console.error("[OTP Router] ❌ Échec après 3 tentatives pour:", to);
  },
};
