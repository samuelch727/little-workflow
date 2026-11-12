import { canonicalJson } from "./hash.js";
import { HarnessContractError, invalid, json, object, text } from "./harnessJson.js";
import { admitHarnessContent, validateHarnessContent } from "./harnessContent.js";
import { rebaseHarnessContent, serveHarnessContent } from "./harnessRedeploy.js";
import { harnessExecutionIdentity } from "./harnessIdentity.js";
import { mergeHarnessContent } from "./harnessMerge.js";
import { accountHarnessStatic } from "./harnessBudget.js";
/** Shared portable vector runner for SDK/DB CI. Fixtures are trusted test data, never authority. */
export function runHarnessConformance(input) {
    const vectors = object(json(input)), owners = object(vectors.owners);
    if (!Array.isArray(vectors.cases) || vectors.cases.length > 128)
        invalid("/cases", "vectors", "Expected bounded conformance cases");
    const failures = [];
    for (const raw of vectors.cases) {
        const c = object(raw, "/cases", ["name", "operation", "owner", "args", "expected", "error"]), name = text(c.name, "/cases/name", 128);
        const owner = object(owners[text(c.owner, "/cases/owner", 128)]), args = c.args;
        if (!Array.isArray(args))
            invalid("/cases/args", "vectors", "Expected argument array");
        try {
            let result;
            switch (c.operation) {
                case "admit":
                    result = admitHarnessContent(args[0], owner.registry, owner.envelope);
                    break;
                case "validate":
                    result = validateHarnessContent(args[0], owner.registry, owner.envelope);
                    break;
                case "serve":
                    result = serveHarnessContent(args[0], owner.registry, owner.envelope);
                    break;
                case "rebase":
                    result = rebaseHarnessContent(args[0], owner.registry, owner.envelope);
                    break;
                case "identity":
                    result = harnessExecutionIdentity(args[0], owner.registry, owner.envelope, args[1]);
                    break;
                case "merge":
                    result = mergeHarnessContent(args[0], args[1], args[2], args[3] === true);
                    break;
                case "budget":
                    result = accountHarnessStatic(args[0], args[1], args[2]);
                    break;
                default: invalid("/cases/operation", "vectors", "Unknown conformance operation");
            }
            if (c.error)
                throw new Error("Expected rejection");
            const expected = object(c.expected);
            if (!Object.keys(expected).length)
                throw new Error("No expected values");
            for (const [path, value] of Object.entries(expected)) {
                if (!path.startsWith("/"))
                    throw new Error("Expected a JSON pointer");
                let actual = result;
                for (const part of path.slice(1).split("/"))
                    actual = actual && typeof actual === "object" ? actual[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
                if (canonicalJson(actual) !== canonicalJson(value))
                    throw new Error(`Mismatch at ${path}`);
            }
        }
        catch (error) {
            if (!(error instanceof HarnessContractError && c.error === error.problem.code))
                failures.push({ name, reason: error instanceof Error ? error.message : "Unknown vector failure" });
        }
    }
    return { passed: vectors.cases.length - failures.length, failures };
}
