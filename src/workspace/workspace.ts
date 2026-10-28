import { SymbolIndex } from '../index/symbol-index.ts';
import { LspService, serverFor } from '../precision/lsp-service.ts';

/**
 * One workspace: its symbol index, built when opened, and a language server
 * per language, each started the first time a tool needs it.
 */
export class Workspace {
  readonly root: string;
  readonly index: SymbolIndex;
  private readonly services = new Map<string, Promise<LspService | undefined>>();

  private constructor(root: string, index: SymbolIndex) {
    this.root = root;
    this.index = index;
  }

  static async open(root: string): Promise<Workspace> {
    return new Workspace(root, await SymbolIndex.build(root));
  }

  /** The language server for [file], or undefined when none is installed. */
  precision(file: string): Promise<LspService | undefined> {
    const spec = serverFor(file);
    if (!spec) return Promise.resolve(undefined);
    let service = this.services.get(spec.name);
    if (!service) {
      service = LspService.start(this.root, spec);
      this.services.set(spec.name, service);
    }
    return service;
  }

  async close(): Promise<void> {
    const services = [...this.services.values()];
    this.services.clear();
    for (const service of services) await (await service.catch(() => undefined))?.stop();
  }
}
