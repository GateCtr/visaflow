Si les URLs sont générées de manière dynamique ou masquées dans des redirections complexes faites par le framework du CEV, le plus simple est de faire passer ton script par un proxy d'interception local (comme Fiddler ou Charles Proxy, ou même un simple script de log).

Puisque tu utilises déjà des proxies (iproyal-cd, brightdata-fr), tu peux modifier temporairement la configuration de ton script pour envoyer tes requêtes HTTP vers un outil d'inspection sur ta machine.

Par exemple, tu peux ajouter un mouchard directement dans la configuration de ton client HTTP (si tu utilises Axios) pour qu'il affiche absolument tout ce qu'il envoie et reçoit :

TypeScript
// Exemple de mouchard (Interceptor) à ajouter sur ton instance Axios
axiosInstance.interceptors.request.use(request => {
  console.log(`📡 [HTTP OUT] ${request.method?.toUpperCase()} -> ${request.url}`);
  if (request.data) console.log(`📦 [PAYLOAD]`, request.data);
  return request;
});

axiosInstance.interceptors.response.use(response => {
  console.log(`📥 [HTTP IN] Status: ${response.status} <- ${response.config.url}`);
  // Si c'est du JSON, on l'affiche pour voir s'il y a les slots
  if (typeof response.data === 'object') {
    console.log(`📄 [RESPONSE JSON]`, JSON.stringify(response.data, null, 2));
  }
  return response;
});
🎯 Ce qu'on veut vérifier
En faisant cela, on va pouvoir traquer la transition exacte. Si, juste après le Login ou l'obtention de l'URL d'intégration, ton script fait un GET ou un POST vers une route spécifique et que c'est cette route qui te retourne le statut final, on saura exactement si on peut l'isoler.

Montre-moi (ou analyse de ton côté) la fonction de ton script qui effectue la toute dernière requête, celle qui extrait le résultat NO_AVAILABILITY. C'est cette ligne de code qui détient le secret de la route.