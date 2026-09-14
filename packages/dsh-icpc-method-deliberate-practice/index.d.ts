/**
 * Types for the companion entry point.
 *
 * The runtime file is plain ESM JavaScript with no imports; this declaration exists so a TypeScript
 * host can load the package without enabling `allowJs`.
 */
import type { Context } from '@deepseek-ai/cordis';

export declare const name: string;
export declare const inject: string[];
/** The method as registered: the definition plus its declared `kind` list. */
export declare const deliberatePracticeMethod: Readonly<Record<string, unknown>>;
/** The plain definition without the registration `kind` list. */
export declare const deliberatePracticeDefinition: Readonly<Record<string, unknown>>;
export declare function apply(ctx: Context): void;
