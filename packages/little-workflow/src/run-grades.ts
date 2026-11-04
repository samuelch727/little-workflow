import { randomUUID } from "node:crypto";
import { WorldPathError, type EventEnvelope } from "./world.js";
import type { World } from "./world-port.js";
import { runFilesFor } from "./run-files.js";

const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]{1,80}$/u;
const GRADE_FILE_PATTERN = /^grade_[A-Za-z0-9-]{1,80}\.json$/u;

/** Whether a run did its job, as judged by a person, a test or a checker after it finished. */
export type RunGrade = {
  readonly gradeId: string;
  readonly runId: string;
  readonly workflowId: string;
  /** The plan the run executed. A `"fail"` grade sends this plan back to the planner. */
  readonly workflowVersionId: string;
  readonly verdict: "pass" | "fail";
  /** What was wrong (or right). The planner reads it when it reviews the plan. */
  readonly reason?: string;
  /** Who or what graded the run, such as a reviewer's name or `"policy-check"`. */
  readonly gradedBy?: string;
  readonly gradedAt: string;
};

export type GradeRunInput = {
  readonly verdict: "pass" | "fail";
  readonly reason?: string;
  readonly gradedBy?: string;
};

/**
 * Grade a finished run. A `"fail"` grade counts as a change: the next run of the same workflow
 * sends the plan that failed back to the planner with the reason, instead of keeping it without a
 * planner call. The planner then adapts the plan, replaces it, or keeps it and says why.
 */
export async function gradeRun(world: World, runId: string, grade: GradeRunInput): Promise<RunGrade> {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new WorldPathError(`Invalid run id: ${runId}`);
  }
  if (grade.verdict !== "pass" && grade.verdict !== "fail") {
    throw new TypeError(`gradeRun: verdict must be "pass" or "fail" (got ${JSON.stringify(grade.verdict)}).`);
  }
  for (const field of ["reason", "gradedBy"] as const) {
    if (grade[field] !== undefined && typeof grade[field] !== "string") {
      throw new TypeError(`gradeRun: ${field} must be a string.`);
    }
  }
  const events = await world.listEvents(runId);
  if (events.length === 0) {
    throw new Error(`gradeRun: no run '${runId}' in ${world.dataDir}. Pass the world the run used.`);
  }
  const workflowVersionId = lastPayloadString(events, "WorkflowVersionRegistered", "workflowVersionId");
  const workflowId = lastPayloadString(events, "OrchestrationRequested", "workflowId");
  if (workflowVersionId === undefined || workflowId === undefined) {
    throw new Error(`gradeRun: run '${runId}' never got a plan, so there is nothing to grade.`);
  }
  const record: RunGrade = {
    gradeId: `grade_${randomUUID()}`,
    runId,
    workflowId,
    workflowVersionId,
    verdict: grade.verdict,
    ...(grade.reason === undefined ? {} : { reason: grade.reason }),
    ...(grade.gradedBy === undefined ? {} : { gradedBy: grade.gradedBy }),
    gradedAt: new Date().toISOString(),
  };
  const files = runFilesFor(world);
  const directory = files.path.join(gradesRoot(world), runId);
  await files.mkdir(directory, { recursive: true });
  const path = files.path.join(directory, `${record.gradeId}.json`);
  const tempPath = `${path}.${process.pid}.tmp`;
  await files.writeFile(tempPath, `${JSON.stringify(record)}\n`, "utf8");
  await files.rename(tempPath, path);
  return record;
}

/**
 * The grades recorded in a world, oldest first. Filter by the run, or by the plan (WorkflowVersion)
 * the graded runs executed.
 */
export async function listRunGrades(
  world: World,
  filter: { readonly runId?: string; readonly workflowVersionId?: string } = {},
): Promise<readonly RunGrade[]> {
  if (filter.runId !== undefined && !RUN_ID_PATTERN.test(filter.runId)) {
    throw new WorldPathError(`Invalid run id: ${filter.runId}`);
  }
  const runIds = filter.runId === undefined
    ? (await readDirectory(world, gradesRoot(world))).filter((name) => RUN_ID_PATTERN.test(name))
    : [filter.runId];
  const grades: RunGrade[] = [];
  for (const runId of runIds) {
    const directory = runFilesFor(world).path.join(gradesRoot(world), runId);
    for (const file of await readDirectory(world, directory)) {
      if (!GRADE_FILE_PATTERN.test(file)) {
        continue;
      }
      const grade = await readGradeFile(world, runFilesFor(world).path.join(directory, file));
      if (grade === undefined) {
        continue;
      }
      if (filter.workflowVersionId === undefined || grade.workflowVersionId === filter.workflowVersionId) {
        grades.push(grade);
      }
    }
  }
  return grades.sort((left, right) =>
    left.gradedAt === right.gradedAt
      ? left.gradeId.localeCompare(right.gradeId)
      : left.gradedAt.localeCompare(right.gradedAt)
  );
}

/** A grade file that cannot be read or is not a grade is skipped, so it cannot stop planner reuse. */
async function readGradeFile(world: World, path: string): Promise<RunGrade | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await runFilesFor(world).readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  return isRunGrade(value) ? value : undefined;
}

function isRunGrade(value: unknown): value is RunGrade {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const grade = value as Record<string, unknown>;
  return (
    ["gradeId", "runId", "workflowId", "workflowVersionId", "gradedAt"].every((field) =>
      typeof grade[field] === "string"
    ) &&
    (grade.verdict === "pass" || grade.verdict === "fail") &&
    (grade.reason === undefined || typeof grade.reason === "string") &&
    (grade.gradedBy === undefined || typeof grade.gradedBy === "string")
  );
}

function gradesRoot(world: World): string {
  return runFilesFor(world).path.join(world.dataDir, "run-grades");
}

async function readDirectory(world: World, path: string): Promise<readonly string[]> {
  try {
    return (await runFilesFor(world).readdir(path)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return [];
    }
    throw error;
  }
}

function lastPayloadString(
  events: readonly EventEnvelope[],
  type: EventEnvelope["type"],
  field: string,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type && typeof event.payload[field] === "string") {
      return event.payload[field] as string;
    }
  }
  return undefined;
}
