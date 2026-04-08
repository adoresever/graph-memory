import { describe, expect, it } from "vitest";

import {
  ReadonlySessionRegistry,
  isHelperSessionKey,
  isSubagentSessionKey,
} from "../src/session-policy.ts";

describe("subagent session detection", () => {
  it("detects OpenClaw subagent session keys", () => {
    expect(isSubagentSessionKey("agent:minimax-clerk:subagent:0cc464e3-3244-4443-9dbf-cea199b73abb")).toBe(true);
    expect(isSubagentSessionKey("subagent:one-shot")).toBe(true);
    expect(isSubagentSessionKey("agent:main:feishu:default:direct:ou_df0924becc2951992502da488004bf1d")).toBe(false);
    expect(isSubagentSessionKey("temp:slug-generator")).toBe(false);
  });
});

describe("helper session detection", () => {
  it("detects helper session keys", () => {
    expect(isHelperSessionKey("temp:slug-generator")).toBe(true);
    expect(isHelperSessionKey("slug-generator-1775243719190")).toBe(true);
    expect(isHelperSessionKey("slug-gen")).toBe(true);
    expect(isHelperSessionKey("agent:main:feishu:default:direct:ou_df0924becc2951992502da488004bf1d")).toBe(false);
  });
});

describe("readonly session registry", () => {
  it("tracks explicit readonly child sessions", () => {
    const registry = new ReadonlySessionRegistry();

    expect(registry.has("agent:main:task:1")).toBe(false);

    registry.markReadonly("agent:main:task:1");
    expect(registry.has("agent:main:task:1")).toBe(true);

    registry.clear("agent:main:task:1");
    expect(registry.has("agent:main:task:1")).toBe(false);
  });

  it("treats helper sessions as readonly by default", () => {
    const registry = new ReadonlySessionRegistry();

    expect(registry.has("temp:slug-generator")).toBe(true);
    expect(registry.has("slug-generator-1775243719190")).toBe(true);
    expect(registry.has("slug-gen")).toBe(true);
  });
});
