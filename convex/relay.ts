/**
 * Relay System — Relais automatique éclaireur ↔ confiné au sein d'une meute.
 *
 * CONCEPT :
 *   Au sein d'une même broadcastVisaClass (ex: "B1/B2"), plusieurs comptes
 *   se relaient le rôle d'éclaireur pour maximiser la couverture temporelle.
 *   Quand l'éclaireur actuel épuise son budget ou atteint une fenêtre de relais,
 *   il passe le rôle à un autre compte éligible de la meute.
 *
 * FLOW :
 *   1. Éclaireur A détecte qu'il doit passer le relais (budget bas, fenêtre atteinte)
 *   2. Bot appelle requestHandoff(visaClass, currentUsername, reason)
 *   3. Convex sélectionne le meilleur successeur (critères : actif, budget restant, token)
 *   4. Le successeur est promu "eclaireur", l'ancien passe en "confine"
 *   5. Au prochain tick, le bot lit le relay state et ajuste les rôles
 *
 * MUTATIONS (internes — appelées par le bot via HTTP) :
 *   - internalGetRelayState : lire l'état courant d'une meute
 *   - internalRequestHandoff : demander un passage de relais
 *   - internalAcceptRelay : confirmer la prise de relais par le successeur
 *   - internalGetPackMembers : lister les membres éligibles d'une meute
 */

import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Récupère l'état du relais pour une meute (visaClass).
 * Retourne null si aucun relay n'est encore configuré.
 */
export const internalGetRelayState = internalQuery({
  args: { visaClass: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("slotRelayState")
      .withIndex("by_visa_class", (q) => q.eq("visaClass", args.visaClass))
      .unique();
  },
});

/**
 * Liste les membres éligibles d'une meute (même broadcastVisaClass, hunter actif).
 * Retourne les comptes qui pourraient prendre le relais.
 */
export const internalGetPackMembers = internalQuery({
  args: { visaClass: v.string() },
  handler: async (ctx, args) => {
    const apps = await ctx.db
      .query("applications")
      .withIndex("by_broadcast_visa_class", (q) => q.eq("broadcastVisaClass", args.visaClass))
      .collect();

    // Filtrer : hunter actif + statut slot_hunting
    const eligible = apps
      .filter((app) => {
        const hc = (app as { hunterConfig?: { isActive?: boolean; embassyUsername?: string } }).hunterConfig;
        return hc?.isActive && hc?.embassyUsername && app.status === "slot_hunting";
      })
      .map((app) => {
        const hc = (app as { hunterConfig?: { embassyUsername: string; accountRole?: string; currentAppointmentDate?: string; maxLoginsPerDay?: number } }).hunterConfig!;
        return {
          applicationId: app._id,
          username: hc.embassyUsername,
          applicantName: (app as { applicantName: string }).applicantName,
          accountRole: hc.accountRole ?? "hybride",
          currentAppointmentDate: hc.currentAppointmentDate,
          maxLoginsPerDay: hc.maxLoginsPerDay ?? 9,
        };
      });

    return eligible;
  },
});

/**
 * Demande un passage de relais. L'éclaireur actuel demande à être remplacé.
 *
 * Sélectionne automatiquement le meilleur successeur selon :
 *   1. Comptes actifs dans la meute (même visaClass)
 *   2. Exclure l'éclaireur sortant
 *   3. Préférer les hybrides (ils ont l'infra pour scanner)
 *   4. En cas d'égalité, round-robin (le moins récemment éclaireur)
 *
 * Si aucun successeur disponible → retourne null (l'éclaireur continue malgré tout).
 */
export const internalRequestHandoff = internalMutation({
  args: {
    visaClass: v.string(),
    currentUsername: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    // 1. Lister les membres de la meute
    const apps = await ctx.db
      .query("applications")
      .withIndex("by_broadcast_visa_class", (q) => q.eq("broadcastVisaClass", args.visaClass))
      .collect();

    const candidates = apps
      .filter((app) => {
        const hc = (app as { hunterConfig?: { isActive?: boolean; embassyUsername?: string } }).hunterConfig;
        if (!hc?.isActive || !hc?.embassyUsername) return false;
        if (app.status !== "slot_hunting") return false;
        // Exclure l'éclaireur sortant
        if (hc.embassyUsername.toLowerCase() === args.currentUsername.toLowerCase()) return false;
        return true;
      })
      .map((app) => {
        const hc = (app as { hunterConfig?: { embassyUsername: string; accountRole?: string; currentAppointmentDate?: string } }).hunterConfig!;
        return {
          applicationId: app._id,
          username: hc.embassyUsername,
          applicantName: (app as { applicantName: string }).applicantName,
          accountRole: hc.accountRole ?? "hybride",
        };
      });

    if (candidates.length === 0) {
      return null; // Personne pour prendre le relais
    }

    // 2. Sélectionner le successeur (préférer hybrides > confinés)
    // Les hybrides sont déjà équipés pour scanner, les confinés aussi (même credentials)
    const sorted = candidates.sort((a, b) => {
      // Priorité : hybride > confine > eclaireur (un éclaireur déjà actif ne devrait pas être ici)
      const prio: Record<string, number> = { hybride: 0, confine: 1, eclaireur: 2 };
      return (prio[a.accountRole] ?? 1) - (prio[b.accountRole] ?? 1);
    });

    // 3. Vérifier l'historique pour round-robin (le moins récent en premier)
    const existingRelay = await ctx.db
      .query("slotRelayState")
      .withIndex("by_visa_class", (q) => q.eq("visaClass", args.visaClass))
      .unique();

    let successor = sorted[0];
    if (existingRelay?.history && existingRelay.history.length > 0) {
      // Trouver le candidat qui a été éclaireur le plus anciennement (ou jamais)
      const lastEclaireurTimes = new Map<string, number>();
      for (const h of existingRelay.history) {
        const existing = lastEclaireurTimes.get(h.from.toLowerCase()) ?? 0;
        if (h.at > existing) lastEclaireurTimes.set(h.from.toLowerCase(), h.at);
      }
      sorted.sort((a, b) => {
        const aTime = lastEclaireurTimes.get(a.username.toLowerCase()) ?? 0;
        const bTime = lastEclaireurTimes.get(b.username.toLowerCase()) ?? 0;
        return aTime - bTime; // Le plus ancien d'abord (ou jamais = 0 = priorité max)
      });
      successor = sorted[0];
    }

    // 4. Écrire le relay state
    const now = Date.now();
    const historyEntry = {
      from: args.currentUsername,
      to: successor.username,
      reason: args.reason,
      at: now,
    };

    if (existingRelay) {
      const history = existingRelay.history ?? [];
      // Garder max 50 entrées d'historique
      const trimmedHistory = history.length >= 50 ? history.slice(-49) : history;
      await ctx.db.patch(existingRelay._id, {
        currentEclaireur: successor.username,
        currentEclaireurAppId: successor.applicationId,
        activeeSince: now,
        history: [...trimmedHistory, historyEntry],
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("slotRelayState", {
        visaClass: args.visaClass,
        currentEclaireur: successor.username,
        currentEclaireurAppId: successor.applicationId,
        activeeSince: now,
        history: [historyEntry],
        updatedAt: now,
      });
    }

    // 5. Mettre à jour les rôles dans hunterConfig des deux comptes
    // Ancien éclaireur → confiné
    const oldApp = apps.find((a) => {
      const hc = (a as { hunterConfig?: { embassyUsername?: string } }).hunterConfig;
      return hc?.embassyUsername?.toLowerCase() === args.currentUsername.toLowerCase();
    });
    if (oldApp) {
      const oldHc = (oldApp as { hunterConfig?: Record<string, unknown> }).hunterConfig;
      if (oldHc) {
        await ctx.db.patch(oldApp._id, {
          hunterConfig: { ...oldHc, accountRole: "confine" } as any,
          updatedAt: now,
        });
      }
    }

    // Nouveau éclaireur → eclaireur
    const newApp = await ctx.db.get(successor.applicationId);
    if (newApp) {
      const newHc = (newApp as { hunterConfig?: Record<string, unknown> }).hunterConfig;
      if (newHc) {
        await ctx.db.patch(successor.applicationId, {
          hunterConfig: { ...newHc, accountRole: "eclaireur" } as any,
          updatedAt: now,
        });
      }
    }

    // 6. Logger l'événement dans les logs des deux dossiers
    if (oldApp) {
      const oldLogs = (oldApp as { logs?: Array<{ msg: string; time: number; author?: string }> }).logs ?? [];
      await ctx.db.patch(oldApp._id, {
        logs: [...oldLogs, {
          msg: `🔄 Relais : passage en confiné → ${successor.applicantName} prend le relais (${args.reason})`,
          time: now,
          author: "relay-system",
        }],
      } as any);
    }
    if (newApp) {
      const newLogs = (newApp as { logs?: Array<{ msg: string; time: number; author?: string }> }).logs ?? [];
      await ctx.db.patch(successor.applicationId, {
        logs: [...newLogs, {
          msg: `🔄 Relais : promu éclaireur par le relay system (ancien : ${args.currentUsername.slice(0, 12)}…, raison : ${args.reason})`,
          time: now,
          author: "relay-system",
        }],
      } as any);
    }

    return {
      newEclaireur: successor.username,
      newEclaireurAppId: successor.applicationId,
      applicantName: successor.applicantName,
    };
  },
});

/**
 * Confirmation par le successeur qu'il est prêt (token actif ou login réussi).
 * Met à jour le timestamp d'activation effective.
 */
export const internalConfirmRelay = internalMutation({
  args: {
    visaClass: v.string(),
    username: v.string(),
  },
  handler: async (ctx, args) => {
    const relay = await ctx.db
      .query("slotRelayState")
      .withIndex("by_visa_class", (q) => q.eq("visaClass", args.visaClass))
      .unique();

    if (!relay) return false;
    if (relay.currentEclaireur.toLowerCase() !== args.username.toLowerCase()) return false;

    await ctx.db.patch(relay._id, {
      activeeSince: Date.now(),
      updatedAt: Date.now(),
    });

    return true;
  },
});
