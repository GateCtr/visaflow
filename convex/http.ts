import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { Webhook } from "svix";

const http = httpRouter();

function requireHunterKey(request: Request): Response | null {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) {
    return new Response("Hunter API key not configured on server", { status: 500 });
  }
  const provided = request.headers.get("X-Hunter-Key");
  if (!provided || provided !== apiKey) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

function requireOtpWebhookKey(request: Request): Response | null {
  const otpKey = process.env.TELEGRAM_OTP_WEBHOOK_KEY;
  // Fallback pragmatique : si non configurée, autoriser la clé hunter
  const expected = otpKey || process.env.HUNTER_API_KEY;
  if (!expected) {
    return new Response("OTP webhook key not configured on server", { status: 500 });
  }
  const provided = request.headers.get("X-OTP-Key");
  if (!provided || provided !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("CLERK_WEBHOOK_SECRET is not set");
      return new Response("Webhook secret not configured", { status: 500 });
    }

    const svix_id = request.headers.get("svix-id");
    const svix_timestamp = request.headers.get("svix-timestamp");
    const svix_signature = request.headers.get("svix-signature");

    if (!svix_id || !svix_timestamp || !svix_signature) {
      return new Response("Missing svix headers", { status: 400 });
    }

    const rawBody = await request.text();

    const wh = new Webhook(webhookSecret);
    let payload: { type: string; data: Record<string, unknown> };

    try {
      payload = wh.verify(rawBody, {
        "svix-id": svix_id,
        "svix-timestamp": svix_timestamp,
        "svix-signature": svix_signature,
      }) as { type: string; data: Record<string, unknown> };
    } catch (err) {
      console.error("Webhook signature verification failed:", err);
      return new Response("Invalid signature", { status: 400 });
    }

    const { type, data } = payload;
    console.log(`Clerk webhook received: ${type}`);

    if (type === "user.created" || type === "user.updated") {
      const emailAddresses = data.email_addresses as Array<{
        id: string;
        email_address: string;
      }>;
      const primaryEmailId = data.primary_email_address_id as string | undefined;
      const primaryEmailObj = primaryEmailId
        ? (emailAddresses?.find((e) => e.id === primaryEmailId) ?? emailAddresses?.[0])
        : emailAddresses?.[0];
      const email = primaryEmailObj?.email_address ?? "";

      const publicMetadata = data.public_metadata as Record<string, unknown>;
      const role = (publicMetadata?.role as string) ?? "client";

      await ctx.runMutation(internal.users.upsert, {
        clerkId: data.id as string,
        email,
        firstName: (data.first_name as string) || undefined,
        lastName: (data.last_name as string) || undefined,
        imageUrl: (data.image_url as string) || undefined,
        role: type === "user.created" ? role : undefined,
      });

      // Write role into Clerk publicMetadata so JWT template can include it
      if (type === "user.created") {
        const clerkSecretKey = process.env.CLERK_SECRET_KEY;
        if (clerkSecretKey && !publicMetadata?.role) {
          try {
            await fetch(`https://api.clerk.com/v1/users/${data.id}/metadata`, {
              method: "PATCH",
              headers: {
                "Authorization": `Bearer ${clerkSecretKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ public_metadata: { role: "client" } }),
            });
            console.log(`Set publicMetadata.role=client for user ${data.id}`);
          } catch (err) {
            console.error("Failed to set publicMetadata.role on Clerk:", err);
          }
        }
      }

      if (type === "user.created" && email) {
        await ctx.runAction(internal.emails.sendWelcomeClient, {
          email,
          firstName: (data.first_name as string) || undefined,
        });
      }
    } else if (type === "user.deleted") {
      await ctx.runMutation(internal.users.remove, {
        clerkId: data.id as string,
      });
    }

    return new Response("OK", { status: 200 });
  }),
});

http.route({
  path: "/hunter/jobs",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    const jobs = await ctx.runQuery(internal.hunter.getActiveJobs);
    return new Response(JSON.stringify(jobs), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ─── CEV Sessions: liste active pour le bot polling ─────────────────────────
http.route({
  path: "/hunter/cev-sessions",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    // Claim atomique : retourne uniquement les sessions dues + pose un lock 30s
    const sessions = await ctx.runMutation(internal.cevSessions.internalClaimDue);
    return new Response(JSON.stringify(sessions), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ─── CEV Sessions: sessions en attente d'établissement (needs_setup) ────────
http.route({
  path: "/hunter/cev-sessions/needs-setup",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    const sessions = await ctx.runMutation(internal.cevSessions.internalClaimNeedsSetup);
    return new Response(JSON.stringify(sessions), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ─── CEV Sessions: activer une session après setup bot (nouveau cookie) ──────
http.route({
  path: "/hunter/cev-sessions/activate",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    const body = await request.json() as {
      sessionId: string;
      sessionCookie: string;
      validUntilMs?: number;
      integrationUrl?: string;  // URL d'intégration découverte par le bot (mode credentials)
    };

    await ctx.runMutation(internal.cevSessions.internalActivateSession, {
      sessionId: body.sessionId as Id<"cevSessions">,
      sessionCookie: body.sessionCookie,
      validUntilMs: body.validUntilMs,
      integrationUrl: body.integrationUrl,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ─── CEV Loop Session: persister la session active (survie crashs/redémarrages) ─
http.route({
  path: "/hunter/cev-loop/persist",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    const body = await request.json() as {
      applicationId: string;
      sessionCookie: string;
      validUntil: string;
      redirectUrl: string;
    };

    await ctx.runMutation(internal.hunter.internalPersistCevLoopSession, {
      applicationId: body.applicationId as Id<"applications">,
      sessionCookie: body.sessionCookie,
      validUntil: body.validUntil,
      redirectUrl: body.redirectUrl,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ─── CEV Loop Session: restaurer la session active au démarrage du bot ───────
http.route({
  path: "/hunter/cev-loop/restore",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    const url = new URL(request.url);
    const applicationId = url.searchParams.get("applicationId");
    if (!applicationId) {
      return new Response(JSON.stringify({ session: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const session = await ctx.runQuery(internal.hunter.internalGetCevLoopSession, {
      applicationId: applicationId as Id<"applications">,
    });

    return new Response(JSON.stringify({ session: session ?? null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ─── CEV Sessions: enregistrer le résultat d'un check ───────────────────────
http.route({
  path: "/hunter/cev-sessions/check",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    const body = await request.json() as {
      sessionId: string;
      result: "no_slot" | "slot_found" | "session_expired" | "error";
      error?: string;
    };

    await ctx.runMutation(internal.cevSessions.internalRecordCheck, {
      sessionId: body.sessionId as Id<"cevSessions">,
      result: body.result,
      error: body.error,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/hunter/slot-found",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    let body: {
      applicationId: string;
      date: string;
      time: string;
      location: string;
      confirmationCode?: string;
      screenshotStorageId?: string;
    };

    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (!body.applicationId || !body.date || !body.time || !body.location) {
      return new Response("Missing required fields: applicationId, date, time, location", { status: 400 });
    }

    try {
      await ctx.runMutation(internal.hunter.markSlotFoundByHunter, {
        applicationId: body.applicationId as Id<"applications">,
        date: body.date,
        time: body.time,
        location: body.location,
        confirmationCode: body.confirmationCode,
        screenshotStorageId: body.screenshotStorageId,
      });

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error("hunter/slot-found error:", msg);
      return new Response(JSON.stringify({ ok: false, error: msg }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

http.route({
  path: "/hunter/heartbeat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    let body: {
      applicationId: string;
      result: "not_found" | "captcha" | "error" | "payment_required";
      errorMessage?: string;
      shouldPause?: boolean;
    };

    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (!body.applicationId || !body.result) {
      return new Response("Missing required fields: applicationId, result", { status: 400 });
    }

    if (!["not_found", "captcha", "error", "payment_required"].includes(body.result)) {
      return new Response("result must be one of: not_found, captcha, error, payment_required", { status: 400 });
    }

    await ctx.runMutation(internal.hunter.recordHeartbeat, {
      applicationId: body.applicationId as Id<"applications">,
      result: body.result,
      errorMessage: body.errorMessage,
      shouldPause: body.shouldPause,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/hunter/otp/request",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    let body: {
      applicationId: string;
      flow: string;
      channel?: string;
      ttlMs?: number;
      chatId?: string;
    };
    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }
    if (!body.applicationId || !body.flow) {
      return new Response("Missing required fields: applicationId, flow", { status: 400 });
    }

    const out = await ctx.runMutation(internal.hunter.requestOtpChallenge, {
      applicationId: body.applicationId as Id<"applications">,
      flow: body.flow,
      channel: body.channel,
      ttlMs: body.ttlMs,
      chatId: body.chatId,
    });

    return new Response(JSON.stringify({ ok: true, ...out }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/hunter/otp/consume",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;
    const u = new URL(request.url);
    const applicationId = u.searchParams.get("applicationId");
    const flow = u.searchParams.get("flow") ?? "spain";
    if (!applicationId) {
      return new Response("Missing required query param: applicationId", { status: 400 });
    }

    const out = await ctx.runMutation(internal.hunter.consumeOtpCode, {
      applicationId: applicationId as Id<"applications">,
      flow,
    });
    return new Response(JSON.stringify({ ok: true, ...out }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

/**
 * Endpoint universel d'ingestion OTP — reçoit le texte brut d'un email ou SMS,
 * extrait le code et le soumet au défi en cours.
 *
 * Auth  : query param ?secret=OTP_INGEST_SECRET  (ou X-OTP-Key / X-Hunter-Key header)
 * AppId : query param ?applicationId=  OU  adresse destinataire otp+{appId}@joventy.cd
 *
 * Body acceptés :
 *   - application/json          { raw_text, text, body, Body, applicationId?, flow? }
 *   - application/x-www-form-urlencoded  (Mailgun: body-plain, stripped-text)
 *   - text/plain                corps brut
 */
http.route({
  path: "/hunter/otp/ingest",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // ── Authentification ─────────────────────────────────────────────────────
    const ingestSecret = process.env.OTP_INGEST_SECRET ?? process.env.HUNTER_API_KEY;
    if (!ingestSecret) {
      return new Response("OTP_INGEST_SECRET not configured", { status: 500 });
    }
    const url = new URL(request.url);
    const secretParam = url.searchParams.get("secret");
    const headerKey =
      request.headers.get("X-OTP-Key") ??
      request.headers.get("X-Hunter-Key");
    if (secretParam !== ingestSecret && headerKey !== ingestSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    // ── Lecture du corps ──────────────────────────────────────────────────────
    const contentType = request.headers.get("Content-Type") ?? "";
    let rawText = "";
    let bodyAppId: string | null = null;
    let bodyFlow: string | null = null;

    if (contentType.includes("application/json")) {
      try {
        // Record<string, unknown> car Resend envoie `to` en tableau string[]
        const j = await request.json() as Record<string, unknown>;
        rawText =
          (j.raw_text as string | undefined) ??
          (j.text as string | undefined) ??       // Resend inbound: champ "text"
          (j.body as string | undefined) ??
          (j.Body as string | undefined) ??
          (j.message as string | undefined) ?? "";
        bodyAppId = (j.applicationId as string | undefined) ?? null;
        bodyFlow = (j.flow as string | undefined) ?? null;

        // Resend inbound: champ "to" est un tableau ["otp+{appId}@joventy.cd"]
        // Extrait l'applicationId depuis l'adresse destinataire si pas déjà fourni
        if (!bodyAppId) {
          const toField = j.to;
          const toAddresses: string[] = Array.isArray(toField)
            ? (toField as string[])
            : typeof toField === "string"
              ? [toField]
              : [];
          for (const addr of toAddresses) {
            const m = addr.match(/otp\+([^@+\s]+)@/i);
            if (m) { bodyAppId = m[1]; break; }
          }
        }
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
    } else if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
      try {
        const form = await request.formData();
        // Mailgun: body-plain > stripped-text > body-html
        rawText =
          (form.get("body-plain") as string | null) ??
          (form.get("stripped-text") as string | null) ??
          (form.get("body-html") as string | null) ??
          (form.get("text") as string | null) ??
          (form.get("body") as string | null) ?? "";
        // Mailgun recipient field: "otp+{appId}@joventy.cd"
        const recipient = (form.get("recipient") as string | null) ?? (form.get("To") as string | null) ?? "";
        const recipientMatch = recipient.match(/otp\+([^@+\s]+)@/i);
        if (recipientMatch) bodyAppId = recipientMatch[1];
        bodyFlow = (form.get("flow") as string | null);
      } catch {
        rawText = await request.text().catch(() => "");
      }
    } else {
      rawText = await request.text().catch(() => "");
    }

    // ── Résolution applicationId ──────────────────────────────────────────────
    // Priorité : body > query param > encodé dans destinataire email
    const qAppId = url.searchParams.get("applicationId");
    const flow = bodyFlow ?? url.searchParams.get("flow") ?? "spain";

    // Extrait depuis adresse destinataire dans query (e.g. ?to=otp+abc123@joventy.cd)
    const toParam = url.searchParams.get("to") ?? "";
    const toMatch = toParam.match(/otp\+([^@+\s]+)@/i);

    const resolvedAppId = bodyAppId ?? qAppId ?? toMatch?.[1] ?? null;

    if (!rawText.trim()) {
      return new Response(JSON.stringify({ ok: false, error: "empty_text" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Ingestion ─────────────────────────────────────────────────────────────
    const result = await ctx.runMutation(internal.hunter.ingestOtp, {
      rawText,
      applicationId: resolvedAppId ? resolvedAppId as Id<"applications"> : undefined,
      flow,
    });

    console.log("[OTP ingest]", JSON.stringify({ ...result, rawText: rawText.slice(0, 80) }));

    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 422,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Alias GET pour les SMS forwarders qui ne supportent que GET
http.route({
  path: "/hunter/otp/ingest",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const ingestSecret = process.env.OTP_INGEST_SECRET ?? process.env.HUNTER_API_KEY;
    if (!ingestSecret) return new Response("OTP_INGEST_SECRET not configured", { status: 500 });

    const url = new URL(request.url);
    if ((url.searchParams.get("secret") ?? url.searchParams.get("key")) !== ingestSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    const rawText = url.searchParams.get("text") ?? url.searchParams.get("body") ?? url.searchParams.get("sms") ?? "";
    const qAppId = url.searchParams.get("applicationId");
    const flow = url.searchParams.get("flow") ?? "spain";

    if (!rawText.trim()) {
      return new Response(JSON.stringify({ ok: false, error: "empty_text" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    const result = await ctx.runMutation(internal.hunter.ingestOtp, {
      rawText,
      applicationId: qAppId ? qAppId as Id<"applications"> : undefined,
      flow,
    });

    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 422,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/hunter/otp/submit",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const err = requireOtpWebhookKey(request);
    if (err) return err;

    let body: {
      applicationId: string;
      flow?: string;
      code: string;
      chatId?: string;
    };
    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }
    if (!body.applicationId || !body.code) {
      return new Response("Missing required fields: applicationId, code", { status: 400 });
    }
    const out = await ctx.runMutation(internal.hunter.submitOtpCode, {
      applicationId: body.applicationId as Id<"applications">,
      flow: body.flow ?? "spain",
      code: body.code,
      chatId: body.chatId,
    });

    return new Response(JSON.stringify(out), {
      status: out.ok ? 200 : 422,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/hunter/attach-confirmation-doc",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    let body: {
      applicationId: string;
      storageId: string;
      docKey: string;
      label: string;
    };

    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (!body.applicationId || !body.storageId || !body.docKey || !body.label) {
      return new Response("Missing required fields: applicationId, storageId, docKey, label", { status: 400 });
    }

    try {
      const docId = await ctx.runMutation(internal.hunter.attachConfirmationDoc, {
        applicationId: body.applicationId as Id<"applications">,
        storageId: body.storageId,
        docKey: body.docKey,
        label: body.label,
      });
      return new Response(JSON.stringify({ ok: true, docId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error("hunter/attach-confirmation-doc error:", msg);
      return new Response(JSON.stringify({ ok: false, error: msg }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

http.route({
  path: "/hunter/upload-screenshot",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    let body: { base64: string; contentType?: string };
    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (!body.base64) {
      return new Response("Missing required field: base64", { status: 400 });
    }

    try {
      const binaryStr = atob(body.base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: body.contentType ?? "image/png" });
      const storageId = await ctx.storage.store(blob);

      return new Response(JSON.stringify({ ok: true, storageId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error("hunter/upload-screenshot error:", msg);
      return new Response(JSON.stringify({ ok: false, error: msg }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

http.route({
  path: "/hunter/pending-test",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    const test = await ctx.runMutation(internal.hunter.claimPendingBotTest);

    if (!test) {
      return new Response(JSON.stringify({ test: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ test }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/hunter/log",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    let body: {
      applicationId: string;
      step: string;
      status: "ok" | "warn" | "fail";
      data?: Record<string, unknown>;
    };

    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!body.applicationId || !body.step || !body.status) {
      return new Response("Missing required fields: applicationId, step, status", { status: 400 });
    }

    try {
      await ctx.runMutation(internal.botLogs.add, {
        applicationId: body.applicationId as Id<"applications">,
        step: body.step,
        status: body.status,
        data: body.data ? JSON.stringify(body.data) : undefined,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error("hunter/log error:", msg);
      return new Response(JSON.stringify({ ok: false, error: msg }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

http.route({
  path: "/hunter/test-result",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    let body: {
      testId: string;
      result: string;
      latencyMs?: number;
      httpStatus?: number;
      errorMessage?: string;
    };

    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!body.testId || !body.result) {
      return new Response("Missing testId or result", { status: 400 });
    }

    await ctx.runMutation(internal.hunter.completeBotTest, {
      testId: body.testId as Id<"botTests">,
      result: body.result,
      latencyMs: body.latencyMs,
      httpStatus: body.httpStatus,
      errorMessage: body.errorMessage,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/hunter/cev-click",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const err = requireHunterKey(request);
    if (err) return err;

    let body: { applicationId: string; windowStart: number; clickCount: number };
    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!body.applicationId || body.windowStart == null || body.clickCount == null) {
      return new Response("Missing required fields", { status: 400 });
    }

    await ctx.runMutation(internal.hunter.recordCevClick, {
      applicationId: body.applicationId as Id<"applications">,
      windowStart: body.windowStart,
      clickCount: body.clickCount,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
