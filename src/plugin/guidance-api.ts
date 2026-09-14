import type {HostConnectionFetch} from '@deepseek-ai/dsh-client-connection';
import type {GuidanceCatalog} from '../application/guidance-catalog.js';
import {registerApiRoute,ApiTransportError} from './api-transport.js';
/** Installed method catalogue; no package loading or external fetching at this boundary. */
export function registerGuidanceApi(registry:HostConnectionFetch,catalog:GuidanceCatalog){
 return registerApiRoute(registry,{operation:'guidance.catalog',method:'POST',validate(value:unknown){
  if(value===null||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length)throw new ApiTransportError('invalid_input');return {};
 },async handle(_,token){token.throwIfCancelled();const methods=await catalog.catalog();token.throwIfCancelled();return {methods};}});
}
