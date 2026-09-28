declare module "@deepseek-ai/dsh-typert-protocol" {
  export abstract class TypertRemoteService {
    protected constructor(ctx: unknown, serviceKey: string, options?: { namespace?: string });
  }

  export function Remote(exportName?: string): (
    method: (...args: any[]) => any,
    context: ClassMethodDecoratorContext,
  ) => void;
}
