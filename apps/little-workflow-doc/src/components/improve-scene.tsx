'use client';

import { useEffect, useRef, useState } from 'react';
import { CircleDot, MessagesSquare } from 'lucide-react';

/*
  The same loop as the hero, as it looks in LittleDB. A change that came out of
  failed chats lands at the top of a project's Changes list, marked Testing. It
  is replayed on the chats that failed and the passing count climbs; it turns
  Kept and the Live mark moves to it. After a short hold the row closes and the
  loop starts again. Nobody clicks anything: the product does this by itself.
  The older rows are real kinds of outcome too, including one that was dropped.
*/

type State = { open: boolean; ready: boolean; passed: number };
const START: State = { open: false, ready: false, passed: 0 };
const DONE: State = { open: true, ready: true, passed: 8 };

export function ImproveScene() {
  const ref = useRef<HTMLDivElement>(null);
  const [s, setS] = useState<State>(DONE);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let alive = true, running = false, timer = 0;
    const wait = (ms: number) => new Promise<void>((done) => { timer = window.setTimeout(done, ms); });
    const loop = async () => {
      running = true;
      setS(START);
      while (alive && running) {
        await wait(900); if (!running) break;
        setS({ open: true, ready: false, passed: 0 });
        for (const passed of [2, 4, 6, 8]) { await wait(520); if (!running) break; setS({ open: true, ready: false, passed }); }
        await wait(300); if (!running) break;
        setS(DONE);
        await wait(2400); if (!running) break;
        setS({ open: false, ready: true, passed: 8 });
        await wait(700); if (!running) break;
        setS(START);
      }
    };
    const view = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !running) void loop();
      if (!entry.isIntersecting) { running = false; window.clearTimeout(timer); setS(DONE); }
    });
    view.observe(el);
    return () => { alive = false; running = false; window.clearTimeout(timer); view.disconnect(); };
  }, []);

  const live = s.open && s.ready;
  return (
    <div
      ref={ref}
      className="scene"
      role="img"
      aria-label="LittleDB's Changes list for the support-agent project. A new change, Ask for the order number, appears marked Testing. It is replayed on the 9 chats that failed, passes 8 of them, turns Kept, and becomes the live version in place of the change before it. An older change that failed its chats is shown as Dropped."
    >
      <div className="scene-body" aria-hidden="true">
        <div className="scene-head">
          <span className="scene-title">Changes</span>
          <span className="scene-proj"><b />support-agent</span>
        </div>
        <div className="scene-drop" data-open={s.open || undefined}>
          <div>
            <Row lead msg="Ask for the order number" issue="Issue 12" chats="9 failed chats" when="Just now" state={s.ready ? 'kept' : 'testing'} count={`${s.passed}/9`} live={live} />
          </div>
        </div>
        <Row msg="Shorter refund replies" issue="Issue 9" chats="6 failed chats" when="2d ago" state="kept" count="6/6" live={!live} />
        <Row msg="Offer a call back instead" issue="Issue 8" chats="5 failed chats" when="3d ago" state="dropped" count="2/5" live={false} />
        <Row msg="Check stock before giving a date" issue="Issue 7" chats="4 failed chats" when="5d ago" state="kept" count="4/4" live={false} />
      </div>
    </div>
  );
}

type RowState = 'testing' | 'kept' | 'dropped';
const WORDS: Record<RowState, string> = { testing: 'Testing', kept: 'Kept', dropped: 'Dropped' };

function Row({ lead, msg, issue, chats, when, state, count, live }: { lead?: boolean; msg: string; issue: string; chats: string; when: string; state: RowState; count: string; live: boolean }) {
  return (
    <div className="scene-row" data-lead={lead || undefined}>
      <span className="scene-lines">
        <span className="scene-msg">{msg}<span className="scene-live" data-on={live || undefined}>Live</span></span>
        <span className="scene-meta">
          <span><CircleDot size={12} strokeWidth={2} />{issue}</span>
          <span><MessagesSquare size={12} strokeWidth={2} />{chats}</span>
          <span className="scene-when">{when}</span>
        </span>
      </span>
      <span className="scene-badge" data-state={state}>
        <span className="scene-mark"><i className="scene-spin" /><i className="scene-dot" /></span>
        <span className="scene-word">
          {(['testing', 'kept', 'dropped'] as const).map((k) => <span key={k} data-on={state === k || undefined}>{WORDS[k]}</span>)}
        </span>
      </span>
      <span className="scene-count">{count}</span>
    </div>
  );
}
