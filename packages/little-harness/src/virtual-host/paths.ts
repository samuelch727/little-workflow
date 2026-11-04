import type { IFileSystem } from "just-bash";

/** Host-owned storage for localDir folders, outside the agent's workspace. */
export type VirtualHostPaths = {
  kind: "virtual";
  dataFs: IFileSystem;
  dataRoot: string;
};
