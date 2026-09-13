import { describe, test, expect } from "bun:test";
import { buildWorkerWarning } from "../src/pi/index.js";

describe("buildWorkerWarning", () => {
  test("默认关闭返回 null", () => {
    delete process.env.GIT_SAFETY_GUARD_WORKER_DETECT;
    expect(buildWorkerWarning()).toBeNull();
  });
});
