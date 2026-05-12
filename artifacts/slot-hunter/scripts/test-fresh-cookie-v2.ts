/**
 * Test Bookitit API with fresh cf_clearance cookie from latest capture
 */

import { BookititApiClient } from '../src/spain/bookitit-client';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 TEST BOOKITIT API WITH FRESH COOKIE (v2)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Fresh cf_clearance cookie from capture-1778520357186.json
  const freshCookie = 'lbQzY8u381IR9AUQZSORMyJaWR6oJalRztP5qmJ0A4E-1778520388-1.2.1.1-evlOsDvDCSdezjq56ufscaKqX4axDSzqgjkrYCdMy9psMgCetd2b0Oc2ezjFuE7aDH.eaZQg6rMrNFfMqcgx7GdhCc3Gk9aPC.65gkUsqJ9e3Mc83R9T1uCLuJejCdaGarqED8DW9VSN_SMQrZsdzKIDTTYnl7Bjbg.f5FoCQ2E.xahmLEpZo86VZEGyV6IzNWbjDUNwudeM4YZStHcJM2atyQv5S4gabCy7GjW2wNwPNdQrXHTZNxfymtvRoH5tsohdhAIVYQnKjTcMB_vJIHK8oDogfTVA_69Xlzn888uTfHVsaWczoJjLwvPUDyzbFsdwQPbba9D9zHM4KbKHxg';

  const client = new BookititApiClient({
    publickey: '25028fcd7126544630b8da0c6e60722b5',
    widgetId: '25028fcd7126544630b8da0c6e60722b5',
    lang: 'es',
    cfClearance: freshCookie
  });

  try {
    console.log('🔍 Testing API connectivity with fresh cookie...');
    console.log(`📅 Cookie timestamp: ${freshCookie.split('-')[1]}`);
    
    // 1. Get services
    console.log('\n📋 1. Getting services...');
    const services = await client.getServices();
    console.log(`✅ Services found: ${services.length}`);
    
    if (services.length === 0) {
      console.log('❌ No services found. Cookie might be invalid or expired.');
      return;
    }
    
    services.forEach((service, index) => {
      const name = service.name ? service.name.replace(/<[^>]*>/g, '').trim() : 'Hidden service';
      console.log(`   ${index + 1}. ${service.id}: ${name}`);
    });
    
    // 2. Get widget configuration
    console.log('\n⚙️ 2. Getting widget configuration...');
    const config = await client.getWidgetConfiguration();
    if (config) {
      console.log(`✅ Widget config loaded`);
      console.log(`   - Registration type: ${config.registration_type}`);
      console.log(`   - Waiting list: ${config.waiting_list}`);
      console.log(`   - Show comments: ${config.show_comments}`);
      console.log(`   - Mandatory comments: ${config.mandatory_comments}`);
    } else {
      console.log('⚠️ No widget configuration found');
    }
    
    // 3. Get agendas for first service
    console.log('\n📅 3. Getting agendas...');
    const firstService = services[0];
    const agendas = await client.getAgendas(firstService.id);
    console.log(`✅ Agendas for ${firstService.id}: ${agendas.length}`);
    
    if (agendas.length > 0) {
      agendas.forEach((agenda, index) => {
        console.log(`   ${index + 1}. ${agenda.id}: ${agenda.name}`);
      });
      
      // 4. Get slots for today
      console.log('\n🕒 4. Checking slots for today...');
      const today = new Date().toISOString().split('T')[0];
      const firstAgenda = agendas[0];
      const slots = await client.getSlots(firstAgenda.id, today);
      console.log(`✅ Slots for ${firstAgenda.id} on ${today}: ${slots.length}`);
      
      const availableSlots = slots.filter(s => s.available);
      console.log(`   Available slots: ${availableSlots.length}`);
      
      if (availableSlots.length > 0) {
        console.log('\n🎉 SLOTS AVAILABLE!');
        availableSlots.forEach(slot => {
          const date = new Date(slot.datetime * 1000);
          console.log(`   - ${date.toLocaleString()}: ${slot.slots} slots`);
        });
      } else {
        console.log('😔 No available slots today');
        
        // Check for next 7 days
        console.log('\n🔍 Checking next 7 days...');
        for (let i = 1; i <= 7; i++) {
          const date = new Date();
          date.setDate(date.getDate() + i);
          const dateStr = date.toISOString().split('T')[0];
          
          try {
            const futureSlots = await client.getSlots(firstAgenda.id, dateStr);
            const futureAvailable = futureSlots.filter(s => s.available);
            if (futureAvailable.length > 0) {
              console.log(`   ${dateStr}: ${futureAvailable.length} slots available`);
            }
          } catch (err) {
            // Skip errors for future dates
          }
        }
      }
    }
    
    // 5. Test availability check
    console.log('\n🔎 5. Checking overall availability...');
    const availability = await client.checkAvailability();
    console.log(`✅ Availability check completed`);
    console.log(`   Has slots: ${availability.hasSlots ? 'YES 🎉' : 'NO 😔'}`);
    console.log(`   Total available slots found: ${availability.slots.length}`);
    
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('✅ TEST COMPLETED SUCCESSFULLY');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    
    // Debug info
    console.error('\n🔧 Debug information:');
    console.error(`   Cookie length: ${freshCookie.length} chars`);
    console.error(`   Cookie starts with: ${freshCookie.substring(0, 20)}...`);
    
    console.error('\n🔧 Troubleshooting:');
    console.error('   1. Cookie might be expired (lifespan ~20 min to 2 hours)');
    console.error('   2. Cloudflare might have changed protection');
    console.error('   3. Network connectivity issue');
    console.error('   4. API endpoint might have changed');
    console.error('   5. Check if cookie format is correct');
    
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('❌ TEST FAILED');
    console.log('═══════════════════════════════════════════════════════════════\n');
  }
}

main().catch(console.error);