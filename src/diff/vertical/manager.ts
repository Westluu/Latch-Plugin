import * as vscode from "vscode";
import { VerticalDiffCodeLensProvider } from "./codeLensProvider";
import {
  createDocumentReviewSession,
  VerticalDiffHandler
} from "./handler";
import {
  PendingVerticalDiffBlock,
  VerticalDiffBlock,
  VerticalDiffSession
} from "./types";

export class VerticalDiffManager implements vscode.Disposable {
  private readonly handlers = new Map<string, VerticalDiffHandler>();
  private readonly codeLensProvider: VerticalDiffCodeLensProvider;
  private readonly onDidChangeSessionsEmitter = new vscode.EventEmitter<void>();

  public readonly onDidChangeSessions = this.onDidChangeSessionsEmitter.event;

  public constructor() {
    this.codeLensProvider = new VerticalDiffCodeLensProvider(this);
  }

  public dispose(): void {
    for (const handler of this.handlers.values()) {
      handler.clearDecorations();
      handler.dispose();
    }
    this.handlers.clear();
    this.onDidChangeSessionsEmitter.dispose();
    this.updateContextKey();
  }

  public getSessions(): VerticalDiffSession[] {
    return [...this.handlers.values()]
      .map((handler) => handler.session)
      .sort((left, right) => left.uri.fsPath.localeCompare(right.uri.fsPath));
  }

  public getSession(uri: vscode.Uri): VerticalDiffSession | undefined {
    return this.handlers.get(uri.toString())?.session;
  }

  public getSessionById(sessionId?: string): VerticalDiffSession | undefined {
    if (!sessionId) {
      return undefined;
    }

    for (const handler of this.handlers.values()) {
      if (handler.session.id === sessionId) {
        return handler.session;
      }
    }

    return undefined;
  }

  public async getPendingViews(
    session: VerticalDiffSession,
    document: vscode.TextDocument
  ): Promise<PendingVerticalDiffBlock[]> {
    const handler = this.handlers.get(session.uri.toString());
    if (!handler) {
      return [];
    }

    return handler.getPendingViews(document);
  }

  public async startDocumentReview(
    editor: vscode.TextEditor,
    proposedText: string,
    reviewBlocks: VerticalDiffBlock[]
  ): Promise<void> {
    const session = createDocumentReviewSession(editor, proposedText, reviewBlocks);
    if (!session) {
      void vscode.window.showInformationMessage(
        "The active file matches HEAD. Nothing to review."
      );
      return;
    }

    this.replaceHandler(
      new VerticalDiffHandler(
        session,
        () => this.refreshState(),
        (uri) => this.handleHandlerClosed(uri)
      )
    );
    await this.handlers.get(session.uri.toString())?.initializeReview();
    void vscode.window.showInformationMessage("Latch review started.");
  }

  public async acceptDiff(sessionId?: string, hunkId?: string): Promise<void> {
    const handler = this.resolveHandler(sessionId);
    if (!handler) {
      return;
    }

    await handler.acceptDiff(hunkId);
  }

  public async rejectDiff(sessionId?: string, hunkId?: string): Promise<void> {
    const handler = this.resolveHandler(sessionId);
    if (!handler) {
      return;
    }

    await handler.rejectDiff(hunkId);
  }

  public async acceptAllDiffs(sessionId?: string): Promise<void> {
    const handler = this.resolveHandler(sessionId);
    if (!handler) {
      return;
    }

    await handler.acceptAllDiffs();
  }

  public async rejectAllDiffs(sessionId?: string): Promise<void> {
    const handler = this.resolveHandler(sessionId);
    if (!handler) {
      return;
    }

    await handler.rejectAllDiffs();
  }

  public async previewInlineDiff(
    sessionId?: string,
    hunkId?: string
  ): Promise<void> {
    const handler = this.resolveHandler(sessionId);
    if (!handler) {
      return;
    }

    await handler.previewInlineDiff(hunkId);
  }

  public async revealSession(sessionId?: string): Promise<void> {
    const handler = this.resolveHandler(sessionId);
    if (!handler) {
      return;
    }

    await handler.reveal();
  }

  public async revealBlock(
    sessionId?: string,
    blockId?: string
  ): Promise<void> {
    const handler = this.resolveHandler(sessionId);
    if (!handler) {
      return;
    }

    await handler.reveal(blockId);
  }

  private async handleDocumentChange(
    event: vscode.TextDocumentChangeEvent
  ): Promise<void> {
    const handler = this.handlers.get(event.document.uri.toString());
    if (!handler) {
      return;
    }

    await handler.handleDocumentChange(event);
  }

  private refreshAllDecorations(): void {
    for (const handler of this.handlers.values()) {
      handler.refresh();
    }
  }

  private replaceHandler(handler: VerticalDiffHandler): void {
    const existing = this.handlers.get(handler.session.uri.toString());
    if (existing) {
      existing.clearDecorations();
      existing.dispose();
      this.handlers.delete(handler.session.uri.toString());
    }

    this.handlers.set(handler.session.uri.toString(), handler);
    this.refreshState();
  }

  public register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this,
      this.codeLensProvider,
      vscode.languages.registerCodeLensProvider(
        { scheme: "*", language: "*" },
        this.codeLensProvider
      ),
      vscode.workspace.onDidChangeTextDocument((event) => {
        void this.handleDocumentChange(event);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.refreshAllDecorations();
      })
    );
  }

  private handleHandlerClosed(uri: vscode.Uri): void {
    const existing = this.handlers.get(uri.toString());
    if (!existing) {
      return;
    }

    existing.dispose();
    this.handlers.delete(uri.toString());
    this.refreshState();
  }

  private resolveHandler(sessionId?: string): VerticalDiffHandler | undefined {
    if (sessionId) {
      for (const handler of this.handlers.values()) {
        if (handler.session.id === sessionId) {
          return handler;
        }
      }
      return undefined;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      return undefined;
    }

    return this.handlers.get(activeEditor.document.uri.toString());
  }

  private refreshState(): void {
    this.updateContextKey();
    this.codeLensProvider.refresh();
    this.onDidChangeSessionsEmitter.fire();
  }

  private updateContextKey(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "latch.hasActiveInlineReview",
      this.handlers.size > 0
    );
  }
}
