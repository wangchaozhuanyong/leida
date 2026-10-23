'use client';
import type {ReactNode} from 'react';

/** Decorative motion follows the published state; it never represents a live scan. */
export function RadarScope({state,kind,children}:{state:string;kind?:string;children:ReactNode}) {
  const quiet=['completed','observed','cancelled','overdue'].includes(state);
  return <div className={`pub-radar-scope radar-${state} kind-${kind||'unknown'}`}>
    <div className="pub-radar-disc" aria-hidden="true">
      <span className="pub-radar-ring ring-outer"/><span className="pub-radar-ring ring-middle"/><span className="pub-radar-ring ring-inner"/>
      {!quiet&&<span className="pub-radar-sweep"/>}
    </div>
    <div className="pub-radar-core">{children}</div>
  </div>;
}
