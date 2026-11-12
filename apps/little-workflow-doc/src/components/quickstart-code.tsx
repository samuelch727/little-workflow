'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import { Check, Copy, FileCode2, Terminal } from 'lucide-react';
import Link from 'next/link';

const examples = [
  {
    id: 'agent', title: 'agent.ts', icon: FileCode2, language: 'TypeScript',
    code: `import { createHarness, localHost }\n  from "@little-stack/harness";\nimport { openai } from "@ai-sdk/openai";\n\nexport const agent = createHarness({\n  host: localHost({ dataDir: ".little" }),\n  model: openai("gpt-5"),\n  system: "You help people get things done.",\n});`,
    href: '/docs/harness/v0.1.0-alpha/quickstart', link: 'Build your first agent',
    note: 'Your model. Your tools. Your workspace.',
  },
  {
    id: 'setup', title: 'Terminal', icon: Terminal, language: 'Shell',
    code: `# Create a Node or Next.js project\nnpx @little-stack/workflow@0.2.0-alpha.3 setup\n\n# Already have a Next.js app? Preview changes:\nnpx @little-stack/workflow@0.2.0-alpha.3 setup \\\n  --here --template existing-next --plan\n\n# Add --workflow to include a durable workflow.`,
    href: '/docs/get-started/setup', link: 'Follow the setup guide', note: 'Node.js 22+ · AI SDK 7',
  },
] as const;

// Keep this small preview readable without a client-side highlighter.
function HighlightedLine({ line }: { line: string }) {
  if (line.trimStart().startsWith('#')) return <span className="code-comment">{line}</span>;
  const tokens = line.split(/("[^"]*"|\b(?:import|from|export|const)\b)/g);
  return tokens.map((token, index) => <span key={index} className={token.startsWith('"') ? 'code-string' : /^(import|from|export|const)$/.test(token) ? 'code-keyword' : undefined}>{token}</span>);
}

export function QuickstartCode() {
  const [selected, setSelected] = useState(0);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const copyAttempt = useRef(0);
  const example = examples[selected];

  function selectTab(index: number) {
    copyAttempt.current += 1;
    setSelected(index);
    setCopyStatus('idle');
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % examples.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + examples.length) % examples.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = examples.length - 1;
    else return;
    event.preventDefault();
    selectTab(next);
    tabs.current[next]?.focus();
  }

  async function copyCode() {
    const attempt = ++copyAttempt.current;
    try {
      await navigator.clipboard.writeText(example.code);
      if (attempt === copyAttempt.current) setCopyStatus('copied');
    } catch {
      if (attempt === copyAttempt.current) setCopyStatus('error');
    }
  }

  return (
    <div className="quickstart-code">
      <div className="code-window-bar">
        <div role="tablist" aria-label="Quickstart examples" className="code-tabs">
          {examples.map((item, index) => <button key={item.id} ref={(element) => { tabs.current[index] = element; }} id={`example-tab-${item.id}`} type="button" role="tab" aria-selected={selected === index} aria-controls={`example-panel-${item.id}`} tabIndex={selected === index ? 0 : -1} onClick={() => selectTab(index)} onKeyDown={(event) => onTabKeyDown(event, index)}><item.icon size={14} aria-hidden="true" />{item.title}</button>)}
        </div>
        <span className="code-language">{example.language}</span>
      </div>
      {examples.map((item, index) => <div key={item.id} id={`example-panel-${item.id}`} role="tabpanel" aria-labelledby={`example-tab-${item.id}`} hidden={index !== selected} tabIndex={0} className="code-panel">
        <pre aria-label={`${item.language} example`}><code>{item.code.split('\n').map((line, lineIndex) => <span className="code-line" key={lineIndex}><span className="code-line-number" aria-hidden="true">{lineIndex + 1}</span><span><HighlightedLine line={line} />{'\n'}</span></span>)}</code></pre>
      </div>)}
      <div className="code-window-footer">
        <Link href={example.href}>{example.link}<span aria-hidden="true">↗</span></Link>
        <button className="code-copy" type="button" onClick={copyCode} aria-label={copyStatus === 'copied' ? 'Code copied' : 'Copy example code'}>{copyStatus === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}<span>{copyStatus === 'copied' ? 'Copied' : 'Copy'}</span></button>
      </div>
      <div className="code-caption"><span className="code-caption-dot" /><span>{example.note}</span><span className="sr-only" role="status">{copyStatus === 'copied' ? 'Example copied to clipboard.' : copyStatus === 'error' ? 'Could not copy. Select the code and copy it manually.' : ''}</span>{copyStatus === 'error' && <span className="code-copy-error">Select the code to copy it.</span>}</div>
    </div>
  );
}
