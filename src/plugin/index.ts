/** Host entry: independent data ownership and public, pinned Cordis service contracts. */
import type { Context } from '@deepseek-ai/cordis';
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import type {SessionPersistence} from '@deepseek-ai/dsh-session-persistence';
import {DurableAuditSessions} from '../adapters/dsh/durable-audit-sessions.js';
import type {Session,SessionId} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-llm';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteTrainingStore } from '../adapters/sqlite/index.js';
import { CodeforcesAdapter, codeforcesSourceInstance } from '../adapters/codeforces/index.js';
import { LuoguAdapter, luoguSourceInstance } from '../adapters/luogu/index.js';
import { DshAuditedModelClient, type DshAuditedHost } from '../adapters/dsh/audited-client.js';
import { DshModelGateway } from '../adapters/dsh/model-gateway.js';
import { DshCoachingGenerator } from '../adapters/dsh/coaching-generator.js';
import { DshPlanGenerator } from '../adapters/dsh/plan-generator.js';
import { AnalysisPipeline } from '../application/analysis-pipeline.js';
import { CoachingService } from '../application/coaching-service.js';
import { ImportService } from '../application/import-service.js';
import { PlanningService } from '../application/planning-service.js';
import { WorkbenchService } from '../application/workbench-service.js';
import { defaultWorkbenchSettings } from '../application/workbench-settings.js';
import type { PlatformAdapter } from '../application/ports.js';
import { CURRENT_TAXONOMY, createCancellationSource, createTaxonomyIndex } from '../domain/index.js';
import { checkHostCompatibility, type HostCompatibilityProbe } from './compatibility.js';
import { parsePluginConfig, resolveDataDir } from './config.js';
import { ModelCatalog, type CatalogHost } from './model-catalog.js';
import { ModelOperations } from './model-operations.js';
import { registerBusinessApi } from './business-api.js';
import { registerModelApi } from './model-api.js';
import { registerBootstrapApi } from './bootstrap-api.js';
import { disposeAll, rollback } from './lifecycle.js';
export const name='icpc-workbench';
export const inject=['connection','llm','sessions','sessionPersistence'];
export interface PublicHost extends DshAuditedHost {
  readonly sessions:DshAuditedHost['sessions']&{prepare(id:SessionId):Session};
  readonly sessionPersistence:Pick<SessionPersistence,'create'>;
  readonly connection:{readonly fetch:HostConnectionFetch}; readonly llm:DshAuditedHost['llm']&CatalogHost;
}
/** Explicit environment seam for offline lifecycle tests; YAML accepts only PluginConfig. */
export interface ActivationEnvironment {
  readonly nodeVersion?:string; readonly launcherPath?:string; readonly dshHome?:string;
  readonly probe?:HostCompatibilityProbe; readonly closeWaitMs?:number;
}
export interface PluginRuntime {
  readonly dataDir:string; readonly controller:ModelOperations; readonly dispose:()=>Promise<void>;
}
export function resolveHarnessHome(value:string|undefined,home=homedir()):string {
  const input=value?.trim();if(!input)return join(home,'.dsh');
  return resolve(input==='~'?home:input.startsWith('~/')||input.startsWith('~\\')?join(home,input.slice(2)):input);
}
/** Local diagnostics deliberately omit provider payloads, raw errors and source material. */
function reportFailure():void {console.error('ICPC_BACKGROUND_FAILURE: inspect the local dsh audit session for model details.');}
export async function activateHost(host:PublicHost,config:unknown={},environment:ActivationEnvironment={}):Promise<PluginRuntime> {
  const compatibility=await checkHostCompatibility({nodeVersion:environment.nodeVersion??process.versions.node,launcherPath:environment.launcherPath??process.argv[1]??'',services:host},environment.probe);
  const parsed=parsePluginConfig(config);
  const dataDir=resolveDataDir(parsed,{dshHome:resolveHarnessHome(environment.dshHome??process.env.DSH_HOME),installationRoot:compatibility.installationRoot});
  await mkdir(dataDir,{recursive:true});
  const now=()=>new Date().toISOString(),uniqueId=(prefix:string)=>prefix+'-'+randomUUID();
  const store=new SqliteTrainingStore({path:join(dataDir,'training.sqlite'),now});
  const auditSessions=new DurableAuditSessions(host.sessions,host.sessionPersistence);
  const closeStorage=async()=>{try{await auditSessions.close();}finally{await store.close();}};
  let controller:ModelOperations|undefined;
  const disposers:(()=>Promise<void>)[]=[async()=>{
    if(!controller){await closeStorage();return;}
    const result=await controller.close();
    if(result.outstanding.length){void controller.whenSettled().then(closeStorage).catch(reportFailure);}
    else await closeStorage();
  }];
  try {
    const sources=[codeforcesSourceInstance(),luoguSourceInstance()];
    await store.transaction(async()=>{
      const existing=new Set((await store.listSourceInstances()).map(s=>s.id));
      await store.upsertSourceInstances(sources.filter(s=>!existing.has(s.id)));
      if(await store.getWorkbenchSettings()===null)await store.saveWorkbenchSettings(defaultWorkbenchSettings(),null);
    });
    const adapters:PlatformAdapter[]=[new CodeforcesAdapter({sourceInstance:sources[0]!}),new LuoguAdapter({sourceInstance:sources[1]!})];
    const byId=new Map(adapters.map(a=>[a.sourceInstance.id,a]));
    const imports=new ImportService({store,now}),workbench=new WorkbenchService({store,taxonomy:createTaxonomyIndex(CURRENT_TAXONOMY),now,uniqueId:randomUUID});
    const client=new DshAuditedModelClient({llm:host.llm,sessions:auditSessions},{now}),catalog=new ModelCatalog(host.llm);
    const coaching=new CoachingService({store,now,generator:new DshCoachingGenerator({client,now}),onInternalError:reportFailure});
    // AI planning (Sprint 11d): the accepted durable service over the same audited client, with the
    // workbench's own preparation/revalidation/save methods bound as its data port. The port names
    // (`prepare`/`revalidate`/`savePlan`) deliberately differ from the workbench method names.
    const planning=new PlanningService({store,generator:new DshPlanGenerator({client,now}),now,onInternalError:reportFailure,
      preparation:{prepare:workbench.preparePlanInput.bind(workbench),revalidate:workbench.revalidatePlanInput.bind(workbench),savePlan:workbench.saveModelPlan.bind(workbench)}});
    // Recovery runs before any route can accept a start: a reservation left behind by a dead process
    // becomes terminal `uncertain` (keeping its quota slot) instead of looking like a live call, and
    // an activation that cannot recover refuses to serve rather than guessing.
    await planning.recoverExpiredReservations(createCancellationSource().token);
    controller=new ModelOperations({store,coaching,now,uniqueId,validateModels:(s,t)=>catalog.validate(s,t),onInternalError:reportFailure,
      planning,getPlan:(planId,accountId,reveal,token)=>workbench.getPlan(reveal?{planId,accountId,reveal:true}:{planId,accountId},token),
      ...(environment.closeWaitMs===undefined?{}:{closeWaitMs:environment.closeWaitMs}),
      createPipeline:r=>new AnalysisPipeline({store,gateway:new DshModelGateway({provider:r.value.provider,client,now}),taxonomy:CURRENT_TAXONOMY,roles:r.value.roles,limits:r.value.modelLimits,now,uniqueId})});
    const observer={onInternalError:reportFailure};
    disposers.push(await registerBusinessApi({registry:host.connection.fetch,store,imports,workbench,sources:sources.map(instance=>({instance})),settings:()=>store.getWorkbenchSettings(),now,uniqueId:randomUUID,
      adapterFor:async id=>{const adapter=byId.get(id);if(!adapter)throw Error('ICPC_SOURCE_ADAPTER_UNSUPPORTED');return adapter;},...observer,onDisposeError:reportFailure}));
    disposers.push(await registerModelApi({registry:host.connection.fetch,controller,...observer}));
    disposers.push(await registerBootstrapApi({registry:host.connection.fetch,store,controller,catalog,dataDir,hostVersion:compatibility.packageVersion,adapters,...observer}));
    return {dataDir,controller,dispose:disposeAll(disposers)};
  } catch(error){return rollback(error,disposers);}
}
/** Cordis owns the returned runtime through one disposable effect. */
export async function apply(ctx:Context,config:unknown={}):Promise<void> {
  const runtime=await activateHost(ctx,config);
  try {ctx.effect(()=>runtime.dispose,'icpc-workbench: host');}
  catch(error){return rollback(error,[runtime.dispose]);}
}