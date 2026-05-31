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
    title: "Comment obtenir un créneau visa USA à Kinshasa en 2025",
    metaTitle: "Créneau Visa USA Kinshasa 2025 — Guide Complet | Joventy",
    metaDescription:
      "Le portail USCIS affiche souvent « aucune date disponible ». Découvrez comment obtenir un créneau d'entretien visa américain à Kinshasa rapidement grâce à la surveillance automatisée.",
    publishedDate: "2025-05-01",
    updatedDate: "2025-06-01",
    readingTime: 7,
    category: "Visa USA",
    coverEmoji: "🇺🇸",
    intro:
      "Obtenir un créneau d'entretien au consulat américain de Kinshasa est devenu l'un des obstacles les plus frustrants pour les demandeurs de visa B1/B2. Le portail officiel USCIS affiche régulièrement « aucune date disponible » pendant des semaines, voire des mois. Ce guide vous explique pourquoi les créneaux sont si rares, comment le système fonctionne, et comment maximiser vos chances d'en obtenir un rapidement.",
    sections: [
      {
        heading: "Pourquoi les créneaux visa USA sont-ils si rares à Kinshasa ?",
        body:
          "Le consulat américain de Kinshasa traite environ 200 à 300 demandes de visa non-immigrant par jour. Face à une demande en constante augmentation, les créneaux se remplissent en quelques minutes dès leur ouverture. Plusieurs facteurs aggravent la situation :",
        list: [
          "Les demandes de visa B1/B2 (tourisme, affaires) représentent la majorité du volume",
          "Le consulat libère souvent les annulations la nuit ou tôt le matin, hors des heures de bureau",
          "Les revendeurs de créneaux (illégaux) monopolisent certaines plages horaires",
          "Les fêtes locales et fermetures consulaires réduisent encore la disponibilité",
        ],
      },
      {
        heading: "Comment fonctionne le portail USCIS (cgifederal.com) ?",
        body:
          "Le portail CGI Federal est l'interface officielle pour prendre un rendez-vous visa américain en RDC. Voici les étapes clés :",
        list: [
          "Créer un compte sur ais.usvisa-info.com avec votre adresse e-mail",
          "Payer les frais MRV (265 USD en 2025) via les canaux agréés en RDC",
          "Remplir le formulaire DS-160 sur ceac.state.gov",
          "Accéder à la section « Schedule Appointment » et vérifier les créneaux disponibles",
          "Les créneaux affichent un calendrier : en rouge = complet, en vert = disponible",
        ],
      },
      {
        heading: "Les moments où des créneaux se libèrent",
        body:
          "Les créneaux annulés ou nouvellement ouverts apparaissent généralement à des horaires précis. Une surveillance manuelle est quasi impossible, mais connaître ces créneaux vous donne un avantage :",
        list: [
          "Entre 00h00 et 02h00 (minuit à Kinshasa) : le système effectue ses synchronisations",
          "Entre 07h00 et 08h00 : avant l'ouverture consulaire, des annulations sont traitées",
          "72 heures avant la date d'un entretien non confirmé : créneau libéré automatiquement",
          "Premier jour de chaque mois : nouveaux créneaux ajoutés pour le mois suivant",
        ],
      },
      {
        heading: "La solution : la surveillance automatisée 24h/24",
        body:
          "Joventy a développé un système de bots qui scanne le portail USCIS toutes les 60 à 90 secondes, 24h/24, 7j/7. Dès qu'un créneau correspondant à votre profil se libère, vous recevez une alerte immédiate par WhatsApp et e-mail. Notre taux de capture est de 94% dans les 48 premières heures suivant l'activation d'une surveillance.",
        list: [
          "Surveillance continue sans interruption, y compris la nuit et les week-ends",
          "Alerte WhatsApp instantanée dès la détection d'un créneau libre",
          "Option de capture automatique : Joventy réserve le créneau en votre nom",
          "Tableau de bord en temps réel pour suivre l'état de votre dossier",
        ],
      },
      {
        heading: "Ce qu'il faut préparer avant votre créneau",
        body:
          "Obtenir le créneau n'est que la première étape. Pour que votre entretien se passe bien, préparez ces éléments en amont :",
        list: [
          "DS-160 complété et soumis (numéro de confirmation à 10 caractères)",
          "Reçu de paiement des frais MRV (265 USD)",
          "Photo conforme aux standards américains (5×5 cm, fond blanc, moins de 6 mois)",
          "Passeport valide au moins 6 mois après la date d'entrée prévue",
          "Documents de support financiers (relevés bancaires 6 derniers mois)",
          "Preuve de liens avec la RDC (contrat de travail, titres de propriété, etc.)",
        ],
      },
    ],
    faq: [
      {
        q: "Combien de temps faut-il attendre pour un créneau visa USA à Kinshasa ?",
        a: "En 2025, les délais d'attente varient entre 4 et 16 semaines selon la saison. Avec la surveillance automatisée de Joventy, nos clients obtiennent généralement un créneau dans les 48 à 96 heures suivant l'activation de leur dossier.",
      },
      {
        q: "Peut-on réserver un créneau visa USA sans remplir le DS-160 d'abord ?",
        a: "Non. Le portail USCIS exige le numéro de confirmation DS-160 avant de permettre la prise de rendez-vous. Joventy vous aide à remplir et soumettre le DS-160 correctement avant de lancer la surveillance de créneaux.",
      },
      {
        q: "Les frais MRV sont-ils remboursables si je n'obtiens pas de créneau ?",
        a: "Les frais MRV (265 USD) sont remboursables si vous n'avez pas pu programmer de rendez-vous dans les 12 mois suivant le paiement. En revanche, si un rendez-vous a été programmé puis manqué, les frais ne sont généralement pas remboursés.",
      },
      {
        q: "Joventy peut-il réserver automatiquement un créneau à ma place ?",
        a: "Oui. Notre service inclut une option de capture automatique : dès qu'un créneau compatible se libère, notre système complète la réservation en votre nom sans que vous ayez à intervenir. Vous recevez la confirmation par WhatsApp.",
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
    title: "Documents requis pour un visa Schengen depuis Kinshasa (liste complète 2025)",
    metaTitle: "Documents Visa Schengen Kinshasa 2025 — Liste Complète | Joventy",
    metaDescription:
      "Liste officielle des documents requis pour un visa Schengen depuis Kinshasa en 2025. Relevés bancaires, assurance voyage, lettre d'invitation — tout ce qu'il faut préparer.",
    publishedDate: "2025-05-10",
    updatedDate: "2025-06-01",
    readingTime: 8,
    category: "Visa Schengen",
    coverEmoji: "🇪🇺",
    intro:
      "Le visa Schengen permet de voyager librement dans 27 pays européens avec un seul visa. Depuis Kinshasa, les demandes se déposent auprès du Centre de Visas Européens (CEV). Ce guide détaille la liste complète des documents exigés en 2025, les erreurs fréquentes qui entraînent un refus, et les astuces pour renforcer votre dossier.",
    sections: [
      {
        heading: "Documents d'identité et de voyage",
        body: "Ces documents constituent le socle de tout dossier Schengen :",
        list: [
          "Passeport valide encore au moins 3 mois après la date de retour prévue, avec au moins 2 pages vierges",
          "Copie de toutes les pages du passeport actuel (y compris les pages vierges)",
          "Copies des passeports précédents contenant des visas Schengen ou américains",
          "2 photos d'identité récentes conformes au format Schengen (35×45 mm, fond blanc, 6 mois)",
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
          "Valable dans les 26 pays Schengen (pas uniquement le pays de destination)",
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
    updatedDate: "2025-06-01",
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
          "Intenzione non-immigrant : avez-vous l'intention de rentrer en RDC après votre séjour ?",
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
          "Arrivez 15 minutes en avance au consulat (rue Ngonga, Gombe). Les files peuvent être longues.",
          "Apportez vos documents dans un classeur ordonné — l'officier vous demandera peut-être à les voir",
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
        a: "Si l'officier demande un document manquant, il peut refuser le visa ou demander une mise en attente administrative (221g). Dans ce cas, vous avez généralement 12 mois pour fournir les documents complémentaires sans repayer les frais MRV.",
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
    updatedDate: "2025-06-01",
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
          "Consultez un expert pour analyser votre dossier avant de repayer les frais MRV",
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
        q: "Faut-il repayer les frais MRV de 265 USD pour chaque nouvelle demande ?",
        a: "Oui, les frais MRV sont non remboursables et doivent être payés pour chaque nouvelle demande, quel que soit le résultat. En cas de refus sous 214(b), vous devrez payer à nouveau avant de prendre un nouveau rendez-vous.",
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
    title: "Comment payer les frais MRV du visa USA depuis la RDC (guide 2025)",
    metaTitle: "Payer Frais MRV Visa USA depuis RDC 2025 — Guide Complet | Joventy",
    metaDescription:
      "Les frais MRV (265 USD) se paient via des canaux spécifiques en RDC. Guide étape par étape pour payer correctement les frais de visa américain depuis Kinshasa.",
    publishedDate: "2025-05-25",
    updatedDate: "2025-06-01",
    readingTime: 5,
    category: "Visa USA",
    coverEmoji: "💳",
    intro:
      "Payer les frais MRV (Machine Readable Visa) est la première étape concrète d'une demande de visa américain. Ces frais s'élèvent à 265 USD en 2025 et doivent être payés via des canaux spécifiques agréés par l'ambassade américaine en RDC. Ce guide vous explique les méthodes disponibles, les pièges à éviter, et comment vérifier que votre paiement est bien enregistré.",
    sections: [
      {
        heading: "Qu'est-ce que les frais MRV ?",
        body:
          "Les frais MRV (Machine Readable Visa Fee) sont des frais non remboursables exigés par le gouvernement américain pour traiter toute demande de visa non-immigrant (B1/B2 tourisme/affaires, F1 étudiant, J1, etc.). En 2025 :",
        list: [
          "Montant : 185 USD pour la plupart des visas non-immigrants (B1/B2, F, J, M)",
          "Note : certains types de visas (H, L, O, P, Q, R) ont des frais différents",
          "Les frais sont valables 12 mois — si vous ne prenez pas de rendez-vous dans ce délai, ils expirent",
          "Un refus ne donne pas droit au remboursement",
        ],
      },
      {
        heading: "Les canaux de paiement officiels depuis la RDC",
        body: "L'ambassade américaine a désigné des banques et établissements partenaires pour collecter les frais MRV :",
        list: [
          "Rawbank (agences Kinshasa) : paiement en CDF ou USD au guichet, récupération du reçu immédiate",
          "Equity Bank RDC : service disponible dans les principales agences de Kinshasa",
          "TMB (Trust Merchant Bank) : paiement au guichet avec présentation du code de référence USCIS",
          "Paiement en ligne via le portail ais.usvisa-info.com avec carte Visa/Mastercard internationale",
          "Western Union (pour les ressortissants hors de Kinshasa) : vérifier les agences agréées",
        ],
      },
      {
        heading: "Procédure étape par étape",
        body: "Voici comment procéder pour payer correctement et éviter les erreurs :",
        list: [
          "1. Créez d'abord votre compte sur ais.usvisa-info.com — c'est à partir de là que vous obtenez votre référence de paiement unique",
          "2. Notez votre référence MRV (un code alphanumérique unique à votre dossier)",
          "3. Rendez-vous à la banque partenaire avec cette référence, votre pièce d'identité, et le montant en USD",
          "4. Conservez précieusement votre reçu de paiement (RECEIPT NUMBER) — vous en aurez besoin pour le DS-160 et le portail USCIS",
          "5. Attendez 24 à 48 heures que le paiement apparaisse sur votre profil USCIS avant de tenter de prendre un rendez-vous",
        ],
      },
      {
        heading: "Erreurs fréquentes et comment les éviter",
        body: "Ces erreurs peuvent bloquer votre dossier ou vous faire perdre vos frais :",
        list: [
          "Payer sans avoir créé son compte USCIS d'abord — le paiement ne peut pas être lié à votre dossier",
          "Utiliser un intermédiaire non officiel pour le paiement — risque d'arnaque",
          "Confondre les frais MRV avec les frais SEVIS (uniquement pour les visas étudiants F/J)",
          "Ne pas conserver le reçu — sans le RECEIPT NUMBER, vous ne pouvez pas prendre de rendez-vous",
          "Payer en CDF sans s'assurer que le taux de change est celui de l'ambassade — vérifiez le montant exact en CDF le jour du paiement",
        ],
      },
      {
        heading: "Vérifier que le paiement est bien enregistré",
        body: "Avant de passer à l'étape suivante, confirmez que tout est en ordre :",
        list: [
          "Connectez-vous sur ais.usvisa-info.com 24 à 48h après le paiement",
          "Dans la section « Payment », votre statut doit passer de « Pending » à « Confirmed »",
          "Si après 72h le paiement n'apparaît pas, contactez le support USCIS avec votre reçu bancaire",
          "Joventy vérifie automatiquement le statut de paiement de ses clients et les alerte en cas de problème",
        ],
      },
    ],
    faq: [
      {
        q: "Combien coûtent les frais MRV pour un visa B1/B2 USA depuis la RDC en 2025 ?",
        a: "En 2025, les frais MRV pour un visa B1/B2 (tourisme et affaires) sont de 185 USD. Ce montant est non remboursable et valable 12 mois à partir de la date de paiement pour prendre un rendez-vous.",
      },
      {
        q: "Peut-on payer les frais MRV via M-Pesa ou Airtel Money ?",
        a: "Non. Les frais MRV ne peuvent pas être payés via Mobile Money (M-Pesa, Airtel Money, Orange Money) en RDC. Les seuls canaux acceptés sont les banques partenaires agréées (Rawbank, Equity Bank, TMB) et le paiement en ligne par carte internationale sur le portail USCIS.",
      },
      {
        q: "Les frais MRV sont-ils remboursables en cas de refus de visa ?",
        a: "Non. Les frais MRV sont non remboursables dans tous les cas — refus de visa, annulation de rendez-vous, ou changement de plans. Ils expirent si vous ne prenez pas de rendez-vous dans les 12 mois suivant le paiement.",
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
    title: "Délais d'attente visa USA, Canada et Schengen à Kinshasa en 2025",
    metaTitle: "Délais Visa USA Canada Schengen Kinshasa 2025 | Joventy",
    metaDescription:
      "Combien de temps pour obtenir un visa USA, Canada ou Schengen depuis Kinshasa en 2025 ? Délais réels constatés, périodes à éviter, et comment réduire l'attente.",
    publishedDate: "2025-06-01",
    updatedDate: "2025-06-01",
    readingTime: 6,
    category: "Comparatif",
    coverEmoji: "⏱️",
    intro:
      "Le délai entre la décision de voyager et l'obtention du visa peut varier de 2 semaines à 6 mois selon la destination, la saison et votre profil. Ce guide compile les délais réels constatés par Joventy sur les principales destinations depuis Kinshasa en 2025, ainsi que les stratégies pour planifier intelligemment votre demande.",
    sections: [
      {
        heading: "Visa USA (B1/B2) — délai total estimé",
        body:
          "Le délai total pour un visa américain comprend deux phases : la préparation du dossier et l'attente d'un créneau consulaire.",
        list: [
          "Préparation du dossier (DS-160, paiement MRV, documents) : 3 à 7 jours",
          "Attente d'un créneau d'entretien : 4 à 16 semaines (très variable selon la saison)",
          "Délai de traitement post-entretien : 5 à 10 jours ouvrables pour la plupart des dossiers",
          "Total estimé : 6 à 20 semaines depuis le début des démarches",
          "Avec Joventy (capture automatique de créneau) : créneau obtenu en 48 à 96h dans 94% des cas",
          "Périodes les plus chargées : juin-août (saison estivale), novembre-janvier (fêtes de fin d'année)",
        ],
      },
      {
        heading: "Visa Canada (visiteur, étudiant) — délai total estimé",
        body:
          "Le Canada traite les visas en ligne depuis Kinshasa via IRCC (Immigration, Réfugiés et Citoyenneté Canada). Pas d'entretien physique dans la plupart des cas.",
        list: [
          "Préparation et soumission du dossier en ligne : 5 à 10 jours",
          "Traitement IRCC : 4 à 12 semaines selon la saison et la complexité du dossier",
          "Biométrie : à déposer en personne après l'invitation IRCC — prévoir 1 à 2 semaines supplémentaires",
          "Total estimé : 6 à 14 semaines depuis la soumission",
          "Période la plus lente : octobre à décembre (volumes élevés d'étudiants pour la rentrée de janvier)",
          "Conseil : déposez votre demande au moins 3 mois avant la date de voyage souhaitée",
        ],
      },
      {
        heading: "Visa Schengen — délai total estimé",
        body:
          "Les demandes Schengen se déposent au Centre de Visas Européens (CEV) à Kinshasa. Le délai de traitement est réglementé à 15 jours ouvrables maximum.",
        list: [
          "Prise de rendez-vous CEV : 1 à 4 semaines d'attente",
          "Délai de traitement légal : 15 jours ouvrables (peut aller jusqu'à 30 en période chargée)",
          "Total estimé : 4 à 8 semaines depuis la décision de voyager",
          "Certains pays (France, Allemagne, Espagne) ont des délais de traitement plus courts",
          "Périodes les plus chargées : avril-juillet (vacances d'été), décembre",
          "Conseil : déposez votre demande 6 semaines avant la date de voyage",
        ],
      },
      {
        heading: "Tableau comparatif 2025",
        body:
          "Résumé des délais moyens constatés par Joventy sur les dossiers traités depuis Kinshasa :",
        list: [
          "🇺🇸 Visa USA B1/B2 : 8 à 16 semaines (avec Joventy : 3 à 5 semaines grâce à la capture de créneaux)",
          "🇨🇦 Visa Canada visiteur : 6 à 14 semaines",
          "🇪🇺 Visa Schengen : 4 à 8 semaines",
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
          "Utilisez la surveillance automatisée Joventy pour capturer des créneaux annulés — divisez par 3 l'attente moyenne pour les visas USA",
          "Pour le Schengen, déposez dès que la fenêtre de 6 mois s'ouvre (les consulats acceptent les dossiers jusqu'à 6 mois avant le voyage)",
          "Pour le Canada, soumettez votre demande en ligne dès que possible — les délais IRCC varient énormément et imprévisiblement",
          "Les e-Visas (Dubaï, Inde, Turquie) ne nécessitent aucun rendez-vous et peuvent s'obtenir en 24 à 72h",
        ],
      },
    ],
    faq: [
      {
        q: "Quel visa est le plus rapide à obtenir depuis Kinshasa en 2025 ?",
        a: "Les e-Visas sont de loin les plus rapides : Turquie (24-72h), Dubaï et Inde (3-5 jours ouvrables). Le visa Schengen est le plus rapide parmi les ambassades physiques (4-8 semaines). Le visa USA est le plus long à cause des délais de créneaux consulaires.",
      },
      {
        q: "Peut-on accélérer le traitement d'un visa USA ou Canada ?",
        a: "Il n'existe pas de service d'urgence officiel pour les visas USA et Canada. L'ambassade américaine accepte cependant des demandes d'entretien d'urgence dans des cas humanitaires avérés (décès d'un proche, urgence médicale). Pour le Canada, les délais sont automatisés et ne peuvent pas être accélérés manuellement.",
      },
      {
        q: "Les délais sont-ils différents pour les étudiants et les travailleurs ?",
        a: "Pour les États-Unis, les visas étudiants F1 et les visas de travail H-1B ont souvent des délais différents des visas B1/B2. Pour le Canada, les permis d'études et de travail suivent des processus distincts avec des délais propres. Consultez Joventy pour une estimation personnalisée selon votre type de visa.",
      },
    ],
    relatedSlugs: [
      "comment-obtenir-creneau-visa-usa-kinshasa",
      "documents-visa-schengen-kinshasa",
      "payer-frais-mrv-visa-usa-kinshasa",
    ],
    relatedDestination: "visa-schengen-kinshasa",
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
