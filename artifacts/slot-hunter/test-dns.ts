#!/usr/bin/env node
import 'dotenv/config';
import { resolve4, lookup } from "node:dns/promises";
import { Resolver } from "node:dns";

console.log("Testing DNS resolution for proxy.soax.com...");

console.log("\n--- Using resolve4 ---");
try {
  const ips = await resolve4("proxy.soax.com");
  console.log("resolve4 result:", ips);
} catch (err) {
  console.error("resolve4 error:", err);
}

console.log("\n--- Using lookup ---");
try {
  const lookupResult = await lookup("proxy.soax.com");
  console.log("lookup result:", lookupResult);
} catch (err) {
  console.error("lookup error:", err);
}

console.log("\n--- Using system dns via ping ---");
try {
  // On Windows, ping -4 to force IPv4
  const { exec } = await import("node:child_process");
  exec("ping -4 -n 1 proxy.soax.com", (error, stdout, stderr) => {
    if (stdout) {
      const match = stdout.match(/\[(\d+\.\d+\.\d+\.\d+)\]/);
      if (match) {
        console.log("Ping found IP:", match[1]);
      } else {
        console.log("Ping output:", stdout);
      }
    }
    if (stderr) {
      console.error("Ping stderr:", stderr);
    }
    if (error) {
      console.error("Ping error:", error);
    }
  });
} catch (err) {
  console.error("Ping test error:", err);
}
