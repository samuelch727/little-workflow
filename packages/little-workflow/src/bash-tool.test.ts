import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBashTool,
  validateBashCommand,
  type BashScope,
} from "./bash-tool.js";

let root = "";
let scratch = "";
let memory = "";
let peerSteps = "";
let outside = "";
let scope: BashScope;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "little-workflow-bash-"));
  scratch = join(root, "scratch");
  memory = join(root, "memory");
  peerSteps = join(root, "steps");
  outside = join(root, "outside");
  await mkdir(scratch, { recursive: true });
  await mkdir(memory, { recursive: true });
  await mkdir(peerSteps, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(memory, "notes.md"), "remember this\n", "utf8");
  await writeFile(join(outside, "secret.md"), "do not read\n", "utf8");
  scope = {
    cwd: "/mnt/scratch/own/",
    readableRoots: [
      { path: scratch, mode: "rw" },
      { path: memory, mode: "ro" },
    ],
    pathAliases: [
      { mountPath: "/mnt/scratch/own/", backingPath: scratch },
      { mountPath: "/mnt/memory/workflow/", backingPath: memory },
    ],
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sandboxed bash tool", () => {
  it("executes rich shell syntax inside explicit mounts", async () => {
    const bash = createBashTool(scope);

    await expect(
      bash.execute({
        cmd: "printf 'alpha\\nbeta\\n' | grep beta | tr a-z A-Z > /mnt/scratch/own/out.txt && cat /mnt/scratch/own/out.txt",
      }),
    ).resolves.toMatchObject({
      stdout: "BETA\n",
      stderr: "",
      exitCode: 0,
    });

    await expect(readFile(join(scratch, "out.txt"), "utf8")).resolves.toBe("BETA\n");
  });

  it("mounts a single-file skill at SKILL.md without exposing source siblings", async () => {
    const skillsDir = join(root, "skills");
    await mkdir(skillsDir, { recursive: true });
    const skillFile = join(skillsDir, "output-schema-validation.md");
    await writeFile(skillFile, "---\nname: output-schema-validation\ndescription: d\n---\nbody\n", "utf8");
    await writeFile(join(skillsDir, "secret.md"), "hidden\n", "utf8");
    const fileScope: BashScope = {
      ...scope,
      cwd: "/mnt/scratch/own/",
      pathAliases: [
        ...(scope.pathAliases ?? []),
        { mountPath: ".agents/skills/output-schema-validation/SKILL.md", backingPath: skillFile },
      ],
    };
    const bash = createBashTool(fileScope);
    await expect(bash.execute({ cmd: "pwd && cat .agents/skills/output-schema-validation/SKILL.md" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringMatching(/^\/mnt\/scratch\/own\n[\s\S]*name: output-schema-validation/u),
    });
    await expect(bash.execute({ cmd: "test ! -e .agents/skills/output-schema-validation/output-schema-validation.md" })).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(bash.execute({ cmd: "test ! -e .agents/skills/output-schema-validation/secret.md" })).resolves.toMatchObject({
      exitCode: 0,
    });
  });

  it("keeps relative directory skill aliases read-only from the default cwd", async () => {
    const skillDir = join(root, "skills", "planner-guide");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "original directory skill\n", "utf8");
    const skillScope: BashScope = {
      ...scope,
      pathAliases: [
        ...(scope.pathAliases ?? []),
        { mountPath: ".agents/skills/planner-guide/", backingPath: skillDir },
      ],
    };
    const bash = createBashTool(skillScope);

    await expect(bash.execute({ cmd: "pwd && cat .agents/skills/planner-guide/SKILL.md" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "/mnt/scratch/own\noriginal directory skill\n",
    });
    const writeResult = await bash.execute({ cmd: "echo nope > .agents/skills/planner-guide/SKILL.md" });
    expect(writeResult.exitCode).not.toBe(0);
    await expect(bash.execute({ cmd: "cat .agents/skills/planner-guide/SKILL.md" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "original directory skill\n",
    });
    await expect(readFile(join(skillDir, "SKILL.md"), "utf8")).resolves.toBe("original directory skill\n");
  });

  it("keeps relative single-file skill aliases read-only from the default cwd", async () => {
    const skillsDir = join(root, "single-file-skills");
    await mkdir(skillsDir, { recursive: true });
    const skillFile = join(skillsDir, "output-schema-validation.md");
    await writeFile(skillFile, "original single-file skill\n", "utf8");
    const skillScope: BashScope = {
      ...scope,
      pathAliases: [
        ...(scope.pathAliases ?? []),
        { mountPath: ".agents/skills/output-schema-validation/SKILL.md", backingPath: skillFile },
      ],
    };
    const bash = createBashTool(skillScope);

    await expect(bash.execute({ cmd: "pwd && cat .agents/skills/output-schema-validation/SKILL.md" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "/mnt/scratch/own\noriginal single-file skill\n",
    });
    const writeResult = await bash.execute({ cmd: "echo nope > .agents/skills/output-schema-validation/SKILL.md" });
    expect(writeResult.exitCode).not.toBe(0);
    await expect(bash.execute({ cmd: "cat .agents/skills/output-schema-validation/SKILL.md" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "original single-file skill\n",
    });
    await expect(readFile(skillFile, "utf8")).resolves.toBe("original single-file skill\n");
  });

  it("persists shell state for the live BashTool instance", async () => {
    const bash = createBashTool(scope);

    await expect(
      bash.execute({ cmd: "export LITTLE_WORKFLOW_STATE=sticky && mkdir -p nested && cd nested" }),
    ).resolves.toMatchObject({ exitCode: 0 });

    await expect(
      bash.execute({ cmd: "pwd && printf \"$LITTLE_WORKFLOW_STATE\\n\" > state.txt && cat state.txt" }),
    ).resolves.toMatchObject({
      stdout: "/mnt/scratch/own/nested\nsticky\n",
      stderr: "",
      exitCode: 0,
    });
    await expect(readFile(join(scratch, "nested", "state.txt"), "utf8")).resolves.toBe("sticky\n");
  });

  it("returns stdout stderr and non-zero exitCode without throwing", async () => {
    const bash = createBashTool(scope);

    await expect(
      bash.execute({ cmd: "echo before && ls /mnt/scratch/own/missing && echo after" }),
    ).resolves.toMatchObject({
      stdout: "before\n",
      exitCode: expect.any(Number),
    });
  });

  it("persists writes only through explicit rw mounts", async () => {
    const bash = createBashTool(scope);

    await expect(
      bash.execute({ cmd: "cat /mnt/memory/workflow/notes.md > /mnt/scratch/own/copied.md" }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(readFile(join(scratch, "copied.md"), "utf8")).resolves.toBe("remember this\n");

    const readonlyWrite = await bash.execute({
      cmd: "echo nope > /mnt/memory/workflow/nope.md",
    });
    expect(readonlyWrite).toMatchObject({ exitCode: expect.any(Number) });
    expect(readonlyWrite.exitCode).not.toBe(0);
    await expect(readFile(join(memory, "nope.md"), "utf8")).rejects.toThrow();
  });

  it("does not expose unmounted host paths or symlink escapes", async () => {
    await symlink(join(outside, "secret.md"), join(scratch, "escape.md"));
    const bash = createBashTool(scope);

    const absoluteOutside = await bash.execute({ cmd: `cat ${join(outside, "secret.md")}` });
    expect(absoluteOutside.exitCode).not.toBe(0);
    expect(absoluteOutside.stdout).not.toContain("do not read");

    const symlinkEscape = await bash.execute({ cmd: "cat /mnt/scratch/own/escape.md" });
    expect(symlinkEscape.exitCode).not.toBe(0);
    expect(symlinkEscape.stdout).not.toContain("do not read");
  });

  it("maps wildcard peer scratch mounts into the sandbox", async () => {
    const enrichScratch = join(peerSteps, "enrich", "scratch");
    await mkdir(enrichScratch, { recursive: true });
    await writeFile(join(enrichScratch, "peer.txt"), "peer-step\n", "utf8");

    const bash = createBashTool({
      ...scope,
      readableRoots: [
        ...scope.readableRoots,
        { path: peerSteps, mode: "ro" },
      ],
      pathAliases: [
        ...(scope.pathAliases ?? []),
        { mountPath: "/mnt/scratch/peer-steps/", backingPath: `${peerSteps}/*/scratch` },
      ],
    });

    await expect(
      bash.execute({ cmd: "cat /mnt/scratch/peer-steps/enrich/peer.txt" }),
    ).resolves.toMatchObject({
      stdout: "peer-step\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("allows sandboxed Python and JavaScript without host tool bridges", async () => {
    const bash = createBashTool(scope);

    await expect(
      bash.execute({
        cmd: "python - <<'PY'\nprint('py:' + str(21 * 2))\nPY\njs-exec -c \"console.log('js:' + (20 + 2))\"",
      }),
    ).resolves.toMatchObject({
      stdout: "py:42\njs:22\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("validates cwd against mounted bash paths without rejecting rich shell syntax", async () => {
    await expect(
      validateBashCommand(scope, {
        cwd: "/mnt/scratch/own/",
        cmd: "echo ok | tr a-z A-Z && printf done",
      }),
    ).resolves.toBeUndefined();
    await expect(
      validateBashCommand(scope, {
        cwd: "/mnt/memory/workflow/",
        cmd: "echo ok",
      }),
    ).rejects.toThrow(/cwd must be inside a writable mount/u);
  });
});
