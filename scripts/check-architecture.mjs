/** Inspect every TypeScript import through the compiler AST; enforce dependency direction. */
import ts from 'typescript';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,relative,dirname,extname} from 'node:path';
const root=resolve(import.meta.dirname,'..'),src=resolve(root,'src');
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(resolve(dir,e.name)):/\.tsx?$/.test(e.name)?[resolve(dir,e.name)]:[]);}
const allowed={domain:['domain'],application:['application','domain'],adapters:['adapters','application','domain'],ui:['ui','application','domain'],plugin:['plugin','adapters','application','domain']};
const failures=[];
for(const path of walk(src)){
 const rel=relative(src,path).replaceAll('\\','/'),layer=rel.split('/')[0];
 if(!allowed[layer]){failures.push(rel+': missing declared layer');continue;}
 const ast=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true,extname(path)==='.tsx'?ts.ScriptKind.TSX:ts.ScriptKind.TS);
 const imports=[];
 function visit(n){
   if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier))imports.push(n.moduleSpecifier.text);
   if(ts.isCallExpression(n)&&(n.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(n.expression)&&n.expression.text==='require'))){
     const argument=n.arguments[0];
     if(argument&&ts.isStringLiteral(argument))imports.push(argument.text);
     else failures.push(rel+': nonliteral runtime import requires explicit review');
   }
   ts.forEachChild(n,visit);
 }
 visit(ast);
 for(const spec of imports){
   if(spec.startsWith('.')){
     const target=relative(src,resolve(dirname(path),spec)).replaceAll('\\','/'),targetLayer=target.split('/')[0];
     if(!allowed[layer].includes(targetLayer))failures.push(rel+': forbidden '+layer+' -> '+target);
     if(layer==='ui'&&target.startsWith('application/ports'))failures.push(rel+': UI must use the business API, not implementation ports');
   }else if((layer==='domain'&&!spec.startsWith('@noble/hashes/'))||layer==='application'){
     failures.push(rel+': non-pure external dependency '+spec);
   }else if(layer==='ui'&&(spec.startsWith('node:')||spec.includes('dsh-llm')||spec.includes('dsh-session/'))){
     failures.push(rel+': UI must not access host IO '+spec);
   }
 }
}
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
else console.log('Architecture imports satisfy the declared layer boundaries.');
