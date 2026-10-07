import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishStoredDiscovery } from './lib/discovery-publication.mjs';

// Filter stored discovery against the just-published inventory history. This
// performs no market requests and does not recalculate scan notification events.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await publishStoredDiscovery({root,password:process.env.DASHBOARD_PASSWORD});
