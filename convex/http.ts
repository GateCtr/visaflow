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
      result: "not_found" | "captcha" | "error";
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
  method: "GET",
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

export default http;
