import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createLuoguAccount} from '../../src/adapters/luogu/account.js';
import {SqliteTrainingStore} from '../../src/adapters/sqlite/store.js';
import {migrateToSchemaV8,readUserVersion,STORE_SCHEMA_VERSION,tableNames} from '../../src/adapters/sqlite/schema.js';
import {emptyLuoguSyncState} from '../../src/application/luogu-sync-types.js';
import {officialInstance,problemKeyOf} from '../sync/fixtures.js';
import {AT,tempDatabase,removeDirectory} from './fixtures.js';

void test('genuine v8 Luogu backlog migrates to v9 with a verified v8 backup and byte-identical legacy rows',async()=>{
 const paths=tempDatabase();const source=officialInstance();const account=createLuoguAccount(source,'900001');
 const legacy={...emptyLuoguSyncState(account.id,source.id,AT)};delete legacy.metadataIssues;
 const state={...legacy,missingMetadata:[problemKeyOf(source,'U900000001')],metadataFailed:22,failure:{code:'changed_response',at:AT,retryAt:null,paused:true,stage:'metadata'}};
 const bodies={source:JSON.stringify(source),account:JSON.stringify(account),state:JSON.stringify(state)};
 const raw=new DatabaseSync(paths.path);try{migrateToSchemaV8(raw,0);assert.equal(readUserVersion(raw),8,'historical helper remains frozen at8');
 raw.prepare('INSERT INTO source_instances(id,platform,base_url,domain,display_name,body) VALUES(?,?,?,?,?,?)').run(source.id,source.platform,source.baseUrl,source.domain,source.displayName,bodies.source);
 raw.prepare('INSERT INTO accounts(id,source_instance_id,handle,display_name,profile_url,body) VALUES(?,?,?,?,?,?)').run(account.id,account.sourceInstanceId,account.handle,account.displayName,account.profileUrl,bodies.account);
 raw.prepare('INSERT INTO luogu_sync_states(account_id,source_instance_id,revision,body) VALUES(?,?,?,?)').run(account.id,source.id,1,bodies.state);
 }finally{raw.close();}
 try{const store=new SqliteTrainingStore({path:paths.path});try{assert.equal(store.capabilities().schemaVersion,9);const row=await store.getLuoguSyncState(account.id);assert.deepEqual(row?.value,state);assert.equal(Object.hasOwn(row!.value,'metadataIssues'),false);assert.equal(row?.revision,1);}finally{await store.close();}
 const db=new DatabaseSync(paths.path,{readOnly:true});let names:readonly string[];try{assert.equal(readUserVersion(db),9);assert.equal(db.prepare('SELECT body FROM luogu_sync_states').get()!['body'],bodies.state);assert.equal(db.prepare('SELECT body FROM source_instances').get()!['body'],bodies.source);assert.equal(db.prepare('SELECT body FROM accounts').get()!['body'],bodies.account);names=tableNames(db);}finally{db.close();}
 const backups=readdirSync(paths.dir).filter(x=>x.includes('.backup-v8-')&&x.endsWith('.sqlite'));assert.equal(backups.length,1);const backup=new DatabaseSync(join(paths.dir,backups[0]!),{readOnly:true});try{assert.equal(readUserVersion(backup),8);assert.deepEqual(tableNames(backup),names!);assert.equal(backup.prepare('SELECT body FROM luogu_sync_states').get()!['body'],bodies.state);}finally{backup.close();}
 }finally{removeDirectory(paths.dir);}
});

void test('a future database format is refused without rewriting its file',()=>{
 const paths=tempDatabase();try{const raw=new DatabaseSync(paths.path);migrateToSchemaV8(raw,0);raw.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION+1}`);raw.close();const before=readFileSync(paths.path);assert.throws(()=>new SqliteTrainingStore({path:paths.path}));assert.deepEqual(readFileSync(paths.path),before);}finally{removeDirectory(paths.dir);}
});
