/** Placeholder for a route of the UI-50 table whose screen arrives in a later task. */
import { Link } from 'react-router-dom';
import { copy } from '../copy.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageFrame } from './PageFrame.js';

export function PlaceholderPage({
  title,
  docTitle,
  purpose,
  crumbs,
}: {
  title: string;
  docTitle?: string;
  purpose: string;
  crumbs?: { label: string; to?: string }[];
}) {
  return (
    <PageFrame title={title} docTitle={docTitle ?? title} {...(crumbs ? { crumbs } : {})}>
      <EmptyState
        title="This screen is not built yet"
        body={<p>{purpose}</p>}
        action={
          <Link className="btn btn-secondary" to="/">
            {copy.notFound.action}
          </Link>
        }
      />
    </PageFrame>
  );
}
