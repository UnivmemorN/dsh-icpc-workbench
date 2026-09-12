import { mkdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import type { TrainingStore, PlatformAdapter } from '../application/ports.js';
import type { SettingsStore } from '../application/workbench-settings.js';
import type { BootstrapResult, BackupResult, ModelCatalogResult } from '../application/bootstrap-types.js';
import { CURRENT_TAXONOMY } from '../domain/index.js';
import { ModelCatalog } from './model-catalog.js';
import { ModelOperations } from './model-operations.js';
import { ApiTransportError, registerApiRoute, type ApiRouteOptions } from './api-transport.js';
import { requestShape } from './model-api.js';
import { disposeAll, rollback } from './lifecycle.js';
export const PLUGIN_VERSION='0.1.2';
export interface BootstrapApiOptions extends ApiRouteOptions {
  readonly registry:HostConnectionFetch; readonly store:TrainingStore&SettingsStore;
  readonly controller:ModelOperations; readonly catalog:ModelCatalog; readonly dataDir:string;
  readonly hostVersion:string; readonly adapters:readonly PlatformAdapter[];
}
/** Read-only bootstrap and explicitly requested local backup; no activation-time platform/model work. */
export async function registerBootstrapApi(o:BootstrapApiOptions):Promise<()=>Promise<void>> {
  const disposers:(()=>Promise<void>)[]=[];
  try {
    disposers.push(registerApiRoute<Record<string,never>,BootstrapResult>(o.registry,{operation:'bootstrap',method:'GET',validate:requestShape({}),handle:async(_v,token)=>{
      token.throwIfCancelled();
      const metadata=await o.store.transaction(async()=>{
        const settings=await o.store.getWorkbenchSettings();if(!settings)throw Error('ICPC_SETTINGS_MISSING');
        const sources=await o.store.listSourceInstances(),accounts=await o.store.listAccounts(null);
        if(sources.length>1000||accounts.length>10000)throw new ApiTransportError('conflict','account/source metadata exceeds supported bounds');
        token.throwIfCancelled();return {settings,sources,accounts};
      });
      const [catalog,modelDiagnostics,batches]=await Promise.all([o.catalog.list(metadata.settings.value.provider,token),o.catalog.validate(metadata.settings.value,token),o.controller.batchList({limit:100},token)]);
      token.throwIfCancelled();
      return {...metadata,pluginVersion:PLUGIN_VERSION,hostVersion:o.hostVersion,dataDir:o.dataDir,schemaVersion:o.store.capabilities().schemaVersion,catalog,modelDiagnostics,batches,
        adapters:o.adapters.map(a=>({sourceInstanceId:a.sourceInstance.id,capabilities:a.capabilities()})),taxonomy:CURRENT_TAXONOMY,
        hydro:{implemented:false,note:'计划支持基于 HydroOJ 的校内 OJ；当前版本尚未实现。'}};
    }},o));
    disposers.push(registerApiRoute<{provider:string},ModelCatalogResult>(o.registry,{operation:'model.catalog',method:'POST',validate:requestShape({provider:v=>{if(typeof v!=='string'||!v.trim()||v.length>256)throw new ApiTransportError('invalid_input');}}),handle:(v,t)=>o.catalog.list(v.provider,t)},o));
    disposers.push(registerApiRoute<Record<string,never>,BackupResult>(o.registry,{operation:'backup',method:'POST',validate:requestShape({}),handle:async(_v,token)=>{
      token.throwIfCancelled();const dir=join(o.dataDir,'backups');await mkdir(dir,{recursive:true});
      if(await realpath(dir)!==dir)throw Error('ICPC_BACKUP_DIRECTORY_LINKED');token.throwIfCancelled();
      const filename=`training-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.sqlite`,path=join(dir,filename);
      await o.store.backupTo(path);token.throwIfCancelled();if(!(await stat(path)).isFile())throw Error('ICPC_BACKUP_NOT_WRITTEN');
      return {filename,path};
    }},o));
    return disposeAll(disposers);
  } catch(error){return rollback(error,disposers);}
}