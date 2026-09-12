import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {taskContext,MAX_WORKER_CONTEXT_BYTES} from './worker-context.mjs';
function fixture(run){const root=mkdtempSync(join(tmpdir(),'icpc-worker-context-'));try{mkdirSync(join(root,'src'));writeFileSync(join(root,'src','example.ts'),'export const value=7;');run(root);}finally{const target=resolve(root),base=resolve(tmpdir());if(relative(base,target).startsWith('..')||target===base)throw Error('Unsafe test cleanup');rmSync(target,{recursive:true,force:true});}}
test('provided source remains literal task context and optional context changes nothing',()=>fixture(root=>{assert.equal(taskContext({},root),'');const prompt=taskContext({contextFiles:['src/example.ts']},root);assert.match(prompt,/BEGIN REPOSITORY CONTEXT src\/example.ts/);assert.match(prompt,/export const value=7;/);}));
test('task context refuses traversal, absolute paths, credentials and arbitrary scratch files',()=>fixture(root=>{for(const file of ['../secret.ts','D:/secrets.ts','/etc/passwd','.env','.local/usage.json','src/../../secret.ts','src\\example.ts'])assert.throws(()=>taskContext({contextFiles:[file]},root));}));
test('context refuses duplicate paths and bounded inputs without truncating source',()=>fixture(root=>{assert.throws(()=>taskContext({contextFiles:['src/example.ts','src/example.ts']},root));writeFileSync(join(root,'src','example.ts'),'x'.repeat(MAX_WORKER_CONTEXT_BYTES+1));assert.throws(()=>taskContext({contextFiles:['src/example.ts']},root),/cap/);}));
test('TSX source context is allowed for UI work without admitting non-source assets',()=>fixture(root=>{
  writeFileSync(join(root,'src','App.tsx'),'export const App=()=> <main>训练</main>;');
  assert.match(taskContext({contextFiles:['src/App.tsx']},root),/训练/);
  for(const file of ['src/App.js','src/App.tsx.json','src/secret.env'])assert.throws(()=>taskContext({contextFiles:[file]},root));
}));