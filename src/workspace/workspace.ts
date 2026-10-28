import { SymbolIndex } from '../index/symbol-index.ts';
import { TsService } from '../precision/ts-service.ts';

/**
 * One workspace: its symbol index, built when opened, and the TypeScript
 * service, started the first time a tool needs the compiler.
 */
export class Workspace {
  readonly root: string;
  readonly index: SymbolIndex;
  private service: Promise<TsService> | undefined;

  private constructor(root: string, index: SymbolIndex) {
    this.root = root;
    this.index = index;
  }

  static async open(root: string): Promise<Workspace> {
    return new Workspace(root, await SymbolIndex.build(root));
  }

  ts(): Promise<TsService> {
    this.service ??= TsService.start(this.root);
    return this.service;
  }

  async close(): Promise<void> {
    const service = this.service;
    this.service = undefined;
    await (await service)?.stop();
  }
}
