import { CRENEAUX_PAGES } from "@/data/creneaux-seo";
import { CreneauxLanding } from "./CreneauxLanding";

const data = CRENEAUX_PAGES.find((p) => p.slug === "creneaux-visa-espagne-kinshasa")!;

export default function CreneauxEspagne() {
  return <CreneauxLanding data={data} />;
}
