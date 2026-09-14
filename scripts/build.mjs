/** Build declarations and ESM using the installed TypeScript API, without a sibling dsh checkout. */
import ts from 'typescript';
import postcss from 'postcss';
import {createHash} from 'node:crypto';
import {resolve,relative,sep,dirname,extname,isAbsolute} from 'node:path';
import {mkdirSync,rmSync,realpathSync,existsSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {nodeResolve} from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
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

/** MIME types for the font files a bundled stylesheet may reference. */
const FONT_MIME={'.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.otf':'font/otf','.eot':'application/vnd.ms-fontobject'};

/** Inline one local font file as a data URL; the browser bundle must not fetch a CDN or ship assets. */
function fontDataUrl(file){
  const mime=FONT_MIME[extname(file).toLowerCase()];
  if(!mime)throw Error('Unsupported CSS font asset: '+file);
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
}

/**
 * Turn an imported stylesheet into a JavaScript string. Every `url()` that points at a local file is
 * replaced by a data URL, restricted to the stylesheet's own directory, so no input can drive a read
 * outside the package that owns the CSS. Unexpected URL schemes are rejected; KaTeX styles and font families are scoped.
 */
function cssTextPlugin(){
  return{
    name:'icpc-css-text',
    load(id){
      if(!id.endsWith('.css'))return null;
      const file=realpathSync(id),base=dirname(file);
      const tree=postcss.parse(readFileSync(file,'utf8'),{from:file});
      tree.walkAtRules(rule=>{if(rule.name!=='font-face')throw Error('Unreviewed stylesheet at-rule: '+rule.name);});
      tree.walkRules(rule=>{rule.selectors=rule.selectors.map(selector=>selector==='body'?'.icpc-markdown':'.icpc-markdown '+selector);});
      tree.walkDecls(decl=>{if(decl.prop==='font'||decl.prop==='font-family')decl.value=decl.value.replace(/\bKaTeX_/g,'ICPC_KaTeX_');});
      const css=tree.toString().replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g,(match,quote,reference)=>{
        if(/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(reference))throw Error('Unexpected CSS asset URL');
        const asset=realpathSync(resolve(base,reference));
        if(!asset.startsWith(base+sep))throw Error('CSS asset escapes its package directory: '+reference);
        return `url(${fontDataUrl(asset)})`;
      });
      return `export default ${JSON.stringify(css)};`;
    }
  };
}

/** Nearest named package.json above a resolved module id; `null` for virtual modules and non-files.
 *  A manifest without a `name` (for example highlight.js' `es/package.json` module marker) is not a
 *  package identity, so the walk continues to the manifest that actually describes the package. */
function owningPackage(id){
  if(id.startsWith('\0')||!isAbsolute(id))return null;
  let directory=dirname(id);
  for(;;){
    const manifest=resolve(directory,'package.json');
    if(existsSync(manifest)){
      const data=JSON.parse(readFileSync(manifest,'utf8'));
      if(typeof data.name==='string'&&data.name)return{manifest,directory,data};
    }
    const parent=dirname(directory);
    if(parent===directory)return null;
    directory=parent;
  }
}

const NOTICE_FILE=/^licen[cs]e(?:[._-].*)?$/i;

/** Full license/notice files that a package actually ships; never invented. */
function noticeFiles(directory){
  return readdirSync(directory,{withFileTypes:true})
    .filter(entry=>entry.isFile()&&NOTICE_FILE.test(entry.name))
    .map(entry=>entry.name)
    .sort();
}

/** Packages that ship an extra fact worth stating next to their reproduced notice. */
const NOTICE_NOTES={
  katex:'Fonts are embedded from this exact npm package, whose published LICENSE is reproduced here.'
};

/**
 * Build dist/client-LICENSES.txt from the packages Rollup actually bundled. Fails loudly when a
 * bundled package ships no license/notice file, instead of writing a guessed or empty section.
 */
