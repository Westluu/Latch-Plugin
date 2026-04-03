import * as vscode from "vscode";
import { ReviewCodeLensProvider } from "./codeLensProvider";
import { FileReviewController } from "./controller";
import { createFileReviewSession } from "./engine";
import {
  FileReviewSession,
  PendingReviewBlockView,
  ReviewBlock
} from "./types";

export class ReviewSessionManager implements vscode.Disposable {
  private readonly controllers = new Map<string, FileReviewController>();
  private readonly codeLensProvider: ReviewCodeLensProvider;
  private readonly onDidChangeSessionsEmitter = new vscode.EventEmitter<void>();

  public readonly onDidChangeSessions = this.onDidChangeSessionsEmitter.event;

  public constructor() {
    this.codeLensProvider = new ReviewCodeLensProvider(this);
  }

  public dispose(): void {
    for (const controller of this.controllers.values()) {
      controller.clearDecorations();
      controller.dispose();
    }
    this.controllers.clear();
    this.onDidChangeSessionsEmitter.dispose();
    this.updateContextKey();
  }

  public getSessions(): FileReviewSession[] {
    return [...this.controllers.values()]
      .map((controller) => controller.session)
      .sort((left, right) => left.uri.fsPath.localeCompare(right.uri.fsPath));
  }

  public getSession(uri: vscode.Uri): FileReviewSession | undefined {
    return this.controllers.get(uri.toString())?.session;
  }

  public getSessionById(sessionId?: string): FileReviewSession | undefined {
    if (!sessionId) {
      return undefined;
    }

    for (const controller of this.controllers.values()) {
      if (controller.session.id === sessionId) {
        return controller.session;
      }
    }

    return undefined;
  }

  public async getPendingViews(
    session: FileReviewSession,
    document: vscode.TextDocument
  ): Promise<PendingReviewBlockView[]> {
    const controller = this.controllers.get(session.uri.toString());
    if (!controller) {
      return [];
    }

    return controller.getPendingViews(document);
  }

  public async startReview(
    editor: vscode.TextEditor,
    workingText: string,
    reviewBlocks: ReviewBlock[]
  ): Promise<void> {
    const session = createFileReviewSession(editor, workingText, reviewBlocks);
    if (!session) {
      void vscode.window.showInformationMessage(
        "The active file matches HEAD. Nothing to review."
      );
      return;
    }

    this.replaceController(
      new FileReviewController(
        session,
        () => this.refreshState(),
        (uri) => this.handleControllerClosed(uri)
      )
    );
    await this.controllers.get(session.uri.toString())?.initializeReview();
    void vscode.window.showInformationMessage("Latch review started.");
  }

  public async acceptDiff(sessionId?: string, blockId?: string): Promise<void> {
    const controller = this.resolveController(sessionId);
    if (!controller) {
      return;
    }

    await controller.acceptDiff(blockId);
  }

  public async rejectDiff(sessionId?: string, blockId?: string): Promise<void> {
    const controller = this.resolveController(sessionId);
    if (!controller) {
      return;
    }

    await controller.rejectDiff(blockId);
  }

  public async acceptAllDiffs(sessionId?: string): Promise<void> {
    const controller = this.resolveController(sessionId);
    if (!controller) {
      return;
    }

    await controller.acceptAllDiffs();
  }

  public async rejectAllDiffs(sessionId?: string): Promise<void> {
    const controller = this.resolveController(sessionId);
    if (!controller) {
      return;
    }

    await controller.rejectAllDiffs();
  }

  public async previewInlineDiff(
    sessionId?: string,
    blockId?: string
  ): Promise<void> {
    const controller = this.resolveController(sessionId);
    if (!controller) {
      return;
    }

    await controller.previewInlineDiff(blockId);
  }

  public async revealSession(sessionId?: string): Promise<void> {
    const controller = this.resolveController(sessionId);
    if (!controller) {
      return;
    }

    await controller.reveal();
  }

  public async revealBlock(
    sessionId?: string,
    blockId?: string
  ): Promise<void> {
    const controller = this.resolveController(sessionId);
    if (!controller) {
      return;
    }

    await controller.reveal(blockId);
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

  private async handleDocumentChange(
    event: vscode.TextDocumentChangeEvent
  ): Promise<void> {
    const controller = this.controllers.get(event.document.uri.toString());
    if (!controller) {
      return;
    }

    await controller.handleDocumentChange(event);
  }

  private refreshAllDecorations(): void {
    for (const controller of this.controllers.values()) {
      controller.refresh();
    }
  }

  private replaceController(controller: FileReviewController): void {
    const existing = this.controllers.get(controller.session.uri.toString());
    if (existing) {
      existing.clearDecorations();
      existing.dispose();
      this.controllers.delete(controller.session.uri.toString());
    }

    this.controllers.set(controller.session.uri.toString(), controller);
    this.refreshState();
  }

  private handleControllerClosed(uri: vscode.Uri): void {
    const existing = this.controllers.get(uri.toString());
    if (!existing) {
      return;
    }

    existing.dispose();
    this.controllers.delete(uri.toString());
    this.refreshState();
  }

  private resolveController(sessionId?: string): FileReviewController | undefined {
    if (sessionId) {
      for (const controller of this.controllers.values()) {
        if (controller.session.id === sessionId) {
          return controller;
        }
      }
      return undefined;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      return undefined;
    }

    return this.controllers.get(activeEditor.document.uri.toString());
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
      this.controllers.size > 0
    );
  }
}
