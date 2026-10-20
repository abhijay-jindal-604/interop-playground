/** The SPA root: the browser router over the route table (06 UI-01, UI-50). */
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { routes } from './routes/routes.js';

const router = createBrowserRouter(routes);

/** Root component: mounts the router, which renders the app shell and the page for the current URL. */
export function App() {
  return <RouterProvider router={router} />;
}
