import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-6 py-20">
      <div className="max-w-3xl">
        <p className="mb-3 text-sm font-medium text-fd-muted-foreground">
          Documentation-first runtime design
        </p>
        <h1 className="mb-5 text-4xl font-semibold tracking-normal text-fd-foreground md:text-6xl">
          Little Workflow
        </h1>
        <p className="mb-8 max-w-2xl text-lg leading-8 text-fd-muted-foreground">
          A planned TypeScript control plane and durable runtime for AI-generated workflows
          that compile into validated, auditable, replayable workflow versions.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/docs"
            className="inline-flex h-10 items-center justify-center rounded-md bg-fd-primary px-4 text-sm font-medium text-fd-primary-foreground"
          >
            Read the docs
          </Link>
          <Link
            href="/docs/v0.1.0-alpha/getting-started/quickstart"
            className="inline-flex h-10 items-center justify-center rounded-md border px-4 text-sm font-medium"
          >
            Quickstart
          </Link>
        </div>
      </div>
    </div>
  );
}
