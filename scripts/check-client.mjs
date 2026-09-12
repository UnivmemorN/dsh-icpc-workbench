/** Verify the shipped classic factory protocol without pretending to be a real browser test. */
import{readFileSync}from'node:fs';import{runInNewContext}from'node:vm';import{createRequire}from'node:module';import assert from'node:assert/strict';
const require=createRequire(import.meta.url),source=readFileSync(new URL('../dist/client.js',import.meta.url),'utf8');
let registration;const effects=[],slots=[],styles=[];
const document={head:{append(style){styles.push(style);}},createElement(){return{dataset:{},textContent:'',remove(){styles.splice(styles.indexOf(this),1);}};}};
runInNewContext(source,{window:{__ModuleLoader__:{load(value){registration=value;}}},document,fetch(){throw Error('No network in client protocol smoke');},console,URL,AbortController,structuredClone,TextEncoder,TextDecoder});
assert.equal(registration.id,'dsh-icpc-workbench');const required=[];
const plugin=registration.factory(id=>{required.push(id);assert.ok(['react','react/jsx-runtime','react-dom/client','@deepseek-ai/cordis'].includes(id));return require(id);});
assert.equal(typeof plugin.apply,'function');
plugin.apply({effect(fn){effects.push(fn());},slots:{inject(name,fn){assert.ok(['main','sidebar.panellist'].includes(name));effects.push(fn());},register(descriptor,component){slots.push(descriptor);assert.equal(typeof component,'function');return()=>{slots.splice(slots.indexOf(descriptor),1);};}},layout:{selectPanel(){}}});
assert.equal(styles.length,1);assert.equal(slots.length,2);assert.ok(slots.some(s=>s.name==='main'&&s.key==='icpc-workbench'));assert.ok(slots.some(s=>s.name==='sidebar.panellist'&&s.id==='icpc-workbench'));assert.ok(required.includes('react'));
for(const dispose of effects.reverse())await dispose();assert.equal(styles.length,0);assert.equal(slots.length,0);console.log('Classic client factory, shared modules and disposal verified.');