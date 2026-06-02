#!/usr/bin/env node
import 'dotenv/config';
import { resolve4 } from "node:dns/promises";

const ANTICAPTCHA_KEY = process.env.ANTICAPTCHA_API_KEY?.trim() ?? '';
const proxyUrl = process.env.IPROYAL_PROXY_URL || process.env.SOAX_PROXY_URL;

async function main() {
  console.log("[TEST] Anti-Captcha Test");
  console.log("[TEST] Proxy URL:", proxyUrl ? proxyUrl.split('@')[0] + '@***' : '(not set - will use proxyless)');
  console.log("[TEST] Anti-Captcha Key:", ANTICAPTCHA_KEY ? 'OK' : '(not set)');

  if (!ANTICAPTCHA_KEY) {
    console.error("[TEST] ERROR: ANTICAPTCHA_API_KEY not set in .env");
    console.error("[TEST] Hint: Copy .env.example to .env and add your key");
    process.exit(1);
  }

  // Build task
  const pageUrl = "https://appointment.cloud.diplomatie.be/Captcha";
  const websiteKey = "5f64399c-14a8-415e-ad1a-7ebccdc4943a";
  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

  let task;
  let proxyConfig: any = null;

  if (proxyUrl) {
    try {
      const parsedProxy = new URL(proxyUrl);
      let proxyType = parsedProxy.protocol.replace(':', '');
      if (proxyType === 'https') proxyType = 'http';
      let port = parsedProxy.port;
      if (!port) {
        port = '5000';
      }
      
      // Resolve hostname to IP address (Anti-Captcha requires IP, not hostname)
      let proxyAddress = parsedProxy.hostname;
      try {
        const ips = await resolve4(parsedProxy.hostname);
        if (ips.length > 0) {
          proxyAddress = ips[0];
          console.log(`[TEST] Resolved proxy hostname ${parsedProxy.hostname} to IP: ${proxyAddress}`);
        } else {
          console.warn(`[TEST] No IPs found for proxy hostname ${parsedProxy.hostname}, using hostname directly (may fail with Anti-Captcha)`)
        }
      } catch (dnsErr) {
        console.warn(`[TEST] DNS resolution failed for ${parsedProxy.hostname}: ${String(dnsErr)}, using hostname directly (may fail with Anti-Captcha)`)
      }
      
      proxyConfig = {
        proxyType: proxyType,
        proxyAddress: proxyAddress,
        proxyPort: parseInt(port, 10),
        proxyLogin: decodeURIComponent(parsedProxy.username || ''),
        proxyPassword: decodeURIComponent(parsedProxy.password || ''),
      };
      console.log("[TEST] Parsed proxy config:", { ...proxyConfig, proxyPassword: "***" });
      
      task = {
        type: "HCaptchaTask",
        websiteURL: pageUrl,
        websiteKey: websiteKey,
        ...proxyConfig,
        userAgent: userAgent,
      };
      console.log("[TEST] Using HCaptchaTask (with proxy)");
    } catch (e) {
      console.error("[TEST] ERROR: Failed to parse proxy URL:", e);
      process.exit(1);
    }
  } else {
    task = {
      type: "HCaptchaTaskProxyless",
      websiteURL: pageUrl,
      websiteKey: websiteKey,
    };
    console.log("[TEST] Using HCaptchaTaskProxyless (no proxy)");
  }

  console.log("\n[TEST] Sending task to Anti-Captcha:", JSON.stringify(task, null, 2));

  // Step 1: Create task
  console.log("\n[TEST] Creating task...");
  const createRes = await fetch("https://api.anti-captcha.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: ANTICAPTCHA_KEY,
      task: task,
    }),
  });

  const createData = await createRes.json() as any;
  console.log("\n[TEST] Anti-Captcha createTask response:", JSON.stringify(createData, null, 2));

  if (createData.errorId !== 0 || !createData.taskId) {
    console.error("\n❌ [TEST] ERROR: createTask failed");
    console.log("\n[TEST] Fallback: Trying proxyless mode instead...");
    
    // Fallback to proxyless
    const fallbackTask = {
      type: "HCaptchaTaskProxyless",
      websiteURL: pageUrl,
      websiteKey: websiteKey,
    };
    
    console.log("\n[TEST] Sending fallback task to Anti-Captcha:", JSON.stringify(fallbackTask, null, 2));
    
    const fallbackCreateRes = await fetch("https://api.anti-captcha.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: ANTICAPTCHA_KEY,
        task: fallbackTask,
      }),
    });
    
    const fallbackCreateData = await fallbackCreateRes.json() as any;
    console.log("\n[TEST] Anti-Captcha fallback createTask response:", JSON.stringify(fallbackCreateData, null, 2));
    
    if (fallbackCreateData.errorId !== 0 || !fallbackCreateData.taskId) {
      console.error("\n❌ [TEST] ERROR: Fallback createTask also failed");
      process.exit(1);
    }
    
    return pollForResult(fallbackCreateData.taskId, ANTICAPTCHA_KEY);
  }

  const taskId = createData.taskId;
  console.log(`\n[TEST] Task created: ${taskId}`);

  // Step 2: Poll for result
  return pollForResult(taskId, ANTICAPTCHA_KEY);
}

async function pollForResult(taskId: number, anticaptchaKey: string) {
  console.log("\n[TEST] Polling for result (this may take up to 5 minutes)...");
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));

    const pollRes = await fetch("https://api.anti-captcha.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: anticaptchaKey, taskId }),
    });

    const pollData = await pollRes.json() as any;

    if (pollData.status === "ready") {
      const token = pollData.solution?.gRecaptchaResponse ?? pollData.solution?.token ?? null;
      if (token) {
        console.log("\n✅ [TEST] SUCCESS! Got token:", token.slice(0, 50) + "...");
        console.log("\nFull token:", token);
        process.exit(0);
      } else {
        console.error("\n❌ [TEST] ERROR: No token found in solution");
        process.exit(1);
      }
    }

    if (pollData.errorId !== 0) {
      console.error("\n❌ [TEST] Poll error:", pollData.errorCode, "-", pollData.errorDescription);
      process.exit(1);
    }

    console.log(`[TEST] Poll #${i + 1}: ${pollData.status}...`);
  }

  console.error("\n❌ [TEST] Timeout after 5 minutes");
  process.exit(1);
}

main().catch(err => {
  console.error("[TEST] Unhandled error:", err);
  process.exit(1);
});
