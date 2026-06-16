import test from "node:test";
import assert from "node:assert/strict";
import { assertValidLwir } from "little-workflow";
import { buildInvestorWorkflowLwir } from "./workflow-lwir.mjs";

test("investor workflow LWIR grants only the unzip-backed data tool and worker model", () => {
  const lwir = buildInvestorWorkflowLwir({
    workflowName: "demo.sp500.investor.report",
  });

  assert.doesNotThrow(() => assertValidLwir(lwir));
  assert.deepEqual(lwir.permissions.tools, ["sp500.unzip_company_dossiers"]);
  assert.deepEqual(lwir.permissions.models, ["model.worker"]);
  assert.equal(lwir.output.schema.type, "string");
  assert.equal(lwir.steps[0].uses, "tool.call");
  assert.equal(lwir.steps[0].with.tool, "sp500.unzip_company_dossiers");
  assert.equal(lwir.steps[1].uses, "parallel");
  assert.equal(lwir.steps[1].with.maxBranches, 50);
  assert.equal(lwir.steps[2].uses, "ai.generate");
  assert.equal(lwir.steps[2].output.mode, "text");
});
