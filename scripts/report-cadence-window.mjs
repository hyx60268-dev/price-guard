import fs from 'node:fs/promises';
import {cadenceSlotReport,cadenceWindowReport} from './lib/cadence-window.mjs';
if(process.argv[2]==='slot'){
 const admitted=process.env.SLOT_ADMITTED==='true';
 const status=admitted?JSON.parse(await fs.readFile(new URL('../public/data/status.json',import.meta.url),'utf8')):null;
 const report=cadenceSlotReport({admitted,reason:process.env.SLOT_REASON,slot:process.env.CADENCE_SLOT,status,sha:process.env.GITHUB_SHA});
 console.log('[CADENCE SLOT]',JSON.stringify(report));
 if(process.env.GITHUB_OUTPUT)await fs.appendFile(process.env.GITHUB_OUTPUT,`slot_report=${JSON.stringify(report)}\n`);
}else{
 const report=cadenceWindowReport(JSON.parse(process.env.CADENCE_NEEDS_JSON||'{}'));
 console.log('[FINITE CADENCE ACCEPTANCE]',JSON.stringify(report));
 if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,`## Finite cadence observations\n\n${report.completedSlots}/${report.plannedSlots} source cycles observed. Reasons: ${report.reasons.join(', ')||'accepted'}.\n\nActual start gaps (seconds): ${report.startGapsSeconds.join(', ')}.\n`);
 if(!report.accepted)process.exitCode=1;
}
