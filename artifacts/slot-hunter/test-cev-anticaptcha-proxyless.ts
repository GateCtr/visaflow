import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

// Load environment variables (.env.local or slot-hunter/.env)
dotenv.config();
if (fs.existsSync(".env.local")) {
  dotenv.config({ path: ".env.local", override: true });
} else if (fs.existsSync("../../.env.local")) {
  dotenv.config({ path: "../../.env.local", override: true });
}

async function testCevAnticaptcha() {
  console.log("=== TEST DE RESOLUTION HCAPTCHA CEV VIA ANTI-CAPTCHA (PROXYLESS) ===");

  const anticaptchaKey = process.env.ANTICAPTCHA_API_KEY;
  console.log(`Clé Anti-Captcha configurée : ${anticaptchaKey ? "OUI (présente)" : "NON (manquante)"}`);

  if (!anticaptchaKey) {
    console.error("ERREUR : La variable ANTICAPTCHA_API_KEY est manquante dans votre environnement.");
    return;
  }

  // 1. Check balance
  try {
    const balanceRes = await fetch("https://api.anti-captcha.com/getBalance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: anticaptchaKey }),
    });
    const balanceData = await balanceRes.json() as any;
    if (balanceData.errorId === 0) {
      console.log(`✅ Connexion Anti-Captcha réussie. Solde : $${balanceData.balance}`);
    } else {
      console.error(`❌ Erreur connexion Anti-Captcha (code ${balanceData.errorCode}) : ${balanceData.errorDescription}`);
      return;
    }
  } catch (err) {
    console.error("❌ Impossible de joindre l'API Anti-Captcha :", err);
    return;
  }

  // 2. Submit hCaptcha Task
  const sitekey = "5f64399c-14a8-415e-ad1a-7ebccdc4943a";
  const pageUrl = "https://appointment.cloud.diplomatie.be/Captcha";

  console.log(`\nSoumission du hCaptcha...`);
  console.log(`- Sitekey : ${sitekey}`);
  console.log(`- URL : ${pageUrl}`);
  console.log(`- Mode : HCaptchaTaskProxyless (Sans Proxy)`);

  let taskId: number;
  try {
    const createRes = await fetch("https://api.anti-captcha.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: anticaptchaKey,
        task: {
          type: "HCaptchaTaskProxyless",
          websiteURL: pageUrl,
          websiteKey: sitekey,
        },
      }),
    });
    const createData = await createRes.json() as any;
    if (createData.errorId === 0 && createData.taskId) {
      taskId = createData.taskId;
      console.log(`✅ Tâche créée avec succès ! ID de la tâche : ${taskId}`);
    } else {
      console.error(`❌ Erreur de création (code ${createData.errorCode}) : ${createData.errorDescription}`);
      return;
    }
  } catch (err) {
    console.error("❌ Exception lors de la création de la tâche :", err);
    return;
  }

  // 3. Poll Solution
  console.log(`\nAttente de la résolution (polling toutes les 5s, max 2 minutes)...`);
  for (let attempt = 1; attempt <= 24; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const pollRes = await fetch("https://api.anti-captcha.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: anticaptchaKey, taskId }),
      });
      const pollData = await pollRes.json() as any;

      if (pollData.errorId !== 0) {
        console.error(`\n❌ La tâche a échoué (code ${pollData.errorCode}) : ${pollData.errorDescription}`);
        
        if (pollData.errorCode === "ERROR_FAILED_LOADING_WIDGET") {
          console.log("\n💡 Analyse de l'erreur :");
          console.log("Anti-Captcha renvoie 'ERROR_FAILED_LOADING_WIDGET'.");
          console.log("Cela confirme que le navigateur worker d'Anti-Captcha a tenté de charger le site en proxyless,");
          console.log("mais les serveurs de l'ambassade (Cloudflare) ont bloqué son adresse IP de datacenter.");
          console.log("-> L'IP de votre machine n'est PAS en cause (car vous tournez en local sans proxy et accédez au site).");
          console.log("-> C'est l'IP d'Anti-Captcha qui est bloquée.");
        }
        return;
      }

      if (pollData.status === "ready") {
        const token = pollData.solution?.gRecaptchaResponse ?? pollData.solution?.token;
        console.log(`\n🎉 RESOU DE CAPTCHA REUSSI !`);
        console.log(`Token reçu (50 premiers caractères) : ${token?.slice(0, 50)}...`);
        return;
      }

      process.stdout.write(`Attempt #${attempt} : status = ${pollData.status}...\r`);
    } catch (err) {
      console.warn(`\n⚠️ Erreur réseau lors du polling :`, err);
    }
  }

  console.error("\n❌ Timeout : Pas de réponse reçue au bout de 2 minutes.");
}

testCevAnticaptcha().catch(console.error);
