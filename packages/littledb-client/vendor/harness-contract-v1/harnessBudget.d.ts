export declare const STATIC_LIMITS: {
    readonly maxStaticUnits: 8000;
    readonly maxCatalogUnits: 2000;
    readonly maxDescriptionUnits: 128;
    readonly maxByteStaticUnits: 32000;
    readonly maxByteCatalogUnits: 8000;
    readonly maxByteDescriptionUnits: 512;
    readonly framingUnits: 256;
};
export type StaticLimits = {
    [K in keyof typeof STATIC_LIMITS]: number;
} & {
    inputWindow?: number;
};
export type StaticPart = {
    text: string;
    category: "owner" | "system" | "catalog" | "tools" | "hints" | "description";
};
export type ExactAccounting = {
    profile: string;
    units: Record<string, number>;
};
export declare function staticLimits(input?: unknown): StaticLimits;
/** Exact counts are trusted caller data; missing/invalid refinement selects the built-in profile. */
export declare function accountHarnessStatic(parts: Record<string, StaticPart>, input?: Partial<StaticLimits>, refinement?: ExactAccounting): {
    profile: string;
    unit: "tokens" | "bytes";
    units: Record<string, number>;
    framingUnits: number;
    totalUnits: number;
    cap: number;
    violations: string[];
    pass: boolean;
};
