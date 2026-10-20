/**
 * AppShell (06 UI-01 layout, UI-72 responsive nav, UI-73 landmarks, UI-78 live regions):
 * skip link, TopBar (brand, Menu at compact width, EnvChip, Recent runs, theme), the left rail nav
 * (>= 640 px), banners, `<main id="main">`, footer, the toast region and the two live regions.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { APP_NAME, BFF_ORIGIN_TEXT, copy } from '../copy.js';
import { boot, openEnvStream } from '../state/boot.js';
import { store, useStore } from '../state/store.js';
import { BrandMark, Icon, IconSprite, type IconName } from '../components/Icon.js';
import { Skeleton } from '../components/Skeleton.js';
import { ToastRegion } from '../components/Toast.js';
import { ShellBanners } from './Banners.js';
import { EnvChip } from './EnvChip.js';
import { RecentRuns } from './RecentRuns.js';
import { ShortcutsDialog } from './ShortcutsDialog.js';
import { ThemeSwitch } from './ThemeSwitch.js';
import { matchShortcut } from './shortcuts.js';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: copy.nav.playground, icon: 'playground', end: true },
  { to: '/history', label: copy.nav.history, icon: 'history' },
  { to: '/matrix', label: copy.nav.matrix, icon: 'matrix' },
  { to: '/tamper', label: copy.nav.tamper, icon: 'tamper' },
  { to: '/drafts', label: copy.nav.drafts, icon: 'drafts' },
];

/** Hidden live regions that screen readers use for announcements. */
function LiveRegions() {
  return (
    <>
      <div
        id="live-polite"
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />
      <div
        id="live-assertive"
        className="visually-hidden"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      />
    </>
  );
}

/** The product name and mark in the header. */
function Brand() {
  return (
    <Link to="/" className="brand">
      <BrandMark />
      <span>{APP_NAME}</span>
    </Link>
  );
}

/** Full-page boot states of UI-02: backend unreachable, wrong address. */
function BootFailure({ kind }: { kind: 'unreachable' | 'guard' }) {
  useEffect(() => {
    document.title = APP_NAME;
  }, []);
  return (
    <div className="boot-failure">
      <header className="boot-failure-head">
        <Brand />
      </header>
      <main id="main" className="boot-failure-main">
        <div className="boot-failure-card">
          <Icon name="st-failed" size={32} className="tone-warn-text" />
          {kind === 'unreachable' ? (
            <>
              <h1>{copy.boot.unreachableHeading}</h1>
              <p>{copy.boot.unreachableBody(window.location.origin || BFF_ORIGIN_TEXT)}</p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => window.location.reload()}
              >
                {copy.boot.reload}
              </button>
            </>
          ) : (
            <>
              <h1>{copy.boot.guardHeading}</h1>
              <p>{copy.boot.guardBody}</p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/** The frame around every page: header, navigation, banners, toasts and shortcuts. Shows a full-page failure notice instead of a page when the backend is unreachable or the address is wrong. */
export function AppShell() {
  const bootState = useStore((s) => s.boot);
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const navId = useId();
  const location = useLocation();
  const navigate = useNavigate();

  const start = useCallback(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void boot(store).then((state) => {
      if (state === 'ready' && !cancelled) stop = openEnvStream(store);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => start(), [start]);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const hit = matchShortcut(e);
      if (!hit) return;
      e.preventDefault();
      if (hit.kind === 'help') setHelpOpen(true);
      else void navigate(hit.to);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  if (bootState === 'unreachable' || bootState === 'guard') {
    return (
      <>
        <LiveRegions />
        <BootFailure kind={bootState} />
      </>
    );
  }

  return (
    <div className="shell">
      <IconSprite />
      <a className="skip-link" href="#main">
        {copy.skipLink}
      </a>
      <header className="topbar">
        <button
          type="button"
          className="btn btn-ghost menu-button"
          aria-expanded={menuOpen}
          aria-controls={navId}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Icon name={menuOpen ? 'close' : 'menu'} size={18} />
          <span>{copy.nav.menu}</span>
        </button>
        <Brand />
        <div className="topbar-end">
          <EnvChip />
          <RecentRuns />
          <ThemeSwitch />
        </div>
      </header>
      <div className="shell-body">
        <nav id={navId} className={`rail${menuOpen ? ' open' : ''}`} aria-label={copy.nav.label}>
          <ul>
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end ?? false} className="rail-link">
                  <Icon name={item.icon} size={20} />
                  <span>{item.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
          <ul className="rail-secondary">
            <li>
              <NavLink to="/environment" className="rail-link">
                <Icon name="environment" size={20} />
                <span>{copy.nav.environment}</span>
              </NavLink>
            </li>
          </ul>
        </nav>
        <div className="shell-main">
          <ShellBanners onRetry={() => void boot(store)} />
          <main
            id="main"
            className="content"
            tabIndex={-1}
            aria-busy={bootState === 'loading' || undefined}
          >
            {bootState === 'loading' ? <BootSkeleton /> : <Outlet />}
          </main>
          <footer className="footer">
            <span>{copy.footer.local}</span>
            <button type="button" className="btn-link" onClick={() => setHelpOpen(true)}>
              <Icon name="keyboard" size={16} />
              <span>{copy.footer.shortcuts}</span>
            </button>
          </footer>
        </div>
      </div>
      <ToastRegion />
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <LiveRegions />
    </div>
  );
}

/** "Starting…" with a skeleton of the three columns (UI-02 boot loading). */
function BootSkeleton() {
  return (
    <div className="page">
      <p className="muted">{copy.boot.loading}</p>
      <div className="three-cols" aria-hidden="true">
        {[0, 1, 2].map((c) => (
          <div key={c} className="card skeleton-card">
            <Skeleton width="40%" height="1.25rem" />
            <Skeleton height="3.5rem" radius="var(--radius-md)" />
            <Skeleton height="3.5rem" radius="var(--radius-md)" />
            <Skeleton height="3.5rem" radius="var(--radius-md)" />
          </div>
        ))}
      </div>
    </div>
  );
}
