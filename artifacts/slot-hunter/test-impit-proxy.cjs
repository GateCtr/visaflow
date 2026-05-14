// Test des options proxy d'impit
const { Impit } = require('impit');
const TEST_URL = 'https://ipv4.icanhazip.com';

async function testImpitOptions() {
  console.log('Testing different Impit proxy options...\n');
  
  const tests = [
    {
      name: 'No proxy (baseline)',
      options: { browser: 'chrome' }
    },
    {
      name: 'With proxy string',
      options: { 
        browser: 'chrome',
        proxy: 'http://geo.iproyal.com:12321'
      }
    },
    {
      name: 'With proxy object',
      options: { 
        browser: 'chrome',
        proxy: {
          url: 'http://geo.iproyal.com:12321'
        }
      }
    },
    {
      name: 'With proxy + auth in URL',
      options: { 
        browser: 'chrome',
        proxy: 'http://jT9eIHi669kwIORb:ngucIBfEKjEkUfDn_country-cd_city-kinshasa@geo.iproyal.com:12321'
      }
    },
    {
      name: 'With proxy object + auth',
      options: { 
        browser: 'chrome',
        proxy: {
          url: 'http://geo.iproyal.com:12321',
          username: 'jT9eIHi669kwIORb',
          password: 'ngucIBfEKjEkUfDn_country-cd_city-kinshasa'
        }
      }
    }
  ];
  
  for (const test of tests) {
    console.log(`Test: ${test.name}`);
    console.log(`Options: ${JSON.stringify(test.options)}`);
    try {
      const impit = new Impit(test.options);
      const response = await impit.fetch(TEST_URL);
      const ip = await response.text();
      console.log(`  IP: ${ip.trim()}`);
      console.log(`  Status: ${response.status}`);
      
      // Vérifier si l'IP a changé (proxy fonctionne)
      if (ip.trim() !== '102.206.241.131') {
        console.log(`  ✅ PROXY WORKING! Different IP`);
      } else {
        console.log(`  ⚠️ Same IP, proxy may not be working`);
      }
    } catch (error) {
      console.log(`  Error: ${error.message}`);
    }
    console.log();
  }
}

testImpitOptions().catch(console.error);