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

  export class Bash {
    constructor(options: {
      readonly fs?: unknown;
      readonly cwd?: string;
      readonly network?: NetworkConfig;
      readonly python?: boolean;
      readonly javascript?: boolean;
      readonly defenseInDepth?: boolean;
      readonly executionLimits?: {
        readonly maxCommandCount?: number;
        readonly maxLoopIterations?: number;
        readonly maxCallDepth?: number;
      };
    });
    getEnv(): Record<string, string>;
    exec(command: string, options: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly signal?: AbortSignal;
      readonly rawScript?: boolean;
    }): Promise<BashExecResult>;
  }

  export class InMemoryFs {
    constructor(options?: Record<string, unknown>);
  }

  export class MountableFs {
    constructor(options?: { readonly base?: unknown });
    mount(path: string, fs: unknown): void;
  }

  export class OverlayFs {
    constructor(options: {
      readonly root: string;
      readonly mountPoint?: string;
      readonly readOnly?: boolean;
      readonly allowSymlinks?: boolean;
      readonly maxFileReadSize?: number;
    });
  }

  export class ReadWriteFs {
    constructor(options: {
      readonly root: string;
      readonly allowSymlinks?: boolean;
      readonly maxFileReadSize?: number;
    });
  }
}
