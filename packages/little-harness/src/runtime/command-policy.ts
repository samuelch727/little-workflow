import type { BashOptions } from "just-bash";
import { justBashNodeExport } from "./just-bash-builds.js";

// Private transport between tieredSandbox and the bundled tier-0 adapters. No public
// runtime option: custom adapters remain responsible for their own execution policy.
const policyKey = Symbol("tier0DeniedCommands");
type PolicyCarrier = { [policyKey]?: readonly string[] };
export function setTier0DeniedCommands(options: object, denied: readonly string[]): void {
  Object.defineProperty(options, policyKey, { value: [...denied], enumerable: true, configurable: true });
}
export function tier0DeniedCommands(options: object): readonly string[] | undefined {
  return (options as PolicyCarrier)[policyKey];
}
export function restrictTier0Commands(options: BashOptions, denied: readonly string[] | undefined): BashOptions {
  if (!denied?.length) return options;
  const getNames = justBashNodeExport("getCommandNames");
  if (!getNames) throw new Error("Tier-0 command policy needs the just-bash command registry");
  const names = [
    ...getNames(),
    ...(justBashNodeExport("getNetworkCommandNames")?.() ?? []),
    ...(justBashNodeExport("getPythonCommandNames")?.() ?? []),
    ...(justBashNodeExport("getJavaScriptCommandNames")?.() ?? []),
  ];
  return { ...options, commands: names.filter(name => !denied.includes(name)) as NonNullable<BashOptions["commands"]> };
}
