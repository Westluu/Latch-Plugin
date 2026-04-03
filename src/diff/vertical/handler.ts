import * as vscode from "vscode";
import {
  PendingVerticalDiffBlock,
  VerticalDiffBlock,
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

function joinLines(lines: string[]): string {
  return lines.join("\n");
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

function buildReviewTextFromBlocks(
  originalLines: string[],
  blocks: VerticalDiffBlock[]
): string {
  const reviewLines: string[] = [];
  let originalIndex = 0;

  for (const block of blocks) {
    while (originalIndex < block.startLine) {
      reviewLines.push(originalLines[originalIndex] ?? "");
      originalIndex += 1;
    }

    for (let index = 0; index < block.numRed; index += 1) {
      reviewLines.push("");
    }

    reviewLines.push(...block.proposedLines);
    originalIndex += block.numRed;
  }

  while (originalIndex < originalLines.length) {
    reviewLines.push(originalLines[originalIndex] ?? "");
    originalIndex += 1;
  }

  return joinLines(reviewLines);
}

function getBlockEndLine(block: VerticalDiffBlock): number {
  return (
    block.startLine +
    Math.max(block.numRed, 1) +
    Math.max(block.numGreen, 0) -
    1
  );
}

function getBlockRange(
  block: VerticalDiffBlock,
  document: vscode.TextDocument
): vscode.Range {
  const lastLine = Math.max(document.lineCount - 1, 0);
  const safeStartLine = Math.max(0, Math.min(block.startLine, lastLine));
  const blockEnd = getBlockEndLine(block);
  const safeEndLine = Math.max(safeStartLine, Math.min(blockEnd, lastLine));

  return new vscode.Range(
    new vscode.Position(safeStartLine, 0),
    new vscode.Position(safeEndLine, document.lineAt(safeEndLine).text.length)
  );
}

function getRemovedBlockRange(
  block: VerticalDiffBlock,
  document: vscode.TextDocument
): vscode.Range | undefined {
  if (block.numRed <= 0) {
    return undefined;
  }

  const lastLine = Math.max(document.lineCount - 1, 0);
  const startLine = Math.max(0, Math.min(block.startLine, lastLine));
  const endLine = Math.max(
    startLine,
    Math.min(block.startLine + block.numRed - 1, lastLine)
  );

  return new vscode.Range(
    new vscode.Position(startLine, 0),
    new vscode.Position(endLine, document.lineAt(endLine).text.length)
  );
}

function getInsertedBlockRange(
  block: VerticalDiffBlock,
  document: vscode.TextDocument
): vscode.Range | undefined {
  if (block.numGreen <= 0) {
    return undefined;
  }

  const lastLine = Math.max(document.lineCount - 1, 0);
  const startLine = Math.max(
    0,
    Math.min(block.startLine + block.numRed, lastLine)
  );
  const endLine = Math.max(
    startLine,
    Math.min(block.startLine + block.numRed + block.numGreen - 1, lastLine)
  );

  return new vscode.Range(
    new vscode.Position(startLine, 0),
    new vscode.Position(endLine, document.lineAt(endLine).text.length)
  );
}

function cloneBlock(block: VerticalDiffBlock): VerticalDiffBlock {
  return {
    ...block,
    originalLines: [...block.originalLines],
    proposedLines: [...block.proposedLines]
  };
}

export function createDocumentReviewSession(
  editor: vscode.TextEditor,
  proposedText: string,
  reviewBlocks: VerticalDiffBlock[]
): VerticalDiffSession | undefined {
  const originalText = editor.document.getText();
  if (originalText === proposedText || reviewBlocks.length === 0) {
    return undefined;
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    uri: editor.document.uri,
    languageId: editor.document.languageId,
    originalText,
    proposedText,
    blocks: reviewBlocks.map(cloneBlock),
    selectionStartLine: 0,
    originalLineCount: editor.document.lineCount
  };
}

export class VerticalDiffHandler implements vscode.Disposable {
  private applying = false;
  private disposed = false;
  private currentSelectionLineCount: number;
  private readonly initialReviewText: string;
  private readonly initialBlocks: VerticalDiffBlock[];
  private readonly removedDecoration =
    vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor(
        "diffEditor.removedTextBackground"
      ),
      border: "1px solid",
      borderColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
      isWholeLine: true
    });
  private readonly insertedDecoration =
    vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor(
        "diffEditor.insertedLineBackground"
      ),
      isWholeLine: true
    });

  public constructor(
    public readonly session: VerticalDiffSession,
    private readonly notifyChanged: () => void,
    private readonly onDidClose: (uri: vscode.Uri) => void
  ) {
    const originalLines = splitLines(this.session.originalText);
    this.initialBlocks = this.session.blocks.map(cloneBlock);
    this.initialReviewText = buildReviewTextFromBlocks(
      originalLines,
      this.initialBlocks
    );
    this.currentSelectionLineCount = this.session.originalLineCount;
  }

  public async initializeReview(): Promise<void> {
    const editor = await this.ensureEditor();
    if (!editor) {
      return;
    }

    editor.selection = new vscode.Selection(
      new vscode.Position(this.session.selectionStartLine, 0),
      new vscode.Position(this.session.selectionStartLine, 0)
    );

    this.applying = true;
    try {
      await editor.edit(
        (builder) => {
          builder.replace(
            this.currentSelectionRange(editor.document),
            this.initialReviewText
          );
        },
        { undoStopAfter: false, undoStopBefore: false }
      );
      this.currentSelectionLineCount = splitLines(this.initialReviewText).length;
      this.session.blocks = this.initialBlocks.map((block) => ({
        ...cloneBlock(block),
        startLine: this.session.selectionStartLine + block.startLine
      }));
    } finally {
      this.applying = false;
    }

    this.refresh();
  }

  public dispose(): void {
    this.disposed = true;
    this.removedDecoration.dispose();
    this.insertedDecoration.dispose();
  }

  public async getPendingViews(
    document: vscode.TextDocument
  ): Promise<PendingVerticalDiffBlock[]> {
    return this.session.blocks.map((block) => ({
      block,
      range: getBlockRange(block, document),
      previewText: makePreview(joinLines(block.proposedLines))
    }));
  }

  public async reveal(blockId?: string): Promise<void> {
    const editor = await this.ensureEditor();
    if (!editor) {
      return;
    }

    const block = blockId
      ? this.session.blocks.find((candidate) => candidate.id === blockId)
      : this.session.blocks[0];

    const targetRange = block
      ? getBlockRange(block, editor.document)
      : new vscode.Range(
          new vscode.Position(this.session.selectionStartLine, 0),
          new vscode.Position(this.session.selectionStartLine, 0)
        );

    editor.selection = new vscode.Selection(targetRange.start, targetRange.start);
    editor.revealRange(
      targetRange,
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
    this.refresh();
  }

  public async acceptDiff(blockId?: string): Promise<void> {
    const target = await this.resolveTargetBlock(blockId);
    if (!target) {
      return;
    }

    await this.acceptRejectGroup(true, target);
  }

  public async rejectDiff(blockId?: string): Promise<void> {
    const target = await this.resolveTargetBlock(blockId);
    if (!target) {
      return;
    }

    await this.acceptRejectGroup(false, target);
  }

  public async acceptAllDiffs(): Promise<void> {
    for (const block of [...this.session.blocks].reverse()) {
      await this.acceptRejectBlock(true, block);
    }
  }

  public async rejectAllDiffs(): Promise<void> {
    for (const block of [...this.session.blocks].reverse()) {
      await this.acceptRejectBlock(false, block);
    }
  }

  public async previewInlineDiff(blockId?: string): Promise<void> {
    const block = blockId
      ? this.session.blocks.find((item) => item.id === blockId)
      : undefined;
    const originalText = block
      ? joinLines(block.originalLines)
      : this.session.originalText;
    const proposedText = block
      ? joinLines(block.proposedLines)
      : this.session.proposedText;
    const title = block
      ? `Latch Preview: ${this.session.uri.path.split("/").pop()} (${block.id})`
      : `Latch Preview: ${this.session.uri.path.split("/").pop()}`;

    const [left, right] = await Promise.all([
      vscode.workspace.openTextDocument({
        content: originalText,
        language: this.session.languageId
      }),
      vscode.workspace.openTextDocument({
        content: proposedText,
        language: this.session.languageId
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

  public async handleDocumentChange(
    _event: vscode.TextDocumentChangeEvent
  ): Promise<void> {
    if (this.applying) {
      this.refresh();
      return;
    }

    this.close();
    void vscode.window.showWarningMessage(
      "Latch inline review was closed because the document changed outside the review flow."
    );
  }

  public refresh(): void {
    if (this.disposed) {
      return;
    }

    const editor = vscode.window.visibleTextEditors.find(
      (item) => item.document.uri.toString() === this.session.uri.toString()
    );

    if (!editor) {
      this.notifyChanged();
      return;
    }

    const removedDecorations: vscode.DecorationOptions[] = [];
    const insertedDecorations: vscode.DecorationOptions[] = [];

    for (const block of this.session.blocks) {
      const removedRange = getRemovedBlockRange(block, editor.document);
      if (removedRange) {
        removedDecorations.push({
          range: removedRange,
          hoverMessage: new vscode.MarkdownString(
            [
              "**Removed lines**",
              "```",
              joinLines(block.originalLines),
              "```"
            ].join("\n")
          )
        });
      }

      const insertedRange = getInsertedBlockRange(block, editor.document);
      if (insertedRange) {
        insertedDecorations.push({
          range: insertedRange,
          hoverMessage: new vscode.MarkdownString(
            [
              "**Inserted lines**",
              "```",
              joinLines(block.proposedLines),
              "```"
            ].join("\n")
          )
        });
      }
    }

    editor.setDecorations(this.removedDecoration, removedDecorations);
    editor.setDecorations(this.insertedDecoration, insertedDecorations);
    this.notifyChanged();
  }

  public clearDecorations(): void {
    if (this.disposed) {
      return;
    }

    const editor = vscode.window.visibleTextEditors.find(
      (item) => item.document.uri.toString() === this.session.uri.toString()
    );

    if (!editor) {
      return;
    }

    editor.setDecorations(this.removedDecoration, []);
    editor.setDecorations(this.insertedDecoration, []);
  }

  private async acceptRejectBlock(
    accept: boolean,
    block: VerticalDiffBlock
  ): Promise<void> {
    const editor = await this.ensureEditor();
    if (!editor) {
      return;
    }

    this.applying = true;

    try {
      if (accept) {
        if (block.numRed > 0) {
          await this.deleteLinesAt(block.startLine, block.numRed);
          this.currentSelectionLineCount -= block.numRed;
          this.shiftBlocksAfter(block.startLine, -block.numRed);
        }
      } else {
        if (block.numGreen > 0) {
          await this.deleteLinesAt(block.startLine + block.numRed, block.numGreen);
          this.currentSelectionLineCount -= block.numGreen;
        }

        if (block.numRed > 0) {
          await this.replaceLines(block.startLine, block.numRed, block.originalLines);
        }

        if (block.numGreen > 0) {
          this.shiftBlocksAfter(block.startLine, -block.numGreen);
        }
      }
    } finally {
      this.applying = false;
    }

    this.session.blocks = this.session.blocks.filter(
      (candidate) => candidate.id !== block.id
    );

    if (this.session.blocks.length === 0) {
      this.close();
      return;
    }

    this.refresh();
  }

  private async acceptRejectGroup(
    accept: boolean,
    block: VerticalDiffBlock
  ): Promise<void> {
    await this.acceptRejectBlock(accept, block);
  }

  private shiftBlocksAfter(startLine: number, offset: number): void {
    if (offset === 0) {
      return;
    }

    this.session.blocks = this.session.blocks.map((block) =>
      block.startLine > startLine
        ? {
            ...block,
            startLine: block.startLine + offset
          }
        : block
    );
  }

  private async resolveTargetBlock(
    blockId?: string
  ): Promise<VerticalDiffBlock | undefined> {
    if (blockId) {
      return this.session.blocks.find((candidate) => candidate.id === blockId);
    }

    const editor = await this.ensureEditor();
    if (!editor) {
      return undefined;
    }

    const cursorLine = editor.selection.active.line;
    return (
      this.session.blocks.find((block) => {
        const blockEnd = getBlockEndLine(block);
        return cursorLine >= block.startLine && cursorLine <= blockEnd;
      }) ?? this.session.blocks[0]
    );
  }

  private currentSelectionRange(document: vscode.TextDocument): vscode.Range {
    const start = new vscode.Position(this.session.selectionStartLine, 0);
    const endLine = Math.min(
      this.session.selectionStartLine +
        Math.max(this.currentSelectionLineCount - 1, 0),
      document.lineCount - 1
    );

    return new vscode.Range(
      start,
      new vscode.Position(endLine, document.lineAt(endLine).text.length)
    );
  }

  private async deleteLinesAt(index: number, count: number): Promise<void> {
    const editor = await this.ensureEditor();
    if (!editor || count <= 0) {
      return;
    }

    await editor.edit(
      (builder) => {
        const start = new vscode.Position(index, 0);
        if (index + count >= editor.document.lineCount) {
          const line = editor.document.lineAt(editor.document.lineCount - 1);
          builder.delete(
            new vscode.Range(
              start,
              new vscode.Position(line.lineNumber, line.text.length)
            )
          );
        } else {
          builder.delete(new vscode.Range(start, new vscode.Position(index + count, 0)));
        }
      },
      { undoStopAfter: false, undoStopBefore: false }
    );
  }

  private async replaceLines(
    index: number,
    count: number,
    lines: string[]
  ): Promise<void> {
    const editor = await this.ensureEditor();
    if (!editor) {
      return;
    }

    await editor.edit(
      (builder) => {
        const start = new vscode.Position(index, 0);
        const endLine = Math.min(
          index + Math.max(count - 1, 0),
          editor.document.lineCount - 1
        );
        const end = new vscode.Position(
          endLine,
          editor.document.lineAt(endLine).text.length
        );
        builder.replace(new vscode.Range(start, end), joinLines(lines));
      },
      { undoStopAfter: false, undoStopBefore: false }
    );
  }

  private async ensureEditor(): Promise<vscode.TextEditor | undefined> {
    const visibleEditor = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === this.session.uri.toString()
    );

    if (visibleEditor) {
      return visibleEditor;
    }

    try {
      return await vscode.window.showTextDocument(this.session.uri, {
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

  private close(): void {
    this.clearDecorations();
    this.disposed = true;
    this.onDidClose(this.session.uri);
  }
}
