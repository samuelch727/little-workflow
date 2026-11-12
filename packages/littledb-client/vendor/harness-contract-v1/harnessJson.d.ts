export type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
export type Problem = {
    path: string;
    code: string;
    message: string;
};
export declare class HarnessContractError extends Error {
    readonly problem: Problem;
    constructor(problem: Problem);
}
export declare const pointer: (key: string) => string;
export declare function invalid(path: string, code: string, message: string): never;
export declare const unsafeKey: (key: string) => boolean;
export declare function object(value: unknown, path?: string, keys?: readonly string[]): Record<string, unknown>;
export declare function text(value: unknown, path: string, max?: number): string;
/** Exact UTF-8 size; reject lone surrogates rather than hashing replacement bytes. */
export declare function utf8Bytes(value: string, path?: string): number;
export declare function integer(value: unknown, path: string, min?: number, max?: number): number;
export declare function json(value: unknown, path?: string, depth?: number, budget?: {
    nodes: number;
}): Json;
export type Digest = `sha256:${string}`;
export declare const digest: (value: unknown) => Digest;
export declare const textDigest: (value: string) => Digest;
export declare function hash(value: unknown, path: string): Digest;
