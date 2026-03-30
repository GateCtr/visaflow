import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Webhook } from "svix";

const http = httpRouter();

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
        email_address: string;
      }>;
      const email = emailAddresses?.[0]?.email_address ?? "";
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
    } else if (type === "user.deleted") {
      await ctx.runMutation(internal.users.remove, {
        clerkId: data.id as string,
      });
    }

    return new Response("OK", { status: 200 });
  }),
});

export default http;
