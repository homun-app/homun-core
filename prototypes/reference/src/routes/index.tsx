import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, CalendarClock, LineChart, Mail, Radar, ReceiptText, Workflow } from "lucide-react";
import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Homun — assistenti operativi per piccole aziende" },
      {
        name: "description",
        content:
          "Crea assistenti e automazioni che rispondono alle email, sollecitano le fatture, seguono i concorrenti e ti avvisano quando qualcosa cambia.",
      },
      { property: "og:title", content: "Homun — assistenti operativi per piccole aziende" },
      {
        property: "og:description",
        content: "Bot e automazioni semplici da creare, senza reparto informatico.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const useCases = [
  { icon: Mail, title: "Risposte alle email", text: "Il bot legge, riassume e propone la risposta giusta." },
  { icon: ReceiptText, title: "Solleciti fatture", text: "Chi non ha pagato riceve un promemoria gentile." },
  { icon: CalendarClock, title: "Appuntamenti", text: "Proposte di orario e conferme senza scambi infiniti." },
  { icon: Radar, title: "Concorrenti", text: "Prezzi e novità dei concorrenti, riassunti ogni settimana." },
  { icon: LineChart, title: "Aggiornamenti", text: "Pagine e bandi che ti interessano, controllati per te." },
  { icon: Workflow, title: "Automazioni", text: "«Quando arriva questo → fai quello». Niente codice." },
];

function Landing() {
  const { user, loading } = useAuth();

  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Wordmark />
        <nav className="flex items-center gap-2">
          {loading ? null : user ? (
            <Button asChild>
              <Link to="/app">Apri Homun</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost">
                <Link to="/auth">Accedi</Link>
              </Button>
              <Button asChild>
                <Link to="/auth">Inizia gratis</Link>
              </Button>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="alpine-glow mx-auto max-w-6xl px-6 pb-20 pt-14 text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
            Assistenti operativi
          </p>
          <h1 className="mx-auto mt-5 max-w-3xl text-balance text-4xl font-extrabold leading-[1.08] tracking-tight text-foreground sm:text-6xl">
            L'AI che si occupa del lavoro ripetitivo della tua azienda
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg text-muted-foreground">
            Homun crea assistenti che rispondono ai messaggi, sollecitano le fatture, seguono i
            concorrenti e ti avvisano quando cambia qualcosa. Si usa scrivendo, come una chat.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link to={user ? "/app" : "/auth"}>
                Crea il tuo primo assistente
                <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/auth">Ho già un account</Link>
            </Button>
          </div>
          <p className="mt-5 text-sm text-muted-foreground">
            Niente informatici: aggiungi solo le funzioni che ti servono.
          </p>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-24">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {useCases.map(({ icon: Icon, title, text }) => (
              <article key={title} className="frost-panel p-6">
                <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Icon className="size-5" />
                </span>
                <h2 className="mt-4 text-base font-semibold text-foreground">{title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="border-y border-border bg-secondary/40 py-20">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 md:grid-cols-3">
            {[
              ["1. Scegli le funzioni", "Email, calendario, fatture, monitoraggio siti, concorrenti: installi solo quelle utili."],
              ["2. Parla col tuo bot", "Chiedi in italiano cosa serve. Il bot usa le funzioni installate e ti mostra cosa ha fatto."],
              ["3. Rendilo automatico", "Trasformi la richiesta in un'automazione: quando succede questo, fai quello."],
            ].map(([title, text]) => (
              <div key={title}>
                <h3 className="text-lg font-semibold text-foreground">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-3xl px-6 py-24 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-foreground">
            Ogni progetto resta separato
          </h2>
          <p className="mt-4 text-muted-foreground">
            Ogni cliente o reparto ha il proprio spazio: dati, assistenti e automazioni sono visibili
            solo a chi inviti, con il ruolo che decidi tu.
          </p>
          <Button asChild size="lg" className="mt-8">
            <Link to={user ? "/app" : "/auth"}>
              Inizia ora
              <ArrowRight />
            </Link>
          </Button>
        </section>
      </main>

      <footer className="border-t border-border py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-6 text-sm text-muted-foreground sm:flex-row sm:justify-between">
          <Wordmark className="h-5" />
          <p>© {new Date().getFullYear()} Homun</p>
        </div>
      </footer>
    </div>
  );
}
