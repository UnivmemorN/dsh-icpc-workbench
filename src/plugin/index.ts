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
import {AssessmentService} from '../application/assessment-service.js';
import {DshAssessmentGenerator} from '../adapters/dsh/assessment-generator.js';
import {registerAssessmentApi} from './assessment-api.js';
import { GuidanceMethodRegistry } from '../adapters/guidance/index.js';
import { DshAuditedModelClient, type DshAuditedHost } from '../adapters/dsh/audited-client.js';
import { DshModelGateway } from '../adapters/dsh/model-gateway.js';
import { DshCoachingGenerator } from '../adapters/dsh/coaching-generator.js';
import { DshPlanGenerator } from '../adapters/dsh/plan-generator.js';
import { AnalysisPipeline } from '../application/analysis-pipeline.js';
import { CoachingService } from '../application/coaching-service.js';
import { ImportService } from '../application/import-service.js';
import { MaterialRefreshBatchService } from '../application/material-refresh-batch-service.js';
import { PlanningService } from '../application/planning-service.js';
import { VirtualPerformanceService } from '../application/virtual-performance-service.js';
import { WorkbenchService } from '../application/workbench-service.js';
import { defaultWorkbenchSettings, isFlashOnlySettings, withFlashOnlyModels } from '../application/workbench-settings.js';
import { DEFAULT_PLATFORM_LIMITS, type PlatformAdapter } from '../application/ports.js';
import type { GuidanceCatalog } from '../application/guidance-catalog.js';
import { CURRENT_TAXONOMY, CODEFORCES_MAIN_INSTANCE_ID, createCancellationSource, createTaxonomyIndex } from '../domain/index.js';
import { checkHostCompatibility, type HostCompatibilityProbe } from './compatibility.js';
import { parsePluginConfig, resolveDataDir } from './config.js';
import { ModelCatalog, type CatalogHost } from './model-catalog.js';
import { ModelOperations } from './model-operations.js';
import { registerBusinessApi } from './business-api.js';
import { registerMaterialBatchApi } from './material-batch-api.js';
import { registerPerformanceApi } from './performance-api.js';
import { registerModelApi } from './model-api.js';
import { registerBootstrapApi } from './bootstrap-api.js';
import { registerLuoguApi } from './luogu-api.js';
import { createLuoguHost, type LuoguHostSeam } from './luogu-host.js';
import { createGatedLuoguAdapter } from './luogu-gated-adapter.js';
import { disposeAll, rollback } from './lifecycle.js';
import { registerGuidanceApi } from './guidance-api.js';
import { applyGuidanceService } from './guidance-service.js';
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
  /** Injected Luogu seams (vault, platform, clock, wait, timers, transport, metadata source). */
  readonly luogu?:LuoguHostSeam;
  /** Injected installed-method catalogue (Sprint 18b1 seam); production passes the Cordis service catalogue. */
  readonly guidance?:GuidanceCatalog;
}
export interface PluginRuntime {
  readonly dataDir:string; readonly controller:ModelOperations; readonly guidance:GuidanceCatalog; readonly dispose:()=>Promise<void>;
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
  // Sprint 18b1: installed training methods. Production shares this registry with the Cordis
  // `icpcGuidance` service; `environment.guidance` is the offline lifecycle seam.
  const guidance=environment.guidance??new GuidanceMethodRegistry();
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
      const settings=await store.getWorkbenchSettings();
      if(settings===null)await store.saveWorkbenchSettings(defaultWorkbenchSettings(),null);
      else if(!isFlashOnlySettings(settings.value))await store.saveWorkbenchSettings(withFlashOnlyModels(settings.value),settings.revision);
    });
    // The anonymous Luogu adapter every public problem read goes through. It carries the composition's
    // transport seam *here*, at the one place it is built, so the host's own default metadata source
    // (the automatic-sync metadata repair) and the business adapter's anonymous reads are both covered
    // by an injected synthetic transport — a seam that reached only one of them would leave a path on
    // the real network.
    const anonymousTransport=environment.luogu?.anonymousTransport??{};
    const anonymousLuogu=new LuoguAdapter({sourceInstance:sources[1]!,...anonymousTransport});
    const adapters:PlatformAdapter[]=[new CodeforcesAdapter({sourceInstance:sources[0]!}),anonymousLuogu];
    const byId=new Map(adapters.map(a=>[a.sourceInstance.id,a]));
    const imports=new ImportService({store,now}),workbench=new WorkbenchService({store,taxonomy:createTaxonomyIndex(CURRENT_TAXONOMY),now,uniqueId:randomUUID,guidance});
    const client=new DshAuditedModelClient({llm:host.llm,sessions:auditSessions},{now,flashOnly:true}),catalog=new ModelCatalog(host.llm);
    const assessment=new AssessmentService({store,capture:workbench,generator:new DshAssessmentGenerator({client,now}),now});
    disposers.push(async()=>{const result=await assessment.close();if(result.failures.length)throw Error('ICPC_ASSESSMENT_SETTLEMENT_FAILED');});
    await assessment.recoverExpiredReservations(createCancellationSource().token);
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
    // Luogu authenticated synchronization (Sprint 17d1): one owned runtime composes the workspace OS
    // vault, the shared source gate, the connection manager, the stored-session submissions source and
    // the durable sync service. Durable state is recovered and the startup sweep runs *before* any
    // route can accept work; its disposer stops the owned timer and drains the service, and it is
    // registered before the API disposer so reverse-order disposal removes the routes first.
    const workbenchSettings=await store.getWorkbenchSettings();
    const luoguHost=createLuoguHost({store,imports,sourceInstance:sources[1]!,metadataSource:byId.get(sources[1]!.id)!,
      dataDir,limits:workbenchSettings?.value.platformLimits??DEFAULT_PLATFORM_LIMITS,ownerId:uniqueId('luogu-sync'),
      onInternalError:reportFailure,...(environment.luogu===undefined?{}:{seam:environment.luogu})});
    disposers.push(async()=>{await luoguHost.dispose();});
    await luoguHost.start(createCancellationSource().token);
    // The business Luogu adapter is rebuilt over the host's own authenticated reader: the anonymous
    // metadata adapter stays the *only* source of public problem reads, while submissions and solution
    // material run through the reader the sync service already drives, so one account has one
    // credential path, one pacing state and one cookie lifecycle. `capabilities()` then reports the
    // submissions/editorial support this composition really has, instead of advertising a session it
    // cannot reach. Both adapters keep the composition's transport seam, so an injected synthetic
    // transport covers every Luogu request of this activation.
    //
    // The business adapter is then wrapped in the host's *own* source gate: every business operation
    // that can reach Luogu — the anonymous statement/profile/catalog reads included — becomes one whole
    // gated operation of this source, so a business read can never start on top of a gated sync,
    // connection probe or another account's read. The host's own paths are already gated at their call
    // site, so this wrapper is applied here and nowhere else.
    const businessLuogu=createGatedLuoguAdapter({
      adapter:new LuoguAdapter({sourceInstance:sources[1]!,sessionReader:luoguHost.sessionReader,...anonymousTransport}),
      gate:luoguHost.gate});
    const businessAdapters=new Map(byId);businessAdapters.set(sources[1]!.id,businessLuogu);
    disposers.push(await registerLuoguApi({registry:host.connection.fetch,store,service:luoguHost.service,
      sourceInstance:sources[1]!,connectionAvailable:luoguHost.connectionAvailable,
      connectionPlatform:luoguHost.connectionPlatform,now,...observer}));
    disposers.push(await registerBusinessApi({registry:host.connection.fetch,store,imports,workbench,sources:sources.map(instance=>({instance})),settings:()=>store.getWorkbenchSettings(),now,uniqueId:randomUUID,
      adapterFor:async id=>{const adapter=businessAdapters.get(id);if(!adapter)throw Error('ICPC_SOURCE_ADAPTER_UNSUPPORTED');return adapter;},...observer,onDisposeError:reportFailure}));
    // Durable bulk material refresh (Sprint 34A): a separate aggregate that refreshes 1..100 selected
    // stored problems through the *same* accepted single-problem refresh service and the same composed
    // adapters (the source-gated Luogu adapter included), so every platform/source gate is preserved.
    // Recovery runs before the routes exist: a batch a dead process left `running` becomes `paused`
    // with its in-flight item retryable, and nothing contacts a platform automatically. The service
    // is never given a model, a budget or an attempt: a bulk material refresh is platform IO only.
    const cfMirrorAdapter=businessAdapters.get(CODEFORCES_MAIN_INSTANCE_ID);
    const materialBatches=new MaterialRefreshBatchService({store,imports,now,uniqueId,
      adapterFor:async id=>{const adapter=businessAdapters.get(id);if(!adapter)throw Error('ICPC_SOURCE_ADAPTER_UNSUPPORTED');return adapter;},
      limits:async()=>((await store.getWorkbenchSettings())?.value.platformLimits??DEFAULT_PLATFORM_LIMITS),
      ...(cfMirrorAdapter===undefined?{}:{mirrorEditorialFor:async()=>({fetchMirrorEditorial:async request=>cfMirrorAdapter.fetchEditorial({problemRef:request.cfRef,token:request.token,limits:request.limits})})}),
      onInternalError:reportFailure});
    await materialBatches.recoverInterrupted(createCancellationSource().token);
    // Route-first disposal: disposers run in reverse registration order, so the service disposer is
    // registered *before* its API disposer. The six routes are therefore removed first and only then
    // is the service closed, so a request can never reach a service that disposal already closed.
    // `close` itself is the whole disposal: it establishes the closing barrier, cancels owned work,
    // waits its one shared finite deadline, durably interrupts every batch still in flight and
    // detaches the late platform promise — so disposal is bounded and a non-cooperative adapter can
    // never keep the store open behind an unbounded `whenSettled()`.
    disposers.push(async()=>{await materialBatches.close();});
    disposers.push(await registerMaterialBatchApi({registry:host.connection.fetch,service:materialBatches,...observer}));
    disposers.push(registerGuidanceApi(host.connection.fetch,guidance));
    disposers.push(await registerAssessmentApi(host.connection.fetch,assessment));
    // Virtual-contest performance ledger (Sprint 18c): free local CRUD over the durable per-account
    // ledger the same store owns; no model, platform or credential path is reachable from it.
    disposers.push(await registerPerformanceApi({registry:host.connection.fetch,...observer,
      service:new VirtualPerformanceService({store,now,uniqueId:()=>uniqueId('virtual-performance')})}));
    disposers.push(await registerModelApi({registry:host.connection.fetch,controller,...observer}));
    disposers.push(await registerBootstrapApi({registry:host.connection.fetch,store,controller,catalog,dataDir,hostVersion:compatibility.packageVersion,adapters:[...businessAdapters.values()],...observer}));
    return {dataDir,controller,guidance,dispose:disposeAll(disposers)};
  } catch(error){return rollback(error,disposers);}
}
/** Cordis owns the returned runtime through one disposable effect. */
export async function apply(ctx:Context,config:unknown={}):Promise<void> {
  // One registry instance is shared by the documented `icpcGuidance` service and the host runtime,
  // so a method a companion package registers is immediately the catalogue the host reads.
  const guidance=new GuidanceMethodRegistry();
  const runtime=await activateHost(ctx,config,{guidance});
  try {applyGuidanceService(ctx,{registry:guidance});ctx.effect(()=>runtime.dispose,'icpc-workbench: host');}
  catch(error){return rollback(error,[runtime.dispose]);}
}
