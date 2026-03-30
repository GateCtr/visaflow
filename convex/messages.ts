import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  return (identity.role as string) || "client";
}

export const list = query({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const app = await ctx.db.get(args.applicationId);
    if (!app) return [];

    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";
    if (!isAdmin && app.userId !== identity.subject) return [];

    return ctx.db
      .query("messages")
      .withIndex("by_application", (q) =>
        q.eq("applicationId", args.applicationId)
      )
      .order("asc")
      .collect();
  },
});

export const send = mutation({
  args: {
    applicationId: v.id("applications"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Application not found");

    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";
    if (!isAdmin && app.userId !== identity.subject)
      throw new Error("Unauthorized");

    const senderName = isAdmin
      ? "Joventy (Admin)"
      : `${identity.givenName || ""} ${identity.familyName || ""}`.trim() ||
        identity.email ||
        "Client";

    await ctx.db.insert("messages", {
      applicationId: args.applicationId,
      senderId: identity.subject,
      senderName,
      content: args.content,
      isFromAdmin: isAdmin,
      readBy: [identity.subject],
    });

    await ctx.db.patch(args.applicationId, { updatedAt: Date.now() });
  },
});

export const markAsRead = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return;

    const userId = identity.subject;
    const app = await ctx.db.get(args.applicationId);
    if (!app) return;

    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";
    if (!isAdmin && app.userId !== userId) return;

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_application", (q) =>
        q.eq("applicationId", args.applicationId)
      )
      .collect();

    for (const msg of messages) {
      const readBy = msg.readBy || [];
      if (!readBy.includes(userId)) {
        await ctx.db.patch(msg._id, { readBy: [...readBy, userId] });
      }
    }
  },
});

export const getUnreadTotal = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return 0;

    const userId = identity.subject;
    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";

    let apps;
    if (isAdmin) {
      apps = await ctx.db.query("applications").collect();
    } else {
      apps = await ctx.db
        .query("applications")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
    }

    let total = 0;
    for (const app of apps) {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_application", (q) =>
          q.eq("applicationId", app._id)
        )
        .collect();

      total += msgs.filter((m) => {
        const readBy = m.readBy || [];
        const notRead = !readBy.includes(userId);
        const notMine = m.senderId !== userId;
        const relevantSide = isAdmin ? !m.isFromAdmin : m.isFromAdmin;
        return notRead && notMine && relevantSide;
      }).length;
    }

    return total;
  },
});

export const listConversations = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const userId = identity.subject;
    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";

    let apps;
    if (isAdmin) {
      apps = await ctx.db.query("applications").order("desc").collect();
    } else {
      apps = await ctx.db
        .query("applications")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .order("desc")
        .collect();
    }

    const result = [];
    for (const app of apps) {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_application", (q) =>
          q.eq("applicationId", app._id)
        )
        .order("desc")
        .collect();

      if (!isAdmin && msgs.length === 0) continue;

      const lastMsg = msgs[0] || null;
      const unreadCount = msgs.filter((m) => {
        const readBy = m.readBy || [];
        const notRead = !readBy.includes(userId);
        const notMine = m.senderId !== userId;
        const relevantSide = isAdmin ? !m.isFromAdmin : m.isFromAdmin;
        return notRead && notMine && relevantSide;
      }).length;

      result.push({
        _id: app._id,
        applicantName: app.applicantName,
        destination: app.destination,
        visaType: app.visaType,
        status: app.status,
        userFirstName: app.userFirstName,
        userLastName: app.userLastName,
        userEmail: app.userEmail,
        updatedAt: app.updatedAt,
        lastMessage: lastMsg
          ? {
              content: lastMsg.content,
              senderName: lastMsg.senderName,
              isFromAdmin: lastMsg.isFromAdmin,
              _creationTime: lastMsg._creationTime,
            }
          : null,
        unreadCount,
        messageCount: msgs.length,
      });
    }

    return result.sort((a, b) => {
      const ta = a.lastMessage?._creationTime ?? a.updatedAt;
      const tb = b.lastMessage?._creationTime ?? b.updatedAt;
      return tb - ta;
    });
  },
});
