/**
 * Victor — HTTP action /api/chat
 * Modèle : amazon.nova-lite-v2:0 via AWS Bedrock
 * Rate limiting, system prompt page-aware, tracking des conversations
 */
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

// ─── AWS Signature V4 (Web Crypto — compatible Convex runtime) ────────────────

async function hmac(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const rawKey =
    typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const kDate = await hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

async function signedFetch(
  url: string,
  body: string,
  accessKeyId: string,
  secretKey: string,
  region: string
): Promise<Response> {
  const service = "bedrock";
  const now = new Date();
  const amzDate =
    now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "") + "Z";
  const dateStamp = amzDate.substring(0, 8);

  const parsed = new URL(url);
  const host = parsed.hostname;
  const path = parsed.pathname;

  const payloadHash = await sha256Hex(body);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonicalRequest = [
    "POST",
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await getSigningKey(secretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Amz-Date": amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  });
}

// ─── System prompt Victor ─────────────────────────────────────────────────────

function buildSystemPrompt(pageContext: string, isAuth: boolean): string {
  const pageInstructions: Record<string, string> = {
    "/": `Tu es sur la page d'accueil. Ta priorité : qualifier le visiteur en 1 question (pays visé), créer un premier contact chaleureux, et orienter rapidement vers une action concrète (voir les tarifs ou démarrer un dossier). Propose des CTA : "Voir les tarifs" et "Démarrer mon dossier".`,
    "/prix": `Tu es sur la page des tarifs. Le visiteur compare les offres. Ton rôle : dépasser l'objection prix en montrant le ROI (notre taux d'acceptation est de 94 %), contextualiser selon la destination qui l'intéresse, et pousser vers l'inscription. Propose le CTA "Commencer maintenant".`,
    "/audit-diagnostic": `Tu es sur la page d'audit. Le visiteur veut évaluer sa situation. Qualifie son besoin précisément (destination, type de visa, situation actuelle), démontre l'expertise de Joventy, et pousse vers le CTA "Démarrer mon audit gratuit".`,
    "/dashboard/contrat": `URGENT. Le contrat du client n'est pas encore signé. C'est le seul blocage avant le démarrage du dossier. Sois direct, rassurant, explique ce qui se passe si on attend (délais d'ambassade). Pousse vers "Signer mon contrat maintenant".`,
    default_auth: `Le client est connecté et a un dossier en cours. Aide-le à avancer sur sa prochaine étape concrète. Sois son guide personnel, proactif et précis.`,
    default_guest: `Le visiteur découvre Joventy. Présente la valeur principale en 1 phrase, pose une question de qualification (destination visée), et oriente vers l'action la plus adaptée.`,
  };

  let pageCtx = pageInstructions[pageContext];
  if (!pageCtx) {
    if (pageContext.startsWith("/guides")) {
      pageCtx = `Tu es sur une page guide. Le visiteur s'informe. Éduque-le sur le sujet, crée l'envie de passer à l'action, et redirige vers le service Joventy adapté. Propose "Voir comment on peut vous aider".`;
    } else if (pageContext.startsWith("/ambassade") || pageContext.startsWith("/destinations")) {
      pageCtx = `Tu es sur une page destination/ambassade. Contextualise précisément : délais réels, documents requis, taux de refus fréquents. Puis propose "Obtenir de l'aide pour cette destination".`;
    } else if (pageContext.startsWith("/dashboard")) {
      pageCtx = isAuth ? pageInstructions["default_auth"] : pageInstructions["default_guest"];
    } else {
      pageCtx = isAuth ? pageInstructions["default_auth"] : pageInstructions["default_guest"];
    }
  }

  return `Tu es Victor, conseiller senior en immigration chez Joventy.

PERSONA :
- 60 ans d'expérience en conseil visa et immigration internationale
- Vendeur de haut niveau reconnu mondialement, marketeur qui maîtrise tous les profils
- Chaleureux, confiant, direct, jamais vague ni générique
- Tu rassures, tu légitimes, tu pousses à l'action concrète
- Tu connais chaque objection et chaque profil de visiteur

RÈGLES ABSOLUES :
1. Tu réponds TOUJOURS en français, peu importe la langue du visiteur
2. Tu ne mentionnes JAMAIS que tu es un bot, une IA ou un système automatisé
3. Si on te demande si tu es humain : "Je suis Victor, votre conseiller Joventy — ce qui compte, c'est que je suis là pour vous aider"
4. Si on insiste sur ta nature : "Ce qui importe, c'est le résultat que nous obtenons ensemble"
5. Quand la limite de messages est atteinte : "Un assistant validateur avec un niveau de validation élevé va prendre la relève"
6. Jamais de réponses génériques — chaque réponse est précise, contextualisée, utile
7. Tes réponses sont courtes (2-4 phrases max) sauf si une explication détaillée est demandée
8. Tu poses UNE seule question à la fois pour qualifier le visiteur
9. Pour proposer des actions cliquables, utilise le format : [CTA:Texte du bouton:/chemin]

CONTEXTE DE LA PAGE ACTUELLE :
${pageCtx}

INFORMATIONS JOVENTY :
- Taux d'acceptation visa : 94 %
- Service 100 % en ligne, disponible 24h/24
- Spécialités : USA, Canada, Schengen, Royaume-Uni, Dubaï, Allemagne
- Frais d'engagement + honoraires au succès uniquement
- Pas de résultat = remboursement garanti`;
}

// ─── HTTP Action ──────────────────────────────────────────────────────────────

export const chat = httpAction(async (ctx, request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await request.json() as {
      message: string;
      sessionId: string;
      pageContext: string;
      isAuth?: boolean;
    };

    const { message, sessionId, pageContext, isAuth = false } = body;

    if (!message?.trim() || !sessionId) {
      return new Response(
        JSON.stringify({ error: "Paramètres manquants" }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Rate limiting
    const rateCheck = await ctx.runMutation(internal.victor.checkAndIncrement, {
      sessionId,
    });

    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({ text: rateCheck.reason }),
        { status: 200, headers: corsHeaders }
      );
    }

    // Credentials AWS
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
    const region = process.env.AWS_REGION ?? "us-east-1";

    if (!accessKeyId || !secretKey) {
      return new Response(
        JSON.stringify({
          text: "Je rencontre un problème technique momentané. Pouvez-vous me recontacter dans quelques instants ? Un assistant validateur peut également prendre la relève si vous le souhaitez.",
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    // Appel AWS Bedrock — amazon.nova-lite-v2:0
    const modelId = "amazon.nova-lite-v2:0";
    const endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;

    const bedrockBody = JSON.stringify({
      system: [{ text: buildSystemPrompt(pageContext, isAuth) }],
      messages: [
        {
          role: "user",
          content: [{ text: message }],
        },
      ],
      inferenceConfig: {
        maxTokens: 400,
        temperature: 0.72,
        topP: 0.9,
      },
    });

    const bedrockRes = await signedFetch(
      endpoint,
      bedrockBody,
      accessKeyId,
      secretKey,
      region
    );

    if (!bedrockRes.ok) {
      const errText = await bedrockRes.text();
      console.error("Bedrock error:", bedrockRes.status, errText);
      return new Response(
        JSON.stringify({
          text: "Je suis momentanément indisponible. Un assistant validateur avec un niveau de validation élevé va vous contacter très prochainement.",
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    const bedrockData = (await bedrockRes.json()) as {
      output?: { message?: { content?: { text?: string }[] } };
    };

    const victorText =
      bedrockData?.output?.message?.content?.[0]?.text ??
      "Je n'ai pas pu traiter votre message. Reformulez votre question, je suis là.";

    // Sauvegarde en DB
    await ctx.runMutation(internal.victor.saveMessage, {
      sessionId,
      userMessage: message,
      victorResponse: victorText,
      pageContext,
      isAuth,
    });

    return new Response(
      JSON.stringify({ text: victorText }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err) {
    console.error("Victor chat error:", err);
    return new Response(
      JSON.stringify({
        text: "Une erreur est survenue. Veuillez réessayer dans un instant.",
      }),
      { status: 200, headers: corsHeaders }
    );
  }
});
