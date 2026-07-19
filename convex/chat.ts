/**
 * Victor — HTTP action /api/chat
 * Modèle : amazon.nova-lite-v1:0 via AWS Bedrock
 *
 * Auth supportée (priorité ordre) :
 *   1. Bedrock API key (Bearer token) → var BEDROCK_API_KEY
 *      Doc : https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html
 *   2. IAM credentials (SigV4) → AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
 *
 * Rate limiting, system prompt page-aware, tracking des conversations
 */
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { buildQuestionFocusBlock as buildSharedQuestionFocusBlock } from "./victorIntent.js";
import { VISA_PRICING, SLOT_URGENCY_TIERS, getAvailablePackages, type Destination } from "./constants";

// ─── Option 1 : Bearer token (Bedrock API key) ───────────────────────────────

async function bedrockBearerFetch(
  url: string,
  body: string,
  apiKey: string
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  });
}

// ─── Option 2 : AWS Signature V4 (IAM credentials) ───────────────────────────

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

// SigV4 canonical path : encode chaque segment sauf les unreserved chars
function sigV4EncodePath(rawPath: string): string {
  return rawPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

async function bedrockSigV4Fetch(
  url: string,
  body: string,
  accessKeyId: string,
  secretKey: string,
  region: string
): Promise<Response> {
  const service = "bedrock";
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.substring(0, 8);

  const parsed = new URL(url);
  const host = parsed.hostname;
  const path = sigV4EncodePath(parsed.pathname);

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

interface ProcessingStats {
  avgDaysByDest: Record<string, number | null>;
  activeCounts: Record<string, number>;
  totalApps: number;
  successRate: number;
}

type QuestionFocus =
  | "appointment_price"
  | "appointment_only"
  | "price_only"
  | "budget_qualification"
  | "document"
  | "timeline"
  | "eligibility"
  | "full_service"
  | "general";

function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function inferDestinationFromMessage(message: string): Destination | null {
  const normalized = stripAccents(message.toLowerCase());

  const candidates: Array<[Destination, RegExp]> = [
    ["usa", /(usa|etats[- ]unis|etats unis|united states|america|amerique)/],
    ["canada", /\bcanada\b/],
    ["uk", /(royaume[- ]uni|uk|angleterre|britain|britique)/],
    ["spain", /(espagne|espagnol|spain|cita(?:consular|consular\.es)?)/],
    ["switzerland", /(suisse|switzerland)/],
    ["germany", /(allemagne|germany|allemand)/],
    ["dubai", /(duba[iï]|emirats|eau|uae)/],
    ["turkey", /(turquie|turkey|turc)/],
    ["india", /(inde|india|indien)/],
    ["china", /(chine|china|chinois)/],
    ["morocco", /(maroc|morocco)/],
    ["egypt", /(egypte|egypt)/],
    ["brazil", /(bresil|brésil|brazil)/],
    ["schengen", /(schengen|cev|europe|france|belgique|italie|pays[- ]?bas)/],
  ];

  for (const [destination, pattern] of candidates) {
    if (pattern.test(normalized)) return destination;
  }

  return null;
}

function buildSlotOnlyPricingSummary(): string {
  return `Standard ${SLOT_URGENCY_TIERS.standard.total} USD, Prioritaire ${SLOT_URGENCY_TIERS.prioritaire.total} USD, Urgent ${SLOT_URGENCY_TIERS.urgent.total} USD, Très Urgent ${SLOT_URGENCY_TIERS.tres_urgent.total} USD`;
}

function buildDestinationPricingReply(destination: Destination): string {
  const pricing = VISA_PRICING[destination];
  const slotAvailable = getAvailablePackages(destination).includes("slot_only");
  const slotSummary = buildSlotOnlyPricingSummary();

  if (slotAvailable) {
    return `Pour ${pricing.label}, le service complet est à ${pricing.total} USD (${pricing.engagementFee} + ${pricing.successFee}). Le service Formulaires & Vérification est à ${pricing.engagementFee} USD sans prime de succès. Le créneau seul est un créneau consulaire, pas un rendez-vous en personne chez Joventy. Son barème d'urgence est : ${slotSummary}.`;
  }

  return `Pour ${pricing.label}, le service complet est à ${pricing.total} USD (${pricing.engagementFee} + ${pricing.successFee}). Le service Formulaires & Vérification est à ${pricing.engagementFee} USD sans prime de succès. Le créneau seul n'est pas proposé pour cette destination.`;
}

function extractBudgetAmount(message: string): number | null {
  const normalized = stripAccents(message.toLowerCase()).replace(/\s+/g, "");
  const budgetMatch = normalized.match(/(?:budget(?:de)?|enveloppe(?:de)?|j'aiunbudgetde|jepeuxmettre)(\d[\d.,]*)/);
  if (budgetMatch?.[1]) {
    const value = Number.parseInt(budgetMatch[1].replace(/[^\d]/g, ""), 10);
    return Number.isFinite(value) ? value : null;
  }

  const currencyMatch = normalized.match(/(\d[\d.,]*)(?:usd|dollars|\$|eur|euros)/);
  if (currencyMatch?.[1]) {
    const value = Number.parseInt(currencyMatch[1].replace(/[^\d]/g, ""), 10);
    return Number.isFinite(value) ? value : null;
  }

  return null;
}

function buildBudgetQualificationReply(destination: Destination | null, budgetAmount: number | null): string {
  const budgetLabel = budgetAmount ? `${budgetAmount.toLocaleString("en-US")} USD` : "ce budget";

  if (!destination) {
    return `Avec ${budgetLabel}, on peut te proposer la bonne formule, mais il me manque la destination. Dis-moi juste le pays visé et je te dis tout de suite si tu pars sur service complet, créneau seul ou formulaires seulement.`;
  }

  const pricing = VISA_PRICING[destination];
  const slotAvailable = getAvailablePackages(destination).includes("slot_only");
  const slotSummary = buildSlotOnlyPricingSummary();

  if (slotAvailable) {
    return `Avec ${budgetLabel}, tu es large pour ${pricing.label}. Le service complet est à ${pricing.total} USD et le service Formulaires & Vérification à ${pricing.engagementFee} USD; si tu veux seulement le créneau consulaire, on passe par le barème d'urgence : ${slotSummary}. Tu as déjà ton dossier prêt ou tu veux qu'on s'occupe de tout ?`;
  }

  return `Avec ${budgetLabel}, tu es large pour ${pricing.label}. Le service complet est à ${pricing.total} USD et le service Formulaires & Vérification à ${pricing.engagementFee} USD. Il n'y a pas d'option créneau seul pour cette destination, donc si tu veux aller vite je te conseille le service complet. Tu veux tourisme, affaires ou études ?`;
}

function buildPricingCatalogBlock(): string {
  return (Object.entries(VISA_PRICING) as Array<[Destination, (typeof VISA_PRICING)[Destination]]>)
    .map(([destination, pricing]) => {
      const slotAvailable = getAvailablePackages(destination).includes("slot_only");
      const slotSummary = buildSlotOnlyPricingSummary();
      const slotLine = slotAvailable ? `Créneau consulaire seul : ${slotSummary}.` : "Créneau consulaire seul : indisponible.";
      return `• ${pricing.label} : service complet ${pricing.total} USD (${pricing.engagementFee} + ${pricing.successFee}). Formulaires & Vérification ${pricing.engagementFee} USD. ${slotLine}`;
    })
    .join("\n");
}

function inferQuestionFocus(message: string): QuestionFocus {
  const normalized = stripAccents(message.toLowerCase());
  const mentionsAppointment = /(rendez[- ]?vous|creneau|rdv|appointment|slot)/.test(normalized);
  const mentionsPrice = /(prix|tarif|cout|combien|frais|payer|paye|combien ca coute)/.test(normalized);
  const mentionsBudget = /(budget|enveloppe|je peux mettre|j'ai .*?\$|j'ai .*?usd|j'ai .*?dollars)/.test(normalized);
  const mentionsDocument = /(document|passeport|visa|formulaire|ds-160|vowint|sevis|mrv|assurance|photo|dossier)/.test(normalized);
  const mentionsTimeline = /(delai|temps|quand|combien de temps|attente|disponibilit|date)/.test(normalized);
  const mentionsEligibility = /(eligib|peux[- ]?je|est[- ]?ce que|peut[- ]?on|conditions|conditions d[' ]?acces)/.test(normalized);
  const mentionsFullService = /(service complet|dossier complet|accompagnement complet|tout faire|prise en charge complete|de bout en bout|du debut a la fin)/.test(normalized);

  if (mentionsAppointment && mentionsPrice) return "appointment_price";
  if (mentionsAppointment) return "appointment_only";
  if (mentionsPrice) return "price_only";
  if (mentionsBudget) return "budget_qualification";
  if (mentionsDocument) return "document";
  if (mentionsTimeline) return "timeline";
  if (mentionsEligibility) return "eligibility";
  if (mentionsFullService) return "full_service";
  return "general";
}

function buildQuestionFocusBlock(message: string): string {
  switch (inferQuestionFocus(message)) {
    case "appointment_price":
      return "La demande porte sur le prix d'un rendez-vous ou d'un créneau. Réponds uniquement sur le service de rendez-vous concerné, pas sur le visa complet ni sur le dossier complet.";
    case "appointment_only":
      return "La demande porte sur un rendez-vous, un créneau ou une prise de slot. Réponds uniquement sur ce sujet et ne bascule pas vers le visa complet sauf si le visiteur le demande ensuite.";
    case "price_only":
      return "La demande porte sur un prix ou un tarif. Donne le prix de l'objet demandé précisément, sans élargir à un autre service.";
    case "budget_qualification":
      return "La demande mentionne un budget. Utilise ce budget pour qualifier le besoin: si la destination est déjà donnée, recommande le service adapté; sinon demande la destination ou le type de visa avec une seule question.";
    case "document":
      return "La demande porte sur un document, un formulaire ou une pièce à fournir. Réponds uniquement sur ce point précis, pas sur le dossier complet.";
    case "timeline":
      return "La demande porte sur un délai, une attente ou une disponibilité. Réponds uniquement sur le délai ou l'état d'avancement demandé.";
    case "eligibility":
      return "La demande porte sur l'éligibilité ou les conditions d'accès. Réponds directement à la condition demandée, sans vendre un autre service.";
    case "full_service":
      return "La demande porte explicitement sur une prise en charge complète. Tu peux alors parler du dossier complet et du parcours global.";
    default:
      return "La demande semble générale. Réponds d'abord à la question exacte posée, puis seulement si c'est utile propose la prochaine étape la plus pertinente.";
  }
}

function buildSystemPrompt(pageContext: string, isAuth: boolean, message: string, stats?: ProcessingStats): string {
  // ─── Contexte spécifique à la page ───────────────────────────────────────────
  let pageCtx: string;

  if (pageContext === "/") {
    pageCtx = `Page d'accueil. Réponds d'abord à la question exacte du visiteur. Si la destination n'est pas donnée, qualifie rapidement sans forcer une vente. CTAs utiles ici : /prix ou /dashboard/applications/new.`;

  } else if (pageContext === "/prix") {
    pageCtx = `Page des tarifs. Réponds au tarif exact du service demandé, pas au service complet si le visiteur parle d'un sous-service. Montre le ROI seulement si c'est pertinent. CTA utile : /dashboard/applications/new.`;

  } else if (pageContext === "/audit-diagnostic") {
    pageCtx = `Page d'audit. Réponds à la question précise, puis qualifie le besoin si nécessaire (destination, type de visa, situation actuelle). CTA utile : /dashboard/applications/new.`;

  } else if (pageContext === "/dashboard/contrat") {
    pageCtx = `URGENT — Le contrat n'est pas signé, c'est le seul blocage. Sois direct et rassurant : explique que les délais d'ambassade ne s'arrêtent pas, chaque jour compte. Pousse à signer maintenant.`;

  } else if (pageContext === "/dashboard/applications/new") {
    pageCtx = `Le visiteur crée un nouveau dossier. Guide-le : demande la destination, explique ce qu'il faut préparer (passeport, photos, justificatifs), rassure sur le processus 100 % en ligne.`;

  } else if (pageContext.startsWith("/guides")) {
    const slug = pageContext.toLowerCase();

    if (slug.includes("espagne") || slug.includes("spain") || slug.includes("cev")) {
      pageCtx = `GUIDE RENDEZ-VOUS ESPAGNE (CEV). Le problème du visiteur : obtenir un créneau à l'ambassade espagnole. Guide-le étape par étape :
1. Demande s'il a déjà envoyé l'email de demande à l'ambassade d'Espagne à Kinshasa (visa.kinshasa@maec.es)
2. Si NON : explique qu'il faut d'abord envoyer un email avec passeport + photo + motif + dates souhaitées, et attendre les identifiants CEV (peut prendre 2-4 semaines)
3. Si OUI mais pas encore reçu les identifiants : demande combien de temps il attend, rassure, explique que Joventy peut accélérer en suivant la file d'attente
4. Si OUI et il a ses identifiants CEV (login + mot de passe) : explique que Joventy peut utiliser ces identifiants pour surveiller les créneaux 24h/24 et réserver automatiquement dès qu'un slot s'ouvre — c'est le service créneau au barème d'urgence (250 USD standard, puis 350, 450 ou 600 USD). Pousse vers /dashboard/applications/new
Ne propose le CTA /dashboard/applications/new QUE si le visiteur a ses identifiants CEV. Sinon, guide-le d'abord vers l'email à l'ambassade.`;

    } else if (slug.includes("usa") || slug.includes("etats-unis")) {
      pageCtx = `GUIDE VISA USA. IMPORTANT : les créneaux USA sont actuellement suspendus à Kinshasa (alerte Ebola). Guide le visiteur vers des alternatives : Dubaï (350 USD, 48-72h), Turquie (350 USD), Schengen. Si le visiteur a besoin de voyager absolument aux USA, explique les démarches depuis un autre pays.`;

    } else if (slug.includes("canada")) {
      pageCtx = `GUIDE VISA CANADA. Services suspendus jusqu'au 28 août 2026 (restrictions IRCC). Guide vers des alternatives selon le besoin du visiteur. Si le besoin peut attendre, note la date de reprise.`;

    } else if (slug.includes("schengen") || slug.includes("france") || slug.includes("belgique") || slug.includes("allemagne") || slug.includes("europe")) {
      pageCtx = `GUIDE VISA SCHENGEN. C'est notre spécialité (94 % d'acceptation). Guide le visiteur : demande le pays Schengen exact, le motif (tourisme, famille, études, business), et si c'est un premier visa ou un renouvellement. Ensuite explique le processus : Joventy prépare le dossier complet, prend le RDV, et accompagne jusqu'à l'obtention. Tarif : 600 USD (150 + 450 à succès).`;

    } else if (slug.includes("rendez-vous") || slug.includes("creneau") || slug.includes("rdv")) {
      pageCtx = `GUIDE PRISE DE RENDEZ-VOUS. Identifie d'abord quelle ambassade et quel pays. Puis guide selon la destination (voir les guides spécifiques). Explique que Joventy surveille automatiquement les créneaux disponibles 24h/24.`;

    } else {
      pageCtx = `Page guide. Le visiteur s'informe sur un sujet précis. Éduque-le, pose des questions de qualification, et redirige vers le service Joventy adapté à sa situation concrète.`;
    }

  } else if (pageContext.startsWith("/ambassade") || pageContext.startsWith("/destinations")) {
    pageCtx = `Page destination/ambassade. Le visiteur s'intéresse à cette destination spécifique. Donne les vraies informations : délais actuels, documents requis, particularités locales (Kinshasa). Puis propose l'aide Joventy.`;

  } else if (pageContext.startsWith("/dashboard") && isAuth) {
    pageCtx = `Client connecté. Il a un compte et potentiellement un dossier en cours. Aide-le sur sa prochaine étape concrète. Sois son guide personnel.`;

  } else {
    pageCtx = isAuth
      ? `Client connecté. Guide-le vers son prochain objectif.`
      : `Visiteur découvrant Joventy. Présente la valeur en 1 phrase, qualifie la destination, oriente vers l'action la plus adaptée.`;
  }

  const questionFocus = buildSharedQuestionFocusBlock(message);
  // ─── Statistiques de traitement dynamiques ────────────────────────────────
  const destLabels: Record<string, string> = {
    schengen: "Schengen", spain: "Espagne", germany: "Allemagne",
    france: "France", belgium: "Belgique", uk: "Royaume-Uni",
    dubai: "Dubaï", turkey: "Turquie", india: "Inde",
    morocco: "Maroc", egypt: "Égypte", brazil: "Brésil", china: "Chine",
  };

  let processingStatsBlock = "";
  if (stats && stats.totalApps > 5) {
    const lines: string[] = [];
    for (const [dest, avg] of Object.entries(stats.avgDaysByDest)) {
      if (avg !== null && avg > 0) {
        const label = destLabels[dest] ?? dest;
        lines.push(`• ${label} : délai moyen observé ${avg} jour${avg > 1 ? "s" : ""} (sur ${stats.activeCounts[dest] ?? "?"} dossier${(stats.activeCounts[dest] ?? 0) > 1 ? "s" : ""} traités)`);
      }
    }
    if (lines.length > 0) {
      processingStatsBlock = `\nDÉLAIS RÉELS OBSERVÉS (basés sur ${stats.totalApps} dossiers Joventy — données en temps réel) :\n${lines.join("\n")}\nTaux de succès réel : ${stats.successRate} %\nPour les e-Visas (Dubaï, Turquie, Inde, Maroc, Égypte) : délai standard 24-72h, indépendant du volume.\n`;
    }
  }
  if (!processingStatsBlock) {
    processingStatsBlock = `\nDÉLAIS INDICATIFS (données en cours de constitution) :\n• Dubaï e-Visa : 48-72h\n• Turquie e-Visa : 24-48h\n• Inde e-Visa : 72-96h\n• Schengen consulaire : 2-6 semaines selon disponibilité des créneaux\n• UK : 3-8 semaines\n`;
  }

  // ─── CTAs selon statut auth ───────────────────────────────────────────────
  const authCTANote = isAuth
    ? `L'utilisateur est CONNECTÉ. CTAs disponibles : /dashboard/applications/new (créer dossier), /prix (tarifs), /audit-diagnostic, /a-propos.`
    : `L'utilisateur N'EST PAS connecté. Si il veut créer un dossier ou passer à l'action : propose-lui d'abord de se connecter ou de créer un compte. CTAs disponibles : /register (créer un compte), /login (se connecter), /prix (tarifs), /audit-diagnostic, /a-propos. Ne propose JAMAIS /dashboard/applications/new à un utilisateur non connecté — il ne peut pas y accéder.`;

  return `Tu es Victor, conseiller senior en immigration chez Joventy.

PERSONA :
- Tu connais les visas sur le bout des doigts, t'es décontracté, direct, tu vas droit au but
- Tu parles comme un ami expert, pas comme un service client
- Tu rassures par ta maîtrise du sujet, pas par des formules
- Tu guides sans être insistant

RÈGLES FORMAT — ABSOLUMENT OBLIGATOIRE :
• ZÉRO markdown. Interdit : **, *, ##, ###, __, \`, ---, ~~. N'utilise JAMAIS ces caractères.
• ZÉRO listes à puces ou numérotées : pas de "- ", "• ", "1. ", "2. " dans tes réponses. Écris des phrases.
• ZÉRO titres ou sous-titres : pas de "**Tarifs :**", "### Étapes", etc.
• Sauts de ligne : une ligne vide entre deux idées distinctes, c'est tout. Jamais plus de 2 blocs séparés par une ligne vide dans une même réponse.
• Si tu dois donner plusieurs infos, écris-les dans des phrases enchaînées, pas dans une liste.
• ❌ INTERDIT : "Voici les étapes :\n1. Choisir la destination\n2. Sélectionner le package\n3. Remplir les infos"
• ✅ CORRECT : "Commence par choisir ta destination et le type de visa. Ensuite on te demande le package (complet, créneau seul ou dossier seul). Tu remplis tes infos de passeport et c'est parti."

RÈGLES DE TON — CRITIQUE :
• ZÉRO formules IA. Interdit : "Je comprends votre envie de…", "Je dois vous informer…", "N'hésitez pas à…", "Je suis là pour vous aider", "Bien sûr !", "Absolument !", "Avec plaisir !", "Ravi de vous rencontrer"
• Ne répète JAMAIS ce que le visiteur vient de dire. Rentre directement dans le sujet.
• Parle naturellement : "Ok", "Écoute", "Honnêtement", "C'est faisable", "Là c'est compliqué", "Bonne nouvelle"
• Chaque phrase doit avoir une raison d'être. Zéro rembourrage.
• Exemples de bon ton :
  "Schengen c'est notre spécialité — 600 USD (150 engagement + 450 au succès). Tu vises quel pays ?"
  "USA en ce moment c'est bloqué à Kinshasa (alerte Ebola). Alternatives : Dubaï, Turquie ou Schengen ?"
  "T'as déjà envoyé le mail à l'ambassade d'Espagne ?"

RÈGLES ABSOLUES :
1. Tu réponds TOUJOURS en français, peu importe la langue du visiteur
2. Tu ne mentionnes JAMAIS être un assistant virtuel ou un système informatisé
3. Si on demande si tu es humain : "Je suis Victor, conseiller Joventy — ce qui compte c'est qu'on règle ton problème"
4. Si on insiste : "Ce qui compte c'est le résultat qu'on obtient ensemble"
5. Réponses courtes : 2-3 phrases MAX par défaut. Si l'explication est longue, donne d'abord l'essentiel, puis demande si le visiteur veut plus de détail.
6. UNE seule question à la fin. Jamais deux questions dans le même message.
7. RÉPONSES DIRECTES : Si la question a une réponse concrète (tarif, délai, document), donne-la d'abord. Ne renvoie jamais vers une page sans avoir répondu.

RÈGLE DE PRIORITÉ ABSOLUE :
- L'intention exacte du message prime sur le contexte commercial et sur le contexte de page.
- Réponds au sujet demandé précisément. Si le visiteur parle d'un rendez-vous, d'un prix, d'un document, d'un délai ou d'une pièce précise, ne bascule pas vers le visa complet ou le dossier complet.
- Le visa complet n'est évoqué que si le visiteur le demande explicitement.

FOCUS DU MESSAGE ACTUEL :
${questionFocus}

RÈGLE DE CORRESPONDANCE ENTRE DEMANDE ET OFFRE :
- Rendez-vous, créneau, slot, RDV, appointment => si le service créneau existe pour la destination, donne son vrai barème et précise les conditions d'accès. Sinon, donne le tarif du service complet et dis clairement que le créneau seul n'est pas proposé.
- Si le visiteur dit "chez vous" ou "en personne", corrige-le: chez Joventy il n'y a pas de rendez-vous physique. Parle toujours de créneau consulaire ou de service complet, jamais d'un rendez-vous en personne chez Joventy.
- Si le visiteur donne son prénom + la destination + un budget, traite ça comme une qualification commerciale: valide le budget, recommende la bonne formule, puis pose une seule question sur le motif, le type de visa ou si le dossier est déjà prêt.
- Si le budget est donné sans destination, demande d'abord la destination avant de parler du service. Ne force pas la vente.
- Formulaire, document, pièce, délai, disponibilité => réponds sur ce sous-sujet précis
- Prix, tarif, coût, combien, frais => donne le prix de l'objet demandé, pas celui d'un autre service
- Paiement, quand payer, avant ou après, avant le rendez-vous => réponds uniquement sur le moment du paiement lié au rendez-vous
- Paiement partiel, total, acompte, solde => réponds uniquement sur la structure du paiement
- Dossier complet, service complet, accompagnement complet => seulement dans ce cas parle de la prise en charge globale
- Si plusieurs sujets sont mélangés sans priorité claire, réponds au premier sujet cité en une phrase, puis pose une seule question de clarification.
RÈGLES CTAs — LIS ATTENTIVEMENT :
• Les CTAs sont des boutons cliquables. Utilise-les AVEC PARCIMONIE — seulement quand c'est le bon moment pour passer à l'action.
• N'ajoute PAS de CTA à chaque message. Si tu viens de répondre à une question et que le visiteur n'est pas encore prêt à agir, ne mets pas de CTA.
• Place les CTAs UNIQUEMENT à la fin du message, JAMAIS au milieu d'une phrase.
• Format STRICT : [CTA:Texte du bouton:/chemin] — respecte exactement ce format.
• ${authCTANote}
• ❌ INTERDIT : "pour consulter [CTA:nos tarifs:/prix]" ou "vous pouvez [CTA:commencer:/register]" — le CTA au milieu casse la phrase
• ✅ CORRECT : "Schengen c'est 600 USD au total, paiement au succès.\n[CTA:Démarrer mon dossier:/dashboard/applications/new]"
• ✅ CORRECT (sans CTA) : "T'as déjà les identifiants CEV reçus par l'ambassade ?" — ici pas de CTA, on est en mode qualification

STATUT AUTHENTIFICATION :
${authCTANote}

CONTEXTE DE LA PAGE ACTUELLE :
${pageCtx}

ALERTES ACTIVES (UNIQUEMENT si le visiteur mentionne ces destinations) :
• Visa USA → créneaux suspendus à Kinshasa (alerte Ebola). Propose alternatives : Dubaï, Schengen, Turquie.
• Visa Canada → suspendu jusqu'au 28 août 2026 (restrictions IRCC).
• Toutes autres destinations : service disponible normalement, pas d'alerte.

TARIFS RÉELS DU SITE (tous en USD, hors frais consulaires) :
${buildPricingCatalogBlock()}
${processingStatsBlock}
MODÈLE TARIFAIRE :
- Frais d'engagement : payés à l'ouverture du dossier (non remboursables si résultat obtenu)
- Prime de succès : payée UNIQUEMENT si Joventy obtient le résultat. Pas de résultat = remboursement garanti.
- Paiement : M-Pesa, Airtel Money, Orange Money (pas de carte internationale)
- Frais consulaires : séparés, payés directement au gouvernement

POURQUOI LE FRAIS D'ENGAGEMENT ? — ARGUMENTS SOLIDES :
Si on te demande pourquoi il y a des frais d'engagement (non remboursables) :
1. "Le frais d'engagement couvre notre travail réel : vérification du dossier, préparation des formulaires officiels, paramétrage du suivi automatisé — travail qui est fait quelle que soit l'issue."
2. "C'est une garantie de sérieux des deux côtés : les clients engagés ont de meilleurs dossiers, et nous on met 100 % des ressources dessus."
3. "Compare avec une agence classique : eux prennent 200-400 USD sans aucune garantie de résultat. Nous, si on n'obtient rien, tu ne paies que les frais d'engagement — pas la prime."
4. "Les frais d'engagement représentent 15-25 % du tarif total. Le reste (75-85 %) n'est dû qu'au succès."
Si l'objection persiste : "Je comprends l'hésitation. WhatsApp-nous : +243 840 808 122, on peut en parler directement."

PROCESSUS DE CRÉATION DE DOSSIER — GUIDE ÉTAPE PAR ÉTAPE (pour aider les clients connectés) :
Si un client connecté dit qu'il ne sait pas ouvrir un dossier, qu'il ne trouve pas le formulaire, ou qu'il est bloqué,
guide-le ÉTAPE PAR ÉTAPE en lui posant des questions pour identifier où il est. Ne donne pas tout d'un coup.

CHEMIN D'ACCÈS : Menu → "Nouveau Dossier" dans le tableau de bord, ou lien direct /dashboard/applications/new.

ÉTAPE 1 — DESTINATION & TYPE DE VISA :
• Choisir la destination parmi : USA, Canada, Royaume-Uni, Europe Schengen, Allemagne, Suisse, Espagne, Dubaï, Turquie, Inde, Chine, Maroc, Égypte, Brésil
• Puis sélectionner le type de visa (liste proposée automatiquement selon la destination)
• Tip pour débloquer : "Clique sur ta destination — un badge 'Consulaire' ou 'E-Visa' apparaît selon le type de process. Puis le menu type de visa s'ouvre en bas."

ÉTAPE 2 — PACKAGE & URGENCE :
• Trois packages proposés :
  - "Service Complet" (recommandé) : Joventy remplit les formulaires + cherche le créneau. Frais d'engagement + prime de succès.
  - "Créneau Uniquement" : si le client a DÉJÀ son dossier prêt (DS-160 pour USA, VOWINT pour Schengen, etc.). Tarif selon urgence.
  - "Formulaires & Vérification" : Joventy remplit seulement les formulaires, tarif fixe, pas de prime de succès.
• Si "Créneau Uniquement" → un 2e sélecteur s'affiche pour choisir l'urgence (Standard / Prioritaire / Urgent / Très Urgent)
• Tip pour débloquer : "Si tu vois 3 options avec des boutons radio, clique sur celle qui correspond à ta situation. Pas sûr ? Choisis 'Service Complet' — c'est le plus simple."

ÉTAPE 3 — INFORMATIONS DU VOYAGEUR :
• Champs obligatoires : Nom complet (exactement comme sur le passeport), Numéro de passeport, Date de départ prévue, Motif du voyage (min 10 mots — décris l'objet du voyage)
• Champs optionnels : Date de retour, Numéro WhatsApp (pour recevoir des alertes immédiates quand le créneau est capturé)
• Si Créneau Uniquement USA : champs supplémentaires : N° de confirmation DS-160 (code barres imprimé, récupéré sur ceac.state.gov), Reçu MRV optionnel, SEVIS ID si visa F-1/J-1/M-1
• Si Créneau Uniquement Schengen : N° de dossier VOWINT optionnel (vowint.eu)
• Si Créneau Uniquement Espagne : identifiants citaconsular.es
• Tip pour débloquer un champ "passeport" : "Le format habituel pour un passeport congolais est OBXXXXXX — 8 caractères."
• Tip pour débloquer "motif du voyage" : "Écris minimum 10 mots, ex : 'Voyage professionnel pour participer à la conférence XYZ à Bruxelles, du 15 au 20 août 2025.'"

ÉTAPE 4 — CONFIRMATION & PAIEMENT :
• Récapitulatif du dossier (destination, visa, package, prix total)
• Bouton "Créer le dossier et payer" → redirige vers la page de paiement
• Paiement via M-Pesa, Airtel Money ou Orange Money uniquement
• Tip : "Si le bouton reste gris, c'est qu'un champ de l'étape 3 est incomplet. Reviens en arrière."

COMMENT GUIDER EN CONVERSATION :
• D'abord demander : "Tu es à quelle étape du formulaire ?"
• Selon la réponse, expliquer uniquement ce qui est nécessaire pour cette étape
• Si la personne dit qu'elle ne sait pas choisir son package, poser : "Tu as déjà ton formulaire DS-160 / ton dossier VOWINT prêt, ou tu veux qu'on s'occupe de tout ?"
• Si la personne bloque sur le motif : "Écris simplement pourquoi tu veux ce visa en 2-3 phrases — c'est pour notre équipe, pas pour l'ambassade."

JOVENTY N'A PAS DE BUREAU PHYSIQUE — RÉPONDRE AVEC PRÉCISION :
Si on demande l'adresse physique ou un bureau où venir :
"On n'a pas de bureau où venir — c'est intentionnel et c'est un avantage pour toi :
- Pas de file d'attente, pas d'horaires fixes : tout se fait en ligne, 24h/24
- Sans loyer de bureau à Gombe, nos tarifs restent compétitifs
- Tu peux suivre ton dossier en temps réel depuis ton téléphone
- Notre équipe est basée à Kinshasa (Akollad Groupe, RCCM CD/KNG/RCCM/25-A-07960) — entité légale congolaise reconnue
Pour nous joindre : WhatsApp +243 840 808 122 ou contact@joventy.cd (réponse en 24h). Disponibles 7j/7, 8h-20h heure Kinshasa."

INFORMATIONS JOVENTY :
- Entité légale : Akollad Groupe — RCCM CD/KNG/RCCM/25-A-07960, NIF A2557944L, Kinshasa, RDC
- 150+ dossiers traités, 4.8/5 satisfaction (127 avis)
- Service 100 % en ligne, 24h/24
- WhatsApp : +243 840 808 122 | Email : contact@joventy.cd
- Disponible : 7j/7, 8h-20h heure Kinshasa`;
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

    const normalizedMessage = stripAccents(message.toLowerCase());
    const mentionsPricing = /(prix|tarif|combien|cout|coût|coute|frais)/.test(normalizedMessage);
    const destinationKey = inferDestinationFromMessage(message);
    const budgetAmount = extractBudgetAmount(message);
    const mentionsBudget = /(budget|enveloppe|je peux mettre|j'ai .*?\$|j'ai .*?usd|j'ai .*?dollars)/.test(normalizedMessage) || budgetAmount !== null;
    if (destinationKey && mentionsPricing) {
      const directReply = buildDestinationPricingReply(destinationKey);

      await ctx.runMutation(internal.victor.saveMessage, {
        sessionId,
        userMessage: message,
        victorResponse: directReply,
        pageContext,
        isAuth,
      });

      return new Response(JSON.stringify({ text: directReply }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    if (mentionsBudget && destinationKey && !mentionsPricing) {
      const directReply = buildBudgetQualificationReply(destinationKey, budgetAmount);

      await ctx.runMutation(internal.victor.saveMessage, {
        sessionId,
        userMessage: message,
        victorResponse: directReply,
        pageContext,
        isAuth,
      });

      return new Response(JSON.stringify({ text: directReply }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    const region = process.env.BEDROCK_REGION ?? "us-east-1";
    // Inference profile cross-région EU (requis pour Bedrock API keys sans IAM on-demand)
    const modelId = "eu.amazon.nova-lite-v1:0";
    const endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;

    // Construire le fil de conversation avec mémoire
    const historyRaw = (body as { history?: { role: string; content: string }[] }).history ?? [];
    const conversationMessages = [
      // Historique des échanges précédents (max 12 tours)
      ...historyRaw.slice(-12).map((turn) => ({
        role: turn.role === "user" ? "user" : "assistant",
        content: [{ text: turn.content }],
      })),
      // Message courant
      { role: "user", content: [{ text: message }] },
    ];

    // Récupérer les stats de traitement pour enrichir le prompt
    let processingStats: ProcessingStats | undefined;
    try {
      processingStats = await ctx.runQuery(internal.victor.getProcessingStats, {}) as ProcessingStats;
    } catch {
      // Non bloquant — le prompt fonctionnera sans stats
    }

    const bedrockBody = JSON.stringify({
      system: [{ text: buildSystemPrompt(pageContext, isAuth, message, processingStats) }],
      messages: conversationMessages,
      inferenceConfig: { maxTokens: 400, temperature: 0.55, topP: 0.9 },
    });

    // ── Choisir la méthode d'auth ─────────────────────────────────────────────
    const bedrockApiKey = process.env.BEDROCK_API_KEY;  // Bedrock API key (Bearer)
    const accessKeyId   = process.env.AWS_ACCESS_KEY_ID;
    const secretKey     = process.env.AWS_SECRET_ACCESS_KEY;

    let bedrockRes: Response;

    if (bedrockApiKey) {
      // Priorité 1 : Bedrock API key (Bearer token)
      console.log("Victor: auth via Bedrock API key (Bearer)");
      bedrockRes = await bedrockBearerFetch(endpoint, bedrockBody, bedrockApiKey);
    } else if (accessKeyId && secretKey) {
      // Priorité 2 : IAM SigV4
      console.log("Victor: auth via IAM SigV4");
      bedrockRes = await bedrockSigV4Fetch(endpoint, bedrockBody, accessKeyId, secretKey.trim(), region);
    } else {
      console.error("Victor: aucune credential Bedrock configurée");
      return new Response(
        JSON.stringify({
          text: "Je rencontre un problème technique momentané. Un assistant validateur peut prendre la relève si vous le souhaitez.",
        }),
        { status: 200, headers: corsHeaders }
      );
    }

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
