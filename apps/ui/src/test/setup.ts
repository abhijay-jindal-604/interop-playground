/** ui test setup: jsdom has no layout engine, so the real Mermaid is never loaded in unit tests. */
import { setMermaidLoader } from '../diagram/render.js';

setMermaidLoader(null);
