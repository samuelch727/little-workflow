export declare const FILE_LIMITS: {
    readonly maxFiles: 128;
    readonly maxFileBytes: 65536;
    readonly maxTotalBytes: 524288;
    readonly maxSkills: 32;
    readonly maxReferenceDepth: 4;
};
export type FileLimits = {
    [K in keyof typeof FILE_LIMITS]: number;
};
export type SkillMetadata = {
    name: string;
    description: string;
    license?: string;
    compatibility?: string;
};
export declare function fileLimits(value?: unknown): FileLimits;
export declare function filePath(path: string): void;
/** Portable literal-string frontmatter subset. Unsupported YAML features fail explicitly. */
export declare function skillMetadata(content: string, path: string): SkillMetadata;
export declare function parseHarnessFiles(input: unknown, bounds?: Partial<FileLimits>): {
    files: Record<string, string>;
    skills: {
        name: string;
        description: string;
        license?: string;
        compatibility?: string;
        path: string;
    }[];
    links: {
        [k: string]: string[];
    };
    manifest: {
        path: string;
        bytes: number;
        hash: `sha256:${string}`;
    }[];
    totalBytes: number;
    bundleHash: `sha256:${string}`;
};