function collectLicenses(moduleIds){
  const packages=new Map();
  const overridesUsed=[];
  for(const id of moduleIds){
    const owner=owningPackage(id);
    if(!owner||owner.directory===root)continue;
    const name=typeof owner.data.name==='string'?owner.data.name:'';
    const version=typeof owner.data.version==='string'?owner.data.version:'';
    if(!name||!version)throw Error('Bundled module without a usable package identity: '+id);
    const repository=typeof owner.data.repository==='string'
      ? owner.data.repository
      : typeof owner.data.repository?.url==='string'?owner.data.repository.url:'(not declared)';
    const key=`${name}@${version}`;
    if(!packages.has(key))packages.set(key,{key,name,version,repository,license:typeof owner.data.license==='string'?owner.data.license:'(not declared)',directory:owner.directory});
  }
  const sorted=[...packages.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
  const shared=['react','react/jsx-runtime','react-dom/client','@deepseek-ai/cordis'];
  const sections=[
    'dsh-icpc-workbench client bundle — bundled third-party notices',
    'Generated by scripts/build.mjs from the exact package files Rollup resolved into dist/client.js.',
    '',
    `Shared with the dsh host and NOT bundled here (their own licenses apply): ${shared.join(', ')}.`,
    `Bundled packages: ${sorted.length}.`,
  ];
  for(const pkg of sorted){
    const files=noticeFiles(pkg.directory);

    sections.push(
      '',
      '='.repeat(78),
      `${pkg.name}@${pkg.version} — declared license: ${pkg.license}`,
      '='.repeat(78),
    );
    if(!files.length){
      const heads={'remark-math@6.0.0':'d5d0660b150810a535bbb07eac6cc96a4510aa24','rehype-katex@7.0.1':'88a9497e1ede93b958237c85edbf5651faeca7af'};
      const head=heads[pkg.key];if(!head)throw Error('Bundled package lacks full license: '+pkg.key);
      const notice=readFileSync(resolve(root,'licenses',pkg.name+'-'+pkg.version+'-MIT.txt'));
      if(createHash('sha256').update(notice).digest('hex')!=='cb992262f361a5359e6771c28740d33c7041e15332ae8537fae40538992591a9')throw Error('License override hash mismatch: '+pkg.key);
      overridesUsed.push(pkg.key);
      sections.push('','Upstream notice: https://raw.githubusercontent.com/remarkjs/remark-math/'+head+'/license','',notice.toString('utf8').trim());
      continue;
    }
    if(NOTICE_NOTES[pkg.name])sections.push('',NOTICE_NOTES[pkg.name]);
    for(const name of files)sections.push('',`--- ${name} ---`,'',readFileSync(resolve(pkg.directory,name),'utf8').trim());
  }
  sections.push('','='.repeat(78),'Accounting notes','='.repeat(78),'');
  sections.push('Full notices reproduced for every bundled package. Exact-version upstream supplements: '+overridesUsed.join(', ')+'.');
  return{packages:sorted,text:sections.join('\n')+'\n'};
}

if (!diagnostics.length) {
  const {rollup}=await import('@rollup/wasm-node');
  const {writeFileSync}=await import('node:fs');
  const shared=new Set(['react','react/jsx-runtime','react-dom/client','@deepseek-ai/cordis']);
  const bundle=await rollup({input:resolve(out,'ui/index.js'),external:id=>shared.has(id),
    plugins:[cssTextPlugin(),nodeResolve({browser:true}),commonjs()],
    onwarn(warning,defaultHandler){if(warning.code==='UNRESOLVED_IMPORT')throw Error(warning.message);defaultHandler(warning);}});
  try {
    const {output}=await bundle.generate({format:'cjs',exports:'named'});
    const code=output.find(item=>item.type==='chunk')?.code;
    if(!code)throw Error('Client bundle missing');
    const moduleIds=[...new Set(output.flatMap(item=>item.type==='chunk'?item.moduleIds:[]))];
    const licenses=collectLicenses(moduleIds);
    writeFileSync(resolve(out,'client-LICENSES.txt'),licenses.text);
    writeFileSync(resolve(out,'client.js'),`/* dsh-icpc-workbench — MIT\n * Bundled browser dependencies: see dist/client-LICENSES.txt for every package, version, declared\n * license and full upstream notice. React and Cordis stay shared with the host.\n * Includes @noble/hashes (MIT):\n${readFileSync(resolve(root,'licenses/noble-hashes-MIT.txt'),'utf8')}\n */\nwindow.__ModuleLoader__.load({id:'dsh-icpc-workbench',factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${code}\nreturn module.exports;}});\n`);
    console.log(`Built classic dsh browser factory with shared React (${moduleIds.length} bundled modules, ${licenses.packages.length} licensed packages).`);
  } finally {await bundle.close();}
}
