import { describe, expect, it } from "vitest";

import { contributePromptDataContext } from "../src/format/prompt-data.ts";

describe("prompt data contribution", () => {
  it("keeps recalled template syntax out of template source without changing data", () => {
    const memory = [
      "Vue {{ cardReading.positionMeaning }}",
      "Handlebars {{{ rawHtml }}}",
      "GitHub Actions ${{ matrix.target }}",
      "registered-looking {{query}} is still historical data",
    ].join("\n");
    const assembly = {
      contexts: [] as Array<{ name: string; text: string }>,
      variables: { query: "current user query" } as Record<string, string | undefined>,
    };

    const variableName = contributePromptDataContext(assembly, {
      name: "graph-memory:recall",
      text: memory,
    });

    expect(variableName).toBe("graph_memory_context_data");
    expect(assembly.contexts).toEqual([{
      name: "graph-memory:recall",
      text: "{{graph_memory_context_data}}",
    }]);
    expect(assembly.variables.graph_memory_context_data).toBe(memory);
  });

  it("does not overwrite another prompt provider's variable", () => {
    const assembly = {
      contexts: [] as Array<{ name: string; text: string }>,
      variables: {
        graph_memory_context_data: "owned elsewhere",
        graph_memory_context_data_2: "also occupied",
      } as Record<string, string | undefined>,
    };

    expect(contributePromptDataContext(assembly, {
      name: "graph-memory:recall",
      text: "exact memory",
    })).toBe("graph_memory_context_data_3");
    expect(assembly.variables.graph_memory_context_data).toBe("owned elsewhere");
    expect(assembly.variables.graph_memory_context_data_3).toBe("exact memory");
  });

  it("rejects invalid plugin-controlled variable names", () => {
    expect(() => contributePromptDataContext({ contexts: [], variables: {} }, {
      name: "graph-memory:recall",
      text: "memory",
      variableBase: "Graph-Memory",
    })).toThrow(/invalid prompt data variable base/);
  });
});
