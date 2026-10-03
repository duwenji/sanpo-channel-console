import { serveFolder } from './serve.js';

// Serves what `npm run publish:local -w api` wrote, at the address it put in the package URLs.
const root = process.argv[2] ?? '../.local/site/public';
const port = Number(process.argv[3] ?? 8787);
serveFolder(root, port).then(({ url }) => console.log(`serving ${root} at ${url}`));
