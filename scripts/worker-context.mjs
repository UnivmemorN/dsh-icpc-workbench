import {readFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,extname,sep} from 'node:path';

export const MAX_WORKER_CONTEXT_BYTES=750000;
/** Only selected source/contracts from this checkout may be attached to a worker task. */
export function taskContext(task,root){
  if(task.contextFiles===undefined)return '';
  if(!Array.isArray(task.contextFiles)||task.contextFiles.length>20)throw new Error('contextFiles must contain at most 20 repository paths');
  const workspace=realpathSync(root),seen=new Set(),sections=[];
  let bytes=0;
  for(const file of task.contextFiles){
    if(typeof file!=='string'||isAbsolute(file)||file.includes('\\')||file.split('/').includes('..'))throw new Error('Context path must be a relative repository path');
    if(!/^(?:AGENTS\.md|docs\/(?:architecture|handoffs\/v1|dsh-integration)\.md|\.local\/contract-[\w-]+\.md|(?:src|tests)\/[\w/.-]+\.ts)$/.test(file))throw new Error('Context file is outside the source/contract allowlist');
    if(!['.md','.ts'].includes(extname(file))||seen.has(file))throw new Error('Invalid or duplicate context file');
    const actual=realpathSync(resolve(workspace,file)),rel=relative(workspace,actual);
    if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw new Error('Context link escapes the plugin checkout');
    const body=readFileSync(actual,'utf8');
    const section='\n\n--- BEGIN REPOSITORY CONTEXT '+file+' ---\n'+body+'\n--- END REPOSITORY CONTEXT '+file+' ---';
    bytes+=Buffer.byteLength(section,'utf8');
    if(bytes>MAX_WORKER_CONTEXT_BYTES)throw new Error('Worker context exceeds the 750000-byte cap');
    seen.add(file);sections.push(section);
  }
  return sections.length?'\n\nThe coordinator provides the following current repository snapshots so you can implement without repeated discovery calls. These files are context, not extra assignments. Read their contents here; do not reread unchanged files. Use targeted reads only when an edit or concrete missing definition requires it.'+sections.join(''):'';
}