import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  return (identity.role as string) || "client";
}

function requireAuth(identity: { [key: string]: unknown } | null) {
  if (!identity) throw new Error("Unauthenticated");
}

function requireAdmin(identity: { [key: string]: unknown } | null) {
  if (!identity || getRole(identity) !== "admin") {
    throw new Error("Accès réservé aux administrateurs");
  }
}

export const generateUploadUrl = mutation({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAuth(identity as Record<string, unknown>);
    return await ctx.storage.generateUploadUrl();
  },
});

export const getDocumentUrl = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const doc = await ctx.db.get(args.documentId);
    if (!doc) return null;

    const app = await ctx.db.get(doc.applicationId);
    if (!app) return null;

    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";
    if (!isAdmin && app.userId !== identity.subject) return null;

    return await ctx.storage.getUrl(doc.storageId as Id<"_storage">);
  },
});

export const uploadDocument = mutation({
  args: {
    applicationId: v.id("applications"),
    docKey: v.string(),
    label: v.string(),
    storageId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAuth(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";
    if (!isAdmin && app.userId !== identity!.subject) {
      throw new Error("Accès non autorisé");
    }

    const existing = await ctx.db
      .query("documents")
      .withIndex("by_application_key", (q) =>
        q.eq("applicationId", args.applicationId).eq("docKey", args.docKey)
      )
      .filter((q) => q.eq(q.field("isAdminUpload"), isAdmin))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        storageId: args.storageId,
        uploadedAt: Date.now(),
        verifiedByAdmin: false,
      });

      await ctx.db.patch(args.applicationId, {
        updatedAt: Date.now(),
        logs: [
          ...(app.logs ?? []),
          {
            msg: `📎 Document remplacé : ${args.label}${isAdmin ? " (par l'admin)" : ""}`,
            time: Date.now(),
            author: isAdmin ? "admin" : (identity!.name ?? "client"),
          },
        ],
      });

      return existing._id;
    }

    const id = await ctx.db.insert("documents", {
      applicationId: args.applicationId,
      docKey: args.docKey,
      label: args.label,
      storageId: args.storageId,
      uploadedBy: identity!.subject,
      uploadedAt: Date.now(),
      verifiedByAdmin: false,
      isAdminUpload: isAdmin,
    });

    await ctx.db.patch(args.applicationId, {
      updatedAt: Date.now(),
      logs: [
        ...(app.logs ?? []),
        {
          msg: `📎 Document uploadé : ${args.label}${isAdmin ? " (par l'admin)" : ""}`,
          time: Date.now(),
          author: isAdmin ? "admin" : (identity!.name ?? "client"),
        },
      ],
    });

    return id;
  },
});

export const verifyDocument = mutation({
  args: {
    documentId: v.id("documents"),
    adminNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const doc = await ctx.db.get(args.documentId);
    if (!doc) throw new Error("Document introuvable");

    await ctx.db.patch(args.documentId, {
      verifiedByAdmin: true,
      adminNote: args.adminNote,
    });

    const app = await ctx.db.get(doc.applicationId);
    if (app) {
      await ctx.db.patch(doc.applicationId, {
        updatedAt: Date.now(),
        logs: [
          ...(app.logs ?? []),
          {
            msg: `✅ Document vérifié par l'admin : ${doc.label}`,
            time: Date.now(),
            author: "admin",
          },
        ],
      });
    }

    return args.documentId;
  },
});

export const remove = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAuth(identity as Record<string, unknown>);

    const doc = await ctx.db.get(args.documentId);
    if (!doc) throw new Error("Document introuvable");

    const app = await ctx.db.get(doc.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";
    if (!isAdmin && doc.uploadedBy !== identity!.subject) {
      throw new Error("Accès non autorisé");
    }

    await ctx.storage.delete(doc.storageId as Id<"_storage">);
    await ctx.db.delete(args.documentId);

    return args.documentId;
  },
});

export const listByApplication = query({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const app = await ctx.db.get(args.applicationId);
    if (!app) return [];

    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";
    if (!isAdmin && app.userId !== identity.subject) return [];

    const docs = await ctx.db
      .query("documents")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .collect();

    const visibleDocs = isAdmin ? docs : docs.filter((d) => !d.isAdminUpload);

    const withUrls = await Promise.all(
      visibleDocs.map(async (doc) => {
        const url = await ctx.storage.getUrl(doc.storageId as Id<"_storage">);
        return { ...doc, url };
      })
    );

    return withUrls;
  },
});

export const getPaymentProofUrls = query({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") {
      return { engagementUrl: null, successFeeUrl: null };
    }

    const app = await ctx.db.get(args.applicationId);
    if (!app) return { engagementUrl: null, successFeeUrl: null };

    const engagementUrl = app.paymentProofUrl
      ? await ctx.storage.getUrl(app.paymentProofUrl as Id<"_storage">)
      : null;
    const successFeeUrl = app.successFeeProofUrl
      ? await ctx.storage.getUrl(app.successFeeProofUrl as Id<"_storage">)
      : null;

    return { engagementUrl, successFeeUrl };
  },
});
