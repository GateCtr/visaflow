// Petit test pour vérifier la détection de fermeture de navigateur
import { spawn } from 'child_process';

console.log('Test de la capture CEV Network Sniffer...');
console.log('Ce test va démarrer le script et vérifier la détection de fermeture.');

// Démarrer le script
const child = spawn('npx', ['tsx', 'src/debug/cev-network-sniffer.ts'], {
  stdio: 'inherit',
  shell: true
});

console.log('Script démarré avec PID:', child.pid);
console.log('\nInstructions pour le test :');
console.log('1. Le navigateur va s\'ouvrir');
console.log('2. Attendez quelques secondes pour voir les requêtes');
console.log('3. Fermez MANUELLEMENT la fenêtre du navigateur');
console.log('4. Observez que le script sauvegarde automatiquement les données');
console.log('5. Le script devrait s\'arrêter proprement');

child.on('close', (code) => {
  console.log(`\nScript terminé avec code: ${code}`);
  console.log('Vérifiez que les fichiers ont été sauvegardés dans debug_dumps/');
});