/** Build declarations and ESM using the installed TypeScript API, without a sibling dsh checkout. */
import ts from 'typescript';
import {resolve,relative,sep} from 'node:path';
import {mkdirSync,rmSync,realpathSync,existsSync,readFileSync} from 'node:fs';
const root=realpathSync(resolve(import.meta.dirname,'..'));
const out=resolve(root,'dist');
const rel=relative(root,out);
if(rel!=='dist'||rel.startsWith('..'+sep))throw new Error('Unsafe build output');
if(existsSync(out)&&realpathSync(out)!==out)throw new Error('Refuse linked build output');
rmSync(out,{recursive:true,force:true});
mkdirSync(out,{recursive:true});
const read=ts.readConfigFile(resolve(root,'tsconfig.json'),ts.sys.readFile);
if(read.error)throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText,'\n'));
const config=ts.parseJsonConfigFileContent({...read.config,include:['src/**/*.ts','src/**/*.tsx'],exclude:['tests','dist']},ts.sys,root,{
  noEmit:false,declaration:true,declarationMap:true,sourceMap:true,rootDir:resolve(root,'src'),outDir:out
});
const program=ts.createProgram(config.fileNames,config.options);
const diagnostics=[...config.errors,...ts.getPreEmitDiagnostics(program)];
if(!diagnostics.length){const emitted=program.emit();diagnostics.push(...emitted.diagnostics);}
if(diagnostics.length){
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>root,getCanonicalFileName:x=>x,getNewLine:()=> '\n'}));
  process.exitCode=1;
}else console.log('Built independent ESM package in dist.');

if (!diagnostics.length) {
  const {rollup}=await import('@rollup/wasm-node');
  const {writeFileSync}=await import('node:fs');
  const {fileURLToPath}=await import('node:url');
  const shared=new Set(['react','react/jsx-runtime','react-dom/client','@deepseek-ai/cordis']);
  const bundle=await rollup({input:resolve(out,'ui/index.js'),external:id=>shared.has(id),
    plugins:[{name:'pure-package-resolution',resolveId(id){return id.startsWith('@noble/hashes/')?fileURLToPath(import.meta.resolve(id)):null;}}],
    onwarn(warning,defaultHandler){if(warning.code==='UNRESOLVED_IMPORT')throw Error(warning.message);defaultHandler(warning);}});
  try {
    const {output}=await bundle.generate({format:'cjs',exports:'named'});
    const code=output.find(item=>item.type==='chunk')?.code;
    if(!code)throw Error('Client bundle missing');
    writeFileSync(resolve(out,'client.js'),`/* dsh-icpc-workbench — MIT\n * Includes @noble/hashes (MIT):\n${readFileSync(resolve(root,'licenses/noble-hashes-MIT.txt'),'utf8')}\n */\nwindow.__ModuleLoader__.load({id:'dsh-icpc-workbench',factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${code}\nreturn module.exports;}});\n`);
    console.log('Built classic dsh browser factory with shared React.');
  } finally {await bundle.close();}
}