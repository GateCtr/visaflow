/**
 * Application Detail — Page admin détail dossier (version modulaire).
 *
 * Layout : 2 colonnes (contenu + chat) avec modules séparés.
 * Ce fichier ne contient que le layout et le routing.
 * Chaque section est dans son propre module.
 *
 * NOTE: Cette version coexiste avec l'ancien ApplicationDetail.tsx
 * pendant la migration progressive. Quand tous les modules seront prêts,
 * le router pointera ici au lieu de l'ancien fichier.
 */

export { default } from "../ApplicationDetail";

// TODO: Quand la migration modulaire sera complète, ce fichier deviendra :
//
// import { HeaderCard } from "./HeaderCard";
// import { ChatPanel } from "./ChatPanel";
// import { PaymentPanel } from "./PaymentPanel";
// import { QuickActions } from "./QuickActions";
// import { SlotPanel } from "./SlotPanel";
// import { HunterConfig } from "./HunterConfig";
// import { DocumentVault } from "./DocumentVault";
// import { ActivityLog } from "./ActivityLog";
// import { BotLogTimeline } from "./BotLogTimeline";
//
// export default function ApplicationDetailPage() { ... }
