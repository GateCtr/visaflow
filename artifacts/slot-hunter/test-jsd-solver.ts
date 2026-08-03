/**
 * test-jsd-solver.ts — Test script for JSD Solver
 * 
 * Usage:
 *   pnpm tsx test-jsd-solver.ts
 * 
 * This script tests the JSD solver against a known JSD-protected portal.
 */

// ─── Import dependencies ──────────────────────────────────────────────────────

import { JSDSolver } from "./src/jsd-solver.js";

// ─── Configuration ────────────────────────────────────────────────────────────

const PORTAL_URL = process.env.SPAIN_WIDGET_URL || 
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

// ─── Test Functions ───────────────────────────────────────────────────────────

/**
 * Test basic JSD solving
 */
async function testBasicSolve() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("Test 1: Basic JSD Solve (Direct - no proxy)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const solver = new JSDSolver();
  const result = await solver.solve(PORTAL_URL, 60000);

  if (result.success && result.session) {
    console.log("\n✅ SUCCESS!");
    console.log(`   cf_clearance: ${result.session.cfClearance.slice(0, 40)}...`);
    console.log(`   Cookies returned: ${result.session.cookies.length}`);
    console.log(`   Valid until: ${new Date(result.session.expiresAt).toISOString()}`);
    
    // Get cookie header
    const cookieHeader = solver.getCookieHeader(result.session);
    console.log(`   Cookie header: ${cookieHeader.slice(0, 80)}...`);
    
  } else {
    console.log("\n❌ FAILED");
    console.log(`   Error: ${result.error}`);
  }

  return result.success;
}

/**
 * Test with proxy (if configured)
 */
async function testProxySolve() {
  const proxyUrl = process.env.DECODO_PROXY_URL || 
    process.env.SOAX_PROXY_URL ||
    process.env.IPROYAL_PROXY_URL;

  if (!proxyUrl) {
    console.log("\n⚠️  Skip proxy test: No proxy URL configured");
    return false;
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("Test 2: JSD Solve with Proxy");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Mask the proxy URL for logging
  const maskedProxy = proxyUrl.replace(/:([^:@]+)@/, ":***@");
  console.log(`   Proxy: ${maskedProxy.slice(0, 60)}...\n`);

  const solver = new JSDSolver(undefined, proxyUrl);
  const result = await solver.solve(PORTAL_URL, 90000);

  if (result.success && result.session) {
    console.log("\n✅ SUCCESS!");
    console.log(`   cf_clearance: ${result.session.cfClearance.slice(0, 40)}...`);
    console.log(`   Proxy used: ${maskedProxy.slice(0, 60)}...`);
    
    // Verify session is valid
    const remaining = solver.getSessionRemainingMs(result.session);
    console.log(`   Session remaining: ${Math.round(remaining / 60000)} min`);
    
  } else {
    console.log("\n❌ FAILED");
    console.log(`   Error: ${result.error}`);
  }

  return result.success;
}

/**
 * Test convenience function
 */
async function testConvenienceFunction() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("Test 3: Convenience Function solveJSDChallenge()");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const result = await solveJSDChallenge(PORTAL_URL, {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    timeoutMs: 60000,
  });

  if (result.success && result.session) {
    console.log("\n✅ SUCCESS!");
    console.log(`   cf_clearance: ${result.session.cfClearance.slice(0, 40)}...`);
    console.log(`   User-Agent: ${result.session.userAgent.slice(0, 60)}...`);
    
  } else {
    console.log("\n❌ FAILED");
    console.log(`   Error: ${result.error}`);
  }

  return result.success;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║       Cloudflare JSD Solver Test Suite                         ║");
  console.log("║       Portal: citaconsular.es                                  ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(`\n   Target: ${PORTAL_URL}`);
  console.log(`   Proxy: ${process.env.DECODO_PROXY_URL ? "DECODO configured" : "none"}`);

  const results: boolean[] = [];

  // Run tests
  try {
    results.push(await testBasicSolve());
  } catch (error) {
    console.error("Test 1 crashed:", error);
    results.push(false);
  }

  try {
    results.push(await testProxySolve());
  } catch (error) {
    console.error("Test 2 crashed:", error);
    results.push(false);
  }

  try {
    results.push(await testConvenienceFunction());
  } catch (error) {
    console.error("Test 3 crashed:", error);
    results.push(false);
  }

  // Summary
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                      Test Summary                              ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  const passed = results.filter(r => r).length;
  const total = results.length;
  
  console.log(`\n   Results: ${passed}/${total} tests passed`);
  
  if (passed === total) {
    console.log("\n   ✅ All tests passed!");
  } else if (passed > 0) {
    console.log(`\n   ⚠️  ${passed} tests passed, ${total - passed} failed`);
  } else {
    console.log("\n   ❌ All tests failed");
  }

  process.exit(passed === total ? 0 : 1);
}

// ─── Run tests ─────────────────────��──────────────────────────────────────────

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});