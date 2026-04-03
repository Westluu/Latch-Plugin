import * as vscode from "vscode";
import {
  buildReviewDocumentText,
  cloneReviewBlock,
  getReviewBlockOriginalText,
  getReviewBlockProposedText,
  joinReviewLines,
  splitReviewLines
} from "./engine";
import {
  FileReviewSession,
  PendingReviewBlockView,
  ReviewBlock
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

function getBlockEndLine(block: ReviewBlock): number {
  return block.startLine + Math.max(block.lines.length, 1) - 1;
}

function getBlockRange(
  block: ReviewBlock,
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

interface BlockEditSegment {
  type: "removed" | "added";
  startOffset: number;
  lines: string[];
}

function buildBlockEditSegments(block: ReviewBlock): BlockEditSegment[] {
  const segments: BlockEditSegment[] = [];
  let current: BlockEditSegment | undefined;

  const flush = () => {
    if (!current || current.lines.length === 0) {
      return;
    }

    segments.push(current);
    current = undefined;
  };

  block.lines.forEach((line, index) => {
    if (line.type === "context") {
      flush();
      return;
    }

    if (!current || current.type !== line.type) {
      flush();
      current = {
        type: line.type,
        startOffset: index,
        lines: []
      };
    }

    current.lines.push(line.content);
  });

  flush();
  return segments;
}

function getBlockSegments(
  block: ReviewBlock,
  type: "removed" | "added"
): BlockEditSegment[] {
  return buildBlockEditSegments(block).filter((segment) => segment.type === type);
}

function getPrimaryBlockSegment(block: ReviewBlock): BlockEditSegment | undefined {
  return buildBlockEditSegments(block)[0];
}

function getSegmentRange(
  block: ReviewBlock,
  segment: BlockEditSegment,
  document: vscode.TextDocument
): vscode.Range {
  const lastLine = Math.max(document.lineCount - 1, 0);
  const startLine = Math.max(
    0,
    Math.min(block.startLine + segment.startOffset, lastLine)
  );
  const endLine = Math.max(
    startLine,
    Math.min(startLine + segment.lines.length - 1, lastLine)
  );

  return new vscode.Range(
    new vscode.Position(startLine, 0),
    new vscode.Position(endLine, document.lineAt(endLine).text.length)
  );
}

function getRemovedBlockRanges(
  block: ReviewBlock,
  document: vscode.TextDocument
): vscode.Range[] {
  return getBlockSegments(block, "removed").map((segment) =>
    getSegmentRange(block, segment, document)
  );
}

function getInsertedBlockRanges(
  block: ReviewBlock,
  document: vscode.TextDocument
): vscode.Range[] {
  return getBlockSegments(block, "added").map((segment) =>
    getSegmentRange(block, segment, document)
  );
}

export class FileReviewController implements vscode.Disposable {
  private applying = false;
  private disposed = false;
  private currentSelectionLineCount: number;
  private readonly initialReviewText: string;
  private readonly initialBlocks: ReviewBlock[];
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
    public readonly session: FileReviewSession,
    private readonly notifyChanged: () => void,
    private readonly onDidClose: (uri: vscode.Uri) => void
  ) {
    const baselineLines = splitReviewLines(this.session.baselineText);
    this.initialBlocks = this.session.blocks.map(cloneReviewBlock);
    this.initialReviewText = buildReviewDocumentText(
      baselineLines,
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
      this.currentSelectionLineCount = splitReviewLines(this.initialReviewText).length;
      let lineDelta = 0;
      this.session.blocks = this.initialBlocks.map((block) => {
        const nextBlock = {
          ...cloneReviewBlock(block),
          startLine: this.session.selectionStartLine + block.startLine + lineDelta
        };
        lineDelta += block.numGreen;
        return nextBlock;
      });
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
  ): Promise<PendingReviewBlockView[]> {
    return this.session.blocks.map((block) => {
      const primarySegment = getPrimaryBlockSegment(block);
      return {
        block,
        range: primarySegment
          ? getSegmentRange(block, primarySegment, document)
          : getBlockRange(block, document),
        previewText: makePreview(joinReviewLines(block.proposedLines))
      };
    });
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

    await this.acceptRejectBlock(true, target);
  }

  public async rejectDiff(blockId?: string): Promise<void> {
    const target = await this.resolveTargetBlock(blockId);
    if (!target) {
      return;
    }

    await this.acceptRejectBlock(false, target);
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
    const baselineText = block
      ? getReviewBlockOriginalText(block)
      : this.session.baselineText;
    const workingText = block
      ? getReviewBlockProposedText(block)
      : this.session.workingText;
    const title = block
      ? `Latch Preview: ${this.session.uri.path.split("/").pop()} (${block.id})`
      : `Latch Preview: ${this.session.uri.path.split("/").pop()}`;

    const [left, right] = await Promise.all([
      vscode.workspace.openTextDocument({
        content: baselineText,
        language: this.session.languageId
      }),
      vscode.workspace.openTextDocument({
        content: workingText,
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
      const removedSegments = getBlockSegments(block, "removed");
      for (const [index, removedRange] of getRemovedBlockRanges(
        block,
        editor.document
      ).entries()) {
        removedDecorations.push({
          range: removedRange,
          hoverMessage: new vscode.MarkdownString(
            [
              "**Removed lines**",
              "```",
              joinReviewLines(removedSegments[index]?.lines ?? []),
              "```"
            ].join("\n")
          )
        });
      }

      const addedSegments = getBlockSegments(block, "added");
      for (const [index, insertedRange] of getInsertedBlockRanges(
        block,
        editor.document
      ).entries()) {
        insertedDecorations.push({
          range: insertedRange,
          hoverMessage: new vscode.MarkdownString(
            [
              "**Inserted lines**",
              "```",
              joinReviewLines(addedSegments[index]?.lines ?? []),
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
    block: ReviewBlock
  ): Promise<void> {
    const editor = await this.ensureEditor();
    if (!editor) {
      return;
    }

    this.applying = true;

    try {
      const removedSegments = getBlockSegments(block, "removed").sort(
        (left, right) => right.startOffset - left.startOffset
      );
      const addedSegments = getBlockSegments(block, "added").sort(
        (left, right) => right.startOffset - left.startOffset
      );

      if (accept) {
        for (const segment of removedSegments) {
          await this.deleteLinesAt(
            block.startLine + segment.startOffset,
            segment.lines.length
          );
        }

        if (removedSegments.length > 0) {
          this.currentSelectionLineCount -= block.numRed;
          this.shiftBlocksAfter(block.startLine, -block.numRed);
        }
      } else {
        for (const segment of addedSegments) {
          await this.deleteLinesAt(
            block.startLine + segment.startOffset,
            segment.lines.length
          );
        }

        if (addedSegments.length > 0) {
          this.currentSelectionLineCount -= block.numGreen;
        }

        if (addedSegments.length > 0) {
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
  ): Promise<ReviewBlock | undefined> {
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
        builder.replace(new vscode.Range(start, end), joinReviewLines(lines));
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
