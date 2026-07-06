export interface GuideSection {
  heading: string;
  body: string;
  list?: string[];
}

export interface Guide {
  slug: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  publishedDate: string;
  updatedDate: string;
  readingTime: number;
  category: string;
  coverEmoji: string;
  intro: string;
  sections: GuideSection[];
  faq: { q: string; a: string }[];
  relatedSlugs: string[];
  relatedDestination?: string;
}

const guides: Guide[] = [
  {
    slug: "comment-obtenir-creneau-visa-usa-kinshasa",
    title: "Comment obtenir un créneau visa USA à Kinshasa en 2026 — Solution quand usvisaappt.com n'a aucune date",
    metaTitle: "Créneau Visa USA Kinshasa 2026 — Que faire quand « aucune date disponible » ? | Joventy",
    metaDescription:
      "usvisaappt.com affiche 'aucune date disponible' à Kinshasa ? Voici comment obtenir un créneau entretien visa USA rapidement : surveiller les annulations, meilleurs horaires, et solution Joventy 24h/24.",
    publishedDate: "2025-05-01",
    updatedDate: "2026-05-31",
    readingTime: 7,
    category: "Visa USA",
    coverEmoji: "🇺🇸",
    intro:
      "Obtenir un créneau d'entretien au consulat américain de Kinshasa est devenu l'un des obstacles les plus frustrants pour les demandeurs de visa B1/B2. Le portail officiel usvisaappt.com affiche régulièrement « aucune date disponible » pendant des semaines, voire des mois. En 2026, la situation est d'autant plus tendue que l'ambassade américaine à Kinshasa est passée en Travel Advisory Level 4 en raison de l'épidémie d'Ebola en Ituri. Ce guide vous explique pourquoi les créneaux sont si rares, comment le système fonctionne, et comment maximiser vos chances d'en obtenir un rapidement.",
    sections: [
      {
        heading: "Pourquoi les créneaux visa USA sont-ils si rares à Kinshasa ?",
        body:
          "Le consulat américain de Kinshasa traite environ 200 à 300 demandes de visa non-immigrant par jour. Face à une demande en constante augmentation, les créneaux se remplissent en quelques minutes dès leur ouverture. Plusieurs facteurs aggravent la situation :",
        list: [
          "Les demandes de visa B1/B2 (tourisme, affaires) représentent la majorité du volume",
          "Le consulat libère souvent des annulations la nuit ou tôt le matin, hors des heures de bureau",
          "Les périodes de forte demande (vacances, saison estivale) saturent le calendrier",
          "Les fêtes locales et fermetures consulaires réduisent encore la disponibilité",
        ],
      },
      {
        heading: "Comment fonctionne le portail de rendez-vous visa USA (usvisaappt.com) ?",
        body:
          "Le portail officiel usvisaappt.com est l'interface pour prendre un rendez-vous visa américain en RDC. Voici les étapes clés :",
        list: [
          "Créer un compte sur usvisaappt.com avec votre adresse e-mail",
          "Payer les frais de visa (185 à 210 USD selon le type de visa) via les canaux agréés en RDC",
          "Remplir le formulaire DS-160 sur ceac.state.gov",
          "Accéder à la section « Schedule Appointment » et consulter les créneaux disponibles",
          "Le calendrier affiche les dates : les jours disponibles peuvent apparaître à tout moment suite à des annulations",
        ],
      },
      {
        heading: "Les moments où des créneaux se libèrent",
        body:
          "Les créneaux annulés ou nouvellement ouverts apparaissent à des moments variables. Connaître ces tendances vous donne un avantage :",
        list: [
          "Tôt le matin (7h00-8h00) : avant l'ouverture consulaire, des annulations sont souvent traitées",
          "72 heures avant la date d'un entretien non confirmé : le créneau est libéré automatiquement par le système",
          "Premier jour de chaque mois : de nouveaux créneaux sont généralement ajoutés pour le mois suivant",
          "En soirée (20h00-22h00) : certaines disponibilités s'ouvrent après les traitements de fin de journée",
        ],
      },
      {
        heading: "La solution : un suivi régulier et une réactivité immédiate",
        body: "L'obtention d'un créneau repose essentiellement sur la réactivité : dès qu'une disponibilité apparaît sur usvisaappt.com, il faut être en mesure de la réserver en quelques minutes. Joventy accompagne ses clients dans cette démarche grâce à un suivi rapproché du portail et une prise en charge rapide :",
        list: [
          "Suivi régulier du portail usvisaappt.com par l'équipe Joventy, y compris en dehors des heures de bureau",
          "Alerte WhatsApp dès qu'une disponibilité est détectée pour votre profil",
          "Prise en charge de la réservation à votre place dès confirmation de votre part",
          "Tableau de bord client pour suivre l'état de votre dossier en temps réel",
        ],
      },
      {
        heading: "Ce qu'il faut préparer avant votre créneau",
        body:
          "Obtenir le créneau n'est que la première étape. Pour que votre entretien se passe bien, préparez ces éléments en amont :",
        list: [
          "DS-160 complété et soumis (numéro de confirmation à 10 caractères)",
          "Reçu de paiement des frais de visa (185 USD)",
          "Photo conforme aux standards américains (5×5 cm, fond blanc, moins de 6 mois)",
          "Passeport valide au moins 6 mois après la date d'entrée prévue",
          "Documents financiers (relevés bancaires 6 derniers mois)",
          "Preuve de liens avec la RDC (contrat de travail, titres de propriété, etc.)",
        ],
      },
    ],
    faq: [
      {
        q: "Combien de temps faut-il attendre pour un créneau visa USA à Kinshasa ?",
        a: "En 2026, les délais d'attente varient entre 4 et 16 semaines selon la saison. Avec le Travel Advisory Level 4 actuel (Ebola), certains services consulaires peuvent être perturbés. L'équipe Joventy suit la situation et obtient généralement un créneau pour ses clients dans les 48 à 96 heures suivant l'activation de leur dossier.",
      },
      {
        q: "Peut-on réserver un créneau visa USA sans remplir le DS-160 d'abord ?",
        a: "Non. Le portail usvisaappt.com exige le numéro de confirmation DS-160 avant de permettre la prise de rendez-vous. Joventy vous aide à remplir et soumettre le DS-160 correctement avant de lancer le suivi des créneaux.",
      },
      {
        q: "Les frais de visa sont-ils remboursables si je n'obtiens pas de créneau ?",
        a: "Les frais de visa (185 USD) sont remboursables si vous n'avez pas pu programmer de rendez-vous dans les 12 mois suivant le paiement. En revanche, si un rendez-vous a été programmé puis manqué, les frais ne sont généralement pas remboursés.",
      },
      {
        q: "Joventy peut-il réserver un créneau à ma place sur usvisaappt.com ?",
        a: "Oui. Notre équipe prend en charge la réservation sur usvisaappt.com en votre nom dès qu'une disponibilité compatible avec votre profil apparaît. Vous recevez la confirmation par WhatsApp.",
      },
    ],
    relatedSlugs: [
      "documents-visa-schengen-kinshasa",
      "payer-frais-mrv-visa-usa-kinshasa",
      "entretien-visa-usa-b1-b2-questions",
    ],
    relatedDestination: "visa-usa-kinshasa",
  },

  {
    slug: "documents-visa-schengen-kinshasa",
    title: "Documents visa Schengen depuis Kinshasa 2026 : liste complète par pays (France, Belgique, Allemagne, Espagne)",
    metaTitle: "Documents Visa Schengen Kinshasa 2026 — Liste complète par ambassade + 10 erreurs à éviter | Joventy",
    metaDescription:
      "Liste exacte des documents pour un visa Schengen depuis Kinshasa en 2026 : formulaire, photos, relevés bancaires, assurance, hébergement — par ambassade. + les 10 erreurs qui causent un refus.",
    publishedDate: "2026-06-01",
    updatedDate: "2026-06-15",
    readingTime: 10,
    category: "Visa Schengen",
    coverEmoji: "🇪🇺",
    intro:
      "Obtenir un visa Schengen depuis Kinshasa en 2026 : une règle essentielle que peu de demandeurs connaissent. Ni l'Ambassade de France, ni l'Ambassade d'Allemagne ne reçoivent directement les dossiers des ressortissants congolais pour les visas court séjour. Tout passe par un guichet unique : le Centre Européen des Visas (CEV), géré par l'Ambassade de Belgique à Kinshasa (cev-kin.eu). Ce guide détaille les documents exigés selon l'ambassade de destination (France, Belgique, Allemagne), les spécificités du CEV, et les 10 erreurs qui causent le plus de refus.",
    sections: [
      {
        heading: "Le CEV — guichet unique pour tous les visas Schengen court séjour depuis Kinshasa",
        body:
          "Le Centre Européen des Visas (CEV) est le seul centre habilité à recevoir les demandes de visa Schengen court séjour des ressortissants congolais à Kinshasa. Il est géré par l'Ambassade de Belgique. Ni TLS Contact, ni VFS Global ne sont utilisés à Kinshasa pour les Congolais. Le CEV représente plusieurs ambassades — France, Belgique, Allemagne, Pays-Bas, et d'autres — pour toutes les demandes de visa court séjour (type C). Point crucial : l'Ambassade de France à Kinshasa et l'Ambassade d'Allemagne à Kinshasa ne reçoivent pas directement les dossiers Schengen des ressortissants congolais ; elles sont compétentes uniquement pour les visas long séjour ou pour les ressortissants d'autres nationalités.",
        list: [
          "📍 Site officiel du CEV : www.cev-kin.eu — prise de rendez-vous en ligne obligatoire",
          "📍 Adresse : Avenue du 24 novembre (Pierre Mulele), Kinshasa (Gombe)",
          "Dépôt possible aussi à Lubumbashi via le Consulat Général de Belgique",
          "Le CEV décide quelle ambassade est compétente selon votre destination principale",
          "Délai de rendez-vous : 1 à 4 semaines d'attente selon la période",
          "Délai de dépôt : entre 15 jours et 6 mois avant la date de départ prévue",
          "Les frais de service CEV s'ajoutent aux droits de visa de l'ambassade concernée",
        ],
      },
      {
        heading: "Visa France depuis Kinshasa — liste des documents (via CEV, 2026)",
        body:
          "⚠️ L'Ambassade de France à Kinshasa ne délivre PAS de visa Schengen court séjour. Les demandes pour la France sont instruites par l'Ambassade de Belgique via le CEV — seul habilité à prendre les décisions. Le formulaire officiel reste celui de france-visas.gouv.fr. Les frais de visa France sont de 90 € adulte.",
        list: [
          "Passeport ordinaire valide au moins 3 mois après la fin du séjour prévu, avec au moins 2 pages vierges et émis il y a moins de 10 ans",
          "Copie de toutes les pages utilisées du passeport actuel + copie intégrale des anciens passeports",
          "2 photos d'identité biométriques récentes (35×45 mm, fond blanc ou gris clair, prises il y a moins de 6 mois, sans lunettes)",
          "Formulaire de demande de visa Schengen complété et signé (téléchargeable sur france-visas.gouv.fr — à ne pas confondre avec l'ancien formulaire papier)",
          "Assurance voyage médicale couvrant tous les pays Schengen, valide pour toute la durée du séjour, minimum 30 000 € de garantie incluant rapatriement sanitaire (AXA, Allianz, Europ Assistance — les polices locales congolaises ne sont pas acceptées)",
          "Preuve d'hébergement : confirmation de réservation hôtel (Booking.com accepté), ou attestation d'accueil légalisée de l'hébergeant français (Mairie de France), ou attestation notariée de logement à titre gratuit",
          "Réservation de billets aller-retour (itinéraire, pas forcément le billet définitif payé — une réservation ferme suffit)",
          "Justificatifs financiers : relevés bancaires des 3 derniers mois (solde minimum recommandé : 1 500 000 FC ou équivalent en USD), ou lettre de prise en charge d'un garant français avec ses propres relevés et justificatifs de revenus",
          "Justificatif de situation professionnelle : attestation de travail récente avec salaire mensuel, ou extrait RCCM + preuve d'activité pour les indépendants, ou attestation d'inscription pour les étudiants",
          "Justificatif de domicile en RDC (facture eau/électricité de moins de 3 mois, ou contrat de bail)",
          "Pour les salariés du secteur public ou parapublic : ordre de mission signé et tamponné par l'autorité hiérarchique",
          "Pour les mineurs : acte de naissance + autorisation de sortie du territoire des deux parents (légalisée) + copie des pièces d'identité des parents",
        ],
      },
      {
        heading: "Visa Belgique depuis Kinshasa — liste des documents (via CEV, 2026)",
        body:
          "Le CEV étant géré par l'Ambassade de Belgique, les demandes de visa Schengen pour la Belgique suivent exactement le même guichet — le CEV. L'Ambassade de Belgique est l'autorité décisionnaire pour les visas Belgique et, par délégation, pour les autres pays Schengen représentés. La Belgique est le pays Schengen le plus demandé depuis Kinshasa en raison des nombreux liens familiaux — ce qui signifie aussi un contrôle plus rigoureux. Frais : 90 € adulte, 45 € enfant 6-12 ans, gratuit sous 6 ans + frais CEV.",
        list: [
          "Passeport valide au moins 3 mois après la date de retour prévue, avec 2 pages vierges minimum",
          "Copie de tous les visas et tampons d'entrée antérieurs (visas refusés compris)",
          "2 photos biométriques récentes identiques aux normes Schengen (35×45 mm, fond blanc, sans lunettes)",
          "Formulaire de demande de visa Schengen complété en français ou en néerlandais (disponible sur le site de l'ambassade)",
          "Assurance médicale voyage : minimum 30 000 €, valable dans tout l'espace Schengen, couvrant l'intégralité du séjour. La Belgique vérifie systématiquement la validité de la police en ligne",
          "Preuve d'hébergement : réservation hôtel confirmée, ou attestation d'accueil officielle (« bijlage 3bis ») remplie par un résident belge et légalisée à la commune belge de résidence de l'hébergeant — document incontournable pour les visites familiales",
          "Itinéraire de voyage détaillé avec réservation de vol aller-retour",
          "Preuve de moyens financiers : relevés bancaires 3 derniers mois + dernier bulletin de salaire ou titre de revenus. La Belgique applique le seuil de 45 € par jour de séjour comme référence officielle",
          "Lettre de motivation détaillant le but du voyage (obligatoire pour les visites familiales, les voyages d'affaires et les conférences)",
          "Justificatif d'activité professionnelle : contrat de travail, attestation de l'employeur, ou preuve d'activité indépendante (patente, RCCM)",
          "Pour visite familiale : preuve du lien de parenté (acte de naissance, acte de mariage), copie du titre de séjour ou de la nationalité belge de la personne invitante",
          "Pour voyage d'affaires : invitation officielle de la société belge sur papier à en-tête",
        ],
      },
      {
        heading: "Visa Allemagne depuis Kinshasa — liste des documents (via CEV, 2026)",
        body:
          "⚠️ L'Ambassade d'Allemagne à Kinshasa NE traite PAS les demandes de visa Schengen des ressortissants congolais. Source officielle : kinshasa.diplo.de. Les demandes pour l'Allemagne se déposent exclusivement au CEV (anciennement appelé « Maison Schengen »). L'Ambassade d'Allemagne reste compétente uniquement pour les ressortissants d'autres nationalités. Frais de visa Allemagne : 90 € adulte + frais CEV. L'Allemagne applique une checklist très structurée.",
        list: [
          "Passeport valide au moins 6 mois après la date de retour (exigence plus stricte que France et Belgique), avec 2 pages vierges",
          "Anciens passeports contenant des visas ou des tampons d'entrée dans des pays tiers",
          "2 photos biométriques récentes (35×45 mm, fond blanc ou gris clair uniforme, prise de face, yeux ouverts, sans reflet ni ombre)",
          "Formulaire de demande de visa Schengen officiel téléchargeable sur le site de l'ambassade d'Allemagne",
          "Assurance voyage médicale : minimum 30 000 €, valable dans tout l'espace Schengen, en allemand ou en anglais — les polices uniquement en français sans traduction anglaise peuvent poser problème",
          "Preuve d'hébergement : réservation hôtel avec confirmation ferme, ou Einladung (lettre d'invitation formelle d'un résident allemand)",
          "Billet aller-retour ou réservation ferme avec dates précises",
          "Preuve de moyens financiers : relevés bancaires des 3 derniers mois (référence : 50 € par jour de séjour), ou Verpflichtungserklärung (déclaration d'engagement financier signée par un garant allemand et enregistrée à l'Ausländerbehörde)",
          "Justificatif d'emploi ou d'activité : attestation de l'employeur précisant salaire, fonction, durée du congé accordé ; ou pour les indépendants, documents d'enregistrement de l'entreprise + relevés financiers récents",
          "Pour voyage d'affaires : invitation de la société allemande avec détail des activités prévues, attestation de prise en charge des frais si applicable",
          "Pour étudiants : attestation d'inscription + preuve de financement des études (bourse, virement parental documenté)",
        ],
      },
      {
        heading: "Les 10 erreurs les plus fréquentes qui causent un refus depuis Kinshasa",
        body:
          "Sur la base des dossiers traités par Joventy et des motifs de refus officiels communiqués par les ambassades, voici les 10 erreurs qui éliminent les demandeurs le plus souvent — avec la formulation exacte utilisée dans les lettres de refus.",
        list: [
          "❌ Erreur #1 — Assurance insuffisante : polices avec couverture inférieure à 30 000 €, ne couvrant pas le rapatriement, ou n'étant pas valables dans tous les pays Schengen. Formulation du refus : « L'assurance voyage produite ne répond pas aux exigences minimales du Code des visas. »",
          "❌ Erreur #2 — Relevés bancaires fabriqués ou gonflés : les ambassades vérifient la cohérence des mouvements (dépôts inhabituels juste avant la demande, virements ronds sans justification). Formulation : « Les informations fournies concernant votre situation financière ne sont pas fiables. »",
          "❌ Erreur #3 — Absence de lien solide avec la RDC : pas de contrat de travail stable, pas de propriété, pas d'enfants mineurs — le consul estime que le risque d'immigration irrégulière est élevé. Formulation : « Votre intention de quitter le territoire avant l'expiration du visa n'a pas été établie. »",
          "❌ Erreur #4 — Déclaration de voyage incohérente : but déclaré (tourisme) incompatible avec les documents produits, ou durée déclarée différente des billets réservés. Formulation : « L'objet et les conditions du séjour envisagé n'ont pas été établis. »",
          "❌ Erreur #5 — Photos non conformes : fond coloré, lunettes, ombres sur le visage, sourire trop marqué, image pixelisée ou imprimée en basse résolution. Les refus pour photo entraînent un renvoi du dossier sans traitement.",
          "❌ Erreur #6 — Passeport avec validité insuffisante : moins de 3 mois au-delà du séjour (6 mois pour l'Allemagne). Erreur souvent commise quand on compte jusqu'à la date de retour sans ajouter la marge de sécurité exigée.",
          "❌ Erreur #7 — Dossier incomplet ou pièces non traduites : toute pièce en langue locale (lingala, kikongo, tshiluba) sans traduction assermentée vers le français est ignorée. L'Allemagne exige les documents clés en allemand ou en anglais.",
          "❌ Erreur #8 — Refus antérieur non déclaré : le formulaire pose explicitement la question. Ne pas mentionner un refus précédent est considéré comme une fraude et entraîne un refus automatique plus sévère.",
          "❌ Erreur #9 — Hébergement non confirmé ou attestation d'accueil sans légalisation : une simple lettre d'un ami en Europe sans légalisation officielle à la commune n'est pas acceptée par la Belgique ni par la France.",
          "❌ Erreur #10 — Dépôt hors délai : dossier déposé moins de 15 jours avant le départ (trop tard pour traitement) ou plus de 6 mois à l'avance (dossier expiré). La fenêtre optimale est entre 3 semaines et 3 mois avant le voyage.",
        ],
      },
      {
        heading: "Délais de traitement et frais en 2026",
        body:
          "En juin 2026, voici les données actualisées pour chaque ambassade à Kinshasa :",
        list: [
          "🇫🇷 France (via CEV) : délai réglementaire maximum de 15 jours ouvrables à compter du dépôt du dossier complet. En période estivale (juin-août), compter 20 à 25 jours. Frais visa : 90 € adulte, 45 € enfant 6-12 ans, gratuit sous 6 ans",
          "🇧🇪 Belgique (via CEV — l'Ambassade de Belgique est l'autorité décisionnaire) : délai standard 15 jours ouvrables. Un entretien consulaire complémentaire peut être demandé. Frais : 90 € adulte, 45 € enfant, gratuit sous 6 ans",
          "🇩🇪 Allemagne (via CEV — l'Ambassade d'Allemagne NE reçoit PAS les Congolais directement) : délai standard 15 jours ouvrables. Le CEV peut refuser la prise en charge si un document manque. Frais : 90 € adulte",
          "Paiement : les frais de visa se règlent en euros ou en USD selon le taux du jour affiché au guichet. Les frais ne sont pas remboursables en cas de refus.",
          "Voie de recours : en cas de refus, vous avez le droit de demander les motifs écrits et de déposer un appel dans les 15 jours auprès de la même ambassade.",
        ],
      },
      {
        heading: "Comment Joventy sécurise votre dossier Schengen",
        body:
          "Joventy accompagne les demandeurs de Kinshasa de A à Z sur la préparation du dossier Schengen :",
        list: [
          "Vérification complète de chaque pièce avant dépôt (conformité, fraîcheur, cohérence)",
          "Sélection de la bonne ambassade en fonction de votre itinéraire réel",
          "Rédaction de la lettre de motivation personnalisée selon le profil et le but du voyage",
          "Aide à l'obtention d'une assurance voyage conforme aux exigences Schengen depuis Kinshasa",
          "Prise de rendez-vous CEV et suivi du traitement",
          "Accompagnement en cas de refus : analyse du motif et préparation du dossier d'appel ou d'une nouvelle demande renforcée",
        ],
      },
    ],
    faq: [
      {
        q: "Quelle ambassade Schengen est la plus facile à obtenir depuis Kinshasa ?",
        a: "Important à savoir : depuis Kinshasa, tous les visas Schengen court séjour se déposent au même endroit — le CEV (cev-kin.eu), géré par l'Ambassade de Belgique. Il n'y a qu'un seul guichet. Ce qui varie selon l'ambassade de destination, c'est la liste de documents et les critères d'évaluation. Il n'existe pas d'ambassade objectivement 'plus facile' : toutes appliquent le même Code des visas Schengen.",
      },
      {
        q: "Peut-on déposer un dossier Schengen sans avoir les billets définitifs payés ?",
        a: "Oui. Les ambassades acceptent une réservation ferme de vols (itinéraire confirmé) sans que le billet soit intégralement payé. Il ne faut surtout pas acheter les billets définitifs avant d'avoir le visa — vous risqueriez de perdre votre argent en cas de refus. Joventy vous aide à obtenir une réservation provisoire acceptable.",
      },
      {
        q: "Mon dossier a déjà été refusé — puis-je redéposer immédiatement ?",
        a: "Oui, il n'y a pas de délai légal minimum entre deux demandes. Mais redéposer sans corriger la cause du refus est contre-productif : les ambassades ont accès à l'historique et un deuxième refus renforce la suspicion. Joventy analyse le motif exact et renforce le dossier avant toute nouvelle tentative.",
      },
      {
        q: "L'assurance souscrite via un opérateur congolais est-elle acceptée ?",
        a: "Généralement non. Les ambassades de France, Belgique et Allemagne à Kinshasa exigent une assurance émise par un assureur reconnu internationalement (AXA, Allianz, Europ Assistance, Médical Air Services). Les polices locales congolaises, même si elles mentionnent une couverture internationale, sont régulièrement refusées car non vérifiables en ligne par le consul.",
      },
      {
        q: "Les relevés bancaires doivent-ils être en euros ou en francs congolais ?",
        a: "Les ambassades acceptent les relevés en francs congolais (FC) ou en USD. Le consul convertit au taux officiel du jour. À titre indicatif : 45 €/jour pour la Belgique, 50 €/jour pour l'Allemagne et la France. Un solde de 3 000 USD pour un séjour de 30 jours est une base solide.",
      },
      {
        q: "Dois-je me présenter en personne pour déposer mon dossier ?",
        a: "Oui. Que vous demandiez un visa France, Belgique ou Allemagne, vous vous rendez physiquement au CEV (Centre Européen des Visas, Avenue du 24 novembre, Kinshasa). Vos empreintes digitales biométriques y sont enregistrées. Seuls les enfants de moins de 12 ans peuvent en être dispensés. Le site du CEV pour prendre rendez-vous est cev-kin.eu.",
      },
    ],
    relatedSlugs: [
      "visa-espagne-kinshasa-rendez-vous-ambassade-2026",
      "comment-obtenir-creneau-visa-usa-kinshasa",
      "delais-visa-usa-canada-schengen-kinshasa-2025",
    ],
    relatedDestination: "visa-schengen-kinshasa",
  },

  {
    slug: "entretien-visa-usa-b1-b2-questions",
    title: "Entretien visa B1/B2 USA à Kinshasa : 15 questions posées par l'officier et les bonnes réponses",
    metaTitle: "Questions Entretien Visa USA Kinshasa 2026 — 15 Questions + Réponses pour éviter le refus | Joventy",
    metaDescription:
      "Quelles questions pose l'officier consulaire USA à Kinshasa ? Les 15 questions les plus fréquentes de l'entretien B1/B2, les réponses qui convainquent, et les erreurs qui déclenchent un refus 214(b).",
    publishedDate: "2025-05-15",
    updatedDate: "2026-05-31",
    readingTime: 9,
    category: "Visa USA",
    coverEmoji: "🎤",
    intro:
      "L'entretien à l'ambassade américaine de Kinshasa dure en moyenne 3 à 5 minutes. En si peu de temps, l'officier consulaire doit décider si vous obtenez votre visa. Il évalue deux choses : votre lien avec la RDC (allez-vous rentrer ?) et la légitimité de votre voyage. Ce guide couvre les 15 questions les plus posées et les formulations qui fonctionnent.",
    sections: [
      {
        heading: "Ce que l'officier évalue vraiment",
        body:
          "Contrairement à ce qu'on croit, l'officier ne cherche pas à vous piéger. Il vérifie trois points fondamentaux :",
        list: [
          "Intention non-immigrant : avez-vous l'intention de rentrer en RDC après votre séjour ?",
          "Solvabilité : pouvez-vous financer votre voyage sans chercher à travailler aux USA ?",
          "Cohérence du dossier : vos documents, vos réponses et votre profil sont-ils cohérents ?",
        ],
      },
      {
        heading: "Questions sur le motif et l'itinéraire du voyage",
        body:
          "Soyez précis, concis et honnête. Répondez en 2 à 3 phrases maximum par question.",
        list: [
          "« What is the purpose of your trip? » → Donnez un motif précis (visite de famille, conférence, tourisme médical). Évitez les formulations vagues comme « voyager ».",
          "« Where will you be staying? » → Nom de l'hôtel ou prénom/adresse de votre hôte. Avoir la réservation imprimée est un plus.",
          "« How long do you plan to stay? » → Donnez une durée précise qui correspond à votre itinéraire. Évitez « peut-être 2 ou 3 semaines ».",
          "« Have you been to the US before? » → Si oui, précisez l'année, la durée et le motif. Un historique positif est un atout.",
          "« Do you have family in the US? » → Répondez honnêtement. Si oui, précisez le lien de parenté et leur statut (citoyen, résident). Ce n'est pas rédhibitoire si votre dossier prouve votre intention de rentrer.",
        ],
      },
      {
        heading: "Questions sur vos attaches en RDC",
        body: "C'est la partie la plus décisive de l'entretien. Préparez des preuves concrètes.",
        list: [
          "« What do you do for work in DRC? » → Décrivez votre poste, votre employeur, votre ancienneté. Si indépendant, décrivez votre activité et vos clients.",
          "« Do you own property in DRC? » → Si oui, mentionnez-le clairement. Une maison, un terrain, une voiture — tout prouve vos attaches.",
          "« Who will take care of your family while you're away? » → Montrez que des personnes dépendent de vous ici.",
          "« Will you lose your job if you stay longer? » → Répondez « Yes, absolutely » si vous êtes salarié. Cela renforce votre intention de rentrer.",
          "« Why should I believe you'll come back? » → Ne soyez pas déstabilisé. Listez calmement : travail, famille, propriété, affaires.",
        ],
      },
      {
        heading: "Questions sur les finances",
        body: "Soyez transparent et cohérent avec vos relevés bancaires.",
        list: [
          "« Who is paying for this trip? » → Si vous payez vous-même, dites-le. Si un sponsor paie, expliquez votre lien et mentionnez la lettre d'engagement.",
          "« How much money do you have in your bank account? » → Donnez le montant approximatif. Ne gonflez pas — l'officier peut vérifier.",
          "« How much does the trip cost? » → Estimez billets + hébergement + frais de vie. Montrez que vous avez les moyens.",
        ],
      },
      {
        heading: "Questions pièges à éviter",
        body:
          "Certaines formulations sonnent faux pour les officiers consulaires. Voici ce qu'il ne faut jamais dire :",
        list: [
          "« Je veux voir comment c'est là-bas » — trop vague, suggère une intention d'émigration",
          "« Mon frère m'a dit de venir » — ne démontre pas votre propre motivation",
          "« Je ne sais pas exactement combien de temps » — signale une absence de planning sérieux",
          "Mentir sur vos revenus ou votre situation familiale — l'officier a accès à des bases de données",
        ],
      },
      {
        heading: "Conseils pratiques pour le jour J",
        body: "La forme compte autant que le fond. Quelques points qui font la différence :",
        list: [
          "Arrivez 15 minutes en avance au consulat américain de Kinshasa (Gombe). Les files peuvent être longues.",
          "Apportez vos documents dans un classeur ordonné — l'officier peut vous demander à les voir",
          "Parlez en anglais si vous le maîtrisez. Sinon, le français est accepté à Kinshasa.",
          "Restez calme et naturel. Un refus n'est pas définitif — vous pouvez représenter votre demande.",
          "Ne répondez pas plus que ce qui est demandé. Soyez concis et factuel.",
        ],
      },
    ],
    faq: [
      {
        q: "L'entretien visa USA se fait-il en anglais ou en français à Kinshasa ?",
        a: "Les officiers consulaires acceptent le français à l'ambassade américaine de Kinshasa. Cependant, si vous maîtrisez l'anglais, l'utiliser peut être un avantage — cela montre que vous avez des raisons légitimes de voyager aux États-Unis.",
      },
      {
        q: "Que se passe-t-il si l'officier me demande des documents que je n'ai pas apportés ?",
        a: "Si l'officier demande un document manquant, il peut refuser le visa ou demander une mise en attente administrative (221g). Dans ce cas, vous avez généralement 12 mois pour fournir les documents complémentaires sans repayer les frais de visa.",
      },
      {
        q: "Peut-on repasser l'entretien après un refus visa USA ?",
        a: "Oui. Un refus sous l'article 214(b) — le plus courant — signifie que vous n'avez pas suffisamment prouvé vos attaches en RDC. Vous pouvez représenter votre demande dès que votre situation a évolué (nouveau travail, propriété achetée, mariage, etc.). Il n'y a pas de délai d'attente obligatoire, mais il est conseillé d'attendre au moins 3 à 6 mois.",
      },
    ],
    relatedSlugs: [
      "comment-obtenir-creneau-visa-usa-kinshasa",
      "visa-usa-refuse-que-faire",
      "payer-frais-mrv-visa-usa-kinshasa",
    ],
    relatedDestination: "visa-usa-kinshasa",
  },

  {
    slug: "visa-usa-refuse-que-faire",
    title: "Visa USA refusé à Kinshasa (214b) : les vraies raisons et comment réussir la deuxième demande",
    metaTitle: "Visa USA Refusé Kinshasa — Raisons du refus 214(b) et comment réussir la 2e demande | Joventy",
    metaDescription:
      "Visa USA refusé 214(b) à Kinshasa ? Les vraies raisons de refus, ce qu'il faut changer dans votre dossier, et dans quel délai représenter votre demande pour maximiser vos chances d'acceptation.",
    publishedDate: "2025-05-20",
    updatedDate: "2026-05-31",
    readingTime: 6,
    category: "Visa USA",
    coverEmoji: "❌",
    intro:
      "Un refus visa USA est décourageant, mais il n'est pas définitif. La majorité des refus à Kinshasa sont émis sous l'article 214(b) de la loi américaine sur l'immigration — ce qui signifie que l'officier n'a pas été convaincu que vous rentrerez en RDC après votre séjour. Voici comment analyser votre refus, corriger les faiblesses de votre dossier, et repartir dans les meilleures conditions.",
    sections: [
      {
        heading: "Comprendre le refus 214(b)",
        body:
          "L'article 214(b) est le motif de refus le plus fréquent pour les visas non-immigrants (B1/B2, F1, etc.). Il stipule que tout demandeur est présumé immigrant jusqu'à preuve du contraire. Pour renverser cette présomption, vous devez démontrer :",
        list: [
          "Des liens solides avec la RDC (travail, famille, propriété, affaires)",
          "Un motif de voyage spécifique et légitime",
          "Des ressources financières suffisantes pour couvrir le voyage sans travailler aux USA",
          "L'intention claire et prouvée de rentrer en RDC à la date prévue",
        ],
      },
      {
        heading: "Les causes les plus fréquentes de refus à Kinshasa",
        body:
          "En analysant les dossiers de nos clients, Joventy a identifié les raisons les plus courantes de refus :",
        list: [
          "Relevés bancaires insuffisants ou incohérents avec le niveau de vie déclaré",
          "Absence de stabilité professionnelle (contrat CDD, emploi récent de moins de 6 mois)",
          "Famille proche (conjoint, enfants) déjà résidant aux USA ou ayant fait une demande de visa",
          "Réponses trop vagues ou contradictoires lors de l'entretien",
          "Demande de visa longue durée sans historique de voyages internationaux",
          "DS-160 mal rempli avec des informations incomplètes ou incohérentes",
        ],
      },
      {
        heading: "Ce que vous devez faire dans les 48h après un refus",
        body: "Réagir rapidement et méthodiquement après un refus vous mettra dans la meilleure position pour une nouvelle demande :",
        list: [
          "Conservez le formulaire de refus (slip rose ou blanc) — il indique le motif légal",
          "Notez par écrit toutes les questions qui vous ont été posées et vos réponses",
          "Ne représentez PAS votre demande immédiatement — analysez d'abord les faiblesses",
          "Évaluez honnêtement quelles attaches supplémentaires vous pouvez documenter",
          "Consultez un expert pour analyser votre dossier avant de repayer les frais de visa",
        ],
      },
      {
        heading: "Comment renforcer votre dossier pour la prochaine demande",
        body:
          "Le refus est une information précieuse sur ce qui manque. Voici les améliorations les plus efficaces :",
        list: [
          "Ouvrir un compte épargne et y alimenter régulièrement pendant 3 à 6 mois avant de redéposer",
          "Négocier une promotion ou une augmentation pour renforcer votre profil professionnel",
          "Acheter un bien immobilier ou obtenir un bail de longue durée en votre nom",
          "Obtenir une lettre de soutien détaillée de votre employeur avec engagement de maintien du poste",
          "Construire un historique de voyages régionaux (CEDEAO, Afrique australe) pour montrer que vous rentrez toujours",
          "Si le voyage a un motif médical ou académique en Europe, obtenir d'abord un visa Schengen peut renforcer votre profil",
        ],
      },
      {
        heading: "Quand et comment représenter sa demande",
        body:
          "Il n'existe pas de délai d'attente légal entre deux demandes, mais une représentation trop rapide sans changement de situation a très peu de chances de succès :",
        list: [
          "Attendez au minimum 3 à 6 mois pour que des changements significatifs soient documentables",
          "Rédigez un nouveau DS-160 entièrement — ne réutilisez pas l'ancien",
          "Dans la section « Have you ever been refused a US visa? » du DS-160, répondez « Yes » et expliquez brièvement",
          "Ne mentez jamais sur un refus précédent — cela constitue une fraude et entraîne une interdiction permanente",
          "Joventy propose un audit de dossier complet avant la représentation pour identifier les points de blocage",
        ],
      },
    ],
    faq: [
      {
        q: "Un refus visa USA est-il permanent ?",
        a: "Non. Un refus 214(b) n'est pas permanent. Vous pouvez représenter votre demande autant de fois que vous le souhaitez. Chaque nouvelle demande est évaluée indépendamment. Seule une fraude documentaire avérée ou une interdiction formelle peut entraîner un refus permanent.",
      },
      {
        q: "Faut-il repayer les frais de visa de 185 USD pour chaque nouvelle demande ?",
        a: "Oui, les frais de visa sont non remboursables et doivent être payés pour chaque nouvelle demande, quel que soit le résultat. En cas de refus sous 214(b), vous devrez payer à nouveau avant de prendre un nouveau rendez-vous sur usvisaappt.com.",
      },
      {
        q: "Mon enfant ou mon conjoint aux USA nuira-t-il à ma demande ?",
        a: "Pas nécessairement, mais c'est un facteur de risque. Les consulats évaluent l'ensemble du dossier. Si vous avez un enfant ou un conjoint aux USA, vous devez compenser ce risque perçu par des preuves très solides de vos attaches en RDC (emploi stable, propriétés, autres enfants/famille ici).",
      },
    ],
    relatedSlugs: [
      "visa-angleterre-kinshasa-rdv-2026",
      "entretien-visa-usa-b1-b2-questions",
      "documents-visa-schengen-kinshasa",
    ],
    relatedDestination: "visa-usa-kinshasa",
  },

  {
    slug: "payer-frais-mrv-visa-usa-kinshasa",
    title: "Comment payer les frais MRV visa USA depuis Kinshasa en 2026 — Étapes exactes sur usvisaappt.com",
    metaTitle: "Payer Frais MRV Visa USA depuis Kinshasa 2026 — Montants exacts + étapes | Joventy",
    metaDescription:
      "Comment payer les frais MRV visa USA depuis la RDC en 2026 : montants exacts (185$–210$ selon le type), méthodes de paiement disponibles à Kinshasa, guide étape par étape sur usvisaappt.com.",
    publishedDate: "2025-05-25",
    updatedDate: "2026-05-31",
    readingTime: 5,
    category: "Visa USA",
    coverEmoji: "💳",
    intro:
      "Payer les frais de visa américain est la première étape concrète d'une demande de visa USA. Ces frais varient de 185 à 210 USD selon le type de visa en 2026 et doivent être payés via des canaux spécifiques agréés. Ce guide vous explique les méthodes disponibles depuis Kinshasa, les pièges à éviter, et comment vérifier que votre paiement est bien enregistré sur usvisaappt.com.",
    sections: [
      {
        heading: "Qu'est-ce que les frais de visa américain ?",
        body:
          "Les frais de visa américain (anciennement appelés MRV — Machine Readable Visa) sont des frais non remboursables exigés par le gouvernement américain pour traiter toute demande de visa non-immigrant. En 2026 :",
        list: [
          "Montant B1/B2 (tourisme & affaires) : 185 USD",
          "Montant F1, J1, M1 (étudiant, échange, formation) : 200 USD",
          "Visas de travail (H, L, O, P) : 205 à 210 USD — vérifiez sur usvisaappt.com",
          "Les frais sont valables 12 mois — si vous ne prenez pas de rendez-vous dans ce délai, ils expirent",
          "Un refus ne donne pas droit au remboursement",
        ],
      },
      {
        heading: "Les canaux de paiement officiels depuis la RDC",
        body: "L'ambassade américaine a désigné des banques partenaires pour collecter les frais de visa. Depuis Kinshasa :",
        list: [
          "Rawbank (agences Kinshasa) : paiement en USD au guichet avec votre code de référence usvisaappt.com",
          "Equity Bank RDC : paiement disponible dans les principales agences de Kinshasa",
          "TMB (Trust Merchant Bank) : paiement au guichet sur présentation de votre référence de dossier",
          "Paiement en ligne via usvisaappt.com avec carte Visa/Mastercard internationale",
        ],
      },
      {
        heading: "Procédure étape par étape",
        body: "Voici comment procéder pour payer correctement et éviter les erreurs :",
        list: [
          "1. Créez d'abord votre compte sur usvisaappt.com — c'est de là que vous obtenez votre référence de paiement unique",
          "2. Notez votre référence de paiement (code alphanumérique unique à votre dossier)",
          "3. Rendez-vous à la banque partenaire avec cette référence, votre pièce d'identité, et le montant en USD",
          "4. Conservez précieusement votre reçu de paiement (RECEIPT NUMBER) — vous en aurez besoin pour le DS-160 et usvisaappt.com",
          "5. Attendez 24 à 48 heures que le paiement apparaisse sur votre profil usvisaappt.com avant de tenter de prendre un rendez-vous",
        ],
      },
      {
        heading: "Erreurs fréquentes et comment les éviter",
        body: "Ces erreurs peuvent bloquer votre dossier ou vous faire perdre vos frais :",
        list: [
          "Payer sans avoir créé son compte usvisaappt.com d'abord — le paiement ne peut pas être lié à votre dossier",
          "Utiliser un intermédiaire non officiel pour le paiement — risque d'arnaque",
          "Confondre les frais de visa avec les frais SEVIS (uniquement pour les visas étudiants F/J)",
          "Ne pas conserver le reçu — sans le RECEIPT NUMBER, vous ne pouvez pas prendre de rendez-vous",
          "Payer en CDF sans vérifier le taux de change officiel du jour — vérifiez le montant exact en CDF à la banque",
        ],
      },
      {
        heading: "Vérifier que le paiement est bien enregistré",
        body: "Avant de passer à l'étape suivante, confirmez que tout est en ordre :",
        list: [
          "Connectez-vous sur usvisaappt.com 24 à 48h après le paiement",
          "Dans la section « Payment », votre statut doit passer de « Pending » à « Confirmed »",
          "Si après 72h le paiement n'apparaît pas, contactez le support usvisaappt.com avec votre reçu bancaire",
          "L'équipe Joventy vérifie le statut de paiement pour ses clients et les alerte en cas de problème",
        ],
      },
    ],
    faq: [
      {
        q: "Combien coûtent les frais de visa B1/B2 USA depuis la RDC en 2026 ?",
        a: "En 2026, les frais de visa pour un B1/B2 (tourisme et affaires) sont de 185 USD. Pour les visas étudiants (F1, J1), comptez 200 USD, et pour les visas de travail (H, L, O, P), 205 à 210 USD. Ces montants sont non remboursables et valables 12 mois à partir de la date de paiement pour prendre un rendez-vous sur usvisaappt.com.",
      },
      {
        q: "Peut-on payer les frais de visa USA via M-Pesa ou Airtel Money ?",
        a: "Non. Les frais de visa américain ne peuvent pas être payés via Mobile Money (M-Pesa, Airtel Money, Orange Money) en RDC. Les seuls canaux acceptés sont les banques partenaires agréées (Rawbank, Equity Bank, TMB) et le paiement en ligne par carte internationale sur usvisaappt.com.",
      },
      {
        q: "Les frais de visa sont-ils remboursables en cas de refus ?",
        a: "Non. Les frais de visa sont non remboursables dans tous les cas — refus de visa, annulation de rendez-vous, ou changement de plans. Ils expirent si vous ne prenez pas de rendez-vous dans les 12 mois suivant le paiement.",
      },
    ],
    relatedSlugs: [
      "comment-obtenir-creneau-visa-usa-kinshasa",
      "entretien-visa-usa-b1-b2-questions",
      "visa-usa-refuse-que-faire",
    ],
    relatedDestination: "visa-usa-kinshasa",
  },

  {
    slug: "delais-visa-usa-canada-schengen-kinshasa-2025",
    title: "Délais réels visa USA, Canada et Schengen depuis Kinshasa en 2026 — Semaines d'attente par destination",
    metaTitle: "Délais Visa USA, Canada, Schengen depuis Kinshasa 2026 — Temps d'attente réels | Joventy",
    metaDescription:
      "Combien de semaines pour un visa USA, Canada ou Schengen depuis Kinshasa en 2026 ? Délais réels constatés par type de visa, périodes à éviter, et comment réduire l'attente de plusieurs semaines.",
    publishedDate: "2025-06-01",
    updatedDate: "2026-05-31",
    readingTime: 6,
    category: "Comparatif",
    coverEmoji: "⏱️",
    intro:
      "Le délai entre la décision de voyager et l'obtention du visa peut varier de 2 semaines à 6 mois selon la destination, la saison et votre profil. En 2026, la situation est marquée par la suspension temporaire des visas canadiens pour les résidents RDC (Ebola, mai-août 2026), le Travel Advisory Level 4 de l'ambassade US à Kinshasa, et la mise en place du système EES aux frontières Schengen. Ce guide compile les délais réels constatés par l'équipe Joventy sur les principales destinations depuis Kinshasa.",
    sections: [
      {
        heading: "Visa USA (B1/B2) — délai total estimé",
        body:
          "Le délai total pour un visa américain comprend deux phases : la préparation du dossier et l'attente d'un créneau consulaire.",
        list: [
          "Préparation du dossier (DS-160, paiement frais, documents) : 3 à 7 jours",
          "Attente d'un créneau d'entretien sur usvisaappt.com : 4 à 16 semaines (très variable selon la saison)",
          "Délai de traitement post-entretien : 5 à 10 jours ouvrables pour la plupart des dossiers",
          "Total estimé : 6 à 20 semaines depuis le début des démarches",
          "Avec Joventy (suivi rapproché du portail usvisaappt.com) : créneau obtenu en 48 à 96h dans la majorité des cas",
          "Périodes les plus chargées : juin-août (saison estivale), novembre-janvier (fêtes de fin d'année)",
        ],
      },
      {
        heading: "Visa Canada (visiteur, étudiant) — délai total estimé",
        body:
          "Le Canada traite les visas en ligne depuis Kinshasa via IRCC (canada.ca). Pas d'entretien physique dans la plupart des cas. ⚠️ ALERTE : depuis le 27 mai 2026, le Canada a suspendu tous les documents d'immigration pour les résidents de la RDC (mesure Ebola, jusqu'au 28 août 2026 minimum).",
        list: [
          "⚠️ SUSPENSION EN COURS : Du 27 mai au 28 août 2026, aucune demande de visa canadien ne peut être traitée pour les résidents RDC",
          "Mesure liée à l'épidémie d'Ebola en Ituri — isolation obligatoire de 21 jours pour tout voyageur quittant la RDC",
          "Préparation et soumission du dossier en ligne (hors période de suspension) : 5 à 10 jours",
          "Traitement IRCC : 4 à 12 semaines selon la saison et la complexité du dossier",
          "Biométrie : à déposer en personne après l'invitation IRCC — prévoir 1 à 2 semaines supplémentaires",
          "Total estimé (hors suspension) : 6 à 14 semaines depuis la soumission",
          "Conseil : attendez la levée de la suspension avant de payer les frais IRCC",
        ],
      },
      {
        heading: "Visa Schengen — délai total estimé",
        body:
          "Les demandes Schengen se déposent au Centre de Visas Européens (CEV) à Kinshasa. Le délai de traitement est réglementé à 15 jours ouvrables maximum. Depuis avril 2026, le système EES (Entry/Exit System) est actif aux frontières — les tampons de passeport sont supprimés et remplacés par un scan biométrique.",
        list: [
          "Prise de rendez-vous CEV : 1 à 4 semaines d'attente",
          "Frais consulaires : 90 €/adulte, 45 €/enfant 6-12 ans (hausse de 80 € à 90 € en 2026)",
          "Délai de traitement légal : 15 jours ouvrables (peut aller jusqu'à 30 en période chargée)",
          "Total estimé : 4 à 8 semaines depuis la décision de voyager",
          "Nouveau en 2026 : le visa Schengen devient progressivement digital (code-barre 2D à la place du sticker)",
          "Certains pays (France, Italie) acceptent déjà les demandes en ligne — biométrie toujours en personne",
          "Conseil : déposez votre demande 6 semaines avant la date de voyage",
        ],
      },
      {
        heading: "Tableau comparatif 2026",
        body:
          "Résumé des délais moyens constatés par l'équipe Joventy sur les dossiers traités depuis Kinshasa :",
        list: [
          "🇺🇸 Visa USA B1/B2 : 8 à 16 semaines (avec Joventy : 3 à 5 semaines grâce au suivi rapproché du portail). Travel Advisory Level 4 en cours.",
          "🇨🇦 Visa Canada visiteur : ⚠️ SUSPENDU pour les résidents RDC du 27 mai au 28 août 2026 (mesure Ebola)",
          "🇪🇺 Visa Schengen : 4 à 8 semaines — frais passés à 90 €/adulte, système EES biométrique actif aux frontières",
          "🇬🇧 Visa Royaume-Uni : 5 à 10 semaines",
          "🇦🇪 E-Visa Dubaï : 3 à 5 jours ouvrables",
          "🇹🇷 Visa Turquie (e-Visa) : 24 à 72 heures",
          "🇮🇳 E-Visa Inde : 3 à 5 jours ouvrables",
          "🇨🇭 Visa Suisse : 4 à 8 semaines (similaire Schengen)",
        ],
      },
      {
        heading: "Comment réduire les délais",
        body: "Quelques stratégies concrètes pour gagner du temps sur l'ensemble du processus :",
        list: [
          "Préparez tous vos documents AVANT de prendre votre rendez-vous pour ne pas perdre un créneau obtenu rapidement",
          "Confiez la veille du portail usvisaappt.com à l'équipe Joventy — ils assurent un suivi régulier et prennent en charge la réservation dès qu'une date est disponible",
          "Pour le Schengen, déposez dès que la fenêtre de 6 mois s'ouvre (les consulats acceptent les dossiers jusqu'à 6 mois avant le voyage)",
          "Pour le Canada, soumettez votre demande en ligne dès que possible — les délais IRCC varient considérablement",
          "Les e-Visas (Dubaï, Inde, Turquie) ne nécessitent aucun rendez-vous et peuvent s'obtenir en 24 à 72h",
        ],
      },
    ],
    faq: [
      {
        q: "Quel visa est le plus rapide à obtenir depuis Kinshasa en 2025 ?",
        a: "Les e-Visas sont de loin les plus rapides : Turquie (24-72h), Dubaï et Inde (3-5 jours ouvrables). Le visa Schengen est le plus rapide parmi les ambassades physiques (4-8 semaines). Le visa USA est le plus long à cause des délais de créneaux consulaires sur usvisaappt.com.",
      },
      {
        q: "Peut-on accélérer le traitement d'un visa USA ou Canada ?",
        a: "Il n'existe pas de service officiel d'urgence pour les visas USA et Canada. L'ambassade américaine accepte cependant des demandes de rendez-vous d'urgence dans des cas humanitaires avérés (décès d'un proche, urgence médicale documentée). Pour le Canada, les délais sont gérés par IRCC et ne peuvent pas être accélérés manuellement.",
      },
      {
        q: "Les délais sont-ils différents pour les étudiants et les travailleurs ?",
        a: "Pour les États-Unis, les visas étudiants F1 et les visas de travail H-1B ont souvent des délais différents des visas B1/B2. Pour le Canada, les permis d'études et de travail suivent des processus distincts. Consultez Joventy pour une estimation personnalisée selon votre type de visa.",
      },
    ],
    relatedSlugs: [
      "comment-obtenir-creneau-visa-usa-kinshasa",
      "documents-visa-schengen-kinshasa",
      "payer-frais-mrv-visa-usa-kinshasa",
    ],
    relatedDestination: "visa-schengen-kinshasa",
  },

  {
    slug: "suspension-visa-canada-rdc-ebola-2026",
    title: "Suspension visa Canada pour la RDC (Ebola 2026) : que faire ?",
    metaTitle: "Suspension Visa Canada RDC Ebola 2026 — Alternatives | Joventy",
    metaDescription: "Le Canada a suspendu tous les visas pour les résidents RDC du 27 mai au 28 août 2026 (Ebola). Découvrez vos options, les alternatives et comment préparer la reprise.",
    publishedDate: "2026-05-29",
    updatedDate: "2026-05-31",
    readingTime: 6,
    category: "Visa Canada",
    coverEmoji: "🚨",
    intro: "Depuis le 27 mai 2026, le gouvernement canadien a suspendu tous les documents d'immigration pour les résidents de la RDC, de l'Ouganda et du Sud-Soudan, en réponse à l'épidémie d'Ebola (souche Bundibugyo) en province de l'Ituri. Cette suspension court jusqu'au 28 août 2026 minimum et affecte plus de 24 000 dossiers. Ce guide explique ce que cela signifie concrètement, quelles sont vos options, et comment préparer la reprise.",
    sections: [
      { heading: "Ce qui est suspendu exactement", body: "Le Canada a mis en pause le traitement de la quasi-totalité des demandes d'immigration pour les résidents RDC :", list: ["Visas visiteurs (tourisme, affaires)", "Permis d'études (Study Permit)", "Permis de travail (Work Permit)", "Visas déjà approuvés mais non utilisés — leur validité est suspendue", "Invitations à la biométrie — reportées", "Super Visa et regroupement familial — également touchés"] },
      { heading: "Mesures sanitaires associées", body: "En plus de la suspension des visas, le Canada impose des mesures sanitaires strictes :", list: ["Isolation obligatoire de 21 jours pour tout voyageur ayant quitté la RDC (même via un pays tiers)", "Surveillance active par l'Agence de la santé publique du Canada (PHAC)", "Les Congolais résidant à l'étranger depuis plus de 21 jours ne sont PAS concernés par la suspension", "L'équipe nationale de football RDC (Léopards) a été autorisée pour la Coupe du Monde après 21 jours en Europe"] },
      { heading: "Ce que vous pouvez faire maintenant", body: "Même si la suspension est en cours, voici les actions productives à prendre :", list: ["Ne payez PAS les frais IRCC tant que la suspension est active — attendez la levée", "Rassemblez et préparez tous vos documents pour être prêt dès la reprise", "Si vous avez déjà payé : vos frais et votre dossier restent valides — IRCC reprendra le traitement à la levée", "Envisagez des destinations alternatives (Dubaï, Turquie, Schengen) si votre voyage est urgent", "Si vous résidez hors RDC depuis plus de 21 jours, vous pouvez potentiellement déposer depuis votre pays de résidence"] },
      { heading: "Restrictions similaires aux USA et au Mexique", body: "La RDC est concernée par des restrictions dans les 3 pays hôtes de la Coupe du Monde 2026 :", list: ["🇺🇸 USA : interdiction d'entrée pour tout non-citoyen ayant été en RDC dans les 21 jours précédents (ordre CDC, 18 mai 2026)", "🇲🇽 Mexique : restriction d'entrée par avion pour toute personne ayant séjourné en RDC dans les 21 derniers jours (60 jours, Aeromexico/Volaris/Viva)", "🇨🇦 Canada : suspension totale des visas + quarantaine 21 jours (27 mai — 28 août 2026)", "La règle commune : il faut avoir quitté la RDC depuis au moins 21 jours pour entrer dans ces 3 pays", "Les citoyens américains peuvent rentrer chez eux mais subissent un screening sanitaire", "Les détenteurs de Green Card américaine sont aussi interdits d'entrée (extension CDC du 22 mai 2026)"] },
      { heading: "Alternatives de voyage sans restriction", body: "Si votre voyage ne peut pas attendre et que vous ne pouvez pas faire les 21 jours de transit :", list: ["🇦🇪 Dubaï (e-Visa) : 48 à 72h, aucune restriction liée à Ebola pour les Congolais", "🇹🇷 Turquie (e-Visa) : 24-48h pour détenteurs de visa USA/Schengen/UK, pas de restriction d'entrée", "🇪🇺 Schengen : dossier et créneau CEV toujours ouverts (pas de restriction d'entrée pour les Congolais, mais EES biométrique à l'arrivée)", "🇬🇧 Royaume-Uni : demandes UKVI toujours acceptées, pas de restriction Ebola", "Ces destinations peuvent aussi servir de transit de 21 jours avant d'aller aux USA/Canada/Mexique"] },
      { heading: "Comment se préparer pour la reprise (août 2026+)", body: "Dès la levée de la suspension, il y aura un afflux massif de demandes. Soyez prêt :", list: ["Préparez votre dossier IRCC complet MAINTENANT (formulaires, documents, photos)", "Ouvrez un compte sur le portail IRCC si ce n'est pas fait", "Accumulez vos preuves financières (3 à 6 mois de relevés bancaires frais)", "Contactez Joventy pour un audit de dossier gratuit — soyez parmi les premiers à soumettre à la reprise", "Surveillez les annonces IRCC : la date de levée peut être avancée ou repoussée selon l'évolution de l'épidémie"] },
    ],
    faq: [
      { q: "Ma demande de visa Canada déjà soumise est-elle annulée ?", a: "Non. Les demandes déjà en cours ne sont pas annulées mais mises en pause. IRCC reprendra le traitement dès la levée de la suspension. Vos frais payés restent valides." },
      { q: "Je suis Congolais mais je réside en Europe depuis 2 ans. Suis-je concerné ?", a: "Si vous résidez hors de la RDC depuis plus de 21 jours et que vous déposez depuis votre pays de résidence (France, Belgique, etc.), vous n'êtes normalement pas concerné par la suspension. Vérifiez auprès du bureau IRCC de votre pays de résidence." },
      { q: "Peut-on quand même voyager au Canada avec un visa déjà obtenu ?", a: "Non. Même les visas déjà approuvés sont suspendus pendant la période. Si vous vous présentez à la frontière canadienne, vous serez soumis à 21 jours d'isolation obligatoire et votre entrée pourrait être refusée." },
      { q: "Quand la suspension sera-t-elle levée ?", a: "La date officielle est le 28 août 2026, mais elle peut être prolongée si l'épidémie n'est pas maîtrisée, ou raccourcie si la situation s'améliore. Joventy suit les annonces IRCC et vous notifie immédiatement." },
    ],
    relatedSlugs: ["delais-visa-usa-canada-schengen-kinshasa-2025", "comment-obtenir-creneau-visa-usa-kinshasa", "documents-visa-schengen-kinshasa"],
    relatedDestination: "visa-canada-kinshasa",
  },

  {
    slug: "coupe-du-monde-2026-visa-usa-kinshasa",
    title: "Coupe du Monde 2026 : comment obtenir un visa USA depuis Kinshasa pour supporter les Léopards",
    metaTitle: "Visa USA Coupe du Monde 2026 Kinshasa — Guide Supporters RDC | Joventy",
    metaDescription: "La RDC est qualifiée pour la Coupe du Monde 2026 aux USA. Guide complet pour obtenir votre visa B1/B2 depuis Kinshasa et supporter les Léopards malgré le Travel Advisory Level 4.",
    publishedDate: "2026-05-29",
    updatedDate: "2026-05-31",
    readingTime: 8,
    category: "Visa USA",
    coverEmoji: "⚽",
    intro: "La RDC est qualifiée pour la Coupe du Monde FIFA 2026 aux États-Unis ! Les Léopards vont fouler les pelouses américaines cet été, et des milliers de supporters congolais veulent y assister. Mais obtenir un visa B1/B2 depuis Kinshasa dans le contexte actuel (Travel Advisory Level 4, épidémie d'Ebola) présente des défis particuliers. Ce guide vous explique comment maximiser vos chances d'obtenir votre visa à temps.",
    sections: [
      { heading: "La RDC qualifiée : ce que cela change pour les visas", body: "La qualification de la RDC est une opportunité unique mais le timing est serré :", list: ["Les matchs de la Coupe du Monde 2026 se jouent de juin à juillet 2026 aux USA, Canada et Mexique", "⚠️ INTERDICTION D'ENTRÉE : les USA, le Canada ET le Mexique interdisent l'entrée aux personnes ayant séjourné en RDC dans les 21 jours précédents (Ebola)", "L'équipe nationale a dû annuler son camp à Kinshasa et passer 21 jours en Europe avant d'entrer aux USA", "Les supporters DOIVENT obligatoirement quitter la RDC au moins 21 jours avant leur vol vers les USA/Canada/Mexique", "Le gouvernement US a levé les visa bonds ($15 000) pour les détenteurs de billets FIFA officiels", "Les entretiens visa continuent à l'ambassade US de Kinshasa malgré le Travel Advisory Level 4"] },
      { heading: "Les conditions spéciales FIFA World Cup", body: "Le Département d'État américain a mis en place des dispositions pour les supporters :", list: ["Exemption de visa bond pour les détenteurs d'un FIFA Pass ou billet officiel", "Les consulats sont invités à traiter les demandes World Cup en priorité — mentionnez-le dans votre DS-160", "Un visa B1/B2 standard suffit — pas de visa spécial requis", "La durée de séjour demandée doit correspondre aux dates de matchs de la RDC", "Apportez votre preuve d'achat de billet FIFA à l'entretien consulaire"] },
      { heading: "Comment préparer votre dossier visa USA World Cup", body: "Votre dossier doit être irréprochable vu le contexte Level 4 :", list: ["Remplissez le DS-160 en mentionnant explicitement « FIFA World Cup 2026 — supporter » comme motif", "Préparez une preuve d'achat de billets FIFA (confirmation email ou FIFA Pass)", "Réservez un hébergement dans la ville du match de la RDC", "Préparez un itinéraire précis : date d'arrivée, match(s), date de retour", "Documents financiers solides — montrez que vous pouvez financer le séjour ET que vous rentrerez", "Preuve de liens avec la RDC : emploi, famille, propriété"] },
      { heading: "Le défi sanitaire : la règle des 21 jours (obligatoire)", body: "C'est le point le plus critique — sans respecter cette règle, vous serez refoulé à l'arrivée :", list: ["Les USA interdisent l'entrée à tout non-citoyen américain ayant été en RDC dans les 21 jours précédents (ordre CDC du 18 mai 2026)", "Le Canada a suspendu tous les visas + quarantaine 21 jours obligatoire", "Le Mexique restreint l'entrée par avion pour les voyageurs ayant séjourné en RDC dans les 21 derniers jours", "Solution OBLIGATOIRE : quitter la RDC au moins 21 jours AVANT votre vol vers les USA/Canada/Mexique", "Passez ces 21 jours en Europe (Schengen), Dubaï, Turquie, ou un autre pays tiers non-concerné", "C'est exactement ce que l'équipe nationale a fait : départ de Kinshasa le 20 mai, 21 jours en Europe, puis USA", "Joventy peut organiser un itinéraire combiné : Kinshasa → Transit 21j → USA (World Cup)"] },
      { heading: "Combien ça coûte au total ?", body: "Budget estimé pour un supporter congolais :", list: ["Frais de visa USA (B1/B2) : 185 USD", "Frais Joventy (engagement + prime de succès) : 250 + 750 USD", "Billet FIFA (catégorie 4, la moins chère) : à partir de 60 USD par match", "Vol Kinshasa → USA (via Europe) : 1 500 à 3 000 USD", "Hébergement USA (2 semaines) : 800 à 2 000 USD", "Séjour intermédiaire 21 jours (si nécessaire) : 500 à 1 500 USD", "Total estimé : 3 500 à 8 000 USD selon les options"] },
    ],
    faq: [
      { q: "Peut-on obtenir un visa USA depuis Kinshasa malgré le Travel Advisory Level 4 ?", a: "Oui, vous pouvez obtenir le visa. L'ambassade continue les entretiens. MAIS même avec un visa valide, vous ne pouvez pas entrer aux USA si vous étiez en RDC dans les 21 jours précédents. Il faut obligatoirement transiter 21 jours dans un pays tiers." },
      { q: "Les détenteurs de billets FIFA ont-ils un traitement prioritaire ?", a: "Les consulats américains sont invités à faciliter le traitement des demandes liées à la Coupe du Monde. Mentionnez explicitement le motif FIFA dans votre DS-160 et apportez votre preuve de billet à l'entretien. La visa bond de $15 000 est levée pour les détenteurs de billets officiels." },
      { q: "Dois-je quitter la RDC 21 jours avant pour entrer aux USA ?", a: "Oui, c'est OBLIGATOIRE. L'ordre du CDC du 18 mai 2026 interdit l'entrée aux non-citoyens américains ayant été en RDC dans les 21 jours précédents. C'est valable aussi pour le Canada et le Mexique (les 3 pays hôtes). L'équipe nationale a dû faire exactement cela." },
      { q: "Puis-je aller voir un match au Mexique si je ne peux pas entrer aux USA ?", a: "Le Mexique applique aussi une restriction : l'entrée par avion est interdite aux personnes ayant séjourné en RDC dans les 21 derniers jours. La même règle des 21 jours de transit s'applique pour les 3 pays (USA, Canada, Mexique)." },
    ],
    relatedSlugs: ["comment-obtenir-creneau-visa-usa-kinshasa", "entretien-visa-usa-b1-b2-questions", "travel-advisory-level-4-rdc-visa-usa-2026"],
    relatedDestination: "visa-usa-kinshasa",
  },

  {
    slug: "ees-schengen-2026-controle-biometrique",
    title: "EES Schengen 2026 : empreintes et scan facial obligatoires aux frontières — ce que ça change pour les Congolais",
    metaTitle: "EES Schengen 2026 — Empreintes, Scan Facial & Fin des Tampons : ce que ça change | Joventy",
    metaDescription: "L'EES (Entry/Exit System) est actif depuis avril 2026 aux frontières Schengen : empreintes digitales, reconnaissance faciale, fin des tampons passeport. Ce que les voyageurs congolais doivent savoir avant de partir.",
    publishedDate: "2026-05-29",
    updatedDate: "2026-05-31",
    readingTime: 5,
    category: "Visa Schengen",
    coverEmoji: "🔐",
    intro: "Depuis le 10 avril 2026, le système EES (Entry/Exit System) est pleinement opérationnel à toutes les frontières extérieures de l'espace Schengen. Fini les tampons de passeport — désormais, chaque voyageur non-européen est enregistré biométriquement (empreintes digitales et photo faciale) à l'entrée et à la sortie. Ce guide explique ce que cela change concrètement pour les voyageurs congolais.",
    sections: [
      { heading: "Qu'est-ce que l'EES ?", body: "L'Entry/Exit System est un système informatique européen qui enregistre les entrées et sorties de tous les ressortissants de pays tiers (non-UE) :", list: ["Remplace les tampons de passeport par un enregistrement numérique", "Collecte les empreintes digitales (4 doigts) et une image faciale à la première entrée", "Les passages suivants nécessitent une vérification biométrique simplifiée", "Les données sont conservées 3 ans", "Opérationnel dans les 29 pays du système Schengen depuis le 10 avril 2026", "Plus de 66 millions de passages enregistrés dans les 6 premières semaines"] },
      { heading: "Ce qui change pour les voyageurs congolais", body: "L'impact principal est sur le temps de passage aux frontières :", list: ["Premier passage : prévoir 5 à 15 minutes supplémentaires pour l'enregistrement biométrique complet", "Passages suivants : scan rapide d'empreintes (1-2 minutes)", "Le système calcule automatiquement vos 90 jours sur 180 — impossible de dépasser sans être détecté", "Plus besoin de compter vos jours manuellement : le système le fait pour vous", "Si vous dépassez vos 90 jours, vous serez signalé automatiquement à la sortie", "Les e-gates (portiques automatiques) se multiplient dans les aéroports — mais pas encore pour les détenteurs de passeport congolais"] },
      { heading: "Ce qui ne change PAS", body: "Rassurez-vous, beaucoup reste identique :", list: ["Le processus de demande de visa Schengen est inchangé", "Les documents requis sont les mêmes", "Les frais restent à 90 €/adulte", "La durée maximale de 90 jours sur 180 est inchangée", "Votre visa sticker reste valable (jusqu'à la transition vers le visa digital)", "Le CEV de Kinshasa fonctionne normalement"] },
      { heading: "Conseils pratiques pour votre prochain voyage Schengen", body: "Pour que votre passage aux frontières se passe bien avec l'EES :", list: ["Arrivez plus tôt à l'aéroport — surtout si c'est votre première entrée Schengen avec l'EES", "Gardez votre passeport en bon état : les lecteurs biométriques sont sensibles", "Ne vous inquiétez pas si la file est plus longue que d'habitude — c'est normal pendant la phase d'adaptation", "Conservez votre itinéraire de voyage — en cas de contrôle, le système peut vérifier votre historique", "Si vous avez un doute sur vos jours restants, demandez à l'agent frontalier — le système affiche le décompte"] },
    ],
    faq: [
      { q: "Dois-je faire quelque chose de spécial avant mon voyage à cause de l'EES ?", a: "Non. L'EES est géré directement à la frontière. Vous n'avez rien à faire en amont. Prévoyez simplement plus de temps à l'arrivée (surtout si c'est votre première entrée sous le nouveau système)." },
      { q: "Mes empreintes seront-elles prises à chaque entrée dans l'espace Schengen ?", a: "Complètement lors de la première entrée (4 doigts + photo faciale). Pour les entrées suivantes dans les 3 ans, une vérification simplifiée suffit." },
      { q: "Que se passe-t-il si je dépasse mes 90 jours ?", a: "Le système EES vous signale automatiquement. Vous risquez une interdiction d'entrée future, une amende, et un refus de visa lors de votre prochaine demande. Ne dépassez jamais vos 90 jours." },
    ],
    relatedSlugs: ["documents-visa-schengen-kinshasa", "visa-schengen-digital-2026", "delais-visa-usa-canada-schengen-kinshasa-2025"],
    relatedDestination: "visa-schengen-kinshasa",
  },

  {
    slug: "visa-schengen-digital-2026",
    title: "Visa Schengen digital 2026 : la fin du sticker visa approche",
    metaTitle: "Visa Schengen Digital 2026 — Fin du Sticker, Code-Barre 2D | Joventy",
    metaDescription: "L'UE remplace progressivement le sticker visa par un code-barre 2D digital. France et Italie acceptent déjà les demandes en ligne. Ce que cela change pour les Congolais.",
    publishedDate: "2026-05-29",
    updatedDate: "2026-05-31",
    readingTime: 5,
    category: "Visa Schengen",
    coverEmoji: "📱",
    intro: "L'Union Européenne est en train de révolutionner son système de visa. En avril 2026, la Commission européenne a adopté les actes juridiques qui remplaceront le sticker visa physique par un code-barre 2D sécurisé, vérifiable en ligne. La France et l'Italie acceptent déjà des demandes entièrement en ligne (sauf la biométrie). Ce guide explique la transition en cours et ce que cela signifie pour les voyageurs depuis Kinshasa.",
    sections: [
      { heading: "Que change le visa digital ?", body: "Le visa Schengen tel qu'on le connaît (sticker collé dans le passeport) va progressivement disparaître :", list: ["Le sticker physique sera remplacé par un code-barre 2D cryptographiquement sécurisé", "Le visa sera stocké dans une base de données centralisée (EU VAP — Visa Application Platform)", "Plus de risque de falsification ou de vol de sticker", "Vérification instantanée par scan à la frontière", "Transition complète prévue d'ici 2028-2031", "Les visas sticker actuels restent valables pendant la période de transition"] },
      { heading: "La plateforme EU VAP (Visa Application Platform)", body: "L'UE développe une plateforme unique de demande de visa en ligne gérée par eu-LISA :", list: ["Objectif : remplacer les portails nationaux séparés par une interface unique", "Upload de documents en ligne avant le rendez-vous", "Paiement des frais en ligne", "Suivi du dossier en temps réel", "La France, l'Italie et l'Estonie acceptent déjà les soumissions en ligne", "La biométrie reste obligatoire en personne (VFS, TLS ou consulat) pour les premiers demandeurs"] },
      { heading: "Ce que cela change pour les demandeurs depuis Kinshasa", body: "À court terme (2026), l'impact est encore limité mais positif :", list: ["Le CEV de Kinshasa continue de fonctionner normalement", "Vous pouvez déjà uploader certains documents en ligne avant votre rendez-vous (via VFS Global / TLScontact)", "Le formulaire papier cède progressivement la place au formulaire en ligne", "La biométrie reste en personne — pas de changement sur ce point", "À moyen terme (2027-2028) : vous pourrez potentiellement faire toute votre demande en ligne depuis Kinshasa", "Joventy anticipe cette transition et prépare déjà les dossiers au format digital"] },
      { heading: "Calendrier de la transition", body: "Voici les étapes clés de la digitalisation du visa Schengen :", list: ["Octobre 2025 : lancement du système EES (phase pilote)", "Avril 2026 : EES pleinement opérationnel aux 29 frontières", "Avril 2026 : adoption des actes juridiques pour le visa digital", "Juin 2026 : l'Italie lance son portail de visa entièrement digital", "Q4 2026 : lancement de ETIAS pour les voyageurs exemptés de visa (ne concerne pas les Congolais)", "2027-2028 : déploiement progressif du code-barre 2D remplaçant le sticker", "2031 : date limite pour la transition complète dans tous les consulats"] },
    ],
    faq: [
      { q: "Mon visa sticker actuel est-il encore valable ?", a: "Oui, absolument. Tous les visas sticker délivrés restent valables jusqu'à leur date d'expiration. La transition vers le digital sera progressive et les deux systèmes coexisteront pendant plusieurs années." },
      { q: "Dois-je faire ma demande de visa en ligne maintenant ?", a: "Pas obligatoirement. Le CEV de Kinshasa accepte toujours les dossiers physiques. Cependant, certains consulats (France, Italie) offrent déjà la possibilité d'uploader des documents en ligne pour gagner du temps au rendez-vous." },
      { q: "La biométrie sera-t-elle toujours nécessaire ?", a: "Oui pour les premiers demandeurs. Si vos empreintes ont déjà été collectées dans les 59 derniers mois, vous n'aurez pas besoin de les refaire — ce qui ouvre la voie à une demande 100% en ligne pour les renouvellements." },
    ],
    relatedSlugs: ["ees-schengen-2026-controle-biometrique", "documents-visa-schengen-kinshasa", "delais-visa-usa-canada-schengen-kinshasa-2025"],
    relatedDestination: "visa-schengen-kinshasa",
  },

  {
    slug: "travel-advisory-level-4-rdc-visa-usa-2026",
    title: "Travel Advisory Level 4 RDC (Ebola 2026) : impact sur les demandes de visa USA",
    metaTitle: "Travel Advisory Level 4 RDC 2026 — Impact Visa USA Kinshasa | Joventy",
    metaDescription: "L'ambassade US à Kinshasa est en Level 4 (Do Not Travel) suite à Ebola. Ce que cela signifie pour vos demandes de visa USA et comment adapter votre stratégie.",
    publishedDate: "2026-05-29",
    updatedDate: "2026-05-31",
    readingTime: 5,
    category: "Visa USA",
    coverEmoji: "⚠️",
    intro: "Depuis mai 2026, l'ambassade américaine à Kinshasa est passée en Travel Advisory Level 4 (« Do Not Travel ») en raison de l'épidémie d'Ebola Bundibugyo en province de l'Ituri. Beaucoup de Congolais pensent à tort que cela empêche de demander un visa USA. Ce n'est pas le cas. Ce guide clarifie la situation et explique comment adapter votre stratégie de demande de visa.",
    sections: [
      { heading: "Qu'est-ce que le Travel Advisory Level 4 ?", body: "Le système d'alerte voyage américain comporte 4 niveaux :", list: ["Level 1 : Exercise Normal Precautions (précautions normales)", "Level 2 : Exercise Increased Caution (prudence accrue)", "Level 3 : Reconsider Travel (reconsidérer le voyage)", "Level 4 : Do Not Travel (ne pas voyager) — c'est le niveau actuel pour la RDC", "IMPORTANT : ce level s'adresse aux AMÉRICAINS qui envisagent de voyager EN RDC", "Il ne concerne PAS la capacité des Congolais à demander un visa pour voyager AUX USA"] },
      { heading: "Interdiction d'entrée aux USA, Canada et Mexique (règle des 21 jours)", body: "Les trois pays hôtes de la Coupe du Monde 2026 ont mis en place des restrictions d'entrée strictes :", list: ["🇺🇸 USA : Le CDC a émis un ordre le 18 mai 2026 interdisant l'entrée aux non-citoyens américains ayant séjourné en RDC, Ouganda ou Sud-Soudan dans les 21 jours précédents — y compris les détenteurs de Green Card", "🇨🇦 Canada : Suspension totale des visas pour les résidents RDC + quarantaine obligatoire de 21 jours (27 mai — 28 août 2026)", "🇲🇽 Mexique : Restriction d'entrée par voie aérienne pour toute personne ayant séjourné en RDC, Ouganda ou Sud-Soudan dans les 21 derniers jours (Aeromexico, Volaris, Viva — 60 jours)", "Cela s'applique à TOUTE personne (congolaise ou non) ayant été physiquement présente dans ces pays", "Les citoyens américains peuvent entrer mais subissent un screening sanitaire renforcé", "Les arrivées aux USA sont limitées à certains aéroports désignés (Dulles, Atlanta, Houston IAH)"] },
      { heading: "Suspension des services visa à l'ambassade US de Kinshasa", body: "En plus de l'interdiction d'entrée, les services consulaires sont aussi impactés :", list: ["⛔ Le Département d'État a SUSPENDU les services visa à l'ambassade US de Kinshasa depuis le 18 mai 2026", "⛔ Les services visa sont également suspendus aux ambassades US en Ouganda et au Sud-Soudan", "⛔ Aucune nouvelle demande de visa ne peut être déposée à Kinshasa actuellement", "⛔ Les entretiens déjà programmés sont reportés jusqu'à nouvel ordre", "⛔ Le portail usvisaappt.com ne propose plus de créneaux pour Kinshasa", "✅ Les visas USA déjà délivrés RESTENT VALIDES — mais vous ne pouvez entrer qu'après 21 jours hors RDC", "💡 Alternative : si vous êtes hors RDC depuis 21+ jours, vous pouvez demander un visa dans un pays tiers (Third Country National)"] },
      { heading: "La stratégie des 21 jours : comment entrer aux USA malgré la restriction", body: "La seule solution est de passer 21 jours hors de la RDC avant d'entrer aux USA :", list: ["Quittez la RDC au moins 21 jours avant votre date d'entrée souhaitée aux USA", "Séjournez dans un pays tiers non-concerné par la restriction (Maroc, Égypte, Dubaï, Turquie, Europe...)", "L'équipe nationale RDC a fait exactement cela : départ de Kinshasa le 20 mai, 21 jours en Europe, puis entrée aux USA", "Pays recommandés pour le transit : Maroc (visa 72h via Joventy), Égypte (e-Visa 24h), Dubaï (e-Visa 48h), Turquie (e-Visa 24h)", "Si vos 21 jours sont écoulés, vous pouvez aussi demander un visa USA dans un pays tiers (ambassade Paris, Nairobi, etc.)", "Joventy peut organiser votre transit complet : visa pays neutre + hébergement + suivi → WhatsApp +243 840 808 122"] },
      { heading: "Alternative : demander le visa USA depuis un pays tiers", body: "Si vous êtes déjà hors de la RDC depuis plus de 21 jours :", list: ["Vous pouvez demander un visa USA depuis un autre pays où vous séjournez légalement", "Options populaires : Casablanca, Le Caire, Nairobi, Johannesburg, Paris (si vous avez un visa Schengen)", "L'entretien Third Country National (TCN) est accepté par de nombreuses ambassades", "Avantage : si vous êtes hors RDC depuis 21+ jours, vous pouvez entrer aux USA dès l'obtention du visa", "Joventy peut vous conseiller sur la meilleure ambassade alternative selon votre profil — WhatsApp +243 840 808 122"] },
    ],
    faq: [
      { q: "Le Travel Advisory Level 4 empêche-t-il d'obtenir un visa USA ?", a: "Les services visa à l'ambassade US de Kinshasa sont actuellement SUSPENDUS (depuis le 18 mai 2026). Aucune nouvelle demande ne peut être déposée à Kinshasa. Les visas déjà délivrés restent valides, mais vous ne pouvez entrer aux USA qu'après 21 jours hors de la RDC. Alternative : demander le visa dans un pays tiers si vous êtes hors RDC depuis 21+ jours." },
      { q: "L'ambassade US à Kinshasa est-elle fermée ?", a: "Les services visa sont suspendus. L'ambassade reste ouverte pour les services aux citoyens américains, mais les entretiens visa sont reportés et aucun nouveau créneau n'est disponible sur usvisaappt.com pour Kinshasa. Contactez Joventy pour les alternatives (demande dans un pays tiers) : +243 840 808 122." },
      { q: "Puis-je entrer aux USA directement depuis Kinshasa ?", a: "Non. Depuis le 18 mai 2026, les non-citoyens américains ayant séjourné en RDC, Ouganda ou Sud-Soudan dans les 21 jours précédents sont interdits d'entrée aux USA. Vous devez obligatoirement passer 21 jours dans un pays neutre (Maroc, Égypte, Dubaï, Turquie, Europe...) avant de vous rendre aux USA. Cette règle s'applique même aux détenteurs de Green Card." },
      { q: "La même restriction s'applique-t-elle au Canada et au Mexique ?", a: "Oui. Le Canada a suspendu tous les visas pour les résidents RDC et impose une quarantaine de 21 jours. Le Mexique restreint l'entrée par avion pour toute personne ayant séjourné en RDC dans les 21 derniers jours. Les trois pays hôtes de la Coupe du Monde appliquent la règle des 21 jours." },
      { q: "Comment obtenir un visa USA si l'ambassade de Kinshasa est suspendue ?", a: "Si vous êtes hors de la RDC depuis 21+ jours, vous pouvez demander un visa USA dans un pays tiers (Third Country National). Ambassades possibles : Casablanca, Le Caire, Paris, Nairobi. Joventy vous accompagne : WhatsApp +243 840 808 122." },
    ],
    relatedSlugs: ["comment-obtenir-creneau-visa-usa-kinshasa", "purger-21-jours-ebola-pays-neutre-visa-usa-2026", "visa-usa-refuse-que-faire"],
    relatedDestination: "visa-usa-kinshasa",
  },

  {
    slug: "purger-21-jours-ebola-pays-neutre-visa-usa-2026",
    title: "Où et comment purger les 21 jours hors RDC pour entrer aux USA, Canada ou Mexique (guide 2026)",
    metaTitle: "Purger 21 Jours Ebola Hors RDC — Pays Neutre Visa USA Canada Mexique 2026 | Joventy",
    metaDescription: "Interdit d'entrée aux USA, Canada et Mexique si vous étiez en RDC dans les 21 derniers jours. Où passer votre quarantaine dans un pays neutre ? Dubaï, Turquie, Europe — guide complet avec budget et visas.",
    publishedDate: "2026-05-31",
    updatedDate: "2026-05-31",
    readingTime: 9,
    category: "Visa USA",
    coverEmoji: "🌍",
    intro: "Depuis mai 2026, les États-Unis, le Canada et le Mexique interdisent l'entrée à toute personne — congolaise ou étrangère — ayant séjourné en RDC, en Ouganda ou au Sud-Soudan dans les 21 jours précédents (mesure Ebola). La solution : passer 21 jours dans un pays neutre avant de prendre votre vol. Mais quel pays choisir ? Comment obtenir le visa ? Combien ça coûte ? Ce guide vous donne un plan d'action complet — et Joventy peut vous aider à obtenir votre visa pour le pays de transit si vous n'en avez pas.",
    sections: [
      { heading: "Rappel : pourquoi 21 jours obligatoires hors RDC ?", body: "La période d'incubation du virus Ebola est de 2 à 21 jours. Les autorités sanitaires des USA, du Canada et du Mexique exigent donc que tout voyageur ait quitté la zone à risque depuis au moins 21 jours complets avant d'entrer sur leur territoire :", list: ["🇺🇸 USA : ordre CDC du 18 mai 2026 — interdiction d'entrée pour tout non-citoyen ayant été en RDC/Ouganda/Sud-Soudan dans les 21 jours (y compris détenteurs de Green Card)", "🇨🇦 Canada : suspension des visas + quarantaine obligatoire 21 jours (27 mai — 28 août 2026)", "🇲🇽 Mexique : restriction d'entrée par voie aérienne, 21 jours minimum hors zone (Aeromexico, Volaris, Viva — 60 jours)", "La règle s'applique à TOUS — Congolais, étrangers, et même les détenteurs de Green Card américaine", "21 jours = 21 jours complets après votre DERNIÈRE journée en RDC (le jour de départ ne compte pas)", "Vous devez pouvoir PROUVER votre séjour hors RDC (billets d'avion, tampons passeport, réservations hôtel)"] },
      { heading: "Les meilleurs pays neutres pour purger les 21 jours", body: "Tous les pays ne sont pas des options valables. Les pays voisins de la RDC sont classés « à haut risque » par l'Africa CDC (Congo-Brazza, Angola, Burundi, Kenya, Rwanda, Tanzanie) et pourraient être ajoutés à la liste à tout moment. Privilégiez ces destinations :", list: ["🇦🇪 DUBAÏ (EAU) — TOP CHOIX : e-Visa en 48-72h, aucune restriction Ebola, vols directs depuis Kinshasa, communauté congolaise présente", "🇲🇦 MAROC (Casablanca/Marrakech) — EXCELLENT : e-Visa disponible pour les détenteurs de visa Schengen ou USA multi-entrées (77 à 110 USD, traitement 24 à 72h). Francophone, vols fréquents, pas de restriction Ebola", "🇹🇷 TURQUIE (Istanbul) — TRÈS BON : e-Visa en 24-48h pour détenteurs de visa USA ou Schengen valide. Pas de restriction, vols fréquents, hébergement abordable", "🇪🇬 ÉGYPTE (Le Caire) — ÉCONOMIQUE : visa obtenu via ambassade par Joventy en 24-72h. Hébergement très économique, aucune restriction Ebola", "🇫🇷 FRANCE / 🇧🇪 BELGIQUE — IDÉAL SI VISA SCHENGEN : si vous avez un visa Schengen multi-entrées valide, séjour immédiat sans démarche. Grande diaspora congolaise", "🇬🇧 ROYAUME-UNI — OPTION : si vous avez un visa UK valide, Londres est sûre et bien connectée aux USA", "🇲🇺 ÎLE MAURICE — SANS VISA : les Congolais n'ont PAS besoin de visa pour Maurice (séjour gratuit jusqu'à 90 jours). Destination calme pour 21 jours", "⚠️ ÉVITEZ les pays voisins de la RDC — même s'ils ne sont pas interdits aujourd'hui, ils peuvent l'être demain"] },
      { heading: "Option 1 : Vous avez déjà un visa Schengen ou USA multi-entrées", body: "Si vous possédez un visa Schengen ou USA à entrées multiples encore valide, vous avez des options immédiates :", list: ["Visa Schengen multi-entrées valide → envolez-vous vers la France, Belgique, Allemagne ou Espagne. Séjour 21 jours sans aucune démarche supplémentaire", "Visa USA ou Schengen valide → e-Visa Maroc en 24-72h (77-110 USD). Le Maroc accepte les détenteurs de visa USA ou Schengen pour son e-Visa", "Visa USA multi-entrées valide → votre visa reste valable mais vous ne pouvez pas entrer aux USA avant les 21 jours. Utilisez le Maroc (e-Visa), la Turquie (e-Visa gratuit avec visa USA valide) ou Dubaï pour le transit", "Visa Turquie (e-Visa) → accessible immédiatement aux détenteurs d'un visa USA ou Schengen valide. Obtention en 24h en ligne", "Île Maurice → aucun visa nécessaire pour les Congolais. Billet d'avion suffisant (séjour gratuit 90 jours)", "Conseil : choisissez un pays avec des vols directs vers votre destination finale (USA/Canada/Mexique)"] },
      { heading: "Option 2 : Vous n'avez PAS de visa — Joventy vous aide", body: "Si vous n'avez ni visa Schengen ni visa pour un pays neutre, Joventy peut vous obtenir rapidement un visa pour passer vos 21 jours. C'est une situation d'urgence — nos tarifs reflètent la mobilisation express de notre équipe. Contactez-nous sur WhatsApp :", list: ["🇲🇦 E-Visa Maroc (si visa USA ou Schengen valide) : Joventy soumet votre demande e-Visa → résultat en 24 à 72h. Frais visa : 77-110 USD. Frais Joventy : 150 USD engagement + 200 USD prime de succès", "🇪🇬 Visa Égypte : Joventy prépare votre dossier et obtient votre visa via l'ambassade → résultat en 24-72h. Frais Joventy : 150 USD engagement + 200 USD prime de succès", "🇦🇪 E-Visa Dubaï : Joventy soumet votre demande sur le portail ICP des EAU → résultat en 48-72h. Frais Joventy : 150 USD engagement + 200 USD prime de succès", "🇹🇷 E-Visa Turquie : si éligible (visa USA ou Schengen valide), obtention en 24h. Frais Joventy : 150 USD + 200 USD", "🇪🇺 Visa Schengen express : Joventy prend votre créneau CEV en urgence et prépare votre dossier complet. Frais : 200 USD + 500 USD. Délai : 2-4 semaines", "🇲🇺 Île Maurice : AUCUN VISA NÉCESSAIRE — il suffit d'un billet d'avion et d'un passeport valide (gratuit, 90 jours max)", "📱 Contactez Joventy maintenant sur WhatsApp : +243 840 808 122 — réponse en moins de 2h", "Notre équipe analyse votre situation, vos visas existants et votre budget pour vous proposer la solution la plus rapide"] },
      { heading: "Budget estimé : 21 jours dans un pays neutre", body: "Voici les budgets réalistes pour 21 jours (vol depuis Kinshasa + hébergement + vie quotidienne). En période d'urgence, les prix des vols sont plus élevés que la normale :", list: ["🇲🇦 Maroc (Casablanca) : Vol 600-900 USD + hébergement 500-1000 USD + vie 400-600 USD + visa 77-110 USD = TOTAL 1 600 à 2 600 USD", "🇪🇬 Égypte (Le Caire) : Vol 500-800 USD + hébergement 400-700 USD + vie 300-500 USD + visa ~60 USD = TOTAL 1 300 à 2 100 USD", "🇦🇪 Dubaï : Vol 700-1100 USD + hébergement 800-1500 USD + vie 500-900 USD + e-Visa ~90 USD = TOTAL 2 100 à 3 600 USD", "🇹🇷 Istanbul : Vol 600-900 USD + hébergement 500-1000 USD + vie 400-600 USD + e-Visa ~50 USD = TOTAL 1 550 à 2 550 USD", "🇫🇷 Paris : Vol 800-1300 USD + hébergement 1000-1800 USD + vie 600-1000 USD = TOTAL 2 400 à 4 100 USD", "🇧🇪 Bruxelles : Vol 800-1200 USD + hébergement 900-1500 USD + vie 500-800 USD = TOTAL 2 200 à 3 500 USD", "🇲🇺 Île Maurice : Vol 600-1000 USD + hébergement 500-900 USD + vie 400-600 USD = TOTAL 1 500 à 2 500 USD (pas de visa)", "💡 Astuce : Airbnb et locations meublées sont 30-50% moins chers qu'un hôtel pour 21 nuits. Réservez tôt — les prix augmentent avec la demande Ebola."] },
      { heading: "Plan d'action étape par étape", body: "Voici exactement ce que vous devez faire :", list: ["1. Contactez Joventy sur WhatsApp (+243 840 808 122) — nous analysons vos visas existants, votre budget et votre urgence", "2. Si besoin d'un visa pour le pays neutre → Joventy lance la demande immédiatement (Dubaï 48h, Turquie 24h)", "3. Réservez votre vol Kinshasa → pays neutre DÈS que le visa de transit est confirmé", "4. Réservez un hébergement pour 22 nuits minimum (21 jours + 1 jour de marge de sécurité)", "5. À votre arrivée dans le pays neutre, conservez TOUTES les preuves de présence (hôtel, achats, billets)", "6. Le jour 22 après votre départ de RDC, prenez votre vol vers les USA/Canada/Mexique", "7. À l'arrivée, les agents frontaliers vérifieront vos dates — montrez vos preuves si demandé"] },
      { heading: "Documents à conserver comme preuve de transit", body: "Les compagnies aériennes ET les agents frontaliers vérifieront que vous respectez les 21 jours. Gardez :", list: ["Carte d'embarquement du vol Kinshasa → pays neutre (avec date de départ de RDC)", "Tampon d'entrée dans le passeport du pays neutre", "Confirmation de réservation hôtel/Airbnb pour 21+ nuits", "Reçus de paiement dans le pays neutre (restaurants, commerces — prouvent votre présence physique)", "Relevé de carte bancaire montrant des transactions sur 21+ jours dans le pays neutre", "⚠️ La compagnie aérienne peut refuser votre embarquement vers les USA si vous ne pouvez pas prouver les 21 jours"] },
    ],
    faq: [
      { q: "Puis-je purger mes 21 jours au Congo-Brazzaville ou en Angola ?", a: "Techniquement oui (le CDC ne les interdit pas actuellement), MAIS l'Africa CDC les classe « à haut risque » et ils pourraient être ajoutés à la liste du jour au lendemain. Joventy recommande fortement un pays hors Afrique centrale (Dubaï, Turquie, Europe, Maurice) pour zéro risque. Contactez-nous : +243 840 808 122." },
      { q: "Mon visa Schengen est expiré mais mon visa USA multi-entrées est valide. Que faire ?", a: "Avec un visa USA valide, vous pouvez obtenir : un e-Visa Maroc en 24-72h (77-110 USD), un e-Visa Turquie en 24h, ou un e-Visa Dubaï en 48h. L'île Maurice ne nécessite aucun visa. Joventy gère tout : WhatsApp +243 840 808 122." },
      { q: "Les 21 jours commencent-ils le jour de mon départ de Kinshasa ?", a: "Le compteur commence le jour APRÈS votre dernier jour en RDC. Si vous quittez Kinshasa le 1er juin, votre jour 1 est le 2 juin, et vous pouvez entrer aux USA à partir du 23 juin (jour 22). Prévoyez 1-2 jours de marge supplémentaire." },
      { q: "Que se passe-t-il si j'arrive aux USA avant les 21 jours ?", a: "Vous serez refoulé. La compagnie aérienne refusera probablement votre embarquement car elle vérifie les dates avant le vol. Si vous passez malgré tout, les agents CBP (Customs and Border Protection) vous interdiront l'entrée à l'arrivée. Ne prenez AUCUN risque." },
      { q: "Joventy peut-il organiser tout le transit de A à Z ?", a: "Oui. Joventy propose un accompagnement complet : obtention du visa pays neutre (Dubaï 48h, Turquie 24h), conseils vols et hébergements, suivi de votre dossier visa USA/Canada en parallèle, et assistance WhatsApp tout au long des 21 jours. Contactez-nous : +243 840 808 122." },
      { q: "Je suis étranger (non-congolais) mais j'étais en RDC. Suis-je aussi concerné ?", a: "Oui. La restriction s'applique à TOUTE personne ayant été physiquement présente en RDC, Ouganda ou Sud-Soudan dans les 21 derniers jours, quelle que soit sa nationalité. Un Français, un Belge ou un Américain ayant séjourné à Kinshasa est soumis à la même règle." },
    ],
    relatedSlugs: ["travel-advisory-level-4-rdc-visa-usa-2026", "coupe-du-monde-2026-visa-usa-kinshasa", "suspension-visa-canada-rdc-ebola-2026"],
    relatedDestination: "visa-usa-kinshasa",
  },

  {
    slug: "visa-espagne-kinshasa-rendez-vous-ambassade-2026",
    title: "Rendez-vous visa Espagne Kinshasa 2026 — Procédure officielle étape par étape (email + citaconsular.es)",
    metaTitle: "Rendez-vous Visa Espagne Kinshasa 2026 — Procédure officielle étape par étape | Joventy",
    metaDescription: "Prendre rendez-vous visa Espagne depuis Kinshasa en 2026 : email à emb.kinshasa.citasvis@maec.es puis créneau sur citaconsular.es. Documents requis, frais 90€, délais réels — guide complet.",
    publishedDate: "2026-06-27",
    updatedDate: "2026-07-05",
    readingTime: 8,
    category: "Visa Schengen",
    coverEmoji: "🇪🇸",
    intro: "Vous cherchez à prendre un rendez-vous visa Espagne depuis Kinshasa ? Attention : l'Espagne ne passe PAS par le Centre Européen des Visas (CEV), contrairement à la France ou la Belgique. La procédure est entièrement gérée par l'Ambassade d'Espagne à Kinshasa et se fait en deux étapes : une inscription par email, puis une réservation de créneau sur le portail citaconsular.es. Ce guide vous explique la procédure exacte, les documents à préparer, et comment Joventy peut s'occuper de tout à votre place.",
    sections: [
      {
        heading: "Étape 1 — Inscription par email à l'Ambassade d'Espagne",
        body: "La première étape est obligatoire avant toute prise de rendez-vous. Vous (ou Joventy en votre nom) devez envoyer un email d'inscription à l'adresse officielle de l'ambassade :",
        list: [
          "Adresse email : emb.kinshasa.citasvis@maec.es",
          "Objet (sujet) de l'email : RENDEZ-VOUS VISA EST (exactement, sans modification)",
          "Corps de l'email : vos données dans l'ordre suivant, en MAJUSCULES, sans accents ni apostrophes, séparées par des points-virgules — Nom;Prénom;Numéro de passeport;Date de voyage (JJMMAAAA);EST",
          "Exemple : MBUYI KALALA;JEAN;AB1234567;15082026;EST",
          "Pièces jointes obligatoires (limite totale : 1 Mo) : photo de vous tenant votre passeport ouvert (détails lisibles, visage visible, pas de lunettes ni couvre-chef), formulaire de demande de visa rempli et signé, réservation de vol aller-retour, assurance santé",
          "⚠️ N'envoyez PAS l'email deux fois avant 14 jours — cela peut entraîner un délai supplémentaire de 2 mois",
          "⚠️ Chaque demandeur (y compris les mineurs) doit envoyer un email séparé",
        ],
      },
      {
        heading: "Étape 2 — Réservation du créneau sur citaconsular.es",
        body: "Après traitement de votre email (délai variable : quelques jours à 2 semaines), l'ambassade vous envoie des identifiants (nom d'utilisateur + mot de passe). Avec ces identifiants :",
        list: [
          "Connectez-vous au portail : citaconsular.es",
          "Choisissez une date et une heure disponibles pour votre rendez-vous à l'Ambassade d'Espagne de Kinshasa",
          "Vous recevez un email de confirmation de rendez-vous",
          "Vous pouvez annuler votre rendez-vous jusqu'à 3 jours avant la date — maximum 5 annulations par an",
          "Le créneau réservé est valable pour vous seul — ne le partagez pas",
          "Joventy peut réserver ce créneau pour vous dès réception des identifiants",
        ],
      },
      {
        heading: "Ambassade d'Espagne à Kinshasa — Adresse et horaires",
        body: "Une fois votre créneau réservé, vous vous rendez physiquement à l'ambassade pour déposer votre dossier et fournir vos données biométriques :",
        list: [
          "Adresse : Boulevard Colonel Tshatshi n°37, Gombe, Kinshasa",
          "Horaires : Lundi au vendredi, 08h30 à 14h00",
          "Biométrie : vos empreintes digitales et photo seront prises sur place (obligatoire pour les plus de 12 ans, sauf si déjà collectées dans les 59 derniers mois)",
          "Vous recevez un récépissé avec un code pour suivre l'état de votre dossier sur sutramiteconsular.maec.es",
          "Le délai légal de traitement est de 15 jours calendaires (peut aller jusqu'à 45 jours si des documents complémentaires sont demandés)",
          "⚠️ Présentez-vous à l'heure exacte de votre rendez-vous — les retards ne sont pas tolérés",
        ],
      },
      {
        heading: "Documents complets à préparer pour le dossier",
        body: "Voici la liste officielle des pièces à apporter le jour du rendez-vous à l'ambassade. Joventy vérifie et prépare l'intégralité de votre dossier :",
        list: [
          "Passeport original en cours de validité (valable au moins 6 mois après la date d'expiration du visa demandé) + photocopies de toutes les pages avec tampons",
          "Formulaire officiel de demande de visa Schengen, dûment rempli en lettres capitales et signé",
          "2 photos d'identité biométriques récentes (fond blanc, visage dégagé, format conforme aux normes Schengen)",
          "Réservation de vol aller-retour confirmée (avec dates, numéros de vol et nom du demandeur)",
          "Preuve d'hébergement : réservation hôtel confirmée OU lettre d'hébergement d'un particulier avec copie de son titre de séjour/passeport",
          "Assurance voyage couvrant les frais médicaux et de rapatriement, valable dans tout l'espace Schengen, minimum 30 000 € de couverture, pour toute la durée du séjour",
          "Relevés bancaires des 3 derniers mois (compte personnel ou professionnel) — solde suffisant pour couvrir le séjour",
          "Justificatifs professionnels : attestation de travail avec congé approuvé, ordre de mission (pour les voyages d'affaires) ou RCCM (pour les indépendants)",
          "Pour les mineurs : acte de naissance, autorisation parentale des deux parents, copie des passeports des parents",
        ],
      },
      {
        heading: "Frais de visa et modalités de paiement",
        body: "Les frais consulaires sont payés directement à l'Ambassade d'Espagne le jour du rendez-vous. Ils ne sont pas inclus dans les frais Joventy :",
        list: [
          "Adulte (12 ans et plus) : 90 €",
          "Enfant de 6 à 12 ans : 45 €",
          "Enfant de moins de 6 ans : GRATUIT",
          "Modalité de paiement : renseignez-vous auprès de l'ambassade pour la devise acceptée (CDF, USD ou carte bancaire selon les cas)",
          "Frais Joventy séparés : 150 USD d'engagement (à la création du dossier) + 450 USD de prime de succès (à la confirmation du créneau uniquement)",
          "La prime de succès n'est DUE que lorsque votre rendez-vous à l'ambassade est confirmé",
        ],
      },
      {
        heading: "Fenêtre de dépôt — quand faire la demande ?",
        body: "L'ambassade impose une fenêtre temporelle stricte pour le dépôt des demandes. Hors de cette fenêtre, votre dossier sera refusé :",
        list: [
          "Minimum : 15 jours avant la date prévue de départ (vous devez déposer votre dossier au moins 15 jours avant votre vol)",
          "Maximum : 6 mois avant la date de départ (vous ne pouvez pas demander le visa plus de 6 mois à l'avance)",
          "Exception : les gens de mer peuvent déposer jusqu'à 9 mois avant le voyage",
          "Conseil Joventy : lancez le processus 2 à 3 mois avant votre départ pour avoir le temps d'obtenir le créneau et de traiter le dossier",
          "En cas d'urgence : contactez Joventy sur WhatsApp — nous optimisons le calendrier selon votre date de voyage",
        ],
      },
      {
        heading: "Ce que Joventy fait pour vous (service complet)",
        body: "Joventy prend en charge l'intégralité de la procédure visa Espagne depuis Kinshasa, de A à Z :",
        list: [
          "Préparation complète de votre dossier : formulaire Schengen, vérification des documents, conseils sur les relevés bancaires et justificatifs",
          "Envoi de l'email d'inscription à emb.kinshasa.citasvis@maec.es en votre nom, avec toutes les pièces jointes au bon format",
          "Réservation du créneau sur citaconsular.es dès réception des identifiants de l'ambassade",
          "Confirmation par WhatsApp avec la date, l'heure et les instructions pour le jour J",
          "Suivi de l'état du dossier via sutramiteconsular.maec.es",
          "Prime de succès (450 USD) payable uniquement à la confirmation du créneau — aucun résultat, aucun solde dû",
          "Paiement via M-Pesa, Airtel Money ou Orange Money",
        ],
      },
    ],
    faq: [
      {
        q: "L'Espagne passe-t-elle par le CEV (Centre Européen des Visas) à Kinshasa ?",
        a: "Non. L'Espagne ne traite PAS ses visas via le CEV. Contrairement à la France, la Belgique ou l'Allemagne, le visa Espagne depuis Kinshasa passe directement par l'Ambassade d'Espagne (Boulevard Colonel Tshatshi n°37, Gombe). La prise de rendez-vous se fait via email + portail citaconsular.es.",
      },
      {
        q: "Comment prendre rendez-vous visa Espagne depuis Kinshasa en 2026 ?",
        a: "La procédure est en deux étapes : 1) Envoyer un email à emb.kinshasa.citasvis@maec.es (objet : RENDEZ-VOUS VISA EST) avec vos données et pièces jointes. 2) Une fois les identifiants reçus, réserver votre créneau sur citaconsular.es. Joventy peut gérer ces deux étapes pour vous.",
      },
      {
        q: "Combien de temps faut-il pour avoir un rendez-vous visa Espagne à Kinshasa ?",
        a: "L'ambassade répond généralement à l'email d'inscription en 1 à 14 jours. La disponibilité des créneaux sur citaconsular.es varie selon la période. Joventy surveille et réserve dès qu'un créneau s'ouvre. En pratique, comptez 2 à 6 semaines entre la création du dossier et le rendez-vous.",
      },
      {
        q: "Joventy peut-il envoyer l'email d'inscription à ma place ?",
        a: "Oui. Joventy envoie l'email d'inscription à emb.kinshasa.citasvis@maec.es en votre nom avec vos données exactes et toutes les pièces jointes requises. Joventy réserve également le créneau sur citaconsular.es dès réception de vos identifiants. C'est inclus dans le service.",
      },
      {
        q: "Quels documents faut-il joindre à l'email d'inscription ?",
        a: "L'email d'inscription doit contenir (en pièces jointes, limite 1 Mo au total) : une photo de vous tenant votre passeport ouvert (face lisible, visage visible), le formulaire de demande de visa rempli, une réservation de vol aller-retour, et une assurance santé valable en Europe.",
      },
      {
        q: "Combien coûte le visa Espagne depuis Kinshasa ?",
        a: "Les frais consulaires payés à l'ambassade sont : 90 € pour un adulte, 45 € pour un enfant de 6-12 ans, gratuit pour les moins de 6 ans. Les frais Joventy sont : 150 USD d'engagement à la création du dossier + 450 USD de prime de succès uniquement à la confirmation du rendez-vous.",
      },
      {
        q: "Que faire si mon email à l'ambassade reste sans réponse ?",
        a: "N'envoyez pas de deuxième email avant 14 jours — l'ambassade indique qu'un renvoi anticipé peut entraîner un délai supplémentaire de 2 mois. Si après 14 jours vous n'avez pas de réponse, vous pouvez renvoyer l'email. Joventy gère cette communication en votre nom et surveille les délais.",
      },
      {
        q: "Puis-je entrer en France ou en Belgique avec un visa espagnol ?",
        a: "Oui. Un visa Schengen délivré par l'Ambassade d'Espagne vous permet de circuler librement dans les 27 pays de l'espace Schengen (France, Belgique, Allemagne, Italie, Pays-Bas, etc.) pendant 90 jours sur 180.",
      },
    ],
    relatedSlugs: [
      "documents-visa-schengen-kinshasa",
      "comment-obtenir-creneau-visa-usa-kinshasa",
      "delais-visa-usa-canada-schengen-kinshasa-2025",
    ],
    relatedDestination: "visa-espagne-kinshasa",
  },

  {
    slug: "rendez-vous-cev-kinshasa-visa-schengen",
    title: "Prendre rendez-vous au CEV Kinshasa pour un visa Schengen 2026 — Procédure complète (Visa On Web + cev-kin.eu)",
    metaTitle: "Rendez-vous CEV Kinshasa Visa Schengen 2026 — Comment prendre RDV étape par étape | Joventy",
    metaDescription:
      "Comment prendre rendez-vous au CEV Kinshasa (cev-kin.eu) pour un visa Schengen en 2026 : créer votre compte Visa On Web, réserver un créneau, délais réels, frais, et erreurs qui font perdre le rendez-vous.",
    publishedDate: "2026-06-15",
    updatedDate: "2026-06-27",
    readingTime: 8,
    category: "Visa Schengen",
    coverEmoji: "🏛️",
    intro:
      "Le Centre Européen des Visas (CEV) à Kinshasa est le seul guichet où les ressortissants congolais peuvent déposer une demande de visa Schengen court séjour. Il représente la France, la Belgique, l'Allemagne, les Pays-Bas et d'autres États Schengen. Mais sa procédure de prise de rendez-vous en ligne — via le portail Visa On Web — est souvent source de confusion et de blocage. Ce guide vous explique les étapes exactes, les délais réels et les erreurs fréquentes.",
    sections: [
      {
        heading: "Le CEV en bref — ce qu'il faut savoir avant de commencer",
        body:
          "Le CEV n'est ni une ambassade ni un centre privé comme VFS ou TLS Contact ailleurs dans le monde. C'est un centre commun officiel, géré par l'Ambassade de Belgique, qui reçoit et instruit les demandes pour le compte de plusieurs pays Schengen. Toute la procédure commence en ligne, mais la dépose du dossier et la prise d'empreintes se font obligatoirement en personne.",
        list: [
          "🌐 Site officiel : www.cev-kin.eu",
          "📍 Adresse : Avenue Pierre Mulele (ex-24 Novembre), Gombe – Kinshasa",
          "📞 Téléphone : +243 819 700 231",
          "📧 Email : cev.kinshasa@diplobel.fed.be",
          "Dépôt possible aussi à Lubumbashi : Consulat Général de Belgique à Lubumbashi",
          "Pays représentés : France, Belgique, Allemagne, Pays-Bas, Luxembourg, et d'autres États Schengen",
          "Compétence : uniquement les visas court séjour (type C, 90 jours max sur 180) pour les ressortissants congolais",
        ],
      },
      {
        heading: "Étape 1 — Créer votre compte sur Visa On Web (VOW)",
        body:
          "Visa On Web (visaonweb.be) est le portail officiel du gouvernement belge pour les demandes de visa Schengen. C'est la première étape obligatoire — sans compte Visa On Web actif, vous ne pouvez pas prendre rendez-vous au CEV.",
        list: [
          "Rendez-vous sur visaonweb.be et créez un compte avec une adresse email valide",
          "Vérifiez votre email et activez le compte (vérifier les spams si vous ne recevez pas l'email)",
          "Connectez-vous et cliquez sur « Introduire une nouvelle demande »",
          "Sélectionnez « Visa de court séjour (type C) » et choisissez le pays de destination principale",
          "Remplissez le formulaire en ligne : informations personnelles, motif du voyage, itinéraire prévu",
          "Une fois le formulaire soumis, le système génère un numéro de dossier VOW — conservez-le",
          "Important : le formulaire VOW ne remplace pas le formulaire papier que vous signerez au guichet du CEV",
        ],
      },
      {
        heading: "Étape 2 — Prendre rendez-vous en ligne sur cev-kin.eu",
        body:
          "Une fois votre dossier VOW créé, vous pouvez prendre rendez-vous sur le site du CEV. Les créneaux disponibles s'affichent en temps réel et partent rapidement, surtout en période de forte demande (mai-septembre).",
        list: [
          "Rendez-vous sur www.cev-kin.eu et cliquez sur « Prendre rendez-vous »",
          "Connectez-vous avec vos identifiants Visa On Web",
          "Sélectionnez le nombre de personnes (si dépôt groupé pour une famille)",
          "Choisissez une date et un créneau horaire disponibles — les créneaux du matin partent en premier",
          "Confirmez le rendez-vous : vous recevez un email de confirmation avec votre numéro de rendez-vous",
          "Imprimez ou enregistrez la confirmation — elle est exigée à l'entrée du CEV",
          "Si aucun créneau n'est disponible : revenez sur le portail les matins en semaine, les annulations libèrent des places en cours de journée",
        ],
      },
      {
        heading: "Étape 3 — Préparer et déposer votre dossier physiquement au CEV",
        body:
          "Le jour de votre rendez-vous, vous vous présentez au CEV avec l'intégralité de votre dossier papier. Le CEV n'accepte pas les dossiers incomplets — si un document manque, votre dossier est refusé à l'accueil et vous devez reprendre un rendez-vous.",
        list: [
          "Arrivez 15 à 20 minutes avant votre créneau — le CEV est strict sur les horaires",
          "Présentez votre confirmation de rendez-vous (papier ou téléphone) et votre passeport à l'entrée",
          "L'agent du CEV vérifie que votre dossier est complet avant d'ouvrir le dossier",
          "Vos empreintes digitales biométriques sont prises sur place — présence physique obligatoire pour tous les demandeurs de plus de 12 ans",
          "Vous recevez un récépissé de dépôt avec un numéro de suivi — conservez-le précieusement",
          "Le suivi du dossier se fait ensuite sur le portail Visa On Web avec votre numéro de dossier",
        ],
      },
      {
        heading: "Délais d'attente pour un rendez-vous CEV en 2026",
        body:
          "Les délais varient considérablement selon la période. En 2026, voici les tendances observées sur le portail CEV :",
        list: [
          "Janvier – mars (basse saison) : rendez-vous disponible sous 1 à 2 semaines",
          "Avril – juin (montée en charge) : 2 à 4 semaines d'attente",
          "Juillet – septembre (haute saison) : 3 à 6 semaines, parfois plus — planifiez en avance",
          "Octobre – décembre : retour à 2 à 3 semaines",
          "Après obtention du rendez-vous, délai de traitement : 15 jours ouvrables réglementaires maximum",
          "Déposez votre dossier entre 15 jours et 6 mois avant votre date de départ prévue",
          "Conseil : si votre voyage est urgent, prenez rendez-vous dès que possible — les créneaux ne s'améliorent pas à court terme",
        ],
      },
      {
        heading: "Frais officiels du CEV en 2026",
        body:
          "Les frais de visa Schengen sont uniformes pour tous les États Schengen représentés au CEV. Ils sont fixés par le Code des visas européen et s'appliquent en euros, convertis en francs congolais ou en USD au taux du jour.",
        list: [
          "💶 Adulte (tarif standard) : 90 € ≈ 105 USD",
          "💶 Enfant de 6 à 12 ans : 45 €",
          "💶 Enfant de moins de 6 ans : gratuit",
          "Les frais sont réglés directement au CEV au moment du dépôt — pas de paiement en ligne",
          "Modes de paiement acceptés : USD cash, euros cash, francs congolais au taux du jour",
          "⚠️ Les frais ne sont pas remboursables en cas de refus — c'est une règle du Code des visas Schengen",
          "Voie de recours gratuite : en cas de refus, vous pouvez demander les motifs écrits et déposer un recours dans les 15 jours",
        ],
      },
      {
        heading: "Les 5 erreurs qui bloquent dès le guichet CEV",
        body:
          "Ces erreurs entraînent un refus de prise en charge au guichet — sans rembourser les frais. Elles s'ajoutent aux erreurs documentaires classiques.",
        list: [
          "❌ Pas de confirmation de rendez-vous imprimée ou accessible : le CEV refuse l'entrée sans justificatif de rendez-vous",
          "❌ Dossier incomplet à l'accueil : l'agent fait un contrôle rapide — si une pièce manque, le dossier est retourné et vous perdez votre créneau",
          "❌ Nom ou date de naissance différent entre le passeport et le compte Visa On Web : les deux doivent être strictement identiques",
          "❌ Arrivée en retard : passé votre créneau, vous n'êtes plus admis. Les retards de plus de 10 minutes entraînent l'annulation du rendez-vous",
          "❌ Formulaire Visa On Web non soumis avant le rendez-vous : le numéro VOW est vérifié à l'accueil",
        ],
      },
      {
        heading: "Comment Joventy accompagne votre dossier CEV",
        body:
          "Chez Joventy, nos conseillers prennent en charge l'intégralité de la procédure CEV pour vous — de la création du compte Visa On Web jusqu'au suivi après dépôt :",
        list: [
          "Création et configuration du compte Visa On Web à votre place",
          "Veille quotidienne des créneaux disponibles sur cev-kin.eu et réservation dès qu'une date correspond à votre planning",
          "Vérification complète de votre dossier papier avant le rendez-vous — aucun document manquant",
          "Préparation du formulaire de demande et de la lettre de motivation personnalisée selon votre profil",
          "Accompagnement au CEV le jour J si nécessaire",
          "Suivi du dossier sur Visa On Web après dépôt et transmission des résultats",
          "En cas de refus : analyse du motif et conseil pour le recours ou la nouvelle demande",
          "📱 Contactez notre équipe sur WhatsApp : +243 840 808 122",
        ],
      },
    ],
    faq: [
      {
        q: "Peut-on prendre rendez-vous au CEV sans compte Visa On Web ?",
        a: "Non. La création d'un compte sur visaonweb.be est obligatoire avant toute prise de rendez-vous au CEV. C'est le portail officiel belge qui génère votre numéro de dossier, vérifié à l'accueil du CEV.",
      },
      {
        q: "Le CEV à Kinshasa traite-t-il les visas pour tous les pays Schengen ?",
        a: "Non, pas tous. Le CEV représente plusieurs États Schengen — notamment la France, la Belgique, l'Allemagne, les Pays-Bas — mais pas l'Espagne ni la Suisse, qui gèrent leurs visas directement via leurs propres ambassades à Kinshasa. Vérifiez sur cev-kin.eu la liste des pays représentés avant de prendre rendez-vous.",
      },
      {
        q: "Que se passe-t-il si je rate mon rendez-vous CEV ?",
        a: "Si vous ratez votre créneau (retard, absence), le rendez-vous est annulé et vous devez en reprendre un nouveau sur cev-kin.eu. Aucun remboursement n'est prévu si les frais ont déjà été réglés. Il est donc essentiel d'arriver 15 minutes avant l'heure prévue.",
      },
      {
        q: "Peut-on déposer un dossier pour plusieurs membres d'une famille au même rendez-vous ?",
        a: "Oui, sous conditions. Lors de la prise de rendez-vous sur cev-kin.eu, vous pouvez indiquer le nombre de personnes. Chaque membre de la famille doit avoir son propre compte Visa On Web et son propre dossier. Les empreintes de chaque personne de plus de 12 ans sont prises individuellement.",
      },
      {
        q: "Le CEV de Lubumbashi accepte-t-il les mêmes demandes que celui de Kinshasa ?",
        a: "Oui. Le Consulat Général de Belgique à Lubumbashi accepte les demandes de visa Schengen dans les mêmes conditions que le CEV de Kinshasa. Si vous résidez au Katanga ou dans les provinces de l'est, c'est l'option la plus pratique.",
      },
      {
        q: "Quel est le délai entre la prise de rendez-vous et le résultat final ?",
        a: "En 2026 : comptez entre 3 et 8 semaines au total — délai d'attente pour le rendez-vous (1 à 6 semaines selon la saison) + délai de traitement (15 jours ouvrables réglementaires après le dépôt). Planifiez votre demande au minimum 2 mois avant votre date de voyage.",
      },
    ],
    relatedSlugs: [
      "documents-visa-schengen-kinshasa",
      "delais-visa-usa-canada-schengen-kinshasa-2025",
      "ees-schengen-2026-controle-biometrique",
    ],
    relatedDestination: "visa-schengen-kinshasa",
  },

  {
    slug: "visa-angleterre-kinshasa-rdv-2026",
    title: "Visa Angleterre depuis Kinshasa : UKVI, rendez-vous biométrique et procédure complète 2026",
    metaTitle: "Visa Angleterre Kinshasa 2026 — Rendez-vous UKVI, Documents, Prix | Joventy",
    metaDescription:
      "Visa Royaume-Uni depuis Kinshasa en 2026 : prise de rendez-vous UKVI, biométrie BLS International, documents exacts, coûts réels (£115+). Guide complet par Joventy.",
    publishedDate: "2026-07-01",
    updatedDate: "2026-07-04",
    readingTime: 9,
    category: "Visa Royaume-Uni",
    coverEmoji: "🇬🇧",
    intro:
      "Obtenir un visa pour le Royaume-Uni (Angleterre, Écosse, Pays de Galles, Irlande du Nord) depuis Kinshasa en 2026 demande une préparation rigoureuse. Contrairement aux visas Schengen ou aux e-Visas simples, la procédure UK est entièrement gérée par UK Visas and Immigration (UKVI) — le service d'immigration britannique — et passe par BLS International à Kinshasa pour la biométrie. Ce guide détaille chaque étape : de la création du compte UKVI à la prise de rendez-vous biométrique, en passant par les documents exacts exigés et les erreurs les plus fréquentes qui causent les refus pour les demandeurs congolais.",
    sections: [
      {
        heading: "Qui gère les visas UK à Kinshasa ? UKVI et BLS International",
        body:
          "Depuis 2023, les demandes de visa UK depuis Kinshasa passent par BLS International — le prestataire mandaté par UK Visas and Immigration (UKVI) pour collecter les biométries et dossiers en Afrique subsaharienne. Il n'y a plus de High Commission britannique qui reçoit directement les demandeurs à Kinshasa pour les visas visiteur.",
        list: [
          "📍 BLS International Kinshasa : collecte biométrique et dépôt de dossier — vérifiez l'adresse actuelle sur blsinternational.com (elle peut changer)",
          "Le formulaire de demande se remplit intégralement en ligne sur le portail UKVI (gov.uk/apply-uk-visa)",
          "Les frais consulaires UK sont payés en ligne en livres sterling (£) par carte",
          "Le dossier papier est remis uniquement lors du rendez-vous biométrique chez BLS",
          "UKVI prend la décision finale — BLS ne fait que collecter les biométries et transmettre",
          "Les demandeurs DRC ne bénéficient pas d'exemption de visa — le Standard Visitor Visa est obligatoire même pour 1 jour au UK",
        ],
      },
      {
        heading: "Les types de visa UK disponibles depuis Kinshasa",
        body:
          "Le type de visa dépend de la raison de votre voyage. Le plus demandé depuis Kinshasa est le Standard Visitor Visa (tourisme, famille, affaires courtes). Voici les principaux types disponibles :",
        list: [
          "🏖️ Standard Visitor Visa — tourisme, famille, affaires ≤6 mois : £115 (court séjour), £432 (2 ans multiple), £796 (5 ans), £963 (10 ans)",
          "🎓 Student Visa — études longue durée (cours >6 mois) : £490 — exige lettre CAS de l'université",
          "👨‍👩‍👧 Family Visa — rejoindre un conjoint/parent au UK : £1 846",
          "💼 Skilled Worker Visa — travail qualifié avec employeur sponsorisé : £719",
          "🔁 Transit Visa — si vous avez une escale au UK sans visa valide USA/Schengen/Canadien : £64",
          "⚠️ Le visa le plus fréquemment demandé — et refusé — depuis Kinshasa est le Standard Visitor Visa. Le taux de refus pour les passeports DRC est l'un des plus élevés d'Afrique subsaharienne en raison des contrôles d'immigration stricts.",
        ],
      },
      {
        heading: "Documents requis pour le Standard Visitor Visa depuis Kinshasa (2026)",
        body:
          "La liste suivante est basée sur les exigences UKVI 2026 et les spécificités de la situation des demandeurs congolais. Un dossier incomplet ou insuffisamment documenté est la première cause de refus.",
        list: [
          "Passeport valide au moins 6 mois après la date de retour prévue, avec 2 pages vierges minimum",
          "Photo biométrique récente (35×45 mm, fond blanc ou gris clair, moins de 6 mois — identique aux normes Schengen)",
          "Relevés bancaires des 6 derniers mois (solde minimum recommandé ≥ équivalent de 3 000 USD) — les relevés en FC doivent être accompagnés du taux de conversion officiel",
          "Justificatif d'emploi ou d'activité : attestation de travail avec salaire, contrat CDI, ou extrait RCCM pour les indépendants",
          "Lettre de motivation personnelle expliquant clairement le but du voyage, les dates, et le lien avec l'invitation (si applicable)",
          "Preuve d'hébergement : réservation hôtel confirmée (Booking.com accepté) ou lettre d'invitation notariée d'un proche résidant au UK",
          "Billets aller-retour (réservation ferme ou achetés — le UK est plus strict que Schengen sur ce point)",
          "Assurance voyage médicale valable au UK (le UK n'est plus dans l'espace Schengen depuis le Brexit)",
          "Preuve de liens forts avec la RDC : contrat de travail, titre foncier, acte de mariage, pièces d'identité des enfants en RDC",
          "Si voyage pour affaires : lettre d'invitation de la société britannique sur papier à en-tête, avec nom, adresse et numéro d'enregistrement Companies House",
          "Si mineur voyageant seul ou avec un seul parent : autorisation de sortie du territoire légalisée par les deux parents ou tuteur légal",
        ],
      },
      {
        heading: "Comment prendre rendez-vous pour un visa UK à Kinshasa — procédure étape par étape",
        body:
          "La procédure UK est entièrement en ligne avant le rendez-vous physique. Voici les étapes dans l'ordre exact à suivre :",
        list: [
          "Étape 1 : Créez un compte sur gov.uk/apply-uk-visa et choisissez le type de visa",
          "Étape 2 : Remplissez le formulaire en ligne (environ 45-60 minutes) — questions sur vos voyages passés, situation financière, famille, liens avec le Royaume-Uni",
          "Étape 3 : Payez les frais consulaires en ligne par carte (£115 pour le Standard Visitor) — le paiement est non remboursable",
          "Étape 4 : Prenez rendez-vous pour la biométrie chez BLS International Kinshasa via le portail UKVI (après le paiement)",
          "Étape 5 : Le jour du rendez-vous BLS — apportez votre formulaire imprimé, vos photos, et l'intégralité de votre dossier papier",
          "Étape 6 : BLS collecte vos empreintes digitales et votre photo (biométrie) et transmet votre dossier à UKVI",
          "Étape 7 : Délai de traitement UKVI : 3 à 8 semaines en standard (payez £500+ pour le traitement prioritaire en 5 jours ouvrables)",
          "Étape 8 : Résultat communiqué par email — en cas d'accord, votre vignette visa est apposée sur votre passeport envoyé par courrier ou à récupérer chez BLS",
        ],
      },
      {
        heading: "Pourquoi les visas UK sont-ils souvent refusés pour les demandeurs congolais ?",
        body:
          "UKVI applique une politique d'immigration très stricte envers les passeports DRC. Comprendre les raisons de refus permet de préparer un dossier solide. Ces refus sont quasi systématiquement liés à :",
        list: [
          "❌ Manque de preuves de retour en RDC : UKVI doit être convaincu que vous reviendrez au Congo après votre visite — un emploi stable, une famille, un bien immobilier sont essentiels",
          "❌ Finances insuffisantes ou non documentées : des relevés montrant des transactions irrégulières ou un solde insuffisant sont rédhibitoires",
          "❌ Lettre de motivation vague ou générique : 'je veux visiter Londres' ne suffit pas — UKVI veut le détail du programme, des contacts, des raisons concrètes",
          "❌ Incohérences entre le formulaire et les documents : dates de voyage, noms, adresses doivent être strictement identiques partout",
          "❌ Antécédents de refus non déclarés : le formulaire UKVI demande explicitement si des visas ont déjà été refusés — une fausse déclaration = ban automatique",
          "❌ Absence d'assurance voyage valide pour le UK (post-Brexit, la carte CEAM européenne n'est plus valable au Royaume-Uni)",
          "✅ Solution : un dossier béton avec preuves de retour, finances documentées sur 6 mois, programme de voyage précis, et lettre de motivation personnalisée",
        ],
      },
      {
        heading: "Comment Joventy accompagne votre demande de visa UK depuis Kinshasa",
        body:
          "Joventy prend en charge l'intégralité de votre dossier visa UK de A à Z, en ligne, sans que vous n'ayez à vous déplacer avant votre rendez-vous BLS :",
        list: [
          "Analyse préalable de votre profil : finances, emploi, situation familiale — identification des points faibles",
          "Remplissage complet du formulaire UKVI en ligne à votre place (évite les erreurs qui entraînent un refus immédiat)",
          "Rédaction de la lettre de motivation personnalisée selon votre situation spécifique",
          "Vérification et organisation de votre dossier papier avant le rendez-vous BLS — aucun document manquant",
          "Conseil sur les relevés bancaires : quels mois montrer, comment les présenter",
          "Accompagnement jusqu'au dépôt et suivi du dossier post-rendez-vous",
          "📱 Tout se passe par WhatsApp : +243 840 808 122",
          "💳 Paiement via M-Pesa, Airtel Money ou Orange Money — frais d'engagement 200 $ + prime de succès 600 $",
        ],
      },
    ],
    faq: [
      {
        q: "Faut-il se déplacer chez BLS International pour un visa UK depuis Kinshasa ?",
        a: "Oui, une fois uniquement — pour la biométrie (empreintes digitales + photo). Tout le reste de la procédure (formulaire, paiement) se fait en ligne. Joventy prépare tout votre dossier à distance avant ce rendez-vous unique.",
      },
      {
        q: "Combien coûte un visa UK (Angleterre) depuis Kinshasa en 2026 ?",
        a: "Les frais consulaires UK pour un Standard Visitor Visa sont de £115 (6 mois). Pour un visa multi-entrées 2 ans : £432, 5 ans : £796, 10 ans : £963. S'ajoutent les frais de service BLS (~50-80 USD) et les frais Joventy (200 $ engagement + 600 $ prime de succès). Le traitement prioritaire UKVI (5 jours ouvrables) coûte environ £500 supplémentaires.",
      },
      {
        q: "Quel est le délai pour obtenir un visa UK depuis Kinshasa ?",
        a: "En traitement standard : 3 à 8 semaines après le rendez-vous biométrique. En traitement prioritaire (payant, £500+) : 5 jours ouvrables. Planifiez votre demande au minimum 2 mois avant votre date de voyage.",
      },
      {
        q: "Peut-on obtenir un visa UK multi-entrées depuis Kinshasa ?",
        a: "Oui. UKVI propose des visas Standard Visitor multi-entrées valables 2, 5 ou 10 ans. Cependant, pour un premier visa UK, UKVI accorde souvent un visa court séjour (6 mois) pour évaluer le profil du demandeur. Un antécédent de respect des conditions de séjour augmente les chances d'obtenir un multi-entrées lors des demandes suivantes.",
      },
      {
        q: "Faut-il un visa pour transiter par le Royaume-Uni avec un passeport congolais ?",
        a: "Oui. Les titulaires d'un passeport DRC ont besoin d'un Direct Airside Transit Visa (DATV) pour transiter par un aéroport britannique, même sans quitter la zone de transit. Exception : si vous avez un visa valide USA, Canada, Australie, Nouvelle-Zélande, Schengen ou irlandais, le DATV peut ne pas être requis — vérifiez sur gov.uk/check-uk-visa.",
      },
    ],
    relatedSlugs: [
      "documents-visa-schengen-kinshasa",
      "visa-espagne-kinshasa-rendez-vous-ambassade-2026",
      "rendez-vous-cev-kinshasa-visa-schengen",
    ],
    relatedDestination: "visa-royaume-uni-kinshasa",
  },

  {
    slug: "centre-visa-chine-kinshasa-2026",
    title: "Centre de visa Chine à Kinshasa : VFS/CVSC, procédure complète et documents 2026",
    metaTitle: "Centre Visa Chine Kinshasa 2026 — VFS, Procédure, Documents, Prix | Joventy",
    metaDescription:
      "Visa Chine depuis Kinshasa en 2026 : Centre CVSC/VFS, portail visaforchina.org, documents requis, coûts réels (~170$), e-Visa court séjour. Guide complet par Joventy.",
    publishedDate: "2026-07-01",
    updatedDate: "2026-07-04",
    readingTime: 8,
    category: "Visa Chine",
    coverEmoji: "🇨🇳",
    intro:
      "Obtenir un visa pour la Chine depuis Kinshasa en 2026 : la procédure est plus complexe qu'il n'y paraît. La Chine a introduit un e-Visa court séjour (≤15 jours) en 2024 pour certaines nationalités — mais les passeports DRC ne figurent pas encore dans la liste des pays éligibles. Les ressortissants congolais doivent passer par le China Visa Application Service Center (CVSC), opéré par VFS Global à Kinshasa. Ce guide détaille la procédure exacte, les documents requis, les coûts réels et les particularités que peu de sources en français expliquent clairement.",
    sections: [
      {
        heading: "Où faire sa demande de visa Chine à Kinshasa ? Le CVSC/VFS",
        body:
          "Le China Visa Application Service Center (CVSC) à Kinshasa est opéré par VFS Global — le même prestataire qui gère les visas UK et d'autres pays. Ce centre collecte les dossiers et biométries au nom du Consulat Général de Chine à Kinshasa, qui prend la décision finale.",
        list: [
          "📍 CVSC Kinshasa (VFS Global) : vérifiez l'adresse actuelle sur visaforchina.org ou vfs-china-kinshasa.com avant de vous déplacer",
          "Horaires habituels : lundi–vendredi, 9h–12h pour le dépôt, 14h–16h pour le retrait des passeports",
          "Rendez-vous conseillé mais pas toujours obligatoire — vérifiez sur le site VFS Chine Kinshasa",
          "Le Consulat de Chine à Kinshasa (Avenue du 24 novembre, Gombe) ne reçoit pas directement les demandeurs pour les visas courants",
          "visaforchina.org : portail officiel chinois pour remplir le formulaire de demande de visa (V.2013)",
          "⚠️ Attention aux sites non officiels : 'visaforchina.com' (sans .org) ou les variantes sont des sites privés qui facturent des frais supplémentaires — utilisez uniquement .org",
        ],
      },
      {
        heading: "Types de visa chinois disponibles depuis Kinshasa",
        body:
          "La Chine utilise un système de lettres pour classer les visas selon le motif du séjour. Voici les types les plus demandés depuis Kinshasa :",
        list: [
          "🏖️ Visa L (Lǚyóu — Tourisme) : le plus demandé — séjour touristique, familial. Durée : 30 ou 90 jours. Validité : 3 mois ou 6 mois selon le profil",
          "💼 Visa M (Màoyì — Affaires/Commerce) : pour les commerçants, importateurs, foires commerciales. Très demandé depuis Kinshasa pour le commerce avec la Chine",
          "🔬 Visa F (Fǎng wèn — Échanges) : visite d'entreprise, invitation officielle, formations",
          "🎓 Visa X2 (Études ≤6 mois) : études courtes ou stage linguistique",
          "🔁 Visa G (Transit) : transit par la Chine sans visa valide pour la destination finale",
          "💡 E-Visa court séjour (≤15 jours) : disponible depuis 2024 pour certains pays — les passeports DRC NE sont PAS encore dans la liste éligible en juillet 2026. Vérifiez visaforchina.org pour les mises à jour.",
        ],
      },
      {
        heading: "Documents requis pour un visa Chine (visa L tourisme) depuis Kinshasa",
        body:
          "La liste suivante correspond aux exigences du Consulat de Chine à Kinshasa pour un visa L (tourisme) en 2026. Les exigences peuvent varier légèrement selon le type de visa.",
        list: [
          "Formulaire de demande V.2013 : rempli en ligne sur visaforchina.org, imprimé et signé (2 pages recto-verso en couleur)",
          "Passeport ordinaire valide au moins 6 mois après la fin du séjour prévu, avec au moins 2 pages vierges",
          "Copie de la page d'identité du passeport",
          "2 photos d'identité biométriques récentes (48×33 mm, fond blanc, sans lunettes — dimensions différentes du format Schengen !)",
          "Confirmation de réservation d'hôtel (ou invitation d'hébergement si logé chez un proche)",
          "Billet d'avion aller-retour (réservation ferme ou achetés)",
          "Relevés bancaires des 3 derniers mois (solde recommandé ≥ 1 500 USD, ou équivalent yuan CNY)",
          "Justificatif d'emploi ou d'activité en RDC (attestation de travail, extrait RCCM)",
          "Justificatif de domicile en RDC (facture eau/électricité)",
          "Pour les visas M (affaires) : lettre d'invitation de la société chinoise sur papier à en-tête avec cachet rouge officiel (obligatoire)",
          "Pour les mineurs : acte de naissance + autorisation des deux parents légalisée",
        ],
      },
      {
        heading: "Procédure étape par étape : visa Chine à Kinshasa",
        body:
          "Voici les étapes dans l'ordre exact, de la préparation à la réception du passeport avec visa :",
        list: [
          "Étape 1 : Remplissez le formulaire V.2013 sur visaforchina.org — créez un compte, complétez le formulaire, imprimez-le en couleur",
          "Étape 2 : Rassemblez tous les documents requis (voir liste ci-dessus) — le CVSC fait un contrôle strict à l'accueil",
          "Étape 3 : Prenez rendez-vous (si obligatoire) sur le site VFS Chine Kinshasa ou présentez-vous directement selon les instructions du moment",
          "Étape 4 : Déposez votre dossier au CVSC/VFS Kinshasa — payez les frais sur place en USD cash",
          "Étape 5 : Biométrie : empreintes digitales des 10 doigts (obligatoire pour la plupart des demandeurs, sauf enfants <12 ans et personnes >70 ans)",
          "Étape 6 : Délai de traitement : 4 à 5 jours ouvrables standard (traitement express : 2-3 jours moyennant frais supplémentaires)",
          "Étape 7 : Récupérez votre passeport au CVSC ou demandez un envoi par courrier",
        ],
      },
      {
        heading: "Coûts réels du visa Chine depuis Kinshasa en 2026",
        body:
          "Le coût total d'un visa chinois depuis Kinshasa comprend plusieurs postes que peu de sources détaillent clairement :",
        list: [
          "💰 Frais consulaires Chine (payés au CVSC) :",
          "→ Visa simple entrée : 140 USD",
          "→ Visa double entrée : 140 USD",
          "→ Visa multi-entrées (6 mois) : 140 USD",
          "→ Visa multi-entrées (12 mois) : 140 USD",
          "💰 Frais de service VFS/CVSC : environ 30 USD supplémentaires",
          "💰 Frais de traitement express (+2-3 jours) : environ 25-30 USD",
          "💰 Total indicatif pour un visa L tourisme standard : ~170 USD",
          "⚠️ Ces frais sont payés en USD cash au comptoir — aucune carte, aucun virement",
          "💳 Les frais Joventy (120 $ engagement + 180 $ prime de succès) sont séparés et payés via M-Pesa, Airtel ou Orange Money",
        ],
      },
      {
        heading: "Comment Joventy gère votre visa Chine depuis Kinshasa",
        body:
          "Joventy prend en charge toute la préparation à distance, de sorte que votre passage au CVSC soit le seul déplacement nécessaire :",
        list: [
          "Remplissage du formulaire V.2013 sur visaforchina.org à votre place (les erreurs de formulaire causent 40% des refus au guichet)",
          "Vérification complète du dossier avant le dépôt : dimensions photos, conformité des relevés, lettre d'invitation vérifiée",
          "Conseil sur le type de visa optimal selon votre profil (L tourisme vs M affaires vs F échanges)",
          "Pour les visas affaires (M) : vérification de la lettre d'invitation chinoise (cachet rouge, mentions obligatoires)",
          "Accompagnement post-dépôt : suivi du dossier et récupération du passeport",
          "📱 Contact WhatsApp : +243 840 808 122",
          "💳 Paiement M-Pesa, Airtel Money ou Orange Money",
        ],
      },
    ],
    faq: [
      {
        q: "Peut-on obtenir un visa Chine sans se déplacer au CVSC/VFS à Kinshasa ?",
        a: "Non. Le dépôt du dossier et la biométrie (empreintes digitales) doivent être effectués en personne au CVSC/VFS Kinshasa. Joventy prépare tout votre dossier à distance en amont — votre passage au CVSC se limite au dépôt et à la biométrie, sans avoir à remplir quoi que ce soit sur place.",
      },
      {
        q: "Combien de temps faut-il pour obtenir un visa Chine depuis Kinshasa ?",
        a: "En traitement standard : 4 à 5 jours ouvrables après le dépôt au CVSC. En traitement express : 2 à 3 jours ouvrables (frais supplémentaires d'environ 25-30 USD). Planifiez votre demande au minimum 3 semaines avant votre date de départ pour avoir de la marge.",
      },
      {
        q: "Le visa Chine permet-il d'entrer en Chine plusieurs fois ?",
        a: "Cela dépend du type de visa accordé. Un visa simple entrée (S) n'autorise qu'une seule entrée. Les visas multi-entrées (M) permettent plusieurs entrées pendant leur validité (3, 6 ou 12 mois). Pour un premier visa depuis Kinshasa, le Consulat accorde généralement un simple ou double entrée — les multi-entrées longue durée sont accordés aux demandeurs avec des antécédents de voyages en Chine.",
      },
      {
        q: "Les ressortissants congolais peuvent-ils utiliser l'e-Visa Chine ?",
        a: "Pas encore en juillet 2026. L'e-Visa court séjour (≤15 jours) lancé par la Chine en 2024 est disponible pour certains pays, mais la RDC ne figure pas dans la liste des nationalités éligibles. Vérifiez visaforchina.org régulièrement — la liste s'étend progressivement.",
      },
      {
        q: "Faut-il une invitation d'une entreprise chinoise pour un visa affaires (M) ?",
        a: "Oui, c'est obligatoire. Pour un visa M (commerce/affaires), le Consulat de Chine exige une lettre d'invitation officielle de votre partenaire commercial chinois, imprimée sur papier à en-tête de l'entreprise et tamponnée avec le cachet rouge officiel. La lettre doit mentionner : votre nom complet, le motif de la visite, les dates, l'entreprise hôte avec son numéro d'enregistrement. Joventy vérifie la conformité de ces lettres avant dépôt.",
      },
    ],
    relatedSlugs: [
      "visa-espagne-kinshasa-rendez-vous-ambassade-2026",
      "documents-visa-schengen-kinshasa",
      "guide-visa-bresil-kinshasa-2026",
    ],
    relatedDestination: "visa-chine-kinshasa",
  },
  {
    slug: "guide-visa-bresil-kinshasa-2026",
    title: "Visa Brésil depuis Kinshasa 2026 — Guide complet du dossier et du rendez-vous consulaire",
    metaTitle: "Visa Brésil Kinshasa 2026 — Dossier, Rendez-vous & Documents | Joventy",
    metaDescription:
      "Guide complet pour obtenir un visa Brésil depuis Kinshasa en 2026 : types de visa, documents requis, prise de rendez-vous consulaire et frais Joventy.",
    publishedDate: "2026-06-01",
    updatedDate: "2026-06-01",
    readingTime: 6,
    category: "Visa Brésil",
    coverEmoji: "🇧🇷",
    intro:
      "Le Brésil attire de plus en plus de voyageurs congolais pour le tourisme, les affaires et les études. Contrairement aux e-Visas de certains pays, la demande de visa brésilien depuis Kinshasa nécessite un dossier complet déposé sur rendez-vous à l'Ambassade du Brésil. Ce guide détaille les types de visa disponibles, les documents à préparer et comment Joventy accompagne chaque étape de votre demande.",
    sections: [
      {
        heading: "Quels types de visa Brésil sont disponibles depuis Kinshasa ?",
        body: "Le Brésil propose plusieurs catégories de visa selon le motif du séjour :",
        list: [
          "VITUR — Tourisme : pour les séjours touristiques, valable pour des visites de courte durée",
          "VITEM II — Affaires : pour les voyages professionnels, réunions et négociations commerciales",
          "VITEM IV — Études : pour suivre un programme d'études dans un établissement brésilien, nécessite une lettre d'admission",
        ],
      },
      {
        heading: "Quels documents sont nécessaires pour un visa Brésil ?",
        body: "Le dossier de demande de visa brésilien doit inclure les pièces suivantes :",
        list: [
          "Passeport valide 6 mois au-delà de la date d'entrée souhaitée",
          "Formulaire de demande de visa consulaire dûment rempli",
          "Photo d'identité récente fond blanc",
          "Justificatifs de situation professionnelle ou financière",
          "Réservation d'hôtel ou lettre d'invitation selon le motif du voyage",
          "Billet d'avion aller-retour ou itinéraire de voyage",
        ],
      },
      {
        heading: "Comment se déroule le rendez-vous consulaire ?",
        body: "La demande de visa brésilien se dépose exclusivement sur rendez-vous à l'Ambassade du Brésil à Kinshasa (Gombe). Une fois le dossier complet constitué, un rendez-vous est fixé pour le dépôt et, selon le cas, un entretien consulaire. Les délais de traitement varient selon la période de l'année et le type de visa demandé.",
      },
      {
        heading: "Comment Joventy vous accompagne pour votre visa Brésil",
        body: "Joventy prend en charge l'intégralité du processus, de la constitution du dossier jusqu'à l'obtention du visa :",
        list: [
          "Préparation et vérification complète de votre dossier",
          "Remplissage du formulaire de demande consulaire",
          "Prise en charge du rendez-vous à l'Ambassade du Brésil à Kinshasa",
          "Suivi de votre dossier jusqu'à l'obtention du visa",
        ],
      },
    ],
    faq: [
      {
        q: "Combien coûte le visa Brésil avec Joventy ?",
        a: "Frais Joventy : 200 USD d'engagement + 400 USD de prime de succès (payés uniquement à l'obtention du visa). Les frais consulaires brésiliens sont payés séparément directement à l'ambassade.",
      },
      {
        q: "Faut-il un rendez-vous pour déposer une demande de visa Brésil à Kinshasa ?",
        a: "Oui, le dépôt de dossier se fait exclusivement sur rendez-vous à l'Ambassade du Brésil à Kinshasa. Joventy organise ce rendez-vous une fois votre dossier complet.",
      },
      {
        q: "Quel est le délai de traitement du visa Brésil depuis Kinshasa ?",
        a: "Le délai dépend de la disponibilité des rendez-vous consulaires et du type de visa demandé. Joventy suit votre dossier de près et vous informe à chaque étape.",
      },
    ],
    relatedSlugs: [
      "comment-obtenir-creneau-visa-usa-kinshasa",
      "centre-visa-chine-kinshasa-2026",
    ],
    relatedDestination: "visa-bresil-kinshasa",
  },
];
export function getAllGuides(): Guide[] {
  return guides;
}

export function getGuideBySlug(slug: string): Guide | undefined {
  return guides.find((g) => g.slug === slug);
}

export function getGuidesByCategory(category: string): Guide[] {
  return guides.filter((g) => g.category === category);
}

export function getRelatedGuides(slugs: string[]): Guide[] {
  return slugs
    .map((s) => getGuideBySlug(s))
    .filter((g): g is Guide => g !== undefined);
}
