export interface CreneauxSEO {
  slug: string;
  flagCode: string;
  destinationKey: string;
  emoji: string;
  name: string;
  title: string;
  metaDescription: string;
  h1: string;
  accroche: string;
  portal: string;
  portalUrl: string;
  portalLabel: string;
  urgency: string;
  stats: { n: string; label: string }[];
  steps: { icon: string; title: string; desc: string }[];
  included: string[];
  faqs: { q: string; a: string }[];
  relatedDestSlug: string;
}

export const CRENEAUX_PAGES: CreneauxSEO[] = [
  {
    slug: "creneaux-visa-allemagne-kinshasa",
    flagCode: "de",
    destinationKey: "germany",
    emoji: "🇩🇪",
    name: "Allemagne",
    title: "Créneau Visa Long Séjour Allemagne Kinshasa 2026 — RK-Termin 24h/24 | Joventy",
    metaDescription:
      "Rendez-vous visa long séjour Allemagne depuis Kinshasa 2026 (études, travail, famille) : Joventy surveille RK-Termin en continu et réserve votre créneau. 350 $ payés uniquement après obtention — aucun acompte.",
    h1: "Créneau Visa Long Séjour Allemagne depuis Kinshasa — RK-Termin géré 24h/24",
    accroche:
      "L'ambassade d'Allemagne à Kinshasa traite les visas long séjour (études, travail, regroupement familial) sur rendez-vous via le portail RK-Termin. Ces créneaux sont rares et disparaissent en quelques minutes. Joventy surveille le portail en permanence et verrouille votre slot dès qu'un rendez-vous disponible apparaît — sans acompte de votre part.",
    portal: "RK-Termin",
    portalUrl: "https://service2.diplo.de",
    portalLabel: "Portail officiel de rendez-vous de l'ambassade d'Allemagne",
    urgency:
      "Les créneaux RK-Termin Allemagne sont libérés de façon irrégulière et pris en quelques secondes.",
    stats: [
      { n: "350 $", label: "payés uniquement après obtention du créneau" },
      { n: "0 $", label: "d'acompte — aucun paiement à l'avance" },
      { n: "24h/24", label: "surveillance continue du portail RK-Termin" },
      { n: "< 2 min", label: "durée typique avant qu'un créneau soit pris" },
    ],
    steps: [
      {
        icon: "📋",
        title: "Votre dossier est prêt — créez votre demande de créneau",
        desc: "Sélectionnez 'Créneau uniquement — Allemagne Long Séjour' sur la plateforme Joventy. Aucun acompte requis. Indiquez votre date de voyage souhaitée.",
      },
      {
        icon: "🤖",
        title: "Notre robot surveille RK-Termin 24h/24",
        desc: "L'outil Joventy scanne le portail RK-Termin (service2.diplo.de) en continu. Dès qu'un créneau de rendez-vous à l'ambassade d'Allemagne à Kinshasa apparaît, le robot le réserve immédiatement.",
      },
      {
        icon: "✅",
        title: "Créneau confirmé → vous payez 350 $",
        desc: "Vous recevez une notification WhatsApp et email avec la date, l'heure et le lieu de votre rendez-vous à l'ambassade d'Allemagne. C'est à ce moment seulement que vous réglez 350 $ via M-Pesa, Airtel Money ou Orange Money.",
      },
    ],
    included: [
      "Surveillance continue du portail RK-Termin (ambassade d'Allemagne à Kinshasa)",
      "Réservation automatique du premier créneau disponible correspondant à vos critères",
      "Notification WhatsApp immédiate à la confirmation du rendez-vous",
      "Accès à l'espace client pour suivre le statut en temps réel",
      "Support WhatsApp en cas de question (réponse < 2h)",
    ],
    faqs: [
      {
        q: "Qu'est-ce que le portail RK-Termin pour les visas Allemagne depuis Kinshasa ?",
        a: "RK-Termin (service2.diplo.de) est le portail officiel en ligne de prise de rendez-vous des ambassades allemandes dans le monde. À Kinshasa, l'ambassade d'Allemagne utilise ce système pour gérer les rendez-vous visa national (long séjour, type D). Les créneaux sont publiés de façon irrégulière et réservés très rapidement.",
      },
      {
        q: "Quelle est la différence entre le visa Schengen et le visa long séjour Allemagne ?",
        a: "Le visa Schengen (type C) permet un séjour de 90 jours maximum dans l'espace Schengen. Le visa long séjour Allemagne (type D, visa national) est délivré pour des séjours supérieurs à 90 jours : études, travail, regroupement familial, retraite. Il est traité directement par l'ambassade d'Allemagne à Kinshasa (et non par le CEV). Joventy vous propose le service créneau uniquement pour le visa national long séjour.",
      },
      {
        q: "Combien de temps faut-il pour avoir un créneau à l'ambassade d'Allemagne à Kinshasa ?",
        a: "Le délai varie selon les périodes et la demande. Historiquement, les créneaux sur RK-Termin à Kinshasa sont disponibles de façon sporadique — parfois quelques jours, parfois plusieurs semaines d'attente. Joventy surveille le portail en continu et réserve votre créneau dès qu'il se libère, bien avant qu'il soit pris manuellement.",
      },
      {
        q: "Puis-je prendre le créneau moi-même sur RK-Termin sans Joventy ?",
        a: "Oui, c'est possible. Mais le portail RK-Termin est difficile d'accès depuis Kinshasa (lenteur, captchas, créneaux qui disparaissent en quelques secondes). Le service Joventy automatise cette surveillance 24h/24. Si vous arrivez à prendre votre créneau seul, vous ne payez rien à Joventy — les 350 $ ne sont dus qu'à l'obtention effective du créneau via Joventy.",
      },
      {
        q: "Combien coûte le service créneau Allemagne avec Joventy ?",
        a: "350 $ au total, payés uniquement après que Joventy a confirmé votre rendez-vous à l'ambassade d'Allemagne. Aucun acompte à l'avance. Paiement via M-Pesa, Airtel Money ou Orange Money.",
      },
      {
        q: "Joventy prépare-t-il aussi mon dossier pour le visa long séjour Allemagne ?",
        a: "Le service créneau (350 $) couvre uniquement la surveillance du portail et la prise de rendez-vous. Si vous souhaitez également que Joventy prépare votre dossier complet (formulaires, vérification des pièces, etc.), vous pouvez opter pour le service visa complet à 1 500 $ (500 $ d'engagement + 1 000 $ de prime de succès).",
      },
      {
        q: "Que se passe-t-il si l'ambassade d'Allemagne annule ou reporte le rendez-vous ?",
        a: "Si votre rendez-vous est annulé par l'ambassade allemande après confirmation, Joventy reprend la surveillance du portail et recherche un nouveau créneau sans frais supplémentaires.",
      },
    ],
    relatedDestSlug: "visa-schengen-kinshasa",
  },
  {
    slug: "creneaux-visa-espagne-kinshasa",
    flagCode: "es",
    destinationKey: "spain",
    emoji: "🇪🇸",
    name: "Espagne",
    title: "Créneau Visa Espagne Kinshasa 2026 — citaconsular.es géré par Joventy | Joventy",
    metaDescription:
      "Rendez-vous visa Espagne depuis Kinshasa 2026 : Joventy envoie l'email d'inscription à l'ambassade et réserve votre créneau sur citaconsular.es. 350 $ payés uniquement après obtention — aucun acompte.",
    h1: "Créneau Visa Espagne depuis Kinshasa — Email ambassade + citaconsular.es géré par Joventy",
    accroche:
      "L'Espagne gère ses rendez-vous visa directement via son ambassade à Kinshasa — pas par le CEV. La procédure est en deux étapes : inscription par email à l'ambassade, puis prise de créneau sur citaconsular.es. Joventy prend en charge l'intégralité de ce processus. Vous ne payez que quand le rendez-vous est confirmé.",
    portal: "citaconsular.es",
    portalUrl: "https://citaconsular.es",
    portalLabel: "Portail officiel de rendez-vous de l'ambassade d'Espagne",
    urgency:
      "Les créneaux sur citaconsular.es sont pris en moins de 2 minutes dès leur ouverture.",
    stats: [
      { n: "350 $", label: "payés uniquement après obtention du créneau" },
      { n: "0 $", label: "d'acompte — aucun paiement à l'avance" },
      { n: "2 étapes", label: "email ambassade + créneau citaconsular.es" },
      { n: "< 2 min", label: "durée typique avant qu'un créneau soit pris" },
    ],
    steps: [
      {
        icon: "📋",
        title: "Votre dossier est prêt — créez votre demande de créneau",
        desc: "Sélectionnez 'Créneau uniquement — Espagne' sur la plateforme Joventy. Aucun acompte. Communiquez vos informations (nom, passeport, date de voyage souhaitée) via l'espace client.",
      },
      {
        icon: "📧",
        title: "Joventy envoie l'email d'inscription à l'ambassade",
        desc: "Joventy contacte emb.kinshasa.citasvis@maec.es en votre nom avec objet 'RENDEZ-VOUS VISA EST' et les pièces jointes requises (photo passeport, formulaire, vol, assurance). L'ambassade répond sous 1 à 14 jours avec vos identifiants citaconsular.",
      },
      {
        icon: "✅",
        title: "Robot réserve sur citaconsular.es → vous payez 350 $",
        desc: "Dès réception des identifiants, notre robot prend le premier créneau disponible sur citaconsular.es. Vous recevez la confirmation par WhatsApp — c'est à ce moment seulement que vous réglez 350 $ via M-Pesa.",
      },
    ],
    included: [
      "Envoi de l'email d'inscription à emb.kinshasa.citasvis@maec.es en votre nom",
      "Surveillance continue du portail citaconsular.es dès réception des identifiants",
      "Réservation automatique du premier créneau disponible",
      "Notification WhatsApp immédiate à la confirmation du rendez-vous",
      "Accès à l'espace client pour suivre chaque étape",
      "Support WhatsApp réactif (réponse < 2h)",
    ],
    faqs: [
      {
        q: "L'Espagne passe-t-elle par le CEV pour les visas depuis Kinshasa ?",
        a: "Non. Contrairement à la France, la Belgique ou l'Allemagne (visa Schengen court séjour), l'Espagne gère ses rendez-vous visa directement via son ambassade à Kinshasa. La prise de rendez-vous passe d'abord par un email à emb.kinshasa.citasvis@maec.es, puis par une réservation sur le portail officiel citaconsular.es. Joventy gère ces deux étapes pour vous.",
      },
      {
        q: "Combien de temps l'ambassade d'Espagne prend-elle pour répondre à l'email d'inscription ?",
        a: "En général, l'ambassade d'Espagne à Kinshasa répond sous 1 à 14 jours ouvrables. Le délai varie selon la période et la charge de l'ambassade. Joventy vous tient informé dès réception de la réponse et enchaîne immédiatement avec la prise de créneau sur citaconsular.es.",
      },
      {
        q: "Que doit contenir l'email envoyé à emb.kinshasa.citasvis@maec.es ?",
        a: "L'objet de l'email doit être 'RENDEZ-VOUS VISA EST'. Le corps doit inclure NOM PRÉNOM, numéro de passeport, date de voyage et la mention 'EST'. Les pièces jointes requises sont : une photo tenant le passeport, le formulaire de candidature, la réservation de vol, et une assurance Schengen d'au moins 30 000 €. La taille totale doit rester sous 1 Mo. Joventy rédige et envoie cet email en votre nom.",
      },
      {
        q: "Combien coûte le rendez-vous visa Espagne avec Joventy ?",
        a: "350 $ au total, payés uniquement après confirmation du créneau sur citaconsular.es. Aucun acompte à l'avance. Les frais consulaires (90 €/adulte, payés le jour du rendez-vous directement à l'ambassade) ne sont pas inclus.",
      },
      {
        q: "Que faire si l'ambassade refuse ou ignore l'email d'inscription ?",
        a: "Si l'ambassade ne répond pas après 14 jours, Joventy renvoie l'email. Si l'email est refusé (pièces non conformes), Joventy analyse le motif et prépare un second envoi corrigé. Ce ré-envoi est inclus dans le service sans frais supplémentaires.",
      },
      {
        q: "Est-ce que le créneau Espagne permet un visa Schengen valable dans toute l'Europe ?",
        a: "Oui. Un visa Schengen délivré par l'Espagne (visa de type C, court séjour) est valable dans les 27 pays de l'espace Schengen : France, Belgique, Allemagne, Italie, Pays-Bas, etc. Vous pouvez circuler librement pendant 90 jours sur 180.",
      },
    ],
    relatedDestSlug: "visa-espagne-kinshasa",
  },
  {
    slug: "creneaux-visa-schengen-belgique-kinshasa",
    flagCode: "be",
    destinationKey: "schengen",
    emoji: "🇧🇪",
    name: "Schengen — CEV Belgique",
    title: "Créneau Schengen Belgique Kinshasa 2026 — CEV visaonweb.be géré par Joventy | Joventy",
    metaDescription:
      "Rendez-vous visa Schengen Belgique depuis Kinshasa 2026 : Joventy crée votre compte Visa On Web, surveille cev-kin.eu et réserve votre créneau CEV. 350 $ payés uniquement après obtention — aucun acompte.",
    h1: "Créneau Visa Schengen Belgique depuis Kinshasa — CEV visaonweb.be géré 24h/24",
    accroche:
      "À Kinshasa, les visas Schengen court séjour (France, Belgique, Allemagne, Pays-Bas, etc.) passent tous par le Centre Européen des Visas (CEV), géré par l'ambassade de Belgique. La prise de créneau se fait sur le portail visaonweb.be. Ces créneaux sont rares et très disputés. Joventy crée votre compte Visa On Web, surveille cev-kin.eu en continu et verrouille votre créneau dès qu'il apparaît.",
    portal: "visaonweb.be / CEV",
    portalUrl: "https://cev-kin.eu",
    portalLabel: "Centre Européen des Visas de Kinshasa — Portail visaonweb.be",
    urgency:
      "Les créneaux CEV à Kinshasa durent en moyenne 30 à 90 secondes avant d'être pris — une surveillance manuelle ne suffit pas.",
    stats: [
      { n: "350 $", label: "payés uniquement après obtention du créneau CEV" },
      { n: "0 $", label: "d'acompte — aucun paiement à l'avance" },
      { n: "27 pays", label: "accessibles avec un seul visa Schengen CEV" },
      { n: "< 90 sec", label: "durée typique d'un créneau CEV disponible" },
    ],
    steps: [
      {
        icon: "📋",
        title: "Votre dossier est prêt — créez votre demande de créneau",
        desc: "Sélectionnez 'Créneau uniquement — Schengen CEV' sur la plateforme Joventy. Aucun acompte. Joventy crée votre compte Visa On Web (visaonweb.be) si vous n'en avez pas encore.",
      },
      {
        icon: "🤖",
        title: "Notre robot surveille cev-kin.eu 24h/24",
        desc: "L'outil Joventy scanne le portail CEV en continu. Dès qu'un créneau de rendez-vous au Centre Européen des Visas de Kinshasa se libère, le robot le réserve immédiatement avec votre numéro de dossier Visa On Web.",
      },
      {
        icon: "✅",
        title: "Créneau CEV confirmé → vous payez 350 $",
        desc: "Vous recevez une notification WhatsApp avec la date, l'heure et le numéro de créneau au CEV. C'est à ce moment seulement que vous réglez 350 $ via M-Pesa, Airtel Money ou Orange Money.",
      },
    ],
    included: [
      "Création de votre compte Visa On Web (visaonweb.be) si nécessaire",
      "Surveillance continue du portail cev-kin.eu",
      "Réservation automatique du premier créneau CEV disponible",
      "Notification WhatsApp immédiate à la confirmation",
      "Accès à l'espace client pour suivre le statut en temps réel",
      "Support WhatsApp réactif (réponse < 2h)",
    ],
    faqs: [
      {
        q: "Qu'est-ce que le CEV (Centre Européen des Visas) à Kinshasa ?",
        a: "Le CEV (Centre Européen des Visas) est le guichet unique pour les visas Schengen court séjour à Kinshasa. Il est géré par l'ambassade de Belgique et regroupe les demandes pour la France, la Belgique, l'Allemagne, les Pays-Bas et d'autres pays Schengen. La prise de rendez-vous se fait via le portail visaonweb.be, et le dépôt du dossier se fait physiquement au CEV (Avenue des Huileries, Gombe).",
      },
      {
        q: "Avec un visa CEV Schengen, dans quels pays puis-je aller ?",
        a: "Un visa Schengen de type C (court séjour) délivré via le CEV permet de circuler librement dans les 27 États membres de l'espace Schengen : France, Belgique, Allemagne, Pays-Bas, Italie, Espagne, Portugal, Autriche, Suisse, Suède, Norvège, etc. Durée maximum 90 jours sur toute période de 180 jours.",
      },
      {
        q: "Pourquoi les créneaux CEV à Kinshasa sont-ils si difficiles à obtenir ?",
        a: "La demande de visas Schengen depuis la RDC est élevée, et le CEV de Kinshasa a une capacité d'accueil limitée. Les créneaux s'ouvrent de façon irrégulière sur visaonweb.be et sont réservés en quelques dizaines de secondes par des personnes qui surveillent le portail en permanence. Joventy automatise cette surveillance pour vous.",
      },
      {
        q: "Dois-je avoir un compte Visa On Web avant de déposer ma demande Joventy ?",
        a: "Non. Si vous n'avez pas encore de compte visaonweb.be, Joventy le crée pour vous dans le cadre du service. Le numéro de dossier VOW est nécessaire pour réserver le créneau CEV.",
      },
      {
        q: "Combien coûte le créneau Schengen CEV avec Joventy ?",
        a: "350 $ au total, payés uniquement après confirmation du créneau CEV. Aucun acompte à l'avance. Les frais consulaires CEV (90 €/adulte, 45 €/enfant 6–12 ans, gratuit sous 6 ans) sont payés séparément directement au CEV le jour du dépôt.",
      },
      {
        q: "L'Espagne passe-t-elle par le CEV à Kinshasa ?",
        a: "Non. L'Espagne est une exception notable : elle gère ses rendez-vous visa directement via son ambassade (email + citaconsular.es). Si vous souhaitez un visa Espagne, Joventy propose un service créneau dédié à /creneaux-visa-espagne-kinshasa.",
      },
      {
        q: "Combien de temps faut-il pour obtenir un créneau CEV à Kinshasa ?",
        a: "Le délai varie selon les périodes. Joventy surveille le portail 24h/24 et réserve le premier créneau disponible. Certains dossiers obtiennent un créneau en quelques jours, d'autres en quelques semaines selon la période.",
      },
    ],
    relatedDestSlug: "visa-schengen-kinshasa",
  },
  {
    slug: "creneaux-visa-usa-kinshasa",
    flagCode: "us",
    destinationKey: "usa",
    emoji: "🇺🇸",
    name: "États-Unis",
    title: "Créneau Visa USA Kinshasa 2026 — usvisaappt.com géré par Joventy | Joventy",
    metaDescription:
      "Rendez-vous visa USA depuis Kinshasa 2026 (B1/B2, F1) : Joventy surveille usvisaappt.com en continu et réserve votre créneau dès qu'il apparaît. 350 $ payés uniquement après obtention — aucun acompte.",
    h1: "Créneau Visa USA depuis Kinshasa — usvisaappt.com surveillé 24h/24 par Joventy",
    accroche:
      "L'ambassade américaine à Kinshasa publie ses créneaux de rendez-vous visa sur le portail usvisaappt.com. En 2026, ces créneaux sont extrêmement rares (restrictions Ebola, Travel Advisory Level 4). Joventy surveille le portail en permanence et réserve votre créneau dès qu'un slot disponible apparaît — vous ne payez que quand c'est confirmé.",
    portal: "usvisaappt.com",
    portalUrl: "https://usvisaappt.com",
    portalLabel: "Portail officiel de rendez-vous visa américain (US Department of State)",
    urgency:
      "En 2026, les créneaux visa USA à Kinshasa sont extrêmement rares. Restrictions Ebola + Travel Advisory Level 4.",
    stats: [
      { n: "350 $", label: "payés uniquement après obtention du créneau" },
      { n: "0 $", label: "d'acompte — aucun paiement à l'avance" },
      { n: "24h/24", label: "surveillance continue d'usvisaappt.com" },
      { n: "185 $", label: "de frais MRV (payés directement à l'ambassade, non inclus)" },
    ],
    steps: [
      {
        icon: "📋",
        title: "Votre DS-160 est soumis et vos frais MRV payés — créez votre demande",
        desc: "Sélectionnez 'Créneau uniquement — USA' sur la plateforme Joventy. Aucun acompte. Assurez-vous que votre formulaire DS-160 est soumis et vos frais MRV (185 $) payés sur usvisaappt.com avant la prise de créneau.",
      },
      {
        icon: "🤖",
        title: "Notre robot surveille usvisaappt.com 24h/24",
        desc: "Joventy scanne le portail officiel usvisaappt.com en permanence. Dès qu'un créneau de rendez-vous visa apparaît à l'ambassade américaine de Kinshasa, le robot le réserve immédiatement avec vos identifiants de dossier.",
      },
      {
        icon: "✅",
        title: "Rendez-vous confirmé → vous payez 350 $",
        desc: "Vous recevez une notification WhatsApp avec la date et l'heure de votre entretien à l'ambassade américaine de Kinshasa. C'est à ce moment seulement que vous réglez 350 $ via M-Pesa, Airtel Money ou Orange Money.",
      },
    ],
    included: [
      "Surveillance continue du portail usvisaappt.com",
      "Réservation automatique du premier créneau disponible à l'ambassade américaine de Kinshasa",
      "Notification WhatsApp immédiate à la confirmation du rendez-vous",
      "Accès à l'espace client pour suivre le statut en temps réel",
      "Support WhatsApp réactif (réponse < 2h)",
      "Conseils de préparation à l'entretien consulaire B1/B2 (si service complet ou sur demande)",
    ],
    faqs: [
      {
        q: "Faut-il avoir soumis le DS-160 avant de demander le créneau via Joventy ?",
        a: "Oui. Pour le service 'Créneau uniquement USA', vous devez avoir votre formulaire DS-160 soumis et vos frais MRV (185 $) payés sur le portail usvisaappt.com. Ces étapes sont des prérequis obligatoires avant toute prise de rendez-vous. Si vous avez besoin d'aide pour remplir le DS-160, optez pour le service visa complet Joventy (1 500 $).",
      },
      {
        q: "Les créneaux visa USA sont-ils vraiment disponibles à Kinshasa en 2026 ?",
        a: "La situation est difficile en 2026 : l'ambassade américaine à Kinshasa a suspendu ses services visa depuis le 18 mai 2026 (épidémie Ebola, Travel Advisory Level 4). Joventy surveille le portail usvisaappt.com en continu et vous notifiera dès que des créneaux seront disponibles — que ce soit à Kinshasa ou qu'une alternative soit proposée.",
      },
      {
        q: "Puis-je demander un créneau visa USA depuis un pays neutre si les services sont suspendus à Kinshasa ?",
        a: "Oui. Si les services USA sont suspendus à Kinshasa, Joventy peut vous aider à obtenir un créneau dans l'ambassade américaine d'un pays neutre (Maroc, Égypte, Dubaï, Rwanda, etc.) après votre purge de 21 jours hors zone Ebola. Ce service est inclus dans le créneau uniquement à 350 $.",
      },
      {
        q: "Combien coûte le créneau visa USA avec Joventy ?",
        a: "350 $ au total, payés uniquement après confirmation du rendez-vous à l'ambassade américaine. Aucun acompte. Les frais MRV (185 $ pour le B1/B2, 210 $ pour le K1/H1B) sont payés séparément directement via usvisaappt.com.",
      },
      {
        q: "Que se passe-t-il si mon visa B1/B2 est refusé à l'entretien après que Joventy a obtenu le créneau ?",
        a: "Si Joventy a verrouillé votre créneau (mission accomplie), les 350 $ sont dus. Le refus lors de l'entretien consulaire est une décision souveraine de l'ambassade américaine, indépendante du service Joventy. Nous vous conseillons gratuitement sur la préparation à l'entretien pour maximiser vos chances.",
      },
      {
        q: "Combien de temps faut-il pour avoir un créneau visa USA à Kinshasa ?",
        a: "En conditions normales, le délai varie de quelques jours à plusieurs semaines selon la période. En 2026, les services visa USA à Kinshasa sont suspendus depuis le 18 mai (Ebola). Joventy surveille le portail 24h/24 et vous notifie dès qu'un créneau est disponible.",
      },
    ],
    relatedDestSlug: "visa-usa-kinshasa",
  },
];

export function getCreneauxPageBySlug(slug: string): CreneauxSEO | undefined {
  return CRENEAUX_PAGES.find((p) => p.slug === slug);
}
