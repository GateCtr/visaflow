import { Helmet } from "react-helmet-async";
import { PublicLayout } from "@/components/layout/PublicLayout";

const SITE = "https://joventy.cd";

export default function MethodologieSources() {
  return (
    <PublicLayout solidNav>
      <Helmet>
        <title>Méthodologie et sources visa | Joventy</title>
        <meta name="description" content="Découvrez comment Joventy distingue les sources officielles des conseils pratiques, présente ses limites et affiche ses tarifs d’assistance visa." />
        <link rel="canonical" href={`${SITE}/methodologie-sources`} />
        <meta property="og:title" content="Méthodologie et sources visa | Joventy" />
        <meta property="og:description" content="Sources officielles, limites de notre assistance et principes de correction des informations visa." />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={`${SITE}/methodologie-sources`} />
        <meta property="og:image" content={`${SITE}/opengraph.jpg`} />
      </Helmet>

      <main className="bg-slate-50 py-12 px-4">
        <article className="mx-auto max-w-3xl rounded-2xl bg-white p-6 shadow-sm sm:p-10">
          <header className="border-b border-slate-100 pb-6">
            <p className="text-sm font-semibold uppercase tracking-wider text-secondary">Transparence éditoriale</p>
            <h1 className="mt-2 text-3xl font-bold text-primary">Méthodologie et sources</h1>
            <p className="mt-4 leading-relaxed text-slate-600">
              Joventy publie des repères pour aider à comprendre les démarches visa depuis la RDC. Ces contenus ne remplacent pas les instructions d’une ambassade, d’un consulat ou d’une administration.
            </p>
          </header>

          <div className="mt-8 space-y-8 text-slate-600 leading-relaxed">
            <section>
              <h2 className="text-xl font-bold text-primary">Hiérarchie des sources</h2>
              <p className="mt-2">
                Nous privilégions les portails des autorités compétentes : ambassades et consulats, administrations d’immigration, portails de demande et centres officiellement désignés. Lorsqu’un guide renvoie vers une source, le lien est affiché dans son bloc « Sources officielles et vérification ».
              </p>
              <p className="mt-2">
                Les consignes de dépôt, listes de pièces, frais gouvernementaux, disponibilités de rendez-vous et décisions doivent toujours être confirmés directement auprès de l’autorité concernée.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-primary">Informations, conseils et mises à jour</h2>
              <p className="mt-2">
                Les guides indiquent leurs dates de publication et de mise à jour lorsqu’elles sont disponibles. Une date ne garantit pas qu’une règle est restée inchangée : les autorités peuvent modifier une procédure sans préavis.
              </p>
              <p className="mt-2">
                Nous distinguons les informations attribuées à une source officielle de nos conseils pratiques d’organisation de dossier. Ces conseils ne constituent ni une décision administrative ni un avis juridique.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-primary">Indépendance et limites</h2>
              <p className="mt-2">
                Joventy est un service privé d’assistance visa d’Akollad Groupe. Joventy n’est affilié à aucune ambassade, aucun consulat ni aucune autorité d’immigration, et ne délivre pas de visa. La décision et les délais relèvent exclusivement des autorités compétentes.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-primary">Corrections</h2>
              <p className="mt-2">
                Si une information paraît inexacte, incomplète ou dépassée, signalez-la à <a className="font-semibold text-primary underline" href="mailto:contact@joventy.cd">contact@joventy.cd</a> avec, si possible, le lien vers la source officielle. Nous examinerons le signalement et corrigerons le contenu lorsque la vérification le justifie.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-primary">Tarifs de l’assistance</h2>
              <p className="mt-2">
                Les tarifs de Joventy sont affichés publiquement sur la page Tarifs : accompagnement partiel 600 USD, accompagnement complet 1 500 USD, et service créneau à partir de 350 USD selon la formule affichée. Les frais gouvernementaux ou consulaires sont distincts et restent dus aux organismes concernés.
              </p>
            </section>
          </div>
        </article>
      </main>
    </PublicLayout>
  );
}