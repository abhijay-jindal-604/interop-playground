/**
 * Awaiting panel (06 UI-15): shown while `Run.awaiting` is set. Heading + countdown to `deadline`
 * (announced at 60, 30 and 10 s), the instruction list by `expects`, and the delivery block of the
 * latest `deliver-*` call (UI-16). The observation form (API-29) joins with the manual tier (T-84).
 */
import { useEffect, useRef, useState } from 'react';
import { deliveryCopy as d } from '../copy.js';
import { announce } from '../lib/announce.js';
import type { DeliveryOutput } from '../inspector/model.js';
import type { RunView } from '../run/reduce.js';
import { DeliveryBlock } from './Delivery.js';

type Expect = keyof typeof d.headings;
const ANNOUNCE_AT = [60, 30, 10];

export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function secondsLeft(deadline: string, now: number): number {
  const t = Date.parse(deadline);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.ceil((t - now) / 1000));
}

export function useCountdown(deadline: string): number {
  const [left, setLeft] = useState(() => secondsLeft(deadline, Date.now()));
  useEffect(() => {
    setLeft(secondsLeft(deadline, Date.now()));
    const t = setInterval(() => setLeft(secondsLeft(deadline, Date.now())), 1_000);
    return () => clearInterval(t);
  }, [deadline]);
  return left;
}

export function AwaitingPanel({
  awaiting,
  delivery,
}: {
  awaiting: NonNullable<RunView['awaiting']>;
  delivery: DeliveryOutput | null;
}) {
  const left = useCountdown(awaiting.deadline);
  const said = useRef<Set<number>>(new Set());
  const expects = awaiting.expects.filter((e): e is Expect => e in d.headings);
  const first = expects[0];

  useEffect(() => {
    if (first) announce(d.announce(d.headings[first]), 'assertive');
  }, [first, awaiting.stepKey]);
  useEffect(() => {
    for (const at of ANNOUNCE_AT) {
      if (left <= at && left > 0 && !said.current.has(at)) {
        said.current.add(at);
        // only the crossing itself is read, not every threshold already passed at mount
        if (left > at - 2) announce(d.announceLeft(at));
      }
    }
  }, [left]);

  const showDelivery =
    delivery !== null && (delivery.channel === 'qr' || delivery.channel === 'deep-link');
  return (
    <section
      className="awaiting"
      role="region"
      aria-label={d.region}
      data-awaiting={awaiting.stepKey}
    >
      {left === 0 ? (
        <p className="awaiting-expired">{d.expired}</p>
      ) : (
        <>
          <div className="awaiting-head">
            <h2 className="awaiting-title">{first ? d.headings[first] : d.region}</h2>
            <p className="awaiting-countdown mono" aria-live="off" data-seconds={left}>
              {d.timeLeft(mmss(left))}
            </p>
          </div>
          {expects.map((e) => (
            <div key={e} className="awaiting-entry" data-expects={e}>
              {e !== first ? <h3 className="awaiting-sub">{d.headings[e]}</h3> : null}
              <ol className="awaiting-steps">
                {d.steps[e].map((s) => (
                  <li key={s}>{s.replace(/^\d+\.\s*/, '')}</li>
                ))}
              </ol>
            </div>
          ))}
          {showDelivery ? <DeliveryBlock delivery={delivery} /> : null}
        </>
      )}
    </section>
  );
}
