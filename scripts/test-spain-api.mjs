// Script de test pour l'API Bookitit España (ES Module)
import https from 'https';

// Configuration basée sur l'analyse
const CONFIG = {
  publickey: '23d9b76923b741cb4165cb7fadba48129',
  widget_id: '25028fcd7126544630b8da0c6e60722b5',
  lang: 'fr',
  timezone: 'Africa/Kinshasa'
};

// Essayer différentes variations d'URL
const testUrls = [
  // Format standard
  `https://api.bookitit.com/api/v3/getservices/?publickey=${CONFIG.publickey}&widget_id=${CONFIG.widget_id}&lang=${CONFIG.lang}`,
  
  // Avec callback JSONP
  `https://api.bookitit.com/api/v3/getservices/?publickey=${CONFIG.publickey}&widget_id=${CONFIG.widget_id}&lang=${CONFIG.lang}&callback=jsonp`,
  
  // URL alternative (peut-être v2 au lieu de v3)
  `https://api.bookitit.com/api/v2/getservices/?publickey=${CONFIG.publickey}&widget_id=${CONFIG.widget_id}&lang=${CONFIG.lang}`,
  
  // URL sans version
  `https://api.bookitit.com/api/getservices/?publickey=${CONFIG.publickey}&widget_id=${CONFIG.widget_id}&lang=${CONFIG.lang}`,
  
  // Essayer avec différents formats
  `https://api.bookitit.com/widgets/${CONFIG.widget_id}/services?publickey=${CONFIG.publickey}&lang=${CONFIG.lang}`,
  
  // URL depuis l'analyse du bundle
  `https://api.bookitit.com/widgets/api/v3/getservices/?publickey=${CONFIG.publickey}&widget_id=${CONFIG.widget_id}&lang=${CONFIG.lang}`
];

async function testUrl(url) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== Testing: ${url} ===`);
    
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        console.log(`Status: ${res.statusCode}`);
        console.log(`Content-Type: ${res.headers['content-type']}`);
        
        if (res.statusCode === 200) {
          console.log('Success! Response preview:', data.substring(0, 300));
          
          // Essayer de parser si c'est du JSON/JSONP
          try {
            if (data.startsWith('jsonp(') || data.startsWith('test(') || data.startsWith('callback(')) {
              const jsonStart = data.indexOf('(') + 1;
              const jsonEnd = data.lastIndexOf(')');
              const jsonStr = data.substring(jsonStart, jsonEnd);
              const json = JSON.parse(jsonStr);
              console.log('Parsed JSONP successfully!');
              console.log('Structure:', Object.keys(json));
            } else {
              const json = JSON.parse(data);
              console.log('Parsed JSON successfully!');
              console.log('Structure:', Object.keys(json));
            }
          } catch (e) {
            console.log('Not valid JSON/JSONP');
          }
        } else {
          console.log('Response preview:', data.substring(0, 200));
        }
        
        resolve({ url, status: res.statusCode, data: data.substring(0, 500) });
      });
    }).on('error', (err) => {
      console.error(`Error: ${err.message}`);
      reject(err);
    });
  });
}

async function runTests() {
  console.log('Testing Bookitit API endpoints...\n');
  
  for (const url of testUrls) {
    try {
      await testUrl(url);
    } catch (err) {
      console.error(`Failed to test ${url}:`, err.message);
    }
  }
  
  console.log('\n=== Testing complete ===');
}

runTests().catch(console.error);