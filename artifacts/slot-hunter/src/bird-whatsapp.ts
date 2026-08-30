/**
 * bird-whatsapp.ts — Service d'envoi de messages WhatsApp via l'API Bird.
 *
 * Utilise le SDK officiel @messagebird/sdk (BirdClient). La clé API est lue depuis
 * la variable d'environnement BIRD_API_KEY (jamais en dur). Le SDK déduit la région
 * (US / EU) automatiquement à partir du préfixe de la clé (bk_... vs bk_eu1_...).
 *
 * WhatsApp business-initiated est TEMPLATE-ONLY : on envoie un template pré-approuvé
 * dans le dashboard Bird, pas du texte libre. Chaque appel envoie 1 message à 1 destinataire.
 *
 * Variables d'environnement :
 *   BIRD_API_KEY              — clé API Bird (obligatoire). Format: bk_xxxxxxxxx
 *   BIRD_WHATSAPP_ENABLED     — "1" pour activer l'envoi (défaut: désactivé si clé absente)
 *
 * Usage :
 *   import { sendWhatsappTemplate } from "./bird-whatsapp.js";
 *   const res = await sendWhatsappTemplate({
 *     to: "+15551234567",
 *     templateSlug: "bird_delivery_update",
 *     bodyParams: [
 *       { name: "ref", text: "A1B2C3D4" },
 *       { name: "date", text: "10 Jul 2026" },
 *     ],
 *   });
 *   if (res.ok) console.log(res.id, res.status);
 */

import { BirdClient } from "@messagebird/sdk";

// ─── Types publics ──────────────────────────────────────────────────────────

/** Un paramètre texte d'un composant de template WhatsApp. */
export interface WhatsappTemplateParam {
  /** Nom du placeholder dans le template (ex: "ref", "date"). */
  name: string;
  /** Valeur texte à insérer. */
  text: string;
}

/** Paramètres d'envoi d'un message template WhatsApp. */
export interface SendWhatsappTemplateParams {
  /** Numéro destinataire au format international E.164 (ex: "+15551234567"). */
  to: string;
  /** Slug du template pré-approuvé dans le dashboard Bird. */
  templateSlug: string;
  /** Paramètres texte du composant "body" du template (dans l'ordre attendu). */
  bodyParams?: WhatsappTemplateParam[];
  /** Variante de langue du template (optionnel, ex: "fr", "en"). */
  language?: string;
}

/** Résultat d'un envoi WhatsApp. */
export type SendWhatsappResult =
  | { ok: true; id: string; status: string }
  | { ok: false; error: string; skipped?: boolean };

// ─── Client singleton (lazy) ────────────────────────────────────────────────

let cachedClient: BirdClient | null = null;

/**
 * Retourne le client Bird singleton, ou null si la clé API est absente.
 * Le client est instancié une seule fois (lazy) et réutilisé.
 */
function getBirdClient(): BirdClient | null {
  const apiKey = process.env.BIRD_API_KEY ?? "";
  if (!apiKey) return null;
  if (cachedClient) return cachedClient;
  cachedClient = new BirdClient({ apiKey });
  return cachedClient;
}

/** True si l'envoi WhatsApp via Bird est activé (clé présente). */
export function isBirdWhatsappEnabled(): boolean {
  return Boolean(process.env.BIRD_API_KEY);
}

// ─── Envoi ──────────────────────────────────────────────────────────────────

/**
 * Envoie un message WhatsApp basé sur un template pré-approuvé via Bird.
 *
 * Échec gracieux : si la clé est absente ou l'envoi échoue, retourne un résultat
 * { ok: false } au lieu de throw — l'appelant décide s'il bloque ou continue.
 * Les notifications WhatsApp sont non-critiques : un échec ne doit pas casser le flux.
 *
 * @param params  destinataire + template + paramètres
 * @returns        { ok: true, id, status } ou { ok: false, error }
 */
export async function sendWhatsappTemplate(
  params: SendWhatsappTemplateParams,
): Promise<SendWhatsappResult> {
  const client = getBirdClient();
  if (!client) {
    console.warn("[bird-whatsapp] BIRD_API_KEY absente — envoi WhatsApp désactivé");
    return { ok: false, error: "BIRD_API_KEY absente", skipped: true };
  }

  // Normaliser le numéro : l'API Bird exige le format E.164 (+ suivi de chiffres).
  const to = normalizeE164(params.to);
  if (!to) {
    return { ok: false, error: `Numéro invalide: ${params.to}` };
  }

  // Construire le composant "body" avec les paramètres texte, si fournis.
  const components = params.bodyParams && params.bodyParams.length > 0
    ? [
        {
          type: "body" as const,
          parameters: params.bodyParams.map((p) => ({
            type: "text" as const,
            name: p.name,
            text: p.text,
          })),
        },
      ]
    : undefined;

  try {
    const msg = await client.whatsapp.send({
      to,
      template: {
        slug: params.templateSlug,
        ...(params.language ? { language: params.language } : {}),
        ...(components ? { components } : {}),
      },
    } as Parameters<typeof client.whatsapp.send>[0]);

    const id = String((msg as { id?: unknown }).id ?? "");
    const status = String((msg as { status?: unknown }).status ?? "accepted");
    console.log(`[bird-whatsapp] ✅ Message envoyé — id=${id} status=${status} to=${maskPhone(to)}`);
    return { ok: true, id, status };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[bird-whatsapp] ❌ Échec envoi à ${maskPhone(to)}: ${errMsg}`);
    return { ok: false, error: errMsg };
  }
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────

/**
 * Normalise un numéro au format E.164 (+ suivi de 8 à 15 chiffres).
 * Retourne null si le numéro ne peut pas être normalisé.
 */
function normalizeE164(raw: string): string | null {
  const trimmed = raw.trim();
  // Garder le + initial s'il existe, retirer tout le reste des non-chiffres.
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/** Masque un numéro pour les logs (garde l'indicatif + 2 derniers chiffres). */
function maskPhone(e164: string): string {
  if (e164.length <= 5) return "***";
  return `${e164.slice(0, 4)}***${e164.slice(-2)}`;
}
