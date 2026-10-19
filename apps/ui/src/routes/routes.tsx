/**
 * The route table (06 UI-01 + UI-50, final). `/return/vp` is a BFF static page (API-35), not an SPA
 * route. Screens that later tasks build render a placeholder with their purpose line.
 */
import type { RouteObject } from 'react-router-dom';
import { AppShell } from '../shell/AppShell.js';
import { EnvironmentPage } from './EnvironmentPage.js';
import { SelectorPage } from '../selector/SelectorPage.js';
import { NotFoundPage } from './NotFoundPage.js';
import { PlaceholderPage } from './PlaceholderPage.js';
import { ReportPage } from '../report/ReportPage.js';
import { RunPage } from './RunPage.js';

function Compare() {
  return (
    <PlaceholderPage
      title="Compare runs"
      purpose="Two runs side by side: what changed between them, step by step."
      crumbs={[{ label: 'History', to: '/history' }, { label: 'Compare' }]}
    />
  );
}
function SuiteReport() {
  return (
    <PlaceholderPage
      title="Suite report"
      purpose="Every run of one suite, with totals per state."
      crumbs={[{ label: 'Matrix', to: '/matrix' }, { label: 'Suite' }]}
    />
  );
}
function DraftReview() {
  return (
    <PlaceholderPage
      title="Issue draft"
      purpose="Review one issue draft before you file it by hand."
      crumbs={[{ label: 'Issue drafts', to: '/drafts' }, { label: 'Draft' }]}
    />
  );
}

export const ROUTE_PATHS = [
  '/',
  '/runs/:runId',
  '/runs/:runId/report',
  '/runs/:runId/compare/:otherRunId',
  '/environment',
  '/history',
  '/matrix',
  '/matrix/snapshots',
  '/matrix/snapshots/compare',
  '/suites/:suiteId',
  '/drafts',
  '/drafts/:draftId',
  '/tamper',
] as const;

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <SelectorPage /> },
      { path: 'runs/:runId', element: <RunPage /> },
      { path: 'runs/:runId/report', element: <ReportPage /> },
      { path: 'runs/:runId/compare/:otherRunId', element: <Compare /> },
      { path: 'environment', element: <EnvironmentPage /> },
      {
        path: 'history',
        element: (
          <PlaceholderPage
            title="History"
            purpose="Every run you made, with filters, pins, notes, and bundle export and import."
          />
        ),
      },
      {
        path: 'matrix',
        element: (
          <PlaceholderPage
            title="Compatibility matrix"
            docTitle="Matrix"
            purpose="Which issuer, wallet and verifier combinations work together, per credential format."
          />
        ),
      },
      {
        path: 'matrix/snapshots',
        element: (
          <PlaceholderPage
            title="Matrix snapshots"
            purpose="Saved states of the matrix, to compare one release with another."
            crumbs={[{ label: 'Matrix', to: '/matrix' }, { label: 'Snapshots' }]}
          />
        ),
      },
      {
        path: 'matrix/snapshots/compare',
        element: (
          <PlaceholderPage
            title="Compare snapshots"
            purpose="Two matrix snapshots side by side, with the cells that changed."
            crumbs={[
              { label: 'Matrix', to: '/matrix' },
              { label: 'Snapshots', to: '/matrix/snapshots' },
              { label: 'Compare' },
            ]}
          />
        ),
      },
      { path: 'suites/:suiteId', element: <SuiteReport /> },
      {
        path: 'drafts',
        element: (
          <PlaceholderPage
            title="Issue drafts"
            purpose="Draft issue reports written from failed runs. You review them and file them by hand."
          />
        ),
      },
      { path: 'drafts/:draftId', element: <DraftReview /> },
      {
        path: 'tamper',
        element: (
          <PlaceholderPage
            title="Tamper mode"
            docTitle="Tamper"
            purpose="Send deliberately broken messages and see whether the software under test rejects them."
          />
        ),
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
