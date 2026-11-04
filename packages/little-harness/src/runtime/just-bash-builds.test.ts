import { getCommandNames, getJavaScriptCommandNames, getPythonCommandNames } from "just-bash";
import { describe, expect, it } from "vitest";
import { JUST_BASH_NODE_ONLY_COMMANDS } from "./just-bash-builds.js";

describe("just-bash's browser build", () => {
  it("cannot run exactly the commands pinned as Node-only", async () => {
    const browser = await import("just-bash/browser");
    const bash = new browser.Bash();
    const missing: string[] = [];
    for (const name of new Set([...getCommandNames(), ...getPythonCommandNames(), ...getJavaScriptCommandNames()])) {
      if ((await bash.exec(`command -v ${name}`)).exitCode !== 0) {
        missing.push(name);
      }
    }
    expect(missing.sort()).toEqual([...JUST_BASH_NODE_ONLY_COMMANDS].sort());
  });
});
