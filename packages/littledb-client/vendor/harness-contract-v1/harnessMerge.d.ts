import { type HarnessContent } from "./harnessContent.js";
export type HarnessConflict = {
    path: string;
    reason: string;
};
/** No composer: all conflicts preserve the live value and invalidate the result as a whole. */
export declare function mergeHarnessFiles(base: Record<string, string>, ours: Record<string, string>, live: Record<string, string>, staleOperation?: boolean): {
    files: Record<string, string> | null;
    conflicts: HarnessConflict[];
};
/** Bindings never merge across installations; descriptions/scalars have no text composer. */
export declare function mergeHarnessContent(base: unknown, ours: unknown, live: unknown, staleOperation?: boolean): {
    content: HarnessContent | null;
    conflicts: HarnessConflict[];
    requiresValidation: true;
    requiresEvaluation: true;
};
