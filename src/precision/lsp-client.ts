import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CallHierarchyIncomingCallsRequest,
  CallHierarchyOutgoingCallsRequest,
  CallHierarchyPrepareRequest,
  createProtocolConnection,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidChangeWatchedFilesNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  FileChangeType,
  DocumentSymbolRequest,
  ExitNotification,
  ImplementationRequest,
  InitializedNotification,
  InitializeRequest,
  ReferencesRequest,
  ResponseError,
  ShutdownRequest,
  StreamMessageReader,
  StreamMessageWriter,
  type DocumentSymbol,
  type Location,
  type LocationLink,
  type ProtocolConnection,
  type ServerCapabilities,
  type SymbolInformation,
} from 'vscode-languageserver-protocol/node';

/** A place in a repo: repo-relative file, 0-based line and character. */
export type Position = { file: string; line: number; character: number };

/**
 * A span in a repo, 0-based and end-inclusive on lines. `nameLine` and
 * `nameColumn` place the declared name when the server tells it apart from
 * the span.
 */
export type Span = { file: string; startLine: number; endLine: number; nameLine: number; nameColumn: number };

const languageIds: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.dart': 'dart',
};

/**
 * A language server over stdio, spoken to in repo-relative paths. Files are
 * opened on first use, since servers answer for open documents.
 */
export class LspClient {
  // Each file's didOpen, so concurrent requests all wait until it is sent.
  private readonly opened = new Map<string, Promise<void>>();
  private readonly versions = new Map<string, number>();
  private readonly root: string;
  private readonly process: ChildProcess;
  private readonly connection: ProtocolConnection;
  private readonly capabilities: ServerCapabilities;

  private constructor(root: string, process: ChildProcess, connection: ProtocolConnection, capabilities: ServerCapabilities) {
    this.root = root;
    this.process = process;
    this.connection = connection;
    this.capabilities = capabilities;
  }

