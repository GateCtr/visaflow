# CEV Slot Hunter — Guide d'installation iPhone (Orion)

## Prérequis

- **Orion Browser** installé sur iPhone (gratuit sur l'App Store — c'est le seul navigateur iOS supportant les extensions Chrome)
- Une clé **Anti-Captcha** active (anti-captcha.com — quelques dollars de crédit suffisent)
- Être connecté à **VOWINT** (visaonweb.diplomatie.be) sur Orion

---

## Étape 1 — Télécharger l'extension

Transfère le dossier `cev-extension/` sur ton iPhone. Méthodes possibles :
- **AirDrop** depuis ton Mac
- **iCloud Drive** / Google Drive / Dropbox
- **Files by Readdle** ou l'app Fichiers

Le dossier doit contenir :
```
cev-extension/
├── manifest.json
├── background.js
├── content.js
├── popup.html
├── popup.js
├── popup.css
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Étape 2 — Installer dans Orion

1. Ouvre **Orion** sur iPhone
2. Va dans **Réglages Orion** → **Extensions**
3. Appuie sur **Charger une extension non empaquetée** (ou "Load unpacked")
4. Navigue jusqu'au dossier `cev-extension/` et sélectionne-le
5. L'extension apparaît dans la barre d'Orion avec l'icône 🎯

> **Note :** Si Orion ne propose pas de charger en dossier, utilise l'option **"Pack extension"** sur desktop d'abord pour créer un fichier `.crx`, puis transfère ce fichier.

---

## Étape 3 — Configuration

1. Appuie sur l'icône de l'extension 🎯 dans Orion
2. **Coller ta clé Anti-Captcha** dans le champ prévu
3. Appuie sur **Sauvegarder** (la clé est stockée localement, jamais transmise)

---

## Étape 4 — Utilisation

1. Dans Orion, **connecte-toi à VOWINT** : https://visaonweb.diplomatie.be
2. **Navigue jusqu'à ta demande** et clique sur l'icône calendrier pour ouvrir le portail CEV
3. Orion t'amène sur `appointment.cloud.diplomatie.be`
4. Ouvre l'extension 🎯 et appuie sur **▶ Démarrer**
5. L'extension :
   - Résout automatiquement les captchas hCaptcha via Anti-Captcha
   - Poll les créneaux toutes les 3-5 minutes (délais aléatoires)
   - Réserve automatiquement dès qu'un créneau s'ouvre
   - T'envoie une notification système quand c'est réservé

---

## Comportement anti-détection

| Mécanisme | Valeur |
|-----------|--------|
| Délai entre checks | 3–5 min aléatoire |
| Pause de session | Automatique après 90min |
| Durée pause | 45 min |
| Limite clics/heure | 4 (serveur tolère 5) |
| Simulation souris | mouseover → mousedown → mouseup → click |
| Bruit de scroll | 30% de chance par cycle |
| Pause "lecture" | 2-7s aléatoire avant action |

---

## Indicateurs du popup

| Couleur | Signification |
|---------|---------------|
| 🔴 Gris | Inactif |
| 🟢 Vert pulsant | Surveillance active |
| 🟡 Jaune pulsant | Résolution captcha en cours |
| 🟣 Violet | Rendez-vous réservé ! |

---

## Dépannage

**"Session expirée"** → La session VOWINT/CEV a expiré. Retourne sur VOWINT, clique à nouveau sur le calendrier, reviens sur CEV et redémarre.

**"Clé Anti-Captcha manquante"** → Ouvre le popup et entre/sauvegarde ta clé.

**Captcha non résolu** → Vérifie ton solde Anti-Captcha sur anti-captcha.com. Note : CapSolver est **blacklisté** pour les sitekeys CEV depuis avril 2026 — utiliser **uniquement Anti-Captcha**.

**L'extension ne détecte pas la page** → Assure-toi d'être sur `appointment.cloud.diplomatie.be` (pas sur VOWINT).

---

## Coût estimé

- **Anti-Captcha** : ~$0.001 par captcha résolu
- Avec 15 captchas/jour → ~$0.015/jour → $0.45/mois
