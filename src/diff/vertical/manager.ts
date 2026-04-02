import * as vscode from "vscode";
import { diffLines, type Change } from "diff";
import { VerticalDiffCodeLensProvider } from "./codeLensProvider";
import {
  PendingVerticalDiffBlock,
  VerticalDiffHunk,
  VerticalDiffSession
} from "./types";

const MAX_PREVIEW_WIDTH = 120;

function makePreview(text: string): string {
  const collapsed = text
    .replace(/\r?\n/g, " \\n ")
    .replace(/\s+/g, " ")
    .trim();

  if (!collapsed) {
    return "+ <empty>";
  }

  if (collapsed.length <= MAX_PREVIEW_WIDTH) {
    return `+ ${collapsed}`;
  }

  return `+ ${collapsed.slice(0, MAX_PREVIEW_WIDTH - 1)}…`;
}

function buildHunks(
  originalText: string,
  proposedText: string
): VerticalDiffHunk[] {
  const changes = diffLines(originalText, proposedText, {
    newlineIsToken: true
  });

  const hunks: VerticalDiffHunk[] = [];
  let originalOffset = 0;
  let hunkIndex = 0;

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];

    if (!change.added && !change.removed) {
      originalOffset += change.value.length;
      continue;
    }

    const start = originalOffset;
    let removedText = "";
    let addedText = "";

    while (index < changes.length) {
      const current: Change = changes[index];

      if (!current.added && !current.removed) {
        break;
      }

      if (current.removed) {
        removedText += current.value;
        originalOffset += current.value.length;
      } else if (current.added) {
        addedText += current.value;
      }

      index += 1;
    }

    index -= 1;
    hunks.push({
      id: `hunk-${hunkIndex}`,
      originalStart: start,
      originalEnd: originalOffset,
      originalText: removedText,
      proposedText: addedText,
      status: "pending"
    });
    hunkIndex += 1;
  }

  return hunks;
}

function renderTextForStatuses(session: VerticalDiffSession): string {
  let cursor = 0;
  let output = "";

  for (const hunk of session.hunks) {
    output += session.originalText.slice(cursor, hunk.originalStart);

    if (hunk.status === "accepted") {
      output += hunk.proposedText;
    } else {
      output += session.originalText.slice(hunk.originalStart, hunk.originalEnd);
    }

    cursor = hunk.originalEnd;
  }

  output += session.originalText.slice(cursor);
  return output;
}

function hasPendingHunks(session: VerticalDiffSession): boolean {
  return session.hunks.some((hunk) => hunk.status === "pending");
}

function describePendingHunks(
  session: VerticalDiffSession,
  document: vscode.TextDocument
): PendingVerticalDiffBlock[] {
  const views: PendingVerticalDiffBlock[] = [];
  let originalCursor = 0;
  let currentOffset = 0;

  for (const hunk of session.hunks) {
    const unchanged = session.originalText.slice(originalCursor, hunk.originalStart);
    currentOffset += unchanged.length;

    const originalSegment = session.originalText.slice(
      hunk.originalStart,
      hunk.originalEnd
    );
    const startOffset = session.selectionAnchorOffset + currentOffset;

    if (hunk.status === "pending") {
      const endOffset = startOffset + originalSegment.length;
      views.push({
        hunk,
        range: new vscode.Range(
          document.positionAt(startOffset),
          document.positionAt(endOffset)
        ),
        previewText: makePreview(hunk.proposedText)
      });
    }

    currentOffset +=
      hunk.status === "accepted" ? hunk.proposedText.length : originalSegment.length;
    originalCursor = hunk.originalEnd;
  }

  return views;
}

