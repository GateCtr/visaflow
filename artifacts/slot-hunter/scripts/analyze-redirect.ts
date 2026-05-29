/**
 * Analyse approfondie de la redirection CEV :
 * - C'est côté serveur ou frontend ?
 * - Que contient l'URL ?
 * - Peut-on la reproduire ?
 */
import "dotenv/config";
import { Impit } from "impit";

const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const SOAX = process.env.SOAX_PROXY_URL || "";
const p = new URL(SOAX);
p.password = encodeURIComponent(decodeURIComponent(p.password) + "_country-cd_city-kinshasa_sessionid-anal" + Date.now() + "_sessiontime-600");
const impit = new Impit({ proxy: p.toString() });
const f = (u: string, o: any) => impit.fetch(u, o) as unknown as Promise<Response>;

function log(m: string) { console.log("[" + new Date().toISOString().slice(11, 19) + "] " + m); }

async function main() {
  log("═══════════════════════════════════════════════════════");
  log("  ANALYSE: COMMENT FONCTIONNE LA REDIRECTION CEV ?");
  log("═══════════════════════════════════════════════════════");
  log("");

  // D'après nos tests précédents, voici l'URL de redirect qu'on a obtenue:
  // https://appointment.cloud.diplomatie.be/Integration/VOW/{orgId}/{appId}/{sessionGuid}/{tokenGuid}/{lang}
  // Exemple réel: /Integration/VOW/df171b6f-.../e978b2fd-.../59eba882-.../0019cc20-.../en-US

  log("1. STRUCTURE DE L'URL DE REDIRECTION:");
  log("   /Integration/VOW/{orgId}/{appId}/{sessionGuid}/{tokenGuid}/{lang}");
  log("");
  log("   orgId = ID de l'organisation CEV (fixe pour Kinshasa)");
  log("   appId = UUID du dossier VOWINT (lié au demandeur)");
  log("   sessionGuid = CRÉÉ par le serveur lors du SetCaptchaToken");
  log("   tokenGuid = CRÉÉ par le serveur lors du SetCaptchaToken");
  log("   lang = en-US / fr-BE");
  log("");

  log("2. FLOW COMPLET (d'après le bundle JS + nos tests):");
  log("");
  log("   ÉTAPE 1: SetCaptchaToken (POST AJAX)");
  log("   → Client envoie: {captcha: 'P1_eyJ...'} ");
  log("   → Serveur vérifie le token hCaptcha");
  log("   → Serveur CRÉE sessionGuid + tokenGuid côté serveur");
  log("   → Serveur retourne: {validUntil: '...', redirectUrl: '/Integration/VOW/...'}");
  log("   → C'est le JS client qui fait location.href = redirectUrl");
  log("");
  log("   ÉTAPE 2: GET redirectUrl (navigation browser)");
  log("   → Le serveur reçoit GET /Integration/VOW/{org}/{app}/{session}/{token}/{lang}");
  log("   → Le serveur vérifie que sessionGuid+tokenGuid sont valides");
  log("   → Le serveur regarde EN TEMPS RÉEL s'il y a des slots pour cet orgId");
  log("   → DÉCISION (côté SERVEUR, 302 redirect):");
  log("      SI slots dispo → 302 → /Integration/VOW/SelectSlot");
  log("      SI pas de slots → 302 → /Integration/Error/NoAvailability");
  log("      SI session invalide → 302 → /Integration/Error/Default");
  log("");

  log("3. QUI DÉCIDE DE LA REDIRECTION ?");
  log("   → C'est le SERVEUR qui décide (HTTP 302)");
  log("   → La décision est prise AU MOMENT DU GET redirectUrl");
  log("   → L'URL redirectUrl elle-même ne contient PAS l'info slot/no-slot");
  log("   → C'est le serveur qui checke les dispos en base de données");
  log("");

  log("4. POURQUOI ON N'ARRIVE JAMAIS À SelectSlot ?");
  log("   → Parce qu'au moment où NOTRE bot fait le GET redirectUrl,");
  log("     il n'y a JAMAIS de slots disponibles (déjà pris)");
  log("   → Les slots sont pris en < 3 minutes après libération");
  log("   → Notre bot a 1 chance toutes les 3 min de tomber au bon moment");
  log("");

  log("5. PEUT-ON REPRODUIRE L'URL DE REDIRECT ?");
  log("   → L'URL contient sessionGuid et tokenGuid");
  log("   → Ces GUIDs sont CRÉÉS côté serveur par SetCaptchaToken");
  log("   → On ne peut PAS les deviner/générer nous-mêmes");
  log("   → MAIS: on peut obtenir cette URL sans résoudre le captcha!");
  log("");

  log("6. TEST CLÉ: Le serveur vérifie-t-il vraiment le captcha token ?");
  log("");

  // Test: envoyer un token bidon et voir si on obtient quand même un redirectUrl valide
  log("   Test avec token bidon...");
  const freshRes = await f(CEV_BASE + "/Captcha", { method: "GET", headers: { "User-Agent": UA }, redirect: "follow" });
  const freshBody = await freshRes.text();
  const freshCookie = (freshRes.headers.get("set-cookie") || "").match(/ASP\.NET_SessionId=([^;]+)/)?.[1] || "";
  log("   Cookie frais: " + freshCookie.slice(0, 16));

  const cevCk = `ASP.NET_SessionId=${freshCookie}; PreferredCulture=en-US`;

  // Submit dummy token
  const stRes = await f(CEV_BASE + "/Captcha/SetCaptchaToken", {
    method: "POST", redirect: "manual",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Cookie": cevCk, "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, */*", "Referer": CEV_BASE + "/Captcha", "Origin": CEV_BASE },
    body: "captcha=FAKE_TOKEN_TEST",
  });
  const stBody = await stRes.text();
  log("   SetCaptchaToken avec FAKE token: status=" + stRes.status);
  log("   Response: " + stBody.slice(0, 300));

  let hasValidRedirect = false;
  try {
    const data = JSON.parse(stBody);
    if (data.redirectUrl) {
      hasValidRedirect = true;
      log("");
      log("   🚨 SERVEUR ACCEPTE LE TOKEN BIDON! redirectUrl reçu: " + data.redirectUrl.slice(0, 80));
      log("   validUntil: " + data.validUntil);
      log("");
      log("   → Maintenant testons: GET cette redirectUrl...");
      
      const rUrl = data.redirectUrl.startsWith("http") ? data.redirectUrl : CEV_BASE + data.redirectUrl;
      const hop1 = await f(rUrl, { method: "GET", redirect: "manual", headers: { "User-Agent": UA, "Cookie": cevCk } });
      log("   → Hop 1: " + hop1.status + " Location: " + (hop1.headers.get("location") || "none"));
      
      if (hop1.status >= 300) {
        const loc = hop1.headers.get("location") || "";
        log("");
        if (loc.includes("SelectSlot")) {
          log("   🎉🎉🎉 SELECTSLOT! Des slots existent!");
        } else if (loc.includes("NoAvailability")) {
          log("   ⚠️ NoAvailability — mais le TOKEN BIDON A ÉTÉ ACCEPTÉ!");
          log("   → Le serveur NE VÉRIFIE PAS le hCaptcha côté serveur!");
          log("   → On peut scanner SANS résoudre de captcha!");
        } else if (loc.includes("Error")) {
          log("   ❌ Error — le token bidon est rejeté au niveau du redirect");
          log("   → Le serveur VÉRIFIE le token au moment du GET redirect");
        }
      }
    } else {
      log("   → Pas de redirectUrl dans la réponse (token peut-être rejeté côté serveur)");
    }
  } catch {
    log("   → Non-JSON (probablement HTML erreur)");
  }

  if (!hasValidRedirect) {
    log("");
    log("   Le serveur a rejeté le token bidon au niveau de SetCaptchaToken.");
    log("   → Le captcha EST vérifié côté serveur.");
  }

  log("");
  log("═══════════════════════════════════════════════════════");
  log("  RÉSUMÉ");
  log("═══════════════════════════════════════════════════════");
  log("");
  log("  La redirection est: CÔTÉ SERVEUR (HTTP 302)");
  log("  SetCaptchaToken: crée sessionGuid+tokenGuid côté serveur");
  log("  GET redirectUrl: serveur vérifie slots EN TEMPS RÉEL → 302");
  log("  Le redirect est imprévisible (dépend de la dispo au moment T)");
  log("");
  log("  Pour intercepter: on peut PAS prédire la destination du redirect");
  log("  MAIS: si le token bidon est accepté → on peut scanner sans captcha!");
  log("");

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
