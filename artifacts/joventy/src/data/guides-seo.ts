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
    title: "Comment obtenir un créneau visa USA à Kinshasa en 2026",
    metaTitle: "Créneau Visa USA Kinshasa 2026 — Guide Complet | Joventy",
    metaDescription:
      "Le portail usvisaappt.com affiche souvent « aucune date disponible ». Découvrez comment obtenir un créneau d'entretien visa américain à Kinshasa rapidement grâce au suivi permanent de notre équipe.",
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
    title: "Documents requis pour un visa Schengen depuis Kinshasa (liste complète 2026)",
    metaTitle: "Documents Visa Schengen Kinshasa 2026 — Liste Complète | Joventy",
    metaDescription:
      "Liste officielle des documents requis pour un visa Schengen depuis Kinshasa en 2026. Relevés bancaires, assurance voyage, lettre d'invitation — tout ce qu'il faut préparer.",
    publishedDate: "2025-05-10",
    updatedDate: "2026-05-31",
    readingTime: 8,
    category: "Visa Schengen",
    coverEmoji: "🇪🇺",
    intro:
      "Le visa Schengen permet de voyager librement dans 27 pays européens avec un seul visa. Depuis Kinshasa, les demandes se déposent auprès du Centre de Visas Européens (CEV). En 2026, les frais consulaires sont passés à 90 € par adulte, le système EES (Entry/Exit System) est désormais opérationnel aux frontières, et la digitalisation du visa progresse. Ce guide détaille la liste complète des documents exigés, les erreurs fréquentes qui entraînent un refus, et les astuces pour renforcer votre dossier.",
    sections: [
      {
        heading: "Documents d'identité et de voyage",
        body: "Ces documents constituent le socle de tout dossier Schengen :",
        list: [
          "Passeport valide encore au moins 3 mois après la date de retour prévue, avec au moins 2 pages vierges",
          "Copie de toutes les pages du passeport actuel (y compris les pages vierges)",
          "Copies des passeports précédents contenant des visas Schengen ou américains",
          "2 photos d'identité récentes conformes au format Schengen (35×45 mm, fond blanc, moins de 6 mois)",
          "Formulaire de demande Schengen complété et signé (disponible sur le site du CEV)",
        ],
      },
      {
        heading: "Documents financiers",
        body:
          "C'est la partie du dossier qui fait le plus souvent l'objet de refus. Les consulats exigent la preuve que vous pouvez subvenir à vos besoins pendant votre séjour (environ 100 € par jour, par personne) :",
        list: [
          "Relevés bancaires des 6 derniers mois (compte courant ET compte épargne si possible)",
          "Attestation bancaire originale avec solde actuel, à demander à votre banque maximum 3 jours avant le dépôt",
          "Fiches de paie des 3 derniers mois ou dernier avis d'imposition",
          "Contrat de travail ou attestation d'emploi avec date d'embauche et salaire",
          "Si indépendant : patente commerciale, états financiers de l'entreprise",
          "Si la famille finance le voyage : acte de tutelle + relevés bancaires du garant + lettre d'engagement",
        ],
      },
      {
        heading: "Documents de séjour et d'itinéraire",
        body: "Vous devez prouver où vous serez logé et le but de votre voyage :",
        list: [
          "Réservation d'hôtel pour toute la durée du séjour (remboursable de préférence)",
          "OU lettre d'invitation d'un particulier avec ses coordonnées, preuve de domicile (justificatif < 3 mois), et copie de son titre de séjour/passeport UE",
          "Itinéraire de voyage détaillé (vols, hôtels, activités prévues)",
          "Réservation de vol aller-retour (confirmée mais remboursable — ne payez pas avant d'avoir le visa)",
        ],
      },
      {
        heading: "Assurance voyage médicale (obligatoire)",
        body:
          "L'assurance voyage est une obligation légale pour tout visa Schengen. Elle doit couvrir :",
        list: [
          "Couverture minimale de 30 000 € pour les frais médicaux et le rapatriement",
          "Valable dans les 27 pays Schengen (pas uniquement le pays de destination)",
          "Valable pour toute la durée du séjour, du jour d'entrée au jour de sortie",
          "Compagnies acceptées : Europ Assistance, AXA, Allianz, Chapka — environ 20 à 50 USD/semaine",
        ],
      },
      {
        heading: "Documents prouvant vos attaches en RDC",
        body:
          "Le consulat doit être convaincu que vous rentrerez. Ces documents rassurent le consul :",
        list: [
          "Titre de propriété d'un bien immobilier en RDC",
          "Acte de mariage et/ou actes de naissance de vos enfants résidant en RDC",
          "Contrat de travail à durée indéterminée avec autorisation de congé signée",
          "Preuve d'inscription scolaire si vous êtes étudiant (carte étudiante + calendrier académique)",
          "Extrait du registre de commerce si vous êtes entrepreneur",
        ],
      },
      {
        heading: "Spécificités selon le type de visa",
        body: "Le motif de votre voyage détermine des documents supplémentaires :",
        list: [
          "Tourisme : programme touristique détaillé, billets de musées/événements si possible",
          "Affaires : invitation d'une entreprise européenne sur papier à en-tête officiel",
          "Étudiant : lettre d'admission d'une école européenne + preuve de financement des études",
          "Médical : lettre du médecin en RDC + confirmation de rendez-vous hospitalier en Europe",
          "Famille : acte de mariage/naissance + documents de résidence du membre de famille en Europe",
        ],
      },
    ],
    faq: [
      {
        q: "Combien d'argent faut-il avoir sur son compte pour un visa Schengen depuis Kinshasa ?",
        a: "Le montant recommandé est d'environ 100 € par jour de séjour. Pour un voyage de 14 jours, visez 1 400 € minimum sur votre compte. Des fonds supérieurs (3 000 à 5 000 €) augmentent considérablement vos chances d'approbation, car ils prouvent une stabilité financière solide.",
      },
      {
        q: "Doit-on acheter les billets d'avion avant de déposer le visa Schengen ?",
        a: "Non. Il est fortement déconseillé d'acheter des billets non remboursables avant d'avoir le visa. Utilisez une réservation de vol confirmée mais remboursable, ou un service de réservation temporaire de vol (flight itinerary). Joventy inclut cette option dans son service.",
      },
      {
        q: "Combien de temps faut-il pour obtenir un visa Schengen depuis Kinshasa ?",
        a: "Le traitement prend en général 15 à 30 jours calendaires. Déposez votre dossier au moins 6 semaines avant votre voyage prévu. En période de forte affluence (vacances d'été, fêtes de fin d'année), comptez 4 à 6 semaines.",
      },
      {
        q: "Peut-on déposer un visa Schengen pour plusieurs pays à la fois ?",
        a: "Un seul visa Schengen vous permet de voyager dans les 27 pays de l'espace Schengen. Vous devez déposer auprès de l'ambassade du pays principal de séjour (celui où vous passerez le plus de nuits), ou du pays d'entrée si les séjours sont équivalents.",
      },
    ],
    relatedSlugs: [
      "comment-obtenir-creneau-visa-usa-kinshasa",
      "delais-visa-usa-canada-schengen-kinshasa-2025",
      "visa-usa-refuse-que-faire",
    ],
    relatedDestination: "visa-schengen-kinshasa",
  },

  {
    slug: "entretien-visa-usa-b1-b2-questions",
    title: "Préparer l'entretien visa B1/B2 USA : 15 questions fréquentes et comment y répondre",
    metaTitle: "Entretien Visa B1/B2 USA Kinshasa — 15 Questions & Réponses | Joventy",
    metaDescription:
      "L'officier consulaire américain de Kinshasa pose toujours les mêmes questions. Découvrez les 15 questions les plus fréquentes de l'entretien visa B1/B2 et comment y répondre pour maximiser vos chances.",
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
    title: "Visa USA refusé depuis Kinshasa : que faire après un refus 214(b) ?",
    metaTitle: "Visa USA Refusé Kinshasa — Que Faire ? Guide 214(b) | Joventy",
    metaDescription:
      "Votre visa américain a été refusé sous l'article 214(b) à Kinshasa ? Ce guide vous explique pourquoi, comment renforcer votre dossier, et quand représenter votre demande.",
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
      "comment-obtenir-creneau-visa-usa-kinshasa",
      "entretien-visa-usa-b1-b2-questions",
      "documents-visa-schengen-kinshasa",
    ],
    relatedDestination: "visa-usa-kinshasa",
  },

  {
    slug: "payer-frais-mrv-visa-usa-kinshasa",
    title: "Comment payer les frais de visa USA depuis la RDC (guide 2026)",
    metaTitle: "Payer Frais Visa USA depuis RDC 2026 — Guide Complet | Joventy",
    metaDescription:
      "Les frais de visa américain (185 à 210 USD selon le type) se paient via des canaux spécifiques en RDC. Guide étape par étape pour payer correctement les frais de visa USA depuis Kinshasa via usvisaappt.com.",
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
    title: "Délais d'attente visa USA, Canada et Schengen à Kinshasa en 2026",
    metaTitle: "Délais Visa USA Canada Schengen Kinshasa 2026 | Joventy",
    metaDescription:
      "Combien de temps pour obtenir un visa USA, Canada ou Schengen depuis Kinshasa en 2026 ? Délais réels constatés, périodes à éviter, suspension Canada Ebola, et comment réduire l'attente.",
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
      { heading: "Alternatives de voyage sans restriction", body: "Si votre voyage ne peut pas attendre et que vous ne pouvez pas faire les 21 jours de transit :", list: ["🇦🇪 Dubaï (e-Visa) : 48 à 72h, aucune restriction liée à Ebola pour les Congolais", "🇹🇷 Turquie (e-Visa ou VFS) : 48h à 4 semaines, pas de restriction d'entrée", "🇪🇺 Schengen : dossier et créneau CEV toujours ouverts (pas de restriction d'entrée pour les Congolais, mais EES biométrique à l'arrivée)", "🇬🇧 Royaume-Uni : demandes UKVI toujours acceptées, pas de restriction Ebola", "Ces destinations peuvent aussi servir de transit de 21 jours avant d'aller aux USA/Canada/Mexique"] },
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
    title: "EES Schengen 2026 : le nouveau contrôle biométrique aux frontières européennes",
    metaTitle: "EES Schengen 2026 — Contrôle Biométrique Frontières Europe | Joventy",
    metaDescription: "Le système EES est opérationnel depuis avril 2026 aux frontières Schengen. Empreintes, scan facial, fin des tampons. Ce que les voyageurs congolais doivent savoir.",
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
      { heading: "Interdiction d'entrée aux USA, Canada et Mexique (règle des 21 jours)", body: "Les trois pays hôtes de la Coupe du Monde 2026 ont mis en place des restrictions d'entrée strictes :", list: ["🇺🇸 USA : Le CDC a émis un ordre le 18 mai 2026 interdisant l'entrée aux non-citoyens américains ayant séjourné en RDC, Ouganda ou Sud-Soudan dans les 21 jours précédents — y compris les détenteurs de Green Card", "🇨🇦 Canada : Suspension totale des visas pour les résidents RDC + quarantaine obligatoire de 21 jours (27 mai — 28 août 2026)", "🇲🇽 Mexique : Restriction d'entrée par voie aérienne pour toute personne ayant séjourné en RDC, Ouganda ou Sud-Soudan dans les 21 derniers jours (Aeromexico, Volaris, Viva — 60 jours)", "Cela s'applique à TOUTE personne (congolaise ou non) ayant été physiquement présente dans ces pays", "Les citoyens américains peuvent entrer mais subissent un screening sanitaire renforcé", "Les arrivées aux USA sont limitées à certains aéroports désignés (Dulles, Atlanta)"] },
      { heading: "Impact sur les demandes de visa depuis Kinshasa", body: "Voici ce qui change et ce qui ne change pas :", list: ["✅ L'ambassade US à Kinshasa continue de traiter les demandes de visa", "✅ Vous POUVEZ obtenir un visa américain — le visa est délivré même si l'entrée est temporairement restreinte", "✅ Le portail usvisaappt.com fonctionne normalement pour la RDC", "⚠️ MAIS même avec un visa valide, vous ne pouvez PAS entrer aux USA si vous étiez en RDC dans les 21 jours précédents", "⚠️ Solution obligatoire : quitter la RDC et séjourner 21 jours dans un pays tiers AVANT de prendre votre vol vers les USA", "⚠️ Le personnel américain non-essentiel a été évacué — les délais de traitement peuvent augmenter"] },
      { heading: "La stratégie des 21 jours : comment entrer aux USA malgré la restriction", body: "La seule solution est de passer 21 jours hors de la RDC avant d'entrer aux USA :", list: ["Quittez la RDC au moins 21 jours avant votre date d'entrée souhaitée aux USA", "Séjournez dans un pays tiers non-concerné par la restriction (Europe, Dubaï, Afrique du Sud, Kenya...)", "L'équipe nationale RDC a fait exactement cela : départ de Kinshasa le 20 mai, 21 jours en Europe, puis entrée aux USA", "Pays recommandés pour le transit : Turquie (e-Visa facile), Dubaï (e-Visa 48h), pays Schengen (si vous avez un visa)", "Gardez toutes les preuves de votre séjour hors RDC (billets, hôtel, tampons de passeport)", "Joventy peut organiser un itinéraire combiné : Kinshasa → Transit 21j → USA"] },
      { heading: "Alternative : demander le visa depuis un pays tiers", body: "Si vous êtes déjà hors de la RDC depuis plus de 21 jours :", list: ["Vous pouvez demander un visa USA depuis un autre pays où vous séjournez légalement", "Options populaires : Brazzaville, Nairobi, Johannesburg, Paris (si vous avez un visa Schengen)", "L'entretien Third Country National (TCN) est accepté par de nombreuses ambassades", "Avantage : si vous êtes hors RDC depuis 21+ jours, vous pouvez entrer aux USA dès l'obtention du visa", "Joventy peut vous conseiller sur la meilleure ambassade alternative selon votre profil"] },
    ],
    faq: [
      { q: "Le Travel Advisory Level 4 empêche-t-il d'obtenir un visa USA ?", a: "Non. Le Level 4 n'empêche pas de demander et obtenir un visa. MAIS attention : même avec un visa valide, vous ne pouvez pas entrer aux USA si vous étiez en RDC dans les 21 jours précédents. Il faut obligatoirement transiter 21 jours dans un pays tiers avant votre vol." },
      { q: "L'ambassade US à Kinshasa est-elle fermée ?", a: "Non. L'ambassade reste ouverte et continue de traiter les demandes de visa. Les entretiens consulaires ont lieu. Certains services non-essentiels peuvent être réduits et les délais légèrement plus longs." },
      { q: "Puis-je entrer aux USA directement depuis Kinshasa ?", a: "Non. Depuis le 18 mai 2026, les non-citoyens américains ayant séjourné en RDC, Ouganda ou Sud-Soudan dans les 21 jours précédents sont interdits d'entrée aux USA. Vous devez obligatoirement passer 21 jours dans un pays tiers (Europe, Dubaï, etc.) avant de vous rendre aux USA. Cette règle s'applique même si vous avez un visa valide et même aux détenteurs de Green Card." },
      { q: "La même restriction s'applique-t-elle au Canada et au Mexique ?", a: "Oui. Le Canada a suspendu tous les visas pour les résidents RDC et impose une quarantaine de 21 jours. Le Mexique restreint l'entrée par avion pour toute personne ayant séjourné en RDC dans les 21 derniers jours. Les trois pays hôtes de la Coupe du Monde appliquent la règle des 21 jours." },
      { q: "Combien de temps ces restrictions vont-elles durer ?", a: "L'ordre du CDC américain est initialement prévu pour 30 jours (renouvelable). La suspension canadienne court jusqu'au 28 août 2026. Les restrictions mexicaines sont en place pour 60 jours. Toutes peuvent être prolongées si l'épidémie persiste." },
    ],
    relatedSlugs: ["comment-obtenir-creneau-visa-usa-kinshasa", "coupe-du-monde-2026-visa-usa-kinshasa", "visa-usa-refuse-que-faire"],
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
      { heading: "Les meilleurs pays neutres pour purger les 21 jours", body: "Tous les pays ne sont pas des options valables. Les pays voisins de la RDC sont classés « à haut risque » par l'Africa CDC (Congo-Brazza, Angola, Burundi, Kenya, Rwanda, Tanzanie) et pourraient être ajoutés à la liste à tout moment. Privilégiez ces destinations :", list: ["🇦🇪 DUBAÏ (EAU) — TOP CHOIX : e-Visa en 48h, aucune restriction Ebola, vols directs depuis Kinshasa, hébergement abordable, communauté congolaise", "🇹🇷 TURQUIE (Istanbul) — EXCELLENT : e-Visa en 24-48h pour détenteurs de visa USA ou Schengen valide, pas de restriction, vols fréquents, hébergement très abordable", "🇫🇷 FRANCE / 🇧🇪 BELGIQUE — IDÉAL SI VISA SCHENGEN : si vous avez un visa Schengen multi-entrées valide, séjour immédiat sans démarche. Grande diaspora congolaise", "🇬🇧 ROYAUME-UNI — OPTION : si vous avez un visa UK valide, Londres est sûre et bien connectée aux USA", "🇲🇺 ÎLE MAURICE — SANS VISA : les Congolais n'ont PAS besoin de visa pour Maurice (≤ 90 jours). Destination calme pour 21 jours", "⚠️ ÉVITEZ les pays voisins de la RDC — même s'ils ne sont pas interdits aujourd'hui, ils peuvent l'être demain"] },
      { heading: "Option 1 : Vous avez déjà un visa Schengen ou USA multi-entrées", body: "Si vous possédez un visa Schengen ou USA à entrées multiples encore valide, vous avez des options immédiates sans aucune nouvelle demande de visa :", list: ["Visa Schengen multi-entrées valide → envolez-vous vers la France, Belgique, Allemagne ou Espagne. Séjour 21 jours sans aucune démarche supplémentaire", "Visa USA multi-entrées valide → votre visa reste valable mais vous ne pouvez pas entrer aux USA avant les 21 jours. Utilisez la Turquie (e-Visa gratuit avec visa USA valide) ou Dubaï pour le transit", "Visa Turquie (e-Visa) → accessible immédiatement aux détenteurs d'un visa USA ou Schengen valide. Obtention en 24h en ligne", "Île Maurice → aucun visa nécessaire pour les Congolais. Billet d'avion suffisant", "Conseil : choisissez un pays avec des vols directs vers votre destination finale (USA/Canada/Mexique)"] },
      { heading: "Option 2 : Vous n'avez PAS de visa — Joventy vous aide", body: "Si vous n'avez ni visa Schengen ni visa pour un pays neutre, Joventy peut vous obtenir rapidement un visa pour passer vos 21 jours. Contactez-nous sur WhatsApp :", list: ["🇦🇪 E-Visa Dubaï : Joventy soumet votre demande sur le portail ICP des EAU → résultat en 48-72h. Frais Joventy : 80 USD engagement + 120 USD prime de succès", "🇹🇷 E-Visa Turquie : si éligible (visa USA ou Schengen valide), obtention en 24h. Frais Joventy : 80 USD + 120 USD", "🇪🇺 Visa Schengen express : Joventy prend votre créneau CEV en urgence et prépare votre dossier complet. Frais : 150 USD + 450 USD. Délai : 2-4 semaines", "🇲🇺 Île Maurice : AUCUN VISA NÉCESSAIRE — il suffit d'un billet d'avion et d'un passeport valide", "📱 Contactez Joventy maintenant sur WhatsApp : +243 840 808 122 — réponse en moins de 2h", "Notre équipe analyse votre situation, vos visas existants et votre budget pour vous proposer la solution la plus rapide"] },
      { heading: "Budget estimé : 21 jours dans un pays neutre", body: "Voici les budgets réalistes pour 21 jours (vol depuis Kinshasa + hébergement + vie quotidienne) :", list: ["🇦🇪 Dubaï : Vol 500-800 USD + hébergement 600-1200 USD + vie 400-700 USD = TOTAL 1 500 à 2 700 USD", "🇹🇷 Istanbul : Vol 400-700 USD + hébergement 400-900 USD + vie 300-500 USD = TOTAL 1 100 à 2 100 USD", "🇫🇷 Paris : Vol 600-1000 USD + hébergement 800-1500 USD + vie 500-900 USD = TOTAL 1 900 à 3 400 USD", "🇧🇪 Bruxelles : Vol 600-900 USD + hébergement 700-1200 USD + vie 400-700 USD = TOTAL 1 700 à 2 800 USD", "🇲🇺 Île Maurice : Vol 500-800 USD + hébergement 400-800 USD + vie 300-500 USD = TOTAL 1 200 à 2 100 USD", "💡 Astuce : Airbnb et locations meublées sont 30-50% moins chers qu'un hôtel pour 21 nuits"] },
      { heading: "Plan d'action étape par étape", body: "Voici exactement ce que vous devez faire :", list: ["1. Contactez Joventy sur WhatsApp (+243 840 808 122) — nous analysons vos visas existants, votre budget et votre urgence", "2. Si besoin d'un visa pour le pays neutre → Joventy lance la demande immédiatement (Dubaï 48h, Turquie 24h)", "3. Réservez votre vol Kinshasa → pays neutre DÈS que le visa de transit est confirmé", "4. Réservez un hébergement pour 22 nuits minimum (21 jours + 1 jour de marge de sécurité)", "5. À votre arrivée dans le pays neutre, conservez TOUTES les preuves de présence (hôtel, achats, billets)", "6. Le jour 22 après votre départ de RDC, prenez votre vol vers les USA/Canada/Mexique", "7. À l'arrivée, les agents frontaliers vérifieront vos dates — montrez vos preuves si demandé"] },
      { heading: "Documents à conserver comme preuve de transit", body: "Les compagnies aériennes ET les agents frontaliers vérifieront que vous respectez les 21 jours. Gardez :", list: ["Carte d'embarquement du vol Kinshasa → pays neutre (avec date de départ de RDC)", "Tampon d'entrée dans le passeport du pays neutre", "Confirmation de réservation hôtel/Airbnb pour 21+ nuits", "Reçus de paiement dans le pays neutre (restaurants, commerces — prouvent votre présence physique)", "Relevé de carte bancaire montrant des transactions sur 21+ jours dans le pays neutre", "⚠️ La compagnie aérienne peut refuser votre embarquement vers les USA si vous ne pouvez pas prouver les 21 jours"] },
    ],
    faq: [
      { q: "Puis-je purger mes 21 jours au Congo-Brazzaville ou en Angola ?", a: "Techniquement oui (le CDC ne les interdit pas actuellement), MAIS l'Africa CDC les classe « à haut risque » et ils pourraient être ajoutés à la liste du jour au lendemain. Joventy recommande fortement un pays hors Afrique centrale (Dubaï, Turquie, Europe, Maurice) pour zéro risque. Contactez-nous : +243 840 808 122." },
      { q: "Mon visa Schengen est expiré mais mon visa USA multi-entrées est valide. Que faire ?", a: "Avec un visa USA valide, vous pouvez obtenir un e-Visa Turquie en 24h (la Turquie accepte les détenteurs de visa USA). Sinon, l'e-Visa Dubaï ne nécessite aucun autre visa et s'obtient en 48h. L'île Maurice ne nécessite aucun visa. Joventy gère tout : WhatsApp +243 840 808 122." },
      { q: "Les 21 jours commencent-ils le jour de mon départ de Kinshasa ?", a: "Le compteur commence le jour APRÈS votre dernier jour en RDC. Si vous quittez Kinshasa le 1er juin, votre jour 1 est le 2 juin, et vous pouvez entrer aux USA à partir du 23 juin (jour 22). Prévoyez 1-2 jours de marge supplémentaire." },
      { q: "Que se passe-t-il si j'arrive aux USA avant les 21 jours ?", a: "Vous serez refoulé. La compagnie aérienne refusera probablement votre embarquement car elle vérifie les dates avant le vol. Si vous passez malgré tout, les agents CBP (Customs and Border Protection) vous interdiront l'entrée à l'arrivée. Ne prenez AUCUN risque." },
      { q: "Joventy peut-il organiser tout le transit de A à Z ?", a: "Oui. Joventy propose un accompagnement complet : obtention du visa pays neutre (Dubaï 48h, Turquie 24h), conseils vols et hébergements, suivi de votre dossier visa USA/Canada en parallèle, et assistance WhatsApp tout au long des 21 jours. Contactez-nous : +243 840 808 122." },
      { q: "Je suis étranger (non-congolais) mais j'étais en RDC. Suis-je aussi concerné ?", a: "Oui. La restriction s'applique à TOUTE personne ayant été physiquement présente en RDC, Ouganda ou Sud-Soudan dans les 21 derniers jours, quelle que soit sa nationalité. Un Français, un Belge ou un Américain ayant séjourné à Kinshasa est soumis à la même règle." },
    ],
    relatedSlugs: ["travel-advisory-level-4-rdc-visa-usa-2026", "coupe-du-monde-2026-visa-usa-kinshasa", "suspension-visa-canada-rdc-ebola-2026"],
    relatedDestination: "visa-usa-kinshasa",
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
