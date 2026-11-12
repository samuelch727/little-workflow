import Link from 'next/link';
import { ArrowRight, ArrowUpRight, BookOpen, Monitor } from 'lucide-react';
import { QuickstartCode } from '@/components/quickstart-code';
import { StackMark } from '@/components/stack-brand';
import { StackIcon } from '@/components/stack-icon';
import { gitConfig } from '@/lib/shared';

const products = [
  {
    name: 'Little Harness', href: '/docs/harness', role: 'THE AGENT RUNTIME',
    summary: 'Give your agent tools, skills, files, and a workspace. Keep sessions and traces together.',
    status: 'Published alpha', detail: '@little-stack/harness', color: 'harness',
  },
  {
    name: 'Little Workflow', href: '/docs/workflow', role: 'DURABLE EXECUTION',
    summary: 'Turn bounded jobs into validated workflows. Run, inspect, and replay every step.',
    status: 'Published alpha', detail: '@little-stack/workflow', color: 'workflow',
  },
  {
    name: 'LittleDB', href: '/docs/littledb', role: 'TRACING & IMPROVEMENT',
    summary: 'Trace what agents do, evaluate the results, and test changes that make them better.',
    status: 'Private source', detail: 'Access required', color: 'littledb',
  },
  {
    name: 'Little Compute', href: '/docs/compute', role: 'THE WORKSPACE ENGINE',
    summary: 'The self-hosted engine for persistent workspaces and on-demand execution.',
    status: 'Unpublished source', detail: 'Control plane frozen', color: 'compute',
  },
] as const;

export default function HomePage() {
  return (
    <>
      <div id="main-content" className="stack-home" tabIndex={-1}>
        <section className="home-hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <Link className="release-link" href="/docs/releases">
              <span className="release-dot" /><span>Harness + Workflow</span>
              <span className="release-version">0.2.0-alpha.3</span><ArrowUpRight size={13} aria-hidden="true" />
            </Link>
            <p className="eyebrow">THE LITTLE STACK DOCUMENTATION</p>
            <h1 id="hero-title">Good agents start<br />with a <span>little stack.</span></h1>
            <p className="hero-description">Build with an agent runtime. Add durable workflows.<br className="hero-break" />{' '}Keep the tools, files, and traces that make it all work.</p>
            <div className="hero-actions">
              <Link className="stack-button stack-button-primary" href="/docs/get-started/setup">Get started <ArrowRight size={16} aria-hidden="true" /></Link>
              <Link className="stack-button stack-button-secondary" href="/docs">Explore the docs <BookOpen size={16} aria-hidden="true" /></Link>
            </div>
            <p className="hero-footnote"><Monitor size={14} aria-hidden="true" />Local first. Bring your own model.</p>
          </div>
          <div className="hero-code-wrap"><QuickstartCode /></div>
        </section>

        <section className="product-section" aria-labelledby="product-title">
          <div className="section-heading">
            <div><p className="eyebrow">ONE STACK. CLEAR RESPONSIBILITIES.</p><h2 id="product-title">Find your building block.</h2></div>
            <Link className="text-link" href="/docs/how-they-fit">How they fit together <ArrowUpRight size={16} aria-hidden="true" /></Link>
          </div>
          <div className="product-grid">
            {products.map((product) => (
              <Link key={product.name} href={product.href} className={`product-card product-${product.color}`}>
                <div className="product-card-top"><StackIcon name={product.color} size={44} className="product-icon" /><ArrowUpRight className="product-arrow" size={18} aria-hidden="true" /></div>
                <p className="product-role">{product.role}</p><h3>{product.name}</h3><p className="product-summary">{product.summary}</p>
                <div className="product-card-bottom"><span className={`availability ${product.status === 'Published alpha' ? 'availability-published' : ''}`}><span />{product.status}</span><span className="product-detail">{product.detail}</span></div>
              </Link>
            ))}
          </div>
          <p className="product-boundary">Harness and Workflow run independently. LittleDB is private; Little Compute is unpublished. <Link href="/docs/releases">See release status <span aria-hidden="true">↗</span></Link></p>
        </section>

        <section className="start-section" aria-labelledby="start-title">
          <div className="start-intro">
            <p className="eyebrow">FROM AN IDEA TO A FIRST RUN</p><h2 id="start-title">Start small.<br />{' '}Build from there.</h2>
            <p>Most projects start with Harness. Add a workflow when a job needs durable, replayable steps.</p>
            <Link className="text-link" href="/docs/get-started">Choose your starting point <ArrowRight size={15} aria-hidden="true" /></Link>
          </div>
          <div className="quickstart-grid">
            <Link className="quickstart-card" href="/docs/harness/v0.1.0-alpha/quickstart">
              <div className="quickstart-card-heading"><StackIcon name="harness" size={24} /><span>01 / HARNESS</span><ArrowUpRight size={18} aria-hidden="true" /></div>
              <h3>Build your first agent</h3><p>Bring a model and a few tools. Embed a Harness agent in your own app.</p><span className="quickstart-destination">Follow the quickstart <ArrowRight size={14} aria-hidden="true" /></span>
            </Link>
            <Link className="quickstart-card" href="/docs/workflow/v0.1.0-alpha/getting-started/quickstart">
              <div className="quickstart-card-heading"><StackIcon name="workflow" size={24} /><span>02 / WORKFLOW</span><ArrowUpRight size={18} aria-hidden="true" /></div>
              <h3>Run a durable workflow</h3><p>Define a job, run it locally, and inspect the steps that got you there.</p><span className="quickstart-destination">Follow the quickstart <ArrowRight size={14} aria-hidden="true" /></span>
            </Link>
          </div>
        </section>

        <div className="local-note">
          <StackMark size={32} className="local-note-icon" />
          <div><h2>Your machine is a good place to start.</h2><p>The published SDKs run locally with Node.js 22+ and AI SDK 7. No Little hosted service required.</p></div>
          <Link className="text-link" href="/docs/get-started/setup#requirements">Requirements <ArrowUpRight size={15} aria-hidden="true" /></Link>
        </div>
      </div>

      <footer className="stack-footer">
        <div><Link href="/" className="footer-brand"><StackMark size={24} /><span>Little Stack</span></Link><span className="footer-tagline">A little foundation for what comes next.</span></div>
        <nav aria-label="Footer"><Link href="/docs">Documentation</Link><Link href="/docs/releases">Releases</Link><Link href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}>GitHub <ArrowUpRight size={12} aria-hidden="true" /></Link><Link href="/llms.txt">llms.txt</Link></nav>
      </footer>
    </>
  );
}
