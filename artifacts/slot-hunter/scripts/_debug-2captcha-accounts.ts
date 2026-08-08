import "dotenv/config";

async function main() {
  const key = process.env.TWOCAPTCHA_API_KEY?.trim();
  if (!key) { console.error("No TWOCAPTCHA_API_KEY"); process.exit(1); }

  const res = await fetch(`https://api.2captcha.com/browser/accounts?key=${key}`);
  const data = await res.json();
  console.log("=== RAW RESPONSE ===");
  console.log(JSON.stringify(data, null, 2));
}

main().catch(console.error);
