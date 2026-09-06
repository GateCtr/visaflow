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
  urgency: string;
  stats: { n: string; label: string }[];
  highlights?: string[];
  steps: { icon: string; title: string; desc: string }[];
  included: string[];
  faqs: { q: string; a: string }[];
  relatedDestSlug: string;
  relatedGuideHref?: string;
}

export const CRENEAUX_PAGES: CreneauxSEO[] = [
  {
    slug: "creneaux-visa-belgique-long-sejour-kinshasa",
    flagCode: "be",
    destinationKey: "visa-belgique-long-sejour-kinshasa",
    emoji: "🇧🇪",
    name: "Belgique long séjour type D",
    title: "Créneau visa Belgique long séjour type D Kinshasa | Joventy",
    metaDescription: "Service privé de créneau visa Belgique type D à Kinshasa : 350 USD après obtention, sans acompte. Rendez-vous CEV officiel gratuit, sans garantie.",
    h1: "Créneau visa Belgique long séjour type D depuis Kinshasa",
    accroche: "Pour un séjour belge de plus de 90 jours, créez d’abord votre compte Visa On Web avec votre email personnel et sélectionnez la bonne catégorie. Le CEV reçoit les longs séjours Belgique et Luxembourg. La prise de rendez-vous officielle CEV est gratuite ; les 350 USD rémunèrent uniquement le service privé Joventy, après obtention, sans acompte, accès privilégié ni garantie de date ou de visa.",
    urgency: "Les disponibilités officielles et la catégorie applicable varient ; aucun délai ni rendez-vous n’est garanti.",
    stats: [
      { n: "350 $", label: "service privé Joventy, après créneau confirmé" },
      { n: "0 $", label: "d’acompte pour le service créneau" },
      { n: "0 $", label: "pour la prise de rendez-vous officielle CEV" },
      { n: "Visa On Web", label: "compte personnel requis avant la démarche" },
    ],
    highlights: ["Aucun acompte requis", "Rendez-vous CEV officiel gratuit", "Compte VOW personnel", "Sans accès privilégié ni garantie"],
    steps: [
      { icon: "📝", title: "Créez votre demande Visa On Web", desc: "Utilisez votre email personnel et la catégorie de long séjour correcte (études, travail, famille ou autre). Vérifiez la checklist officielle avant toute réservation." },
      { icon: "🔎", title: "Demandez le service privé de suivi", desc: "Sans acompte, Joventy suit les disponibilités publiques pertinentes et vous assiste dans le parcours. Nous ne sommes pas le CEV et ne promettons aucune date." },
      { icon: "✅", title: "Créneau confirmé → paiement de 350 $", desc: "Après obtention effective d’un créneau, vous réglez 350 USD pour le service Joventy. Les éventuels frais officiels restent distincts." },
    ],
    included: ["Assistance de compréhension du parcours Visa On Web personnel", "Suivi des disponibilités publiques du CEV", "Transmission des informations après confirmation", "Accès à l’espace client", "Service privé, sans décision consulaire ni accès privilégié"],
    faqs: [
      { q: "Le rendez-vous CEV pour un visa D belge est-il payant ?", a: "La prise de rendez-vous officielle CEV est gratuite. Les 350 USD concernent seulement le service privé Joventy, après obtention, sans acompte." },
      { q: "Puis-je utiliser un compte Visa On Web créé par quelqu’un d’autre ?", a: "Utilisez et conservez votre propre compte avec votre email personnel. Vérifiez toutes les données et la catégorie avant de poursuivre." },
      { q: "Le CEV traite-t-il les longs séjours France ou Allemagne ?", a: "Non. Au CEV, les longs séjours concernent Belgique et Luxembourg. La France et l’Allemagne suivent leurs parcours d’ambassade respectifs." },
      { q: "Joventy garantit-il une date ou le visa ?", a: "Non. Les disponibilités relèvent du canal officiel et la décision appartient aux autorités belges ou à l’Office des étrangers." },
    ],
    relatedDestSlug: "visa-belgique-long-sejour-kinshasa",
    relatedGuideHref: "/guides/visa-belgique-long-sejour-kinshasa-procedure",
  },
  {
    slug: "creneaux-visa-france-long-sejour-kinshasa",
    flagCode: "fr",
    destinationKey: "france_long_stay",
    emoji: "🇫🇷",
    name: "France long séjour",
    title: "Créneau visa France long séjour Kinshasa 2026 — France-Visas | Joventy",
    metaDescription: "Rendez-vous visa France long séjour depuis Kinshasa : étapes France-Visas et Ambassade de France. Service créneau à 350 USD, payé après obtention, sans acompte.",
    h1: "Créneau visa France long séjour depuis Kinshasa — France-Visas",
    accroche: "Pour un séjour en France de plus de 90 jours, préparez d'abord la demande correspondant à votre situation sur France-Visas. Les rendez-vous et le dépôt relèvent de l'Ambassade de France à Kinshasa, selon ses instructions. Joventy peut suivre la disponibilité et vous assister dans la démarche de rendez-vous ; nous n'avons aucun accès privilégié et ne pouvons pas promettre une date.",
    urgency: "Les disponibilités dépendent des ouvertures officielles et de votre catégorie de visa ; anticipez votre demande.",
    stats: [
      { n: "350 $", label: "payés après confirmation du créneau obtenu" },
      { n: "0 $", label: "d'acompte pour cette destination hors Espagne" },
      { n: "France-Visas", label: "à compléter avant de suivre les instructions de dépôt" },
      { n: "Ambassade", label: "autorité compétente pour le long séjour à Kinshasa" },
    ],
    highlights: [
      "Aucun acompte requis",
      "Paiement Mobile Money accepté",
      "Suivi du canal officiel applicable",
      "Notification après confirmation",
    ],
    steps: [
      { icon: "📝", title: "Préparez votre parcours France-Visas", desc: "Identifiez votre catégorie (études, famille, travail ou autre long séjour), complétez les informations demandées et rassemblez les pièces de la checklist." },
      { icon: "🔎", title: "Demandez le suivi du rendez-vous", desc: "Créez votre demande « Créneau uniquement — France long séjour ». Sans acompte, Joventy suit le canal officiel indiqué pour votre catégorie ; aucune date n'est garantie." },
      { icon: "✅", title: "Créneau confirmé → paiement de 350 $", desc: "Quand un rendez-vous est effectivement confirmé selon le parcours officiel, vous recevez les informations disponibles et réglez les 350 USD par Mobile Money." },
    ],
    included: [
      "Vérification de la cohérence entre la catégorie France-Visas et la demande de rendez-vous",
      "Suivi du canal officiel de rendez-vous applicable à votre long séjour",
      "Transmission des informations de rendez-vous lorsqu'il est confirmé",
      "Accès à l'espace client pour le suivi de la demande",
      "Support administratif ; ni décision consulaire ni accès privilégié",
    ],
    faqs: [
      { q: "Le service créneau France long séjour coûte-t-il 350 USD ?", a: "Oui. Le service de rendez-vous seul est facturé 350 USD après l'obtention effective d'un créneau confirmé. Pour cette destination hors Espagne, aucun acompte n'est demandé." },
      { q: "Le visa France long séjour passe-t-il par le CEV ?", a: "Non. Le CEV concerne le court séjour Schengen lorsqu'il est compétent. Un long séjour français se prépare avec France-Visas puis relève de l'Ambassade de France à Kinshasa." },
      { q: "Joventy peut-il garantir une date ou un visa ?", a: "Non. Les dates dépendent des ouvertures officielles et la décision de visa appartient exclusivement à l'ambassade. Joventy ne dispose pas d'accès privilégié." },
      { q: "Campus France est-il nécessaire pour un visa étudiant ?", a: "Pour certains projets d'études, une procédure Campus France peut être requise avant la demande de visa. Vérifiez votre situation sur Campus France et France-Visas." },
    ],
    relatedDestSlug: "visa-france-long-sejour-kinshasa",
  },
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
      "L'ambassade d'Allemagne à Kinshasa traite les visas long séjour (études, travail, regroupement familial) sur rendez-vous via le portail RK-Termin. Ces créneaux sont rares et disparaissent en quelques minutes. Joventy surveille le système en permanence et verrouille votre slot dès qu'un rendez-vous disponible apparaît — sans acompte de votre part.",
    urgency:
      "Les créneaux RK-Termin Allemagne sont libérés de façon irrégulière et pris en quelques secondes.",
    stats: [
      { n: "350 $", label: "payés uniquement après obtention du créneau" },
      { n: "0 $", label: "d'acompte — aucun paiement à l'avance" },
      { n: "24h/24", label: "surveillance continue du système RK-Termin" },
      { n: "< 2 min", label: "durée typique avant qu'un créneau soit pris" },
    ],
    steps: [
      {
        icon: "📋",
        title: "Votre dossier est prêt — créez votre demande de créneau",
        desc: "Sélectionnez 'Créneau uniquement — Allemagne Long Séjour' sur la plateforme Joventy. Aucun acompte requis. Indiquez votre date de voyage souhaitée.",
      },
      {
        icon: "🔍",
        title: "Notre système surveille RK-Termin 24h/24",
        desc: "Le système Joventy scanne le portail RK-Termin de l'ambassade d'Allemagne en continu. Dès qu'un créneau de rendez-vous à Kinshasa apparaît, il est verrouillé immédiatement.",
      },
      {
        icon: "✅",
        title: "Créneau confirmé → vous payez 350 $",
        desc: "Vous recevez une notification WhatsApp et email avec la date, l'heure et le lieu de votre rendez-vous à l'ambassade d'Allemagne. C'est à ce moment seulement que vous réglez 350 $ via M-Pesa, Airtel Money ou Orange Money.",
      },
    ],
    included: [
      "Surveillance continue du portail de rendez-vous de l'ambassade d'Allemagne à Kinshasa",
      "Capture du premier créneau disponible correspondant à vos critères",
      "Notification WhatsApp immédiate à la confirmation du rendez-vous",
      "Accès à l'espace client pour suivre le statut en temps réel",
      "Support WhatsApp en cas de question (réponse < 2h)",
    ],
    faqs: [
      {
        q: "Qu'est-ce que le portail RK-Termin pour les visas Allemagne depuis Kinshasa ?",
        a: "RK-Termin est le portail officiel en ligne de prise de rendez-vous des ambassades allemandes dans le monde. À Kinshasa, l'ambassade d'Allemagne utilise ce système pour gérer les rendez-vous visa national (long séjour, type D). Les créneaux sont publiés de façon irrégulière et réservés très rapidement.",
      },
      {
        q: "Quelle est la différence entre le visa Schengen et le visa long séjour Allemagne ?",
        a: "Le visa Schengen (type C) permet un séjour de 90 jours maximum dans l'espace Schengen. Le visa long séjour Allemagne (type D, visa national) est délivré pour des séjours supérieurs à 90 jours : études, travail, regroupement familial, retraite. Il est traité directement par l'ambassade d'Allemagne à Kinshasa. Joventy vous propose le service créneau pour le visa national long séjour.",
      },
      {
        q: "Combien de temps faut-il pour avoir un créneau à l'ambassade d'Allemagne à Kinshasa ?",
        a: "Le délai varie selon les périodes et la demande. Historiquement, les créneaux à Kinshasa sont disponibles de façon sporadique — parfois quelques jours, parfois plusieurs semaines d'attente. Joventy surveille le système en continu et réserve votre créneau dès qu'il se libère.",
      },
      {
        q: "Puis-je prendre le créneau moi-même sans Joventy ?",
        a: "Oui, c'est possible. Mais le système de rendez-vous est difficile d'accès depuis Kinshasa (lenteur, créneaux qui disparaissent en quelques secondes). Le service Joventy assure une surveillance 24h/24. Si vous arrivez à prendre votre créneau seul, vous ne payez rien à Joventy — les 350 $ ne sont dus qu'à l'obtention effective du créneau via Joventy.",
      },
      {
        q: "Combien coûte le service créneau Allemagne avec Joventy ?",
        a: "350 $ au total, payés uniquement après que Joventy a confirmé votre rendez-vous à l'ambassade d'Allemagne. Aucun acompte à l'avance. Paiement via M-Pesa, Airtel Money ou Orange Money.",
      },
      {
        q: "Joventy prépare-t-il aussi mon dossier pour le visa long séjour Allemagne ?",
        a: "Oui. Le service créneau (350 $) couvre la surveillance du système et la prise de rendez-vous. Si vous souhaitez également que Joventy prépare votre dossier complet (formulaires, vérification des pièces, accompagnement intégral), vous pouvez opter pour le service visa complet à 1 500 $.",
      },
      {
        q: "Que se passe-t-il si l'ambassade d'Allemagne annule ou reporte le rendez-vous ?",
        a: "Si votre rendez-vous est annulé par l'ambassade allemande après confirmation, Joventy reprend la surveillance et recherche un nouveau créneau sans frais supplémentaires.",
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
      "L'Espagne gère ses rendez-vous visa directement via son ambassade à Kinshasa — pas par le système commun des pays Schengen. La procédure est en deux étapes : inscription par email à l'ambassade, puis prise de créneau sur citaconsular.es avec votre numéro de passeport et mot de passe. Joventy prend en charge l'intégralité de ce processus. Vous ne payez que quand le rendez-vous est confirmé.",
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
        desc: "Sélectionnez 'Créneau uniquement — Espagne' sur la plateforme Joventy. Aucun acompte. Communiquez vos informations (nom, numéro de passeport, date de voyage souhaitée) via l'espace client.",
      },
      {
        icon: "📧",
        title: "Joventy envoie l'email d'inscription à l'ambassade",
        desc: "Joventy contacte emb.kinshasa.citasvis@maec.es en votre nom avec objet 'RENDEZ-VOUS VISA EST' et les pièces jointes requises. L'ambassade répond sous 1 à 14 jours avec vos identifiants citaconsular (numéro de passeport + mot de passe).",
      },
      {
        icon: "✅",
        title: "Notre système réserve sur citaconsular.es → vous payez 350 $",
        desc: "Dès réception des identifiants, notre système prend le premier créneau disponible sur citaconsular.es. Vous recevez la confirmation par WhatsApp — c'est à ce moment seulement que vous réglez 350 $ via M-Pesa.",
      },
    ],
    included: [
      "Envoi de l'email d'inscription à emb.kinshasa.citasvis@maec.es en votre nom",
      "Surveillance continue du système citaconsular.es dès réception des identifiants",
      "Capture du premier créneau disponible",
      "Notification WhatsApp immédiate à la confirmation du rendez-vous",
      "Accès à l'espace client pour suivre chaque étape",
      "Support WhatsApp réactif (réponse < 2h)",
    ],
    faqs: [
      {
        q: "L'Espagne passe-t-elle par le système commun Schengen pour les visas depuis Kinshasa ?",
        a: "Non. Contrairement à la France, la Belgique ou l'Allemagne (visa Schengen court séjour), l'Espagne gère ses rendez-vous visa directement via son ambassade à Kinshasa. La prise de rendez-vous passe d'abord par un email à emb.kinshasa.citasvis@maec.es, puis par une réservation sur le portail officiel citaconsular.es avec votre numéro de passeport et mot de passe. Joventy gère ces deux étapes pour vous.",
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
        a: "350 $ au total, payés uniquement après confirmation du créneau sur citaconsular.es. Aucun acompte à l'avance. Paiement via M-Pesa, Airtel Money ou Orange Money.",
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
    name: "Schengen — CEV Kinshasa",
    title: "Créneau rendez-vous CEV Kinshasa 2026 — Visa Schengen | Joventy",
    metaDescription:
      "Créneau rendez-vous CEV Kinshasa pour visa Schengen : service privé Joventy à 350 USD après obtention, sans acompte. Le rendez-vous officiel est gratuit.",
    h1: "Créneau rendez-vous CEV Kinshasa pour visa Schengen",
    accroche:
      "Le CEV, géré par l’Ambassade de Belgique (anciennement Maison Schengen), reçoit les demandes de court séjour des pays qu’il représente : il ne concerne donc pas uniquement la Belgique. Créez impérativement votre propre compte Visa On Web avec votre email personnel et vérifiez la compétence sur cev-kin.eu. La prise de rendez-vous officielle est gratuite. Les 350 USD de Joventy rémunèrent exclusivement un service privé de surveillance et d’assistance, après obtention, sans accès privilégié ni garantie de date.",
    urgency:
      "Le CEV ouvre des possibilités sur une période glissante de cinq semaines ; de nouvelles plages sont ajoutées chaque jour. Une date n’est jamais garantie.",
    stats: [
      { n: "350 $", label: "service privé Joventy, après obtention du créneau" },
      { n: "0 $", label: "d'acompte — aucun paiement à l'avance" },
      { n: "0 $", label: "pour la prise de rendez-vous officielle CEV" },
      { n: "5 semaines", label: "période glissante annoncée par le CEV" },
    ],
    steps: [
      {
        icon: "📋",
        title: "Créez vous-même votre dossier Visa On Web",
        desc: "Utilisez votre email personnel, complétez et imprimez le formulaire, puis utilisez le bouton officiel « Créez un rendez-vous ». Les données ne sont plus modifiables après la réservation et sont contrôlées à l’entrée.",
      },
      {
        icon: "🔍",
        title: "Surveillance et assistance privées Joventy",
        desc: "Sur votre demande, Joventy suit les disponibilités publiques et vous assiste avec votre dossier. Nous n’avons aucun accès au CEV et ne pouvons ni contourner les règles ni promettre une date.",
      },
      {
        icon: "✅",
        title: "Créneau CEV confirmé → vous payez 350 $",
        desc: "Après confirmation d’un créneau, vous réglez 350 USD pour le service privé Joventy. Le rendez-vous officiel CEV reste gratuit ; les frais de visa éventuels sont distincts et se règlent selon les instructions officielles.",
      },
    ],
    included: [
      "Assistance pour comprendre le parcours Visa On Web (compte personnel du demandeur)",
      "Surveillance continue du système de rendez-vous du CEV Kinshasa",
      "Capture du premier créneau CEV disponible",
      "Notification WhatsApp immédiate à la confirmation",
      "Accès à l'espace client pour suivre le statut en temps réel",
      "Support WhatsApp réactif (réponse < 2h)",
    ],
    faqs: [
      {
        q: "Qu'est-ce que le CEV (Centre Européen des Visas) à Kinshasa ?",
        a: "Le CEV (Centre Européen des Visas), anciennement Maison Schengen, est géré par l’Ambassade de Belgique. Il reçoit les visas court séjour des pays qu’il représente. Consultez la page officielle des destinations sur cev-kin.eu avant de commencer : l’Espagne ne passe pas par le CEV.",
      },
      {
        q: "Avec un visa CEV Schengen, dans quels pays puis-je aller ?",
        a: "Un visa Schengen de type C (court séjour) délivré via le CEV permet de circuler librement dans les 27 États membres de l'espace Schengen : France, Belgique, Allemagne, Pays-Bas, Italie, Portugal, Autriche, Suisse, Suède, Norvège, etc. Durée maximum 90 jours sur toute période de 180 jours.",
      },
      {
        q: "Pourquoi les créneaux CEV à Kinshasa sont-ils si difficiles à obtenir ?",
        a: "Le CEV annonce environ 1 000 possibilités par semaine, affichées sur une période glissante de cinq semaines, avec de nouvelles plages chaque jour. Si aucune date n’apparaît, les créneaux ouverts sont déjà réservés : réessayez le lendemain.",
      },
      {
        q: "Dois-je avoir un compte Visa On Web avant de déposer ma demande Joventy ?",
        a: "Créez votre propre compte Visa On Web avec votre email personnel. Les informations du rendez-vous proviennent du formulaire VOW et ne sont plus modifiables après la réservation.",
      },
      {
        q: "Combien coûte le créneau Schengen CEV avec Joventy ?",
        a: "Le rendez-vous officiel CEV est gratuit. Les 350 USD, sans acompte et dus après obtention, correspondent uniquement au service privé de surveillance et d’assistance Joventy ; ils ne sont pas versés au CEV.",
      },
      {
        q: "L'Espagne passe-t-elle par le CEV à Kinshasa ?",
        a: "Non. L'Espagne est une exception notable : elle gère ses rendez-vous visa directement via son ambassade (email + citaconsular.es avec numéro de passeport et mot de passe). Si vous souhaitez un visa Espagne, Joventy propose un service créneau dédié.",
      },
      {
        q: "Combien de temps faut-il pour obtenir un créneau CEV à Kinshasa ?",
        a: "Le CEV ne publie pas de délai individuel garanti. Consultez chaque jour les ouvertures sur la période glissante de cinq semaines ; ne demandez pas un rendez-vous plus de trois mois avant le voyage, car une date après le voyage peut être annulée.",
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
    title: "Créneau Visa USA Kinshasa 2026 — Système consulaire géré 24h/24 par Joventy | Joventy",
    metaDescription:
      "Rendez-vous visa USA depuis Kinshasa 2026 (B1/B2, F1) : Joventy surveille le système consulaire américain en continu et réserve votre créneau dès qu'il apparaît. 350 $ payés uniquement après obtention — aucun acompte.",
    h1: "Créneau Visa USA depuis Kinshasa — Système consulaire américain surveillé 24h/24 par Joventy",
    accroche:
      "L'ambassade américaine à Kinshasa publie ses créneaux de rendez-vous visa sur son portail officiel. En 2026, ces créneaux sont extrêmement rares (restrictions Ebola, Travel Advisory Level 4). Joventy surveille le système en permanence et réserve votre créneau dès qu'un slot disponible apparaît — vous ne payez que quand c'est confirmé.",
    urgency:
      "En 2026, les créneaux visa USA à Kinshasa sont extrêmement rares. Restrictions Ebola + Travel Advisory Level 4.",
    stats: [
      { n: "350 $", label: "payés uniquement après obtention du créneau" },
      { n: "0 $", label: "d'acompte — aucun paiement à l'avance" },
      { n: "24h/24", label: "surveillance continue du système consulaire américain" },
      { n: "DS-160", label: "formulaire requis avant la prise de créneau" },
    ],
    steps: [
      {
        icon: "📋",
        title: "Votre DS-160 est soumis — créez votre demande",
        desc: "Sélectionnez 'Créneau uniquement — USA' sur la plateforme Joventy. Aucun acompte. Assurez-vous que votre formulaire DS-160 est soumis avant la prise de créneau.",
      },
      {
        icon: "🔍",
        title: "Notre système surveille le portail consulaire 24h/24",
        desc: "Joventy scrute en permanence le système de rendez-vous de l'ambassade américaine de Kinshasa. Dès qu'un créneau apparaît, il est réservé immédiatement avec vos identifiants de dossier.",
      },
      {
        icon: "✅",
        title: "Rendez-vous confirmé → vous payez 350 $",
        desc: "Vous recevez une notification WhatsApp avec la date et l'heure de votre entretien à l'ambassade américaine de Kinshasa. C'est à ce moment seulement que vous réglez 350 $ via M-Pesa, Airtel Money ou Orange Money.",
      },
    ],
    included: [
      "Surveillance continue du système de rendez-vous de l'ambassade américaine de Kinshasa",
      "Capture du premier créneau disponible",
      "Notification WhatsApp immédiate à la confirmation du rendez-vous",
      "Accès à l'espace client pour suivre le statut en temps réel",
      "Support WhatsApp réactif (réponse < 2h)",
      "Conseils de préparation à l'entretien consulaire B1/B2",
    ],
    faqs: [
      {
        q: "Faut-il avoir soumis le DS-160 avant de demander le créneau via Joventy ?",
        a: "Oui. Pour le service 'Créneau uniquement USA', vous devez avoir votre formulaire DS-160 soumis. Si vous avez besoin d'aide pour remplir le DS-160, optez pour le service visa complet Joventy (1 500 $).",
      },
      {
        q: "Les créneaux visa USA sont-ils vraiment disponibles à Kinshasa en 2026 ?",
        a: "La situation est difficile en 2026 : l'ambassade américaine à Kinshasa a suspendu ses services visa depuis le 18 mai 2026 (épidémie Ebola, Travel Advisory Level 4). Joventy surveille le système en continu et vous notifiera dès que des créneaux seront disponibles — que ce soit à Kinshasa ou qu'une alternative soit proposée.",
      },
      {
        q: "Puis-je demander un créneau visa USA depuis un pays neutre si les services sont suspendus à Kinshasa ?",
        a: "Oui. Si les services USA sont suspendus à Kinshasa, Joventy peut vous aider à obtenir un créneau dans l'ambassade américaine d'un pays neutre (Maroc, Égypte, Dubaï, Rwanda, etc.) après votre purge de 21 jours hors zone Ebola. Ce service est inclus dans le créneau uniquement à 350 $.",
      },
      {
        q: "Combien coûte le créneau visa USA avec Joventy ?",
        a: "350 $ au total, payés uniquement après confirmation du rendez-vous à l'ambassade américaine. Aucun acompte. Paiement via M-Pesa, Airtel Money ou Orange Money.",
      },
      {
        q: "Que se passe-t-il si mon visa B1/B2 est refusé à l'entretien après que Joventy a obtenu le créneau ?",
        a: "Si Joventy a verrouillé votre créneau (mission accomplie), les 350 $ sont dus. Le refus lors de l'entretien consulaire est une décision souveraine de l'ambassade américaine, indépendante du service Joventy. Nous vous conseillons gratuitement sur la préparation à l'entretien pour maximiser vos chances.",
      },
      {
        q: "Combien de temps faut-il pour avoir un créneau visa USA à Kinshasa ?",
        a: "En conditions normales, le délai varie de quelques jours à plusieurs semaines selon la période. En 2026, les services visa USA à Kinshasa sont suspendus depuis le 18 mai (Ebola). Joventy surveille le système 24h/24 et vous notifie dès qu'un créneau est disponible.",
      },
    ],
    relatedDestSlug: "visa-usa-kinshasa",
  },
];

export function getCreneauxPageBySlug(slug: string): CreneauxSEO | undefined {
  return CRENEAUX_PAGES.find((p) => p.slug === slug);
}
