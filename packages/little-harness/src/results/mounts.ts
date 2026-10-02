import { resolve } from "node:path";

export type MountedResultPath = {
  readonly resultId: string;
  readonly resultGrantId: string;
  readonly storageValuePath: string;
  readonly storageRecordPath: string;
  readonly outputPath: string;
};

export type MountedResultPathInput = {
  readonly resultId: string;
  readonly resultGrantId: string;
};

export const resultIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export function mountedResultPath(
  sessionDataDir: string,
  input: MountedResultPathInput,
): MountedResultPath {
  const { resultId, resultGrantId } = input;
  if (!resultIdPattern.test(resultId)) {
    throw new Error(`Invalid Harness result id: ${resultId}`);
  }
  if (!resultIdPattern.test(resultGrantId)) {
    throw new Error(`Invalid Harness result grant id: ${resultGrantId}`);
  }
  const root = resolve(sessionDataDir, "results");
  const base = resolve(root, resultId);
  if (base !== root && !base.startsWith(`${root}/`)) {
    throw new Error(`Result path escaped session results root: ${resultId}`);
  }
  return {
    resultId,
    resultGrantId,
    storageValuePath: resolve(base, "value.json"),
    storageRecordPath: resolve(base, "record.json"),
    outputPath: `harness-result://${resultId}/output`,
  };
}
