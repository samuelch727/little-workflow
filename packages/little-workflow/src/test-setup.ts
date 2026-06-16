import { afterEach } from "vitest";
import { closeEventStoresForTest } from "./world.js";

afterEach(() => {
  closeEventStoresForTest();
});
