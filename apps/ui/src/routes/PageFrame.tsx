/**
 * Page frame (06 UI-50): one `<h1>` per route, a breadcrumb `<nav aria-label="Breadcrumb">`, an
 * actions row, content max width 1280 px. Sets the page title (UI-01) and moves focus to the `<h1>`
 * on route change (UI-73 rule 1), not on the first load.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { pageTitle } from '../copy.js';

let firstRoute = true;

/** Common page layout: title, breadcrumbs and document title. */
export function PageFrame({
  title,
  docTitle,
  crumbs,
  actions,
  lead,
  children,
}: {
  title: ReactNode;
  /** the screen name in `{screen} · Interop Playground`; omit for the bare app name */
  docTitle?: string;
  crumbs?: { label: string; to?: string }[];
  actions?: ReactNode;
  lead?: ReactNode;
  /** kept for callers; "Quiet" (ADR-126) no longer shows a label above the `<h1>` */
  eyebrow?: string;
  children?: ReactNode;
}) {
  const h1 = useRef<HTMLHeadingElement>(null);
  const location = useLocation();
  useEffect(() => {
    document.title = pageTitle(docTitle);
  }, [docTitle]);
  useEffect(() => {
    if (firstRoute) {
      firstRoute = false;
      return;
    }
    h1.current?.focus();
  }, [location.key]);
  return (
    <div className="page">
      {crumbs && crumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="breadcrumb">
          <ol>
            {crumbs.map((c, i) => (
              <li key={`${c.label}-${i}`}>
                {c.to ? (
                  <Link to={c.to}>{c.label}</Link>
                ) : (
                  <span aria-current="page">{c.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div className="page-head">
        <h1 ref={h1} tabIndex={-1}>
          {title}
        </h1>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
      {lead ? <div className="page-lead">{lead}</div> : null}
      {children}
    </div>
  );
}
