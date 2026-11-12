/** Shared portable vector runner for SDK/DB CI. Fixtures are trusted test data, never authority. */
export declare function runHarnessConformance(input: unknown): {
    passed: number;
    failures: {
        name: string;
        reason: string;
    }[];
};
