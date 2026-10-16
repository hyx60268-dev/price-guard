import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const scripts={cost:'check-cloud-cost.mjs',coverage:'check-cycle-coverage.mjs'};
const filename=scripts[process.argv[2]];if(!filename)throw Error('Unknown acceptance checker');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'price-acceptance-')),receipt=path.join(directory,'result.json');
try{
 const exitCode=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[new URL(filename,import.meta.url).pathname],{stdio:'inherit',env:{...process.env,ACCEPTANCE_RESULT_PATH:receipt}});child.on('error',reject);child.on('exit',(code,signal)=>signal?reject(Error('Acceptance checker interrupted')):resolve(code))});
 const result=JSON.parse(await fs.readFile(receipt,'utf8'));
 if(result.kind!=='product'||![0,1].includes(exitCode)||result.accepted!==(exitCode===0))throw Error('Acceptance checker execution/publication integrity failure');
 if(process.env.GITHUB_OUTPUT)await fs.appendFile(process.env.GITHUB_OUTPUT,`exit_code=${exitCode}\n`);
}catch(error){throw Error('Stop cadence: product acceptance could not be reliably evaluated',{cause:error})}
finally{await fs.rm(directory,{recursive:true,force:true})}
