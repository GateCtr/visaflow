/**
 * Test avec cookies (sessionHeaders)
 */

import "dotenv/config";
import { loginUsaPortal, setUsaSessionProxy } from "./src/usaPortal.js";
import { usaFetch, sessionHeaders } from "./src/usaPortal/usa-http.js";
import { makeIproyalStickyUrl } from "./src/usaPortal/usa-http.js";

const EMAIL = process.env.USA_EMAIL || "screentapinc@gmail.com";
const PASSWORD = process.env.USA_PASSWORD || "Akollad@2026";
const USA_PAYMENT_STATUS_URL = "https://www.usvisaappt.com/visaworkflowprocessor/workflow/getUserHistoryApplicantPaymentStatus";

async function testWithCookies() {
  console.log("Test avec cookies (sessionHeaders)");
  
  // 1. Login avec proxy
  const stickyProxyUrl = makeIproyalStickyUrl(process.env.IPROYAL_PROXY_URL!, 30);
  setUsaSessionProxy(stickyProxyUrl);
  
  const session = await loginUsaPortal(EMAIL, PASSWORD);
  if (!session) {
    console.error("❌ Login failed");
    return;
  }
  
  console.log(`✅ Login: ${session.fullName}`);
  
  // 2. Essayer avec sessionHeaders (avec cookies)
  // D'abord sans applicationId
  const headers1 = sessionHeaders(
    session.accessToken,
    "", // applicationId vide
    323, // missionId
    "https://www.usvisaappt.com/visaapplicantui/login",
    false
  );
  
  console.log("\n[1] Test avec sessionHeaders (applicationId vide):");
  console.log(`Cookie: ${headers1.Cookie}`);
  
  try {
    const res1 = await usaFetch(USA_PAYMENT_STATUS_URL, { 
      method: "GET", 
      headers: headers1 
    });
    console.log(`Status: ${res1.status}`);
    const body1 = await res1.text();
    console.log(`Body: ${body1.slice(0, 200)}`);
  } catch (error: any) {
    console.log(`Error: ${error.message}`);
  }
  
  // 3. Essayer avec x-auth-token header
  console.log("\n[2] Test avec x-auth-token header:");
  const headers2 = {
    ...headers1,
    "x-auth-token": session.accessToken,
    "x-requested-with": "XMLHttpRequest"
  };
  
  try {
    const res2 = await usaFetch(USA_PAYMENT_STATUS_URL, { 
      method: "GET", 
      headers: headers2 
    });
    console.log(`Status: ${res2.status}`);
    const body2 = await res2.text();
    console.log(`Body: ${body2.slice(0, 200)}`);
  } catch (error: any) {
    console.log(`Error: ${error.message}`);
  }
  
  // 4. Essayer sans Authorization, seulement x-auth-token
  console.log("\n[3] Test sans Authorization, seulement x-auth-token:");
  const headers3 = { ...headers1 };
  delete headers3.Authorization;
  headers3["x-auth-token"] = session.accessToken;
  headers3["x-requested-with"] = "XMLHttpRequest";
  
  try {
    const res3 = await usaFetch(USA_PAYMENT_STATUS_URL, { 
      method: "GET", 
      headers: headers3 
    });
    console.log(`Status: ${res3.status}`);
    const body3 = await res3.text();
    console.log(`Body: ${body3.slice(0, 200)}`);
  } catch (error: any) {
    console.log(`Error: ${error.message}`);
  }
  
  setUsaSessionProxy(undefined);
}

testWithCookies().catch(console.error);