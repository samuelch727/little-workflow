import Link from 'next/link';

type Product = {
  name: string;
  href: string;
  status: string;
  available: boolean;
  role: string;
  summary: string;
};

const products: Product[] = [
  {
    name: 'Little Harness',
    href: '/docs/harness',
    status: 'npm 0.2.0-alpha.0',
    available: true,
    role: 'Start here',
    summary:
      'The agent runtime: sessions, tools, skills, files, artifacts and traces, with each session in its own workspace.',
  },
  {
    name: 'Little Workflow',
    href: '/docs/workflow',
    status: 'npm 0.2.0-alpha.1',
    available: true,
    role: 'Optional',
    summary:
      'For bounded, durable jobs: an agent designs a workflow, Little Workflow validates and runs it, and any workflow can be handed to a Harness agent as a tool.',
  },
  {
    name: 'LittleDB',
    href: '/docs/littledb',
    status: 'Private source',
    available: false,
    role: 'The product',
    summary:
      'Tracing and self-improvement for Harness agents and Workflow runs: it records what they do, scores it, and ships the changes that test better. Private source; Harness and Workflow work without it.',
  },
  {
    name: 'Workspaces',
    href: '/docs/how-they-fit#workspaces',
    status: 'Unpublished source',
    available: false,
    role: 'Where work lives',
    summary:
      "Each user's folder, ready when they return: the folder tier for most turns, a container that wakes on demand. Managed with LittleDB's hosted service or self-hosted with Little Compute.",
  },
];

const local = [
  {
    title: 'Harness sessions stay local',
    body: 'The Local Host keeps sessions, traces and artifacts in a folder you choose.',
  },
  {
    title: 'Workflow runs stay local',
    body: 'Local World records every run event in an embedded SQLite store on disk.',
  },
  {
    title: 'No hosted service required',
    body: 'Workspaces can be self-hosted with Little Compute, and LittleDB is optional.',
  },
];

function StatusBadge({ product }: { product: Product }) {
  return (
    <span
      className={
        product.available
          ? 'rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-200'
          : 'rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-200'
      }
    >
      {product.status}
    </span>
  );
}

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-16 px-6 py-16 md:py-24">
      <section className="max-w-3xl">
        <p className="mb-3 text-sm font-medium text-fd-muted-foreground">Little documentation</p>
        <h1 className="mb-5 text-4xl font-semibold tracking-tight text-fd-foreground md:text-5xl">
          Agents that get better from the conversations they have.
        </h1>
        <p className="mb-8 text-lg leading-8 text-fd-muted-foreground">
          LittleDB traces what your agents do and improves them. Little Harness and Little
          Workflow are the SDK you build those agents with. Start with Little Harness; add Little
          Workflow when a job must be bounded, durable and replayable.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/docs/get-started/setup"
            className="inline-flex h-10 items-center justify-center rounded-md bg-fd-primary px-4 text-sm font-medium text-fd-primary-foreground"
          >
            Set up a project
          </Link>
          <Link
            href="/docs/how-they-fit"
            className="inline-flex h-10 items-center justify-center rounded-md border px-4 text-sm font-medium"
          >
            How they fit
          </Link>
          <Link
            href="/docs"
            className="inline-flex h-10 items-center justify-center rounded-md border px-4 text-sm font-medium"
          >
            All docs
          </Link>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xl font-semibold text-fd-foreground">The pieces</h2>
        <p className="mb-6 text-sm text-fd-muted-foreground">
          Harness and Workflow are published alpha packages. LittleDB and the workspace engines are
          documented from source and cannot be installed yet.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {products.map((product) => (
            <Link
              key={product.name}
              href={product.href}
              className="group flex flex-col gap-3 rounded-lg border bg-fd-card p-5 transition-colors hover:bg-fd-accent/60"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-base font-semibold text-fd-foreground">{product.name}</span>
                <StatusBadge product={product} />
              </div>
              <p className="text-sm leading-6 text-fd-muted-foreground">{product.summary}</p>
              <span className="text-xs font-medium uppercase tracking-wide text-fd-muted-foreground">
                {product.role}
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="grid gap-8 md:grid-cols-[1fr_1.2fr]">
        <div>
          <h2 className="mb-2 text-xl font-semibold text-fd-foreground">Local first</h2>
          <p className="text-sm leading-6 text-fd-muted-foreground">
            The published packages run on your machine with no Little service to sign up for. Bring
            your own model provider through the AI SDK.
          </p>
        </div>
        <ul className="grid gap-3">
          {local.map((item) => (
            <li key={item.title} className="rounded-lg border p-4">
              <p className="text-sm font-medium text-fd-foreground">{item.title}</p>
              <p className="text-sm leading-6 text-fd-muted-foreground">{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border bg-fd-muted/40 p-5 text-sm leading-6 text-fd-muted-foreground">
        <span className="font-medium text-fd-foreground">Review preview.</span> Some pages describe
        changes that exist only in the current source and are labeled UNRELEASED. See{' '}
        <Link href="/docs/releases" className="font-medium underline underline-offset-2">
          Releases
        </Link>{' '}
        for what each package version contains.
      </section>
    </main>
  );
}
