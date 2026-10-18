/** Not-found view (06 UI-01). */
import { Link, useLocation } from 'react-router-dom';
import { copy } from '../copy.js';
import { PageFrame } from './PageFrame.js';

export function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <PageFrame title={copy.notFound.heading} docTitle={copy.notFound.heading}>
      <p>{copy.notFound.body(pathname)}</p>
      <p>
        <Link className="btn btn-primary" to="/">
          {copy.notFound.action}
        </Link>
      </p>
    </PageFrame>
  );
}
