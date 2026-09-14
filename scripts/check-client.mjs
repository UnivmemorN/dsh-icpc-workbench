/** Verify the shipped classic factory protocol without pretending to be a real browser test. */
import postcss from 'postcss';
import{readFileSync}from'node:fs';import{runInNewContext}from'node:vm';import{createRequire}from'node:module';import assert from'node:assert/strict';
const require=createRequire(import.meta.url),source=readFileSync(new URL('../dist/client.js',import.meta.url),'utf8');
let registration;const effects=[],slots=[],styles=[];
const document={compatMode:'CSS1Compat',head:{append(style){styles.push(style);}},createElement(){return{dataset:{},textContent:'',remove(){styles.splice(styles.indexOf(this),1);}};}};
/** Inert parser mock: the bundled browser Markdown renderer constructs a DOMParser at factory load. */
class DOMParser{parseFromString(){return{};}}
runInNewContext(source,{window:{__ModuleLoader__:{load(value){registration=value;}}},document,DOMParser,fetch(){throw Error('No network in client protocol smoke');},console,URL,AbortController,structuredClone,TextEncoder,TextDecoder});
assert.equal(registration.id,'dsh-icpc-workbench');const required=[];
const plugin=registration.factory(id=>{required.push(id);assert.ok(['react','react/jsx-runtime','react-dom/client','@deepseek-ai/cordis'].includes(id));return require(id);});
assert.equal(typeof plugin.apply,'function');
plugin.apply({effect(fn){effects.push(fn());},slots:{inject(name,fn){assert.ok(['main','sidebar.panellist'].includes(name));effects.push(fn());},register(descriptor,component){slots.push(descriptor);assert.equal(typeof component,'function');return()=>{slots.splice(slots.indexOf(descriptor),1);};}},layout:{selectPanel(){}}});
assert.equal(styles.length,1);assert.equal(slots.length,2);assert.ok(slots.some(s=>s.name==='main'&&s.key==='icpc-workbench'));assert.ok(slots.some(s=>s.name==='sidebar.panellist'&&s.id==='icpc-workbench'));assert.ok(required.includes('react'));
// Validate the shipped stylesheet rather than a separate copy of the build transform.
const stylesheet=postcss.parse(styles[0].textContent);let fontFaces=0,fontUrls=0,mathRules=0;
stylesheet.walkAtRules('font-face',rule=>{
 fontFaces++;rule.walkDecls('font-family',decl=>assert.match(decl.value,/ICPC_KaTeX_/));
 rule.walkDecls('src',decl=>{const urls=[...decl.value.matchAll(/url\(([^)]+)\)/g)];assert.ok(urls.length);for(const [,url]of urls){assert.match(url,/^data:font\/(?:woff2?|ttf);base64,[A-Za-z0-9+/=]+$/);fontUrls++;}});
});
stylesheet.walkRules(rule=>{if(rule.selector.includes('.katex')||rule.selector.includes('.mml-eqn-num')){mathRules++;for(const selector of rule.selectors)assert.ok(/^(?:\.icpc-root )?\.icpc-markdown /.test(selector),selector);}});
assert.ok(fontFaces>0&&fontUrls>=fontFaces&&mathRules>0);assert.ok(!stylesheet.nodes.some(n=>n.type==='rule'&&n.selector==='body'));
console.log('Bundled math CSS scoped; '+fontFaces+' font faces / '+fontUrls+' embedded assets verified.');
for(const dispose of effects.reverse())await dispose();assert.equal(styles.length,0);assert.equal(slots.length,0);console.log('Classic client factory, shared modules and disposal verified.');
