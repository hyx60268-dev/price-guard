import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function isolateRakumaAccess(t,module){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rakuma-access-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 module.initializeRakumaRequestAccess({root});
 return root;
}
