import fs from 'node:fs/promises';

// Preserve discovery during the early price publication without recalculating
// changes against the current snapshot (that would erase notification events).
for(const name of ['discovery.json.enc','discovery-status.json']){
  try{await fs.copyFile(new URL(`../state/${name}`,import.meta.url),new URL(`../public/data/${name}`,import.meta.url))}
  catch(error){if(error.code!=='ENOENT')throw error}
}
