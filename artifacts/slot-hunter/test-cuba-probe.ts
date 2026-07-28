/**
 * test-cuba-probe.ts — Lance runSpainHttpProbe sur Cuba (CapSolver, sans navigateur)
 * Usage: tsx test-cuba-probe.ts
 */
import * as dotenv from "dotenv";
dotenv.config();

import { runSpainHttpProbe } from "./src/spain-http-scanner.js";
import { invalidateSpainCfSession } from "./src/spain-soax-solver.js";

const CUBA_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";

console.log(`\n${"═".repeat(66)}`);
console.log("  runSpainHttpProbe — Cuba (CapSolver HTTP-only)");
console.log(`${"═".repeat(66)}\n`);

// Force une session fraîche à chaque run
invalidateSpainCfSession();

const t0 = Date.now();
const result = await runSpainHttpProbe(CUBA_URL);
const dur = Math.round((Date.now() - t0) / 1000);

console.log(`\n${"═".repeat(66)}`);
console.log(`  status      : ${result.status}`);
console.log(`  slotInfo    : ${result.slotInfo ?? "(aucun)"}`);
console.log(`  errorMessage: ${result.errorMessage ?? "(aucun)"}`);
console.log(`  durée       : ${dur}s`);
console.log(`${"═".repeat(66)}\n`);

process.exit(0);
