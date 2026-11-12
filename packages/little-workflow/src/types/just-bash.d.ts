declare module "just-bash" {
  export type BashExecResult = {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
    readonly env: Record<string, string>;
    readonly metadata?: Record<string, unknown>;
  };

  export type NetworkConfig = {
    readonly allowedUrlPrefixes?: string[];
    readonly allowedMethods?: string[];
    readonly maxRedirects?: number;
    readonly timeoutMs?: number;
    readonly maxResponseSize?: number;
    readonly denyPrivateRanges?: boolean;
    readonly dangerouslyAllowFullInternetAccess?: boolean;
  };

  export type BashOptions = {
    readonly fs?: unknown;
    readonly cwd?: string;
    readonly network?: NetworkConfig;
    readonly python?: boolean;
    readonly javascript?: boolean | { readonly invokeTool?: unknown };
    readonly defenseInDepth?: boolean;
    readonly executionLimits?: {
      readonly maxCommandCount?: number;
      readonly maxLoopIterations?: number;
      readonly maxCallDepth?: number;
    };
  };

  export class Bash {
    constructor(options: BashOptions);
    getEnv(): Record<string, string>;
    exec(command: string, options: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly signal?: AbortSignal;
      readonly rawScript?: boolean;
    }): Promise<BashExecResult>;
  }

  // just-bash 3.0.3 omits security/transform files referenced by its top-level
  // declarations. Retain the existing Bash facade, but use its actual filesystem
  // declarations so World.files has exactly the interface Little Harness uses.
  export type IFileSystem = import("../../node_modules/just-bash/dist/fs/interface.js").IFileSystem;
  export type BufferEncoding = import("../../node_modules/just-bash/dist/fs/interface.js").BufferEncoding;
  export type CpOptions = import("../../node_modules/just-bash/dist/fs/interface.js").CpOptions;
  export type FileContent = import("../../node_modules/just-bash/dist/fs/interface.js").FileContent;
  export type FsStat = import("../../node_modules/just-bash/dist/fs/interface.js").FsStat;
  export type MkdirOptions = import("../../node_modules/just-bash/dist/fs/interface.js").MkdirOptions;
  export type RmOptions = import("../../node_modules/just-bash/dist/fs/interface.js").RmOptions;

  export type InMemoryFs = import("../../node_modules/just-bash/dist/fs/in-memory-fs/in-memory-fs.js").InMemoryFs;
  export const InMemoryFs: typeof import("../../node_modules/just-bash/dist/fs/in-memory-fs/in-memory-fs.js").InMemoryFs;
  export type MountableFs = import("../../node_modules/just-bash/dist/fs/mountable-fs/mountable-fs.js").MountableFs;
  export const MountableFs: typeof import("../../node_modules/just-bash/dist/fs/mountable-fs/mountable-fs.js").MountableFs;
  export type OverlayFs = import("../../node_modules/just-bash/dist/fs/overlay-fs/overlay-fs.js").OverlayFs;
  export const OverlayFs: typeof import("../../node_modules/just-bash/dist/fs/overlay-fs/overlay-fs.js").OverlayFs;
  export type ReadWriteFs = import("../../node_modules/just-bash/dist/fs/read-write-fs/read-write-fs.js").ReadWriteFs;
  export const ReadWriteFs: typeof import("../../node_modules/just-bash/dist/fs/read-write-fs/read-write-fs.js").ReadWriteFs;
}
