import Link from 'next/link';
import { ImproveScene } from '@/components/improve-scene';
import { QuickstartCode } from '@/components/quickstart-code';
import { StackMark } from '@/components/stack-brand';
import { StackIcon, type StackIconName } from '@/components/stack-icon';
import { WaterHero } from '@/components/water-hero';
import { gitConfig } from '@/lib/shared';

type Part = { name: string; href: string; icon: StackIconName; summary: string; status: string; live?: boolean };

// What you build with, what improves it, where it runs.
const PARTS: Part[] = [
  { name: 'Little Harness', href: '/docs/harness', icon: 'harness', summary: 'Runs your agent with tools, skills, files and traces.', status: '0.2.0-alpha.3 on npm', live: true },
  { name: 'Little Workflow', href: '/docs/workflow', icon: 'workflow', summary: 'Bounded jobs that run durably and replay step by step.', status: '0.2.0-alpha.3 on npm', live: true },
  { name: 'LittleDB', href: '/docs/littledb', icon: 'littledb', summary: 'Traces what agents do and tests changes that make them better.', status: 'Private for now' },
  { name: 'Little Compute', href: '/docs/compute', icon: 'compute', summary: 'Workspaces that keep each user’s files and wake on demand.', status: 'Not published' },
];

export default function HomePage() {
  return (
    <>
      <div id="main-content" className="stack-main" tabIndex={-1}>
        <WaterHero>
          <h1 id="hero-title">Agents that keep getting better.</h1>
          <p className="hero-description">Left alone, every agent drifts its own way. Little Stack runs your agents, tests each fix on the chats that went wrong, and brings all of them up to the same, better version.</p>
          <div className="hero-actions">
            <Link className="stack-button stack-button-primary" href="/docs/get-started/setup">Get started</Link>
            <Link className="hero-link" href="/docs">Read the docs</Link>
          </div>
        </WaterHero>

        <div className="stack-home">
          <nav className="stack-list" aria-label="The parts of the stack">
            <ul>
              {PARTS.map((part) => (
                <li key={part.name}>
                  <Link href={part.href} className="stack-item">
                    <StackIcon name={part.icon} size={36} />
                    <span className="stack-item-name">{part.name}</span>
                    <span className="stack-item-summary">{part.summary}</span>
                    <span className={`stack-item-status${part.live ? ' is-live' : ''}`}>{part.status}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <section className="loop-section" aria-labelledby="loop-title">
            <div className="loop-copy">
              <h2 id="loop-title">The same loop, in the product</h2>
              <p>LittleDB finds the chats that went wrong and writes a change. It replays the change on those chats. If it passes, it is kept and goes live, and the change before it steps aside.</p>
              <p className="loop-note">Nobody has to click anything, and a change that fails its chats is dropped.</p>
              <Link href="/docs/littledb">How LittleDB improves an agent</Link>
            </div>
            <ImproveScene />
          </section>

          <section className="first-agent" aria-labelledby="first-agent-title">
            <div className="first-agent-copy">
              <h2 id="first-agent-title">Your first agent</h2>
              <p>Start with Little Harness. Add Little Workflow when a job has to be bounded, durable and replayable. Connect LittleDB when you have access to it.</p>
              <ul className="first-agent-links">
                <li><Link href="/docs/harness/v0.1.0-alpha/quickstart">Harness quickstart</Link></li>
                <li><Link href="/docs/workflow/v0.1.0-alpha/getting-started/quickstart">Workflow quickstart</Link></li>
                <li><Link href="/docs/how-they-fit">How the parts fit together</Link></li>
              </ul>
            </div>
            <QuickstartCode />
          </section>
        </div>
      </div>

      <footer className="stack-footer">
        <Link href="/" className="footer-brand"><StackMark size={28} /><span>Little Stack</span></Link>
        <nav aria-label="Footer">
          <Link href="/docs">Docs</Link>
          <Link href="/docs/releases">Releases</Link>
          <Link href="/docs/glossary">Glossary</Link>
          <Link href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}>GitHub</Link>
          <Link href="/llms.txt">llms.txt</Link>
        </nav>
      </footer>
    </>
  );
}
