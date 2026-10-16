import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {restoreCadenceState} from './lib/cadence-state.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
console.log('[CADENCE STATE]',JSON.stringify(await restoreCadenceState({root,staged:path.join(root,'.cadence-state'),password:process.env.DASHBOARD_PASSWORD})));
