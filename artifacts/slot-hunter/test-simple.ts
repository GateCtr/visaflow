import * as dotenv from "dotenv";
dotenv.config();

async function testAntiCaptchaBalance() {
  console.log("Test simple de la clé Anti-Captcha...");
  
  const anticaptchaKey = process.env.ANTICAPTCHA_API_KEY || "979f89a9c444082156df0cfd8174e805";
  
  console.log(`Clé Anti-Captcha: ${anticaptchaKey.slice(0, 10)}...`);
  
  try {
    // Tester la connexion à l'API
    console.log("Test de connexion à l'API Anti-Captcha...");
    
    const response = await fetch("https://api.anti-captcha.com/getBalance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: anticaptchaKey }),
      signal: AbortSignal.timeout(10000),
    });
    
    const data = await response.json();
    console.log("Réponse API:", data);
    
    if (data.errorId === 0 && data.balance !== undefined) {
      console.log(`✅ SUCCÈS: Clé Anti-Captcha valide!`);
      console.log(`   Solde: ${data.balance}`);
      console.log(`   Error ID: ${data.errorId}`);
      
      // Tester avec un sitekey de test (Turnstile)
      console.log("\nTest création de tâche Turnstile (avec sitekey de test)...");
      
      const testSitekey = "0x4AAAAAAAVrQYFpKjQYFpKj"; // Sitekey de test Cloudflare
      const testPageUrl = "https://www.citaconsular.es";
      
      const taskResponse = await fetch("https://api.anti-captcha.com/createTask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: anticaptchaKey,
          task: {
            type: "TurnstileTaskProxyless",
            websiteURL: testPageUrl,
            websiteKey: testSitekey,
          },
        }),
        signal: AbortSignal.timeout(15000),
      });
      
      const taskData = await taskResponse.json();
      console.log("Réponse création tâche:", taskData);
      
      if (taskData.errorId === 0 && taskData.taskId) {
        console.log(`✅ Tâche créée avec succès! ID: ${taskData.taskId}`);
        
        // Vérifier le statut de la tâche
        console.log("\nVérification du statut de la tâche...");
        
        const statusResponse = await fetch("https://api.anti-captcha.com/getTaskResult", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: anticaptchaKey, taskId: taskData.taskId }),
          signal: AbortSignal.timeout(10000),
        });
        
        const statusData = await statusResponse.json();
        console.log("Statut tâche:", statusData);
        
      } else {
        console.log(`❌ Erreur création tâche: ${taskData.errorCode ?? taskData.errorId}`);
        console.log(`   Description: ${taskData.errorDescription ?? "N/A"}`);
      }
      
    } else {
      console.log(`❌ ERREUR: Clé Anti-Captcha invalide ou erreur API`);
      console.log(`   Error ID: ${data.errorId}`);
      console.log(`   Error Code: ${data.errorCode ?? "N/A"}`);
    }
    
  } catch (error) {
    console.error("Erreur pendant le test:", error);
  }
  
  console.log("\nTest des autres services de captcha...");
  
  // Tester CapSolver
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  if (capsolverKey) {
    console.log(`\nTest CapSolver (clé: ${capsolverKey.slice(0, 10)}...)`);
    
    try {
      const csResponse = await fetch("https://api.capsolver.com/getBalance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: capsolverKey }),
        signal: AbortSignal.timeout(10000),
      });
      
      const csData = await csResponse.json();
      console.log("Réponse CapSolver:", csData);
    } catch (error) {
      console.error("Erreur CapSolver:", error);
    }
  }
}

// Exécuter le test
testAntiCaptchaBalance().catch(console.error);