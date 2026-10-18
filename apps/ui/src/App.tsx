/** The SPA root: the browser router over the route table (06 UI-01, UI-50). */
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { routes } from './routes/routes.js';

const router = createBrowserRouter(routes);

export function App() {
  return <RouterProvider router={router} />;
}