  /** Starts [command] in [root] and completes the initialize handshake. */
  static async start(command: string, args: string[], root: string): Promise<LspClient> {
    const child = spawn(command, args, { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
    if (!child.stdout || !child.stdin) throw new Error(`${command} has no stdio`);
    const connection = createProtocolConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    connection.listen();
    const rootUri = pathToFileURL(root).href;
    const { capabilities } = await connection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
      capabilities: {
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          references: {},
          definition: { linkSupport: true },
          callHierarchy: {},
          implementation: { linkSupport: true },
        },
      },
    });
    await connection.sendNotification(InitializedNotification.type, {});
    return new LspClient(root, child, connection, capabilities);
  }

  /**
   * Tells the server [file] changed on disk (or is gone, when it cannot be
   * read): an open document gets its new text, and the server hears of the
   * file either way.
   */
  async changed(file: string): Promise<void> {
    const uri = this.uri(file);
    const text = await readFile(join(this.root, file), 'utf8').catch(() => undefined);
    const opening = this.opened.get(file);
    if (opening) {
      await opening;
      if (text === undefined) {
        this.opened.delete(file);
        await this.connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
      } else {
        const version = (this.versions.get(file) ?? 1) + 1;
        this.versions.set(file, version);
        await this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        });
      }
    }
    const type = text === undefined ? FileChangeType.Deleted : FileChangeType.Changed;
    await this.connection.sendNotification(DidChangeWatchedFilesNotification.type, { changes: [{ uri, type }] });
  }

  /** Opens [file] in the server unless it already is. */
  open(file: string): Promise<void> {
    let opening = this.opened.get(file);
    if (!opening) {
      opening = (async () => {
        await this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: {
            uri: this.uri(file),
            languageId: languageIds[extname(file)] ?? 'plaintext',
            version: 1,
            text: await readFile(join(this.root, file), 'utf8'),
          },
        });
      })();
      this.opened.set(file, opening);
    }
    return opening;
  }

  /** The symbols declared in [file], nested as the server reports them. */
  async documentSymbols(file: string): Promise<DocumentSymbol[]> {
    await this.open(file);
    const symbols = await answerOrNone(
      this.connection.sendRequest(DocumentSymbolRequest.type, { textDocument: { uri: this.uri(file) } }),
    );
    // A server without hierarchy support answers flat; nothing here needs that.
    return (symbols ?? []).filter((s): s is DocumentSymbol => !isFlat(s));
  }

  /** Every reference to the symbol at [at], without its declaration. */
  async references(at: Position): Promise<Span[]> {
    await this.open(at.file);
    const locations = await answerOrNone(
      this.connection.sendRequest(ReferencesRequest.type, {
        textDocument: { uri: this.uri(at.file) },
        position: { line: at.line, character: at.character },
        context: { includeDeclaration: false },
      }),
    );
    return (locations ?? []).flatMap((loc) => this.span(loc));
  }

  /** Where the symbol at [at] is declared. */
  async definition(at: Position): Promise<Span[]> {
    await this.open(at.file);
    const result = await answerOrNone(
      this.connection.sendRequest(DefinitionRequest.type, {
        textDocument: { uri: this.uri(at.file) },
        position: { line: at.line, character: at.character },
      }),
    );
    const list: (Location | LocationLink)[] = Array.isArray(result) ? result : result ? [result] : [];
    return list.flatMap((loc) => this.span(loc));
  }

  /** The declarations that implement or override the one at [at]; none when the server cannot tell. */
  async implementations(at: Position): Promise<Span[]> {
    if (!this.capabilities.implementationProvider) return [];
    await this.open(at.file);
    const result = await answerOrNone(
      this.connection.sendRequest(ImplementationRequest.type, {
        textDocument: { uri: this.uri(at.file) },
        position: { line: at.line, character: at.character },
      }),
    );
    const list: (Location | LocationLink)[] = Array.isArray(result) ? result : result ? [result] : [];
    return list.flatMap((loc) => this.span(loc));
  }

  /**
   * The functions that call the symbol at [at] (`in`), or that it calls
   * (`out`), as the server's call hierarchy gives them: each caller's or
   * callee's declaration, and the places the calls are written.
   */
  async calls(at: Position, direction: 'in' | 'out'): Promise<(Span & { sites: Position[] })[]> {
    await this.open(at.file);
    const position = { line: at.line, character: at.character };
    const items = await answerOrNone(
      this.connection.sendRequest(CallHierarchyPrepareRequest.type, { textDocument: { uri: this.uri(at.file) }, position }),
    );
    const found: (Span & { sites: Position[] })[] = [];
    for (const item of items ?? []) {
      const others =
        direction === 'in'
          ? (await answerOrNone(this.connection.sendRequest(CallHierarchyIncomingCallsRequest.type, { item })))?.map(
              (c) => ({ other: c.from, ranges: c.fromRanges }),
            )
          : (await answerOrNone(this.connection.sendRequest(CallHierarchyOutgoingCallsRequest.type, { item })))?.map(
              (c) => ({ other: c.to, ranges: c.fromRanges }),
            );
      for (const { other, ranges } of others ?? []) {
        const [span] = this.span({ targetUri: other.uri, targetRange: other.range, targetSelectionRange: other.selectionRange });
        // Calls in come from the caller's file; calls out sit in the asked-about file.
        const siteFile = direction === 'in' ? span?.file : at.file;
        if (span && siteFile) {
          found.push({ ...span, sites: ranges.map((r) => ({ file: siteFile, line: r.start.line, character: r.start.character })) });
        }
      }
    }
    return found;
  }

  async stop(): Promise<void> {
    const polite = (async () => {
      await this.connection.sendRequest(ShutdownRequest.type);
      await this.connection.sendNotification(ExitNotification.type);
    })();
    // A server that never answers the shutdown is killed after two seconds.
    let timer: NodeJS.Timeout | undefined;
    const patience = new Promise<void>((done) => {
      timer = setTimeout(done, 2000);
    });
    try {
      await Promise.race([polite.catch(() => {}), patience]);
    } finally {
      clearTimeout(timer);
      this.connection.dispose();
      this.process.kill();
    }
  }

  private uri(file: string): string {
    return pathToFileURL(join(this.root, file)).href;
  }

  // Locations outside the repo (node_modules, the standard library) are
  // left out: an answer always names a repo file.
  private span(loc: Location | LocationLink): Span[] {
    const uri = 'targetUri' in loc ? loc.targetUri : loc.uri;
    const range = 'targetRange' in loc ? loc.targetRange : loc.range;
    const name = 'targetSelectionRange' in loc ? loc.targetSelectionRange : loc.range;
    if (!uri.startsWith('file:')) return [];
    const file = relative(this.root, fileURLToPath(uri));
    if (file.startsWith('..') || file.split('/').includes('node_modules')) return [];
    return [
      {
        file,
        startLine: range.start.line,
        endLine: range.end.line,
        nameLine: name.start.line,
        nameColumn: name.start.character,
      },
    ];
  }
}

function isFlat(symbol: DocumentSymbol | SymbolInformation): symbol is SymbolInformation {
  return 'location' in symbol;
}

// A server can refuse one file (gopls for a file a build tag leaves out,
// say); that file then has no answer. Lost connections still throw.
async function answerOrNone<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof ResponseError) return null;
    throw error;
  }
}

