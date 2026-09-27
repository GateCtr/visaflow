// ─── TikTok Events API (server-side) ─────────────────────────────────────────
// Envoie des événements de conversion depuis le serveur vers TikTok, en complément
// du pixel web (index.html, pixel DASGMEBC77UA02BT4J9G). L'API serveur récupère les
// conversions que le navigateur peut rater (bloqueurs, incohérences) et améliore le
// matching / l'optimisation des campagnes.
//
// Endpoint : POST https://business-api.tiktok.com/open_api/v1.3/event/track/
// Auth     : header "Access-Token: <TIKTOK_ACCESS_TOKEN>"
// Doc      : Events API 2.0 (event_source="web").
//
// Secrets (dashboard Convex → Environment Variables) :
//   - TIKTOK_ACCESS_TOKEN     (obligatoire ; sans lui, l'envoi est ignoré proprement)
//   - TIKTOK_EVENT_SOURCE_ID  (pixel/event source id ; défaut = pixel web actuel)
//
// Contrainte : appel réseau → uniquement dans une internalAction (jamais dans une
// mutation). Les mutations déclenchent via ctx.scheduler.runAfter(0, internal.tiktokEvents.trackEvent, …).
// PII (email, téléphone) normalisées puis hashées SHA-256 avant envoi (exigence TikTok).

import { internalAction } from "./_generated/server";
import { v } from "convex/values";

const TIKTOK_EVENTS_API_URL = "https://business-api.tiktok.com/open_api/v1.3/event/track/";

/** Pixel/event source id par défaut (identique au pixel web dans index.html). */
const DEFAULT_EVENT_SOURCE_ID = "DASGMEBC77UA02BT4J9G";

/** Événements standards TikTok utilisés par Joventy. */
type TiktokEventName =
  | "CompleteRegistration" // création de dossier
  | "SubmitForm"           // créneau/visa capturé (lead qualifié)
  | "CompletePayment"      // prime de succès payée (conversion finale)
  | "InitiateCheckout";    // acompte/engagement validé

/** Normalise puis hashe en SHA-256 (hex) une donnée PII. Retourne undefined si vide. */
async function sha256Hex(input: string | undefined | null): Promise<string | undefined> {
  if (!input) return undefined;
  const normalized = input.trim().toLowerCase();
  if (!normalized) return undefined;
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Normalise un numéro de téléphone en E.164 approximatif (garde le +, retire le reste). */
function normalizePhone(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const digits = trimmed.replace(/[^\d+]/g, "");
  if (!digits) return undefined;
  // Assure un préfixe "+" (TikTok attend E.164 avant hash).
  return digits.startsWith("+") ? digits : `+${digits}`;
}

/**
 * Envoie un événement unique à l'Events API TikTok. Ne lève jamais (best-effort) —
 * un échec de tracking ne doit pas casser le flux métier.
 */
export const trackEvent = internalAction({
  args: {
    event: v.union(
      v.literal("CompleteRegistration"),
      v.literal("SubmitForm"),
      v.literal("CompletePayment"),
      v.literal("InitiateCheckout"),
    ),
    /** Identifiant stable pour la déduplication avec un éventuel ttq.track côté web. */
    eventId: v.string(),
    /** Email en clair (sera hashé SHA-256 ici, jamais envoyé en clair). */
    email: v.optional(v.string()),
    /** Téléphone en clair (sera normalisé + hashé SHA-256 ici). */
    phone: v.optional(v.string()),
    /** Identifiant externe stable non-PII (ex. userId Clerk) — hashé SHA-256. */
    externalId: v.optional(v.string()),
    /** Montant de la conversion (USD) pour les events monétaires. */
    value: v.optional(v.number()),
    /** Type de contenu (ex. destination + package) pour le reporting. */
    contentId: v.optional(v.string()),
    contentName: v.optional(v.string()),
    /** URL de la page associée (améliore l'attribution). */
    pageUrl: v.optional(v.string()),
  },
  handler: async (_ctx, args): Promise<void> => {
    const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
    if (!accessToken) {
      console.warn("[TikTok] TIKTOK_ACCESS_TOKEN non configuré — événement ignoré");
      return;
    }
    const eventSourceId = process.env.TIKTOK_EVENT_SOURCE_ID ?? DEFAULT_EVENT_SOURCE_ID;

    const [emHash, phHash, extHash] = await Promise.all([
      sha256Hex(args.email),
      sha256Hex(normalizePhone(args.phone)),
      sha256Hex(args.externalId),
    ]);

    const user: Record<string, string> = {};
    if (emHash) user.email = emHash;
    if (phHash) user.phone = phHash;
    if (extHash) user.external_id = extHash;

    const properties: Record<string, unknown> = {};
    if (typeof args.value === "number" && args.value > 0) {
      properties.value = args.value;
      properties.currency = "USD";
    }
    if (args.contentId || args.contentName) {
      properties.contents = [
        {
          content_id: args.contentId ?? "slot",
          content_name: args.contentName ?? args.contentId ?? "slot",
          content_type: "product",
        },
      ];
    }

    const payload = {
      event_source: "web",
      event_source_id: eventSourceId,
      data: [
        {
          event: args.event as TiktokEventName,
          event_time: Math.floor(Date.now() / 1000),
          event_id: args.eventId,
          user,
          properties,
          ...(args.pageUrl ? { page: { url: args.pageUrl } } : {}),
        },
      ],
    };

    try {
      const res = await fetch(TIKTOK_EVENTS_API_URL, {
        method: "POST",
        headers: {
          "Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
      if (!res.ok || (body && body.code !== 0)) {
        console.error(
          "[TikTok] Envoi événement échoué",
          res.status,
          body?.code,
          body?.message ?? "(pas de message)",
        );
      } else {
        console.log(`[TikTok] ✅ Événement ${args.event} envoyé (event_id=${args.eventId})`);
      }
    } catch (e) {
      console.error("[TikTok] Exception fetch", e instanceof Error ? e.message : e);
    }
  },
});
