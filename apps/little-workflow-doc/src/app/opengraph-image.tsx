import { ImageResponse } from 'next/og';
import { getStackIconDataUri } from '@/lib/stack-icon-artwork';

export const alt = 'Little Stack — Documentation for agents, durable workflows, and a feedback loop';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: '100%', height: '100%', padding: '64px 72px', background: '#fcfcf9', color: '#242923', fontFamily: 'sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 32 }}>
        {/* The same static SVG geometry as the site mark, without idle eyes. */}
        <img src={getStackIconDataUri('brand')} alt="" width={52} height={52} />
        <span>Little Stack</span>
        <span style={{ color: '#656b62', fontSize: 22 }}> / documentation</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 72, letterSpacing: -3, lineHeight: 1.1 }}>Good agents start</div>
        <div style={{ fontSize: 72, letterSpacing: -3, lineHeight: 1.1, color: '#386844' }}>with a little stack.</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid #e4e7de', paddingTop: 28, fontSize: 20 }}>
        <div style={{ display: 'flex', gap: 24 }}><span>Harness</span><span>Workflow</span><span>LittleDB</span><span>Compute</span></div>
        <span style={{ color: '#386844' }}>little-stack.dev</span>
      </div>
    </div>,
    size,
  );
}