export class VerticalDiffManager implements vscode.Disposable {
  private readonly sessions = new Map<string, VerticalDiffSession>();
  private readonly applyingSessionIds = new Set<string>();
  private readonly removedDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
    border: "1px solid",
    borderColor: new vscode.ThemeColor("diffEditor.removedLineBackground")
  });
  private readonly insertedPreviewDecoration =
    vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
        margin: "0 0 0 1rem"
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
  private readonly codeLensProvider: VerticalDiffCodeLensProvider;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.codeLensProvider = new VerticalDiffCodeLensProvider(this);

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

  public dispose(): void {
    this.sessions.clear();
    this.removedDecoration.dispose();
    this.insertedPreviewDecoration.dispose();
    this.updateContextKey();
  }

  public getSession(uri: vscode.Uri): VerticalDiffSession | undefined {
    return this.sessions.get(uri.toString());
  }

  public getSessionById(sessionId?: string): VerticalDiffSession | undefined {
    if (!sessionId) {
      return undefined;
    }

    for (const session of this.sessions.values()) {
      if (session.id === sessionId) {
        return session;
      }
    }

    return undefined;
  }

  public getPendingViews(
    session: VerticalDiffSession,
    document: vscode.TextDocument
  ): PendingVerticalDiffBlock[] {
    return describePendingHunks(session, document);
  }

  public async startReview(
    editor: vscode.TextEditor,
    proposedText: string
  ): Promise<void> {
    const originalText = editor.document.getText(editor.selection);

    const hunks = buildHunks(originalText, proposedText);
    if (hunks.length === 0) {
      void vscode.window.showInformationMessage(
        "The clipboard text matches the selection. Nothing to review."
      );
      return;
    }

    const session: VerticalDiffSession = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      uri: editor.document.uri,
      languageId: editor.document.languageId,
      selectionAnchorOffset: editor.document.offsetAt(editor.selection.start),
      originalText,
      proposedText,
      currentText: originalText,
      hunks
    };

    this.sessions.set(session.uri.toString(), session);
    this.refreshSession(session);
    void vscode.window.showInformationMessage(
      `Latch review started with ${hunks.length} pending change${
        hunks.length === 1 ? "" : "s"
      }.`
    );
  }

  public async acceptDiff(sessionId?: string, hunkId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    if (!session) {
      return;
    }

    const target = await this.resolveTargetHunk(session, hunkId);
    if (!target) {
      return;
    }

    target.status = "accepted";
    await this.commitSessionUpdate(session);
  }

  public async rejectDiff(sessionId?: string, hunkId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    if (!session) {
      return;
    }

    const target = await this.resolveTargetHunk(session, hunkId);
    if (!target) {
      return;
    }

    target.status = "rejected";
    await this.commitSessionUpdate(session);
  }

  public async acceptAllDiffs(sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    if (!session) {
      return;
    }

    session.hunks.forEach((hunk) => {
      if (hunk.status === "pending") {
        hunk.status = "accepted";
      }
    });
    await this.commitSessionUpdate(session);
  }

  public async rejectAllDiffs(sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    if (!session) {
      return;
    }

    session.hunks.forEach((hunk) => {
      if (hunk.status === "pending") {
        hunk.status = "rejected";
      }
    });
    await this.commitSessionUpdate(session);
  }

  public async previewInlineDiff(
    sessionId?: string,
    hunkId?: string
  ): Promise<void> {
    const session = this.resolveSession(sessionId);
    if (!session) {
      return;
    }

    const hunk = hunkId
      ? session.hunks.find((item) => item.id === hunkId)
      : undefined;

    const originalText = hunk ? hunk.originalText : session.originalText;
    const proposedText = hunk ? hunk.proposedText : session.proposedText;
    const title = hunk
      ? `Latch Preview: ${session.uri.path.split("/").pop()} (${hunk.id})`
      : `Latch Preview: ${session.uri.path.split("/").pop()}`;

    const [left, right] = await Promise.all([
      vscode.workspace.openTextDocument({
        content: originalText,
        language: session.languageId
      }),
      vscode.workspace.openTextDocument({
        content: proposedText,
        language: session.languageId
      })
    ]);

    await vscode.commands.executeCommand(
      "vscode.diff",
      left.uri,
      right.uri,
      title,
      { preview: true }
    );
  }

  private async commitSessionUpdate(session: VerticalDiffSession): Promise<void> {
    const editor = await this.ensureEditor(session);
    if (!editor) {
      return;
    }

    const nextText = renderTextForStatuses(session);
    const start = editor.document.positionAt(session.selectionAnchorOffset);
    const end = editor.document.positionAt(
      session.selectionAnchorOffset + session.currentText.length
    );

    if (nextText !== session.currentText) {
      this.applyingSessionIds.add(session.id);

      try {
        const applied = await editor.edit((builder) => {
          builder.replace(new vscode.Range(start, end), nextText);
        });

        if (!applied) {
          throw new Error("VS Code rejected the edit.");
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Unable to apply inline diff: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return;
      } finally {
        this.applyingSessionIds.delete(session.id);
      }
    }

    session.currentText = nextText;

    if (!hasPendingHunks(session)) {
      this.clearSession(session.uri);
      return;
    }

    this.refreshSession(session);
  }

  private async resolveTargetHunk(
    session: VerticalDiffSession,
    hunkId?: string
  ): Promise<VerticalDiffHunk | undefined> {
    if (hunkId) {
      return session.hunks.find(
        (candidate) => candidate.id === hunkId && candidate.status === "pending"
      );
    }

    const editor = await this.ensureEditor(session);
    if (!editor) {
      return undefined;
    }

    const pendingViews = this.getPendingViews(session, editor.document);
    if (pendingViews.length === 0) {
      return undefined;
    }

    const cursorLine = editor.selection.active.line;
    return (
      pendingViews.find(
        (view) =>
          view.range.start.line <= cursorLine && view.range.end.line >= cursorLine
      )?.hunk ?? pendingViews[0].hunk
    );
  }

  private resolveSession(sessionId?: string): VerticalDiffSession | undefined {
    if (sessionId) {
      return this.getSessionById(sessionId);
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      return undefined;
    }

    return this.getSession(activeEditor.document.uri);
  }

  private async ensureEditor(
    session: VerticalDiffSession
  ): Promise<vscode.TextEditor | undefined> {
    const visibleEditor = vscode.window.visibleTextEditors.find((editor) =>
      editor.document.uri.toString() === session.uri.toString()
    );

    if (visibleEditor) {
      return visibleEditor;
    }

    try {
      return await vscode.window.showTextDocument(session.uri, {
        preserveFocus: false,
        preview: false
      });
    } catch {
      void vscode.window.showWarningMessage(
        "The original editor is no longer available for this review session."
      );
      return undefined;
    }
  }

  private async handleDocumentChange(
    event: vscode.TextDocumentChangeEvent
  ): Promise<void> {
    const session = this.getSession(event.document.uri);
    if (!session) {
      return;
    }

    if (this.applyingSessionIds.has(session.id)) {
      this.refreshSession(session);
      return;
    }

    this.clearSession(event.document.uri);
    void vscode.window.showWarningMessage(
      "Latch inline review was closed because the document changed outside the review flow."
    );
  }

  private refreshSession(session: VerticalDiffSession): void {
    const editor = vscode.window.visibleTextEditors.find(
      (item) => item.document.uri.toString() === session.uri.toString()
    );

    if (!editor) {
      this.updateContextKey();
      this.codeLensProvider.refresh();
      return;
    }

    const pendingViews = this.getPendingViews(session, editor.document);

    editor.setDecorations(
      this.removedDecoration,
      pendingViews
        .filter((view) => !view.range.isEmpty)
        .map((view) => view.range)
    );

    editor.setDecorations(
      this.insertedPreviewDecoration,
      pendingViews.map((view) => ({
        range: new vscode.Range(view.range.start, view.range.start),
        renderOptions: {
          after: {
            contentText: view.previewText
          }
        },
        hoverMessage: new vscode.MarkdownString(
          ["**Proposed change**", "```", view.hunk.proposedText || "<empty>", "```"].join(
            "\n"
          )
        )
      }))
    );

    this.updateContextKey();
    this.codeLensProvider.refresh();
  }

  private refreshAllDecorations(): void {
    for (const session of this.sessions.values()) {
      this.refreshSession(session);
    }
  }

  private clearSession(uri: vscode.Uri): void {
    const session = this.sessions.get(uri.toString());
    if (!session) {
      return;
    }

    this.sessions.delete(uri.toString());

    const editor = vscode.window.visibleTextEditors.find(
      (item) => item.document.uri.toString() === uri.toString()
    );

    if (editor) {
      editor.setDecorations(this.removedDecoration, []);
      editor.setDecorations(this.insertedPreviewDecoration, []);
    }

    this.updateContextKey();
    this.codeLensProvider.refresh();
  }

  private updateContextKey(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "latch.hasActiveInlineReview",
      this.sessions.size > 0
    );
  }
}
