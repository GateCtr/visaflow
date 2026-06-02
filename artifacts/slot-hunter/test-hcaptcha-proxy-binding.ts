#!/usr/bin/env node
import "dotenv/config";
import { makeCevProxyStickyUrl } from "./src/cev-shared-impit.js";

const ANTICAPTCHA_BASE = "https://api.anti-captcha.com";
const WEBSITE_URL = "https://appointment.cloud.diplomatie.be/Captcha";
const WEBSITE_KEY = "5f64399c-14a8-415e-ad1a-7ebccdc4943a";

async function testHcaptchaWithProxy() {
    console.log("\n🚀 TEST HCaptchaTask WITH SOAX PROXY");
    console.log("=".repeat(80));

    const soaxProxyUrl = process.env.SOAX_PROXY_URL;
    if (!soaxProxyUrl) {
        console.error("❌ SOAX_PROXY_URL not found!");
        return;
    }

    // Créer la même URL proxy SOAX que le bot CEV
    const ceProxyUrl = makeCevProxyStickyUrl("soax", 360, "test-cev-proxy");
    console.log(`✅ Proxy URL proxy SOAX générée: ${ceProxyUrl.replace(/:([^:@]+)@/, ":***@")}`);

    // Parser la proxy URL
    const parsedProxy = new URL(ceProxyUrl);
    const proxyType = parsedProxy.protocol.replace(":", "");
    const proxyLogin = decodeURIComponent(parsedProxy.username);
    const proxyPassword = decodeURIComponent(parsedProxy.password);
    const proxyAddress = parsedProxy.hostname;
    const proxyPort = parseInt(parsedProxy.port || "5000");

    console.log("\n📤 Création de la tâche Anti-Captcha...");
    
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
    const task = {
        type: "HCaptchaTask",
        websiteURL: WEBSITE_URL,
        websiteKey: WEBSITE_KEY,
        proxyType: proxyType,
        proxyAddress: proxyAddress,
        proxyPort: proxyPort,
        proxyLogin: proxyLogin,
        proxyPassword: proxyPassword,
        userAgent: userAgent,
    };

    console.log("📋 Tâche:", JSON.stringify({ ...task, proxyPassword: "***" }, null, 2));

    // Créer la tâche
    const createRes = await fetch(`${ANTICAPTCHA_BASE}/createTask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            clientKey: process.env.ANTICAPTCHA_API_KEY,
            task: task,
        }),
        signal: AbortSignal.timeout(30000),
    });

    const createData = await createRes.json();
    console.log("\n📥 Réponse createTask:", JSON.stringify(createData, null, 2));

    if (createData.errorId !== 0) {
        console.error("\n❌ Échec de la création de la tâche:", createData.errorDescription);
        console.log("\n→ Test avec HCaptchaTaskProxyless...");

        // Test fallback
        const fallbackTask = {
            type: "HCaptchaTaskProxyless",
            websiteURL: WEBSITE_URL,
            websiteKey: WEBSITE_KEY,
        };

        const fallbackCreateRes = await fetch(`${ANTICAPTCHA_BASE}/createTask`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                clientKey: process.env.ANTICAPTCHA_API_KEY,
                task: fallbackTask,
            }),
            signal: AbortSignal.timeout(30000),
        });

        const fallbackCreateData = await fallbackCreateRes.json();
        console.log("\n📥 Fallback createTask:", JSON.stringify(fallbackCreateData, null, 2));
        if (fallbackCreateData.errorId === 0 && fallbackCreateData.taskId) {
            const token = await pollTask(fallbackCreateData.taskId, "proxyless");
            console.log("\n✅ Token obtenu:", token);
        }
    } else {
        const token = await pollTask(createData.taskId, "with-proxy");
        console.log("\n✅ Token obtenu:", token);
    }
}

async function pollTask(taskId: string, mode: string) {
    console.log(`\n🔍 Polling du résultat (mode: ${mode})...`);
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const pollRes = await fetch(`${ANTICAPTCHA_BASE}/getTaskResult`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                clientKey: process.env.ANTICAPTCHA_API_KEY,
                taskId: taskId,
            }),
        });
        const pollData = await pollRes.json();
        if (pollData.status === "ready") {
            return pollData.solution?.gRecaptchaResponse || pollData.solution?.token || null;
        }
        if (pollData.errorId !== 0) {
            console.error("Erreur polling:", pollData.errorDescription);
            return null;
        }
        if (i % 10 === 0) console.log(`  ⏳ Poll #${i + 1}: ${pollData.status}...`);
    }
    return null;
}

testHcaptchaWithProxy().catch(console.error);
