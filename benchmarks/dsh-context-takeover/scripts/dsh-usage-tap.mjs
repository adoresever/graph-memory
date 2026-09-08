import {appendFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export const name = 'benchmark-dsh-usage-tap';
export const inject = ['llm'];

let sequence = 0;

function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter(block => block?.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('\n');
}

function requestKind(options) {
  if (options.purpose === 'compaction') return 'compaction';
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const extractionTool = Array.isArray(options.tools)
    && options.tools.some(tool => ['submit_result', 'submit_graph_extraction'].includes(tool?.name));
  const pluginOnly = messages.length === 1
    && messages[0]?.source?.kind === 'plugin'
    && messages[0]?.source?.plugin === 'graph-memory';
  return extractionTool || pluginOnly ? 'graph-memory' : 'conversation';
}

export function apply(ctx) {
  const output = process.env.DSH_USAGE_TAP_FILE;
  if (!output) throw new Error('DSH_USAGE_TAP_FILE is required');
  mkdirSync(dirname(output), {recursive: true});

  ctx.on('llm/stream', function (options, next) {
    const startedAt = Date.now();
    const seq = ++sequence;
    const benchmarkTurn = (Array.isArray(options.messages) ? options.messages : [])
      .map(textOf)
      .join('\n')
      .match(/\[BENCHMARK_TURN=(T\d+)\]/)?.[1] ?? null;
    return (async function* measuredStream() {
      let usage;
      let finish;
      let error;
      try {
        for await (const chunk of next()) {
          if (chunk?.type === 'usage') usage = chunk.usage;
          if (chunk?.type === 'finish') finish = chunk.reason;
          yield chunk;
        }
      } catch (caught) {
        error = String(caught?.message ?? caught);
        throw caught;
      } finally {
        appendFileSync(output, `${JSON.stringify({
          seq,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          kind: requestKind(options),
          provider: options.provider,
          model: options.model,
          sessionId: options.sessionId ?? null,
          benchmarkTurn,
          messageCount: Array.isArray(options.messages) ? options.messages.length : 0,
          messageSources: Array.isArray(options.messages) ? options.messages.map(message => ({
            role: message?.role,
            kind: message?.source?.kind,
            plugin: message?.source?.plugin,
          })) : [],
          durationMs: Date.now() - startedAt,
          usage: usage ?? null,
          finish: finish ?? null,
          error: error ?? null,
        })}\n`);
      }
    })();
  }, {global: true, prepend: true});
}
