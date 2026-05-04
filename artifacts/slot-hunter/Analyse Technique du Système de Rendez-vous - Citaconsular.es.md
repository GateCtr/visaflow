# Analyse Technique du Système de Rendez-vous - Citaconsular.es

Ce rapport détaille le fonctionnement interne du widget de prise de rendez-vous utilisé par `citaconsular.es` (basé sur la plateforme Bookitit), extrait à partir du bundle JavaScript.

---

## 1. Architecture des API et Points de Terminaison

Le widget communique avec un serveur via des requêtes **JSONP** (pour contourner les restrictions CORS). L'URL de base est dynamiquement construite mais pointe généralement vers `/onlinebookings/`.

### Points de terminaison principaux :
| Action | Endpoint | Description |
| :--- | :--- | :--- |
| **Initialisation** | `getwidgetconfigurations/` | Récupère la configuration spécifique du consulat (services, agendas, types de champs). |
| **Disponibilité** | `datetime/` | Recherche les créneaux libres pour un service et une période donnés. |
| **Inscription** | `signup/` | Crée un nouveau compte client et une réservation temporaire. |
| **Connexion** | `signin/` | Connecte un client existant pour effectuer une réservation. |
| **Vérification** | `confirmclient/` | Valide le code de vérification (SMS/Email) envoyé au client. |
| **Finalisation** | `summary/` | Confirme définitivement le rendez-vous et génère le ticket. |
| **Libération** | `freetempevent/` | Libère une réservation temporaire si l'utilisateur revient en arrière. |

---

## 2. Logique de Disponibilité (Slots)

La récupération des créneaux se fait via la collection `Slots` (`js/widgets/default/collections/slots.js`).

- **Paramètres de requête** : La requête vers `datetime/` inclut `services`, `agendas`, `start` (début du mois), `end` (fin du mois), et `selectedPeople`.
- **Recherche Automatique** : Le script (`datetimelist.js`) possède une logique de "scan" automatique. S'il ne trouve pas de créneaux pour le mois en cours, il itère jusqu'à **9 mois** dans le futur pour trouver la première date disponible.
- **Gestion des Erreurs** : Si le serveur renvoie une exception ou si aucun créneau n'est trouvé après 9 mois, le message "No hay horas disponibles" s'affiche.

---

## 3. Logique d'Inscription et Connexion

### Inscription (`signup.js`) :
- **Validation** : Le modèle `Client` valide les champs obligatoires (nom, email, mot de passe de min. 6 caractères, conditions acceptées).
- **Sécurité** : Le système supporte reCAPTCHA, hCaptcha et **Cloudflare Turnstile** (`idDivCfCaptchaSignUp`).
- **Flux** : L'inscription crée un `bktToken` unique qui lie la session utilisateur à la réservation temporaire.

### Connexion (`signin.js`) :
- Permet d'utiliser un compte existant.
- Nettoie les réservations temporaires précédentes via `freetempevent/` avant d'en créer une nouvelle pour éviter les doublons.

---

## 4. Capture et Confirmation du Rendez-vous

Le processus de "capture" se déroule en plusieurs étapes de validation :

1.  **Réservation Temporaire** : Dès que l'utilisateur sélectionne un créneau (`selecttime`), une entrée temporaire est créée côté serveur.
2.  **Validation du Client** (`confirmclient.js`) :
    - Un code est envoyé par **Email (type 0)** ou **SMS (type 1)**.
    - L'utilisateur doit saisir ce code qui est envoyé à `confirmclient/` avec le `bktToken`.
3.  **Paiement (Optionnel)** : Si le service est payant, le routeur dirige vers `creditcardcapture`. Les passerelles supportées incluent **Stripe, PayPal, Redsys et Niubiz**.
4.  **Confirmation Finale** (`summary.js`) :
    - Un appel final est fait à `summary/` avec toutes les données accumulées.
    - Le serveur transforme la réservation temporaire en rendez-vous définitif.

---

## 5. Impression et Résultat

La confirmation génère un objet `Event` complet.
- **Vue Ticket** (`ticket.js`) : Formate les données (Locateur, Agenda, Service, Date/Heure).
- **Impression** : Le widget utilise une fenêtre popup (`window.open`) pour générer une version HTML imprimable du ticket et appelle `window.print()`.

---

## Conclusion pour l'automatisation
Pour interagir avec ce système par script, il est crucial de :
1. Maintenir le `bktToken` tout au long du flux.
2. Gérer les captchas (souvent le point bloquant).
3. Respecter le format JSONP pour les appels API.
4. Gérer le délai d'expiration des réservations temporaires.
