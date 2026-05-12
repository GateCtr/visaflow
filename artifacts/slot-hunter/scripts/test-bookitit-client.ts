/**
 * test-bookitit-client.ts — Tester le client Bookitit API
 */

import { testBookititApi } from '../src/spain/bookitit-client';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 TEST BOOKITIT ESPAÑA API CLIENT');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const result = await testBookititApi();
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 TEST RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');
  
  if (result.success) {
    console.log('✅ SUCCESS!');
    console.log(`   Services found: ${result.servicesCount}`);
    console.log('\n💡 NEXT STEPS:');
    console.log('   1. Implement automatic cookie renewal');
    console.log('   2. Add slot polling scheduler');
    console.log('   3. Integrate with notification system');
    console.log('   4. Add authentication flow');
  } else {
    console.log('❌ FAILED');
    console.log(`   Error: ${result.error}`);
    console.log('\n🔧 TROUBLESHOOTING:');
    console.log('   1. Cookie cf_clearance might be expired');
    console.log('   2. Need fresh capture with new cookie');
    console.log('   3. Cloudflare might have changed protection');
    console.log('   4. Check network connectivity');
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);