import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');

test('production geometry dependency failure preserves the normal scan and cannot declare readiness',()=>{
 const source=read('.github/workflows/price-scan-transaction.yml');
 const setup=source.slice(source.indexOf('      - name: Prepare optional local geometry Python'),source.indexOf('      - name: 验证比价与成本回归测试'));
 assert.equal((setup.match(/continue-on-error: true/g)||[]).length,2);
 assert.match(setup,/steps\.admission\.outputs\.admitted == 'true'/);
 assert.match(setup,/steps\.geometry_python\.outcome == 'success'/);
 assert.equal((setup.match(/timeout-minutes: 3/g)||[]).length,2);
 assert.match(setup,/actions\/setup-python@v5/);assert.match(setup,/python-version: '3\.12'/);
 assert.match(setup,/--isolated --disable-pip-version-check install --index-url https:\/\/pypi.org\/simple --only-binary=:all: --no-deps --require-hashes/);
 assert.ok(setup.indexOf('node scripts/check-geometry-runtime.mjs')<setup.indexOf("echo 'ready=1'"));
 assert.match(setup,/geometryPreparationPhase/);assert.match(setup,/geometryPipCacheHit/);
 assert.doesNotMatch(setup,/secrets\.|DASHBOARD_PASSWORD|GITHUB_TOKEN|scripts\/scan|curl|wget|workflow_dispatch/);
 assert.match(source,/PRICE_GUARD_GEOMETRY_READY: \$\{\{ steps\.geometry_runtime\.outputs\.ready \|\| '0' \}\}/);
 assert.match(source,/group: pages\n      cancel-in-progress: false/);
 assert.match(source,/      - name: 并行检查三平台价格与闲鱼成本\n        id: scan\n        if: \$\{\{ steps\.admission\.outputs\.admitted == 'true' \}\}/);
});

test('CI proves the real pinned runtime before full regression and does not silently skip failure',()=>{
 const workflow=read('.github/workflows/tests.yml');
 // The separately isolated read-only publication job uses the existing key;
 // neither geometry installation nor the full test job receives any secret.
 const source=workflow.split('\n  saved-shared-quote-readback:')[0];
 assert.match(source,/permissions:\n  contents: read/);assert.doesNotMatch(source,/continue-on-error|secrets\./);
 assert.doesNotMatch(workflow,/pull_request_target/);
 assert.match(source,/--only-binary=:all: --no-deps --require-hashes -r requirements-geometry.txt/);
 assert.ok(source.indexOf('node scripts/check-geometry-runtime.mjs')<source.indexOf('- run: npm test'));
});

test('default runtime cannot be enabled by a missing or truthy non-one readiness environment',()=>{
 const moduleUrl=new URL('../scripts/lib/geometry-rank-batch.mjs',import.meta.url).href;
 for(const [flag,expected] of [[undefined,false],['0',false],['true',false],['1',true]]){
  const env={PATH:process.env.PATH};if(flag!==undefined)env.PRICE_GUARD_GEOMETRY_READY=flag;
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import {defaultGeometryRanker} from ${JSON.stringify(moduleUrl)};console.log(defaultGeometryRanker.canRun())`],{env,encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(result.stdout.trim(),String(expected));
 }
});

test('candidate configuration preserves original source budgets, image count and concurrency',()=>{
 const settings=JSON.parse(read('config/settings.json'));
 assert.equal(typeof settings.yahooGeometryPriority,'boolean');assert.equal(typeof settings.yahooGeometryReallocate,'boolean');
 assert.equal(settings.yahooRecommendationFallbackMaxCards,20);assert.equal(settings.maxYahooDetailChecks,8);
 assert.equal(settings.yahooRequestIntervalMs,5000);assert.equal(settings.yahooConcurrency,4);assert.equal(settings.scanBudgetMinutes,12);
});

test('only three fixed official runtime packages with compatible cp312 wheel hashes are installable',()=>{
 const source=read('requirements-geometry.txt'),lines=source.split('\n').filter(line=>line&&!line.startsWith('#'));
 assert.equal(lines.length,3);assert.match(lines[0],/^Pillow==12\.3\.0 --hash=sha256:[a-f0-9]{64}$/);
 assert.match(lines[1],/^numpy==2\.3\.5 --hash=sha256:[a-f0-9]{64}$/);assert.match(lines[2],/^scipy==1\.17\.0 --hash=sha256:[a-f0-9]{64}$/);
 assert.doesNotMatch(source,/https?:|--extra-index|^-e |git\+|\.tar\.gz/m);
 assert.equal((source.match(/cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64/g)||[]).length,3);
});

test('timed optional installation failure exits before readiness while preserving numeric timing',()=>{
 const source=read('.github/workflows/price-scan-transaction.yml');
 const helper=source.match(/          run_timed\(\) \{[\s\S]*?\n          \}/)?.[0];assert.ok(helper);
 for(const [command,code,ready] of [['false',1,false],['true',0,true]]){
  const result=spawnSync('bash',['-e','-c',helper+'\nrun_timed wheels '+command+'\necho READY'],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(result.status,code);assert.equal(result.stdout.includes('READY'),ready);
  const row=JSON.parse(result.stdout.split('\n')[0]);assert.equal(row.geometryPreparationPhase,'wheels');assert.equal(row.exitCode,code);assert.ok(Number.isSafeInteger(row.elapsedMs)&&row.elapsedMs>=0);
 }
});
