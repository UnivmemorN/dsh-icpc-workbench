/** Bootstrap/catalog data is local account metadata, never provider credentials or problem bodies. */
import type { Account, SourceInstance, Taxonomy } from '../domain/index.js';
import type { PlatformCapabilities } from './ports.js';
import type { WorkbenchSettingsRecord } from './workbench-settings.js';
import type { ModelBatchListResult, ModelValidationDiagnostic } from './model-operation-types.js';
export interface CatalogModel {
  readonly id: string; readonly name: string; readonly description?: string;
  readonly inputModalities?: readonly string[];
  readonly contextWindow?: number; readonly defaultMaxTokens?: number;
  readonly reasoningEfforts?: readonly string[];
}
export interface ModelCatalogResult {
  readonly provider: string;
  readonly providers: readonly {readonly id: string; readonly name: string}[];
  readonly models: readonly CatalogModel[];
  readonly diagnostics: readonly ModelValidationDiagnostic[];
}
export interface BootstrapResult {
  readonly pluginVersion: string; readonly hostVersion: string; readonly dataDir: string; readonly schemaVersion: number;
  readonly settings: WorkbenchSettingsRecord;
  readonly catalog: ModelCatalogResult;
  readonly modelDiagnostics: readonly ModelValidationDiagnostic[];
  readonly sources: readonly SourceInstance[]; readonly accounts: readonly Account[];
  readonly adapters: readonly {readonly sourceInstanceId: string; readonly capabilities: PlatformCapabilities}[];
  readonly hydro: {readonly implemented: false; readonly note: string};
  readonly batches: ModelBatchListResult;
  readonly taxonomy: Taxonomy;
}
export interface BackupResult { readonly filename: string; readonly path: string; }