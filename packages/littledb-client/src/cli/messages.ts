import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

/** A copyable command for the same installed package, never the unrelated unscoped package. */
export function commandHint(command: string, legacy = false): string {
  const executable = legacy
    ? "littledb-agents"
    : process.env.npm_command === "dlx"
      ? `pnpm dlx @little-stack/littledb@${version}`
      : process.env.npm_command === "exec"
        ? `npx @little-stack/littledb@${version}`
        : "littledb";
  return `${executable} ${command}`;
}
