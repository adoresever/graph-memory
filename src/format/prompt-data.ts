/**
 * Safe boundary for contributing dynamic data to a one-pass prompt template.
 *
 * DeepSeek Harness interpolates `{{variable}}` references in context text, but
 * deliberately does not scan substituted variable values again. Historical
 * memory can therefore remain byte-for-byte intact when the context contains
 * only a plugin-owned placeholder and the memory itself is stored as its value.
 */

export interface PromptDataAssembly {
  contexts: Array<{ name: string; text: string }>;
  variables: Record<string, string | undefined>;
}

export interface PromptDataContribution {
  name: string;
  text: string;
  variableBase?: string;
}

const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;
const DEFAULT_VARIABLE_BASE = "graph_memory_context_data";

/**
 * Append exact data through a unique prompt variable instead of placing
 * untrusted text in the host's template source.
 *
 * The returned name is useful for diagnostics and tests. Existing variables
 * are never overwritten; a deterministic suffix is allocated on collision.
 */
export function contributePromptDataContext(
  assembly: PromptDataAssembly,
  contribution: PromptDataContribution,
): string | null {
  if (!contribution.text) return null;

  const base = contribution.variableBase ?? DEFAULT_VARIABLE_BASE;
  if (!VARIABLE_NAME.test(base)) {
    throw new TypeError(`invalid prompt data variable base: ${JSON.stringify(base)}`);
  }

  let variableName = base;
  let suffix = 2;
  while (Object.hasOwn(assembly.variables, variableName)) {
    variableName = `${base}_${suffix}`;
    suffix += 1;
  }

  assembly.variables[variableName] = contribution.text;
  assembly.contexts.push({
    name: contribution.name,
    text: `{{${variableName}}}`,
  });
  return variableName;
}
