import * as vscode from "vscode";
import {
  buildReviewBlocksFromTexts,
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
const FAST_RECOMPUTE_DELAY_MS = 45;
const NORMAL_RECOMPUTE_DELAY_MS = 90;
const LARGE_EDIT_RECOMPUTE_DELAY_MS = 120;
const MULTILINE_RECOMPUTE_DELAY_MS = 180;

type RenderedLineKind = "context" | "removed" | "added";

interface RenderedLine {
  kind: RenderedLineKind;
  baselineLineIndex?: number;
  workingLineIndex?: number;
}

interface RenderedBlockSlice {
  startLine: number;
  endLine: number;
}

interface RenderedProjection {
  text: string;
  lines: RenderedLine[];
  blocks: ReviewBlock[];
  blockSlices: Map<string, RenderedBlockSlice>;
}

interface BlockEditSegment {
  type: "removed" | "added";
  startOffset: number;
  lines: string[];
}

interface TextReplacement {
  startOffset: number;
  endOffset: number;
  text: string;
}

interface LogicalSelectionPoint {
  kind: RenderedLineKind;
  baselineLineIndex?: number;
  workingLineIndex?: number;
  character: number;
}

interface LogicalSelection {
  anchor: LogicalSelectionPoint;
  active: LogicalSelectionPoint;
  isReversed: boolean;
}

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

function cloneRenderedLine(line: RenderedLine): RenderedLine {
  return { ...line };
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n");
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

function getDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
}

function getMinimalTextReplacement(
  currentText: string,
  nextText: string
): TextReplacement | undefined {
  if (currentText === nextText) {
    return undefined;
  }

  const currentLines = splitReviewLines(currentText);
  const nextLines = splitReviewLines(nextText);
  let firstDifferentLine = 0;

  while (
    firstDifferentLine < currentLines.length &&
    firstDifferentLine < nextLines.length &&
    currentLines[firstDifferentLine] === nextLines[firstDifferentLine]
  ) {
    firstDifferentLine += 1;
  }

  let currentSuffixIndex = currentLines.length - 1;
  let nextSuffixIndex = nextLines.length - 1;
  while (
    currentSuffixIndex >= firstDifferentLine &&
    nextSuffixIndex >= firstDifferentLine &&
    currentLines[currentSuffixIndex] === nextLines[nextSuffixIndex]
  ) {
    currentSuffixIndex -= 1;
    nextSuffixIndex -= 1;
  }

  const getLineStartOffset = (text: string, lineIndex: number): number => {
    if (lineIndex <= 0) {
      return 0;
    }

    let currentLine = 0;
    let searchOffset = 0;

    while (currentLine < lineIndex) {
      const newlineOffset = text.indexOf("\n", searchOffset);
      if (newlineOffset === -1) {
        return text.length;
      }

      searchOffset = newlineOffset + 1;
      currentLine += 1;
    }

    return searchOffset;
  };

  const startOffset = getLineStartOffset(currentText, firstDifferentLine);

  let endOffset = currentText.length;
  if (currentSuffixIndex + 1 < currentLines.length) {
    endOffset = getLineStartOffset(currentText, currentSuffixIndex + 1);
  }

  if (
    firstDifferentLine === currentSuffixIndex + 1 &&
    firstDifferentLine === nextSuffixIndex + 1
  ) {
    endOffset = startOffset;
  }

  return {
    startOffset,
    endOffset,
    text: nextLines.slice(firstDifferentLine, nextSuffixIndex + 1).join("\n")
  };
}

function getRangeForLines(
  startLine: number,
  endLine: number,
  document: vscode.TextDocument
): vscode.Range {
  const lastLine = Math.max(document.lineCount - 1, 0);
  const safeStartLine = Math.max(0, Math.min(startLine, lastLine));
  const safeEndLine = Math.max(safeStartLine, Math.min(endLine, lastLine));

  return new vscode.Range(
    new vscode.Position(safeStartLine, 0),
    new vscode.Position(safeEndLine, document.lineAt(safeEndLine).text.length)
  );
}

function getBlockRange(
  slice: RenderedBlockSlice,
  document: vscode.TextDocument
): vscode.Range {
  return getRangeForLines(slice.startLine, slice.endLine, document);
}

function getSegmentRange(
  slice: RenderedBlockSlice,
  segment: BlockEditSegment,
  document: vscode.TextDocument
): vscode.Range {
  const startLine = slice.startLine + segment.startOffset;
  const endLine = startLine + Math.max(segment.lines.length - 1, 0);
  return getRangeForLines(startLine, endLine, document);
}

function isDefinedNumber(value: number | undefined): value is number {
  return typeof value === "number";
}

export class FileReviewController implements vscode.Disposable {
  private applying = false;
  private disposed = false;
  private recomputeTimer?: NodeJS.Timeout;
  private pendingRecomputeDelayMs = NORMAL_RECOMPUTE_DELAY_MS;
  private currentSelectionLineCount: number;
  private renderedText: string;
  private renderedLines: RenderedLine[];
  private renderedBlockSlices = new Map<string, RenderedBlockSlice>();
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
    this.currentSelectionLineCount = this.session.originalLineCount;
    this.renderedText = this.session.baselineText;
    this.renderedLines = this.buildPlainRenderedLines(this.session.baselineText);
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

    await this.recomputeSession(false);
  }

  public dispose(): void {
    this.disposed = true;
    this.clearRecomputeTimer();
    this.removedDecoration.dispose();
    this.insertedDecoration.dispose();
  }

  public async getPendingViews(
    document: vscode.TextDocument
  ): Promise<PendingReviewBlockView[]> {
    return this.session.blocks.flatMap((block) => {
      const slice = this.renderedBlockSlices.get(block.id);
      if (!slice) {
        return [];
      }

      const primarySegment = getPrimaryBlockSegment(block);
      return [
        {
          block,
          range: primarySegment
            ? getSegmentRange(slice, primarySegment, document)
            : getBlockRange(slice, document),
          previewText: makePreview(joinReviewLines(block.proposedLines))
        }
      ];
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
    const slice = block ? this.renderedBlockSlices.get(block.id) : undefined;
    const targetRange = slice
      ? getBlockRange(slice, editor.document)
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
    this.clearRecomputeTimer();
    this.session.baselineText = this.session.workingText;
    await this.writePlainTextAndClose(this.session.workingText);
  }

  public async rejectAllDiffs(): Promise<void> {
    this.clearRecomputeTimer();
    this.session.workingText = this.session.baselineText;
    await this.writePlainTextAndClose(this.session.baselineText);
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
    event: vscode.TextDocumentChangeEvent
  ): Promise<void> {
    if (this.applying || this.disposed) {
      if (this.applying) {
        this.refresh();
      }
      return;
    }

    try {
      this.translateDocumentChanges(event);
    } catch {
      await this.restoreLastKnownWorkingTextAndClose();
      void vscode.window.showWarningMessage(
        "Latch inline review could not translate that edit. The last known working text was restored and the review was closed."
      );
      return;
    }

    this.pendingRecomputeDelayMs = this.computeRecomputeDelay(event);
    this.scheduleRecompute();
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
      const slice = this.renderedBlockSlices.get(block.id);
      if (!slice) {
        continue;
      }

      const removedSegments = getBlockSegments(block, "removed");
      for (const [index, removedSegment] of removedSegments.entries()) {
        removedDecorations.push({
          range: getSegmentRange(slice, removedSegment, editor.document),
          hoverMessage: new vscode.MarkdownString(
            [
              "**Removed lines**",
              "```",
              joinReviewLines(removedSegment.lines),
              "```"
            ].join("\n")
          )
        });
      }

      const addedSegments = getBlockSegments(block, "added");
      for (const [index, addedSegment] of addedSegments.entries()) {
        insertedDecorations.push({
          range: getSegmentRange(slice, addedSegment, editor.document),
          hoverMessage: new vscode.MarkdownString(
            [
              "**Inserted lines**",
              "```",
              joinReviewLines(addedSegment.lines),
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

  private buildPlainRenderedLines(text: string): RenderedLine[] {
    return splitReviewLines(text).map((_, index) => ({
      kind: "context",
      baselineLineIndex: index,
      workingLineIndex: index
    }));
  }

  private buildRenderedProjection(blocks: ReviewBlock[]): RenderedProjection {
    const baselineLines = splitReviewLines(this.session.baselineText);
    const reviewLines: string[] = [];
    const renderedLines: RenderedLine[] = [];
    const renderedBlocks: ReviewBlock[] = [];
    const blockSlices = new Map<string, RenderedBlockSlice>();
    let baselineIndex = 0;
    let workingIndex = 0;

    for (const block of blocks) {
      while (baselineIndex < block.startLine) {
        reviewLines.push(baselineLines[baselineIndex] ?? "");
        renderedLines.push({
          kind: "context",
          baselineLineIndex: baselineIndex,
          workingLineIndex: workingIndex
        });
        baselineIndex += 1;
        workingIndex += 1;
      }

      const sliceStartLine = this.session.selectionStartLine + reviewLines.length;
      let anchorLine = sliceStartLine;

      block.lines.forEach((line, index) => {
        reviewLines.push(line.content);

        if (line.type !== "context" && index === 0) {
          anchorLine = this.session.selectionStartLine + reviewLines.length - 1;
        }

        if (line.type === "context") {
          renderedLines.push({
            kind: "context",
            baselineLineIndex: baselineIndex,
            workingLineIndex: workingIndex
          });
          baselineIndex += 1;
          workingIndex += 1;
          return;
        }

        if (line.type === "removed") {
          renderedLines.push({
            kind: "removed",
            baselineLineIndex: baselineIndex
          });
          baselineIndex += 1;
          return;
        }

        renderedLines.push({
          kind: "added",
          workingLineIndex: workingIndex
        });
        workingIndex += 1;
      });

      const firstChangedLine = block.lines.findIndex((line) => line.type !== "context");
      if (firstChangedLine > 0) {
        anchorLine = sliceStartLine + firstChangedLine;
      }

      const sliceEndLine = this.session.selectionStartLine + reviewLines.length - 1;
      const renderedBlock = cloneReviewBlock(block);
      renderedBlock.startLine = anchorLine;
      renderedBlocks.push(renderedBlock);
      blockSlices.set(block.id, {
        startLine: sliceStartLine,
        endLine: sliceEndLine
      });
    }

    while (baselineIndex < baselineLines.length) {
      reviewLines.push(baselineLines[baselineIndex] ?? "");
      renderedLines.push({
        kind: "context",
        baselineLineIndex: baselineIndex,
        workingLineIndex: workingIndex
      });
      baselineIndex += 1;
      workingIndex += 1;
    }

    return {
      text: joinReviewLines(reviewLines),
      lines: renderedLines,
      blocks: renderedBlocks,
      blockSlices
    };
  }

  private translateDocumentChanges(
    event: vscode.TextDocumentChangeEvent
  ): void {
    const sortedChanges = [...event.contentChanges].sort((left, right) => {
      if (left.range.start.line !== right.range.start.line) {
        return right.range.start.line - left.range.start.line;
      }

      return right.range.start.character - left.range.start.character;
    });
    let nextRenderedText = this.renderedText;
    let nextRenderedLines = this.renderedLines.map(cloneRenderedLine);

    for (const change of sortedChanges) {
      const translated = this.applyContentChange(
        nextRenderedText,
        nextRenderedLines,
        change
      );

      if (!translated) {
        throw new Error("unsupported change");
      }

      nextRenderedText = translated.text;
      nextRenderedLines = translated.lines;
    }

    const finalDocumentText = normalizeText(event.document.getText());
    if (nextRenderedText !== finalDocumentText) {
      throw new Error("render mismatch");
    }

    this.renderedText = nextRenderedText;
    this.renderedLines = nextRenderedLines;
    this.currentSelectionLineCount = nextRenderedLines.length;
    this.session.workingText = this.deriveWorkingText(
      nextRenderedText,
      nextRenderedLines
    );
  }

  private applyContentChange(
    currentText: string,
    currentLines: RenderedLine[],
    change: vscode.TextDocumentContentChangeEvent
  ): { text: string; lines: RenderedLine[] } | undefined {
    const textLines = splitReviewLines(currentText);
    if (textLines.length !== currentLines.length) {
      return undefined;
    }

    const { start, end } = change.range;
    const startLineText = textLines[start.line];
    const endLineText = textLines[end.line];

    if (
      startLineText === undefined ||
      endLineText === undefined ||
      start.character > startLineText.length ||
      end.character > endLineText.length
    ) {
      return undefined;
    }

    const replacementPrefix = startLineText.slice(0, start.character);
    const replacementSuffix = endLineText.slice(end.character);
    const replacementLines = splitReviewLines(
      replacementPrefix + normalizeText(change.text) + replacementSuffix
    );
    const affectedTextLines = textLines.slice(start.line, end.line + 1);
    const affectedRenderedLines = currentLines.slice(start.line, end.line + 1);
    const replacementRenderedLines = this.buildReplacementRenderedLines(
      affectedTextLines,
      affectedRenderedLines,
      replacementLines,
      normalizeText(change.text),
      start.character,
      end.character
    );
    const nextTextLines = [
      ...textLines.slice(0, start.line),
      ...replacementLines,
      ...textLines.slice(end.line + 1)
    ];
    const nextRenderedLineState = this.reindexRenderedLines([
      ...currentLines.slice(0, start.line),
      ...replacementRenderedLines,
      ...currentLines.slice(end.line + 1)
    ]);

    return {
      text: joinReviewLines(nextTextLines),
      lines: nextRenderedLineState
    };
  }

  private buildReplacementRenderedLines(
    affectedTextLines: string[],
    affectedRenderedLines: RenderedLine[],
    replacementLines: string[],
    insertedText: string,
    startCharacter: number,
    endCharacter: number
  ): RenderedLine[] {
    const replacementRenderedLines = replacementLines.map<RenderedLine>(() => ({
      kind: "added"
    }));
    const firstAffectedText = affectedTextLines[0] ?? "";
    const lastAffectedText = affectedTextLines[affectedTextLines.length - 1] ?? "";
    const firstAffectedLine = affectedRenderedLines[0];
    const lastAffectedLine = affectedRenderedLines[affectedRenderedLines.length - 1];
    const lastReplacementIndex = replacementRenderedLines.length - 1;
    const shouldPreserveFirstLine =
      firstAffectedLine !== undefined &&
      replacementLines[0] === firstAffectedText &&
      startCharacter === firstAffectedText.length &&
      (insertedText === "" || insertedText.startsWith("\n"));
    const shouldPreserveLastLine =
      lastAffectedLine !== undefined &&
      lastReplacementIndex >= 0 &&
      replacementLines[lastReplacementIndex] === lastAffectedText &&
      endCharacter === 0 &&
      (insertedText === "" || insertedText.endsWith("\n"));

    if (shouldPreserveFirstLine) {
      replacementRenderedLines[0] = cloneRenderedLine(firstAffectedLine);
    }

    if (shouldPreserveLastLine && lastReplacementIndex >= 0) {
      replacementRenderedLines[lastReplacementIndex] =
        cloneRenderedLine(lastAffectedLine);
    }

    return replacementRenderedLines;
  }

  private reindexRenderedLines(lines: RenderedLine[]): RenderedLine[] {
    let workingIndex = 0;

    return lines.map((line) => {
      if (line.kind === "removed") {
        return {
          ...line,
          workingLineIndex: undefined
        };
      }

      const reindexedLine: RenderedLine = {
        ...line,
        workingLineIndex: workingIndex
      };
      workingIndex += 1;
      return reindexedLine;
    });
  }

  private deriveWorkingText(text: string, lines: RenderedLine[]): string {
    const textLines = splitReviewLines(text);
    if (textLines.length !== lines.length) {
      throw new Error("rendered line mismatch");
    }

    return joinReviewLines(
      textLines.filter((_, index) => lines[index]?.kind !== "removed")
    );
  }

  private async acceptRejectBlock(
    accept: boolean,
    block: ReviewBlock
  ): Promise<void> {
    const slice = this.renderedBlockSlices.get(block.id);
    if (!slice) {
      return;
    }

    this.clearRecomputeTimer();

    if (accept) {
      const baselineRange = this.resolveLineReplaceRange(
        slice,
        "baselineLineIndex"
      );
      this.session.baselineText = this.replaceTextLines(
        this.session.baselineText,
        baselineRange.start,
        baselineRange.end,
        block.proposedLines
      );
    } else {
      const workingRange = this.resolveLineReplaceRange(slice, "workingLineIndex");
      this.session.workingText = this.replaceTextLines(
        this.session.workingText,
        workingRange.start,
        workingRange.end,
        block.originalLines
      );
    }

    await this.recomputeSession();
  }

  private resolveLineReplaceRange(
    slice: RenderedBlockSlice,
    key: "baselineLineIndex" | "workingLineIndex"
  ): { start: number; end: number } {
    const localStart = slice.startLine - this.session.selectionStartLine;
    const localEnd = slice.endLine - this.session.selectionStartLine;
    const blockLines = this.renderedLines.slice(localStart, localEnd + 1);
    const indexedLines = blockLines
      .map((line) => line[key])
      .filter(isDefinedNumber);

    if (indexedLines.length > 0) {
      return {
        start: indexedLines[0],
        end: indexedLines[indexedLines.length - 1] + 1
      };
    }

    const previousIndex = this.findAdjacentIndexedLine(localStart - 1, -1, key);
    if (previousIndex !== undefined) {
      return {
        start: previousIndex + 1,
        end: previousIndex + 1
      };
    }

    const nextIndex = this.findAdjacentIndexedLine(localEnd + 1, 1, key);
    if (nextIndex !== undefined) {
      return {
        start: nextIndex,
        end: nextIndex
      };
    }

    return { start: 0, end: 0 };
  }

  private findAdjacentIndexedLine(
    index: number,
    step: -1 | 1,
    key: "baselineLineIndex" | "workingLineIndex"
  ): number | undefined {
    for (
      let currentIndex = index;
      currentIndex >= 0 && currentIndex < this.renderedLines.length;
      currentIndex += step
    ) {
      const candidate = this.renderedLines[currentIndex]?.[key];
      if (isDefinedNumber(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private replaceTextLines(
    text: string,
    start: number,
    end: number,
    replacementLines: string[]
  ): string {
    const lines = splitReviewLines(text);
    lines.splice(start, Math.max(end - start, 0), ...replacementLines);
    return joinReviewLines(lines);
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
        const slice = this.renderedBlockSlices.get(block.id);
        if (!slice) {
          return false;
        }

        return cursorLine >= slice.startLine && cursorLine <= slice.endLine;
      }) ?? this.session.blocks[0]
    );
  }

  private async recomputeSession(closeWhenClean = true): Promise<void> {
    this.clearRecomputeTimer();

    const blocks = buildReviewBlocksFromTexts(
      this.session.baselineText,
      this.session.workingText
    );

    if (blocks.length === 0) {
      this.session.blocks = [];
      this.renderedBlockSlices.clear();

      if (closeWhenClean) {
        await this.writePlainTextAndClose(this.session.workingText);
      }
      return;
    }

    const editor = await this.ensureEditor();
    if (!editor) {
      return;
    }

    const projection = this.buildRenderedProjection(blocks);
    await this.replaceEditorText(editor, projection.text, projection.lines);

    this.renderedText = projection.text;
    this.renderedLines = projection.lines;
    this.renderedBlockSlices = projection.blockSlices;
    this.session.blocks = projection.blocks;
    this.currentSelectionLineCount = projection.lines.length;
    this.refresh();
  }

  private scheduleRecompute(): void {
    this.clearRecomputeTimer();
    this.recomputeTimer = setTimeout(() => {
      void this.recomputeSession();
    }, this.pendingRecomputeDelayMs);
  }

  private clearRecomputeTimer(): void {
    if (!this.recomputeTimer) {
      return;
    }

    clearTimeout(this.recomputeTimer);
    this.recomputeTimer = undefined;
  }

  private computeRecomputeDelay(
    event: vscode.TextDocumentChangeEvent
  ): number {
    const includesMultilineEdit = event.contentChanges.some(
      (change) =>
        change.text.includes("\n") ||
        change.range.start.line !== change.range.end.line
    );
    if (includesMultilineEdit) {
      return MULTILINE_RECOMPUTE_DELAY_MS;
    }

    const editMagnitude = event.contentChanges.reduce((total, change) => {
      const removedLines = change.range.end.line - change.range.start.line;
      return total + change.text.length + removedLines * 16;
    }, 0);

    if (editMagnitude <= 4) {
      return FAST_RECOMPUTE_DELAY_MS;
    }

    if (editMagnitude <= 40) {
      return NORMAL_RECOMPUTE_DELAY_MS;
    }

    return LARGE_EDIT_RECOMPUTE_DELAY_MS;
  }

  private async replaceEditorText(
    editor: vscode.TextEditor,
    text: string,
    nextRenderedLines: RenderedLine[]
  ): Promise<void> {
    const currentText = normalizeText(editor.document.getText());
    const replacement = getMinimalTextReplacement(currentText, text);
    if (!replacement) {
      return;
    }

    const previousSelections = this.captureLogicalSelections(editor);

    this.applying = true;

    try {
      await editor.edit(
        (builder) => {
          builder.replace(
            new vscode.Range(
              editor.document.positionAt(replacement.startOffset),
              editor.document.positionAt(replacement.endOffset)
            ),
            replacement.text
          );
        },
        { undoStopAfter: false, undoStopBefore: false }
      );
    } finally {
      this.applying = false;
    }

    editor.selections = previousSelections.map((selection) =>
      this.resolveLogicalSelection(selection, editor.document, nextRenderedLines)
    );
  }

  private async writePlainTextAndClose(text: string): Promise<void> {
    const editor = await this.ensureEditor();
    const nextRenderedLines = this.buildPlainRenderedLines(text);
    if (editor) {
      await this.replaceEditorText(editor, text, nextRenderedLines);
    }

    this.renderedText = text;
    this.renderedLines = nextRenderedLines;
    this.currentSelectionLineCount = this.renderedLines.length;
    this.close();
  }

  private async restoreLastKnownWorkingTextAndClose(): Promise<void> {
    const editor = await this.ensureEditor();
    const nextRenderedLines = this.buildPlainRenderedLines(this.session.workingText);
    if (editor) {
      await this.replaceEditorText(
        editor,
        this.session.workingText,
        nextRenderedLines
      );
    }

    this.close();
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

  private captureLogicalSelections(editor: vscode.TextEditor): LogicalSelection[] {
    return editor.selections.map((selection) => ({
      anchor: this.toLogicalSelectionPoint(selection.anchor, editor.document),
      active: this.toLogicalSelectionPoint(selection.active, editor.document),
      isReversed: selection.isReversed
    }));
  }

  private toLogicalSelectionPoint(
    position: vscode.Position,
    document: vscode.TextDocument
  ): LogicalSelectionPoint {
    const safeLine = Math.max(
      0,
      Math.min(position.line, Math.max(this.renderedLines.length - 1, 0))
    );
    const renderedLine = this.renderedLines[safeLine] ?? {
      kind: "context" as const
    };
    const lineLength = document.lineAt(safeLine).text.length;

    return {
      kind: renderedLine.kind,
      baselineLineIndex: renderedLine.baselineLineIndex,
      workingLineIndex: renderedLine.workingLineIndex,
      character: Math.min(position.character, lineLength)
    };
  }

  private resolveLogicalSelection(
    selection: LogicalSelection,
    document: vscode.TextDocument,
    nextRenderedLines: RenderedLine[]
  ): vscode.Selection {
    const anchor = this.resolveLogicalSelectionPoint(
      selection.anchor,
      document,
      nextRenderedLines
    );
    const active = this.resolveLogicalSelectionPoint(
      selection.active,
      document,
      nextRenderedLines
    );

    return selection.isReversed
      ? new vscode.Selection(active, anchor)
      : new vscode.Selection(anchor, active);
  }

  private resolveLogicalSelectionPoint(
    point: LogicalSelectionPoint,
    document: vscode.TextDocument,
    nextRenderedLines: RenderedLine[]
  ): vscode.Position {
    const resolvedLine = this.findRenderedLineIndex(point, nextRenderedLines);
    const safeLine = Math.max(
      0,
      Math.min(resolvedLine, Math.max(document.lineCount - 1, 0))
    );
    const lineLength = document.lineAt(safeLine).text.length;

    return new vscode.Position(safeLine, Math.min(point.character, lineLength));
  }

  private findRenderedLineIndex(
    point: LogicalSelectionPoint,
    nextRenderedLines: RenderedLine[]
  ): number {
    if (point.workingLineIndex !== undefined) {
      const exactWorkingMatch = nextRenderedLines.findIndex(
        (line) =>
          line.workingLineIndex === point.workingLineIndex &&
          line.kind === point.kind
      );
      if (exactWorkingMatch >= 0) {
        return exactWorkingMatch;
      }

      const fallbackWorkingMatch = nextRenderedLines.findIndex(
        (line) => line.workingLineIndex === point.workingLineIndex
      );
      if (fallbackWorkingMatch >= 0) {
        return fallbackWorkingMatch;
      }
    }

    if (point.baselineLineIndex !== undefined) {
      const exactBaselineMatch = nextRenderedLines.findIndex(
        (line) =>
          line.baselineLineIndex === point.baselineLineIndex &&
          line.kind === point.kind
      );
      if (exactBaselineMatch >= 0) {
        return exactBaselineMatch;
      }

      const fallbackBaselineMatch = nextRenderedLines.findIndex(
        (line) => line.baselineLineIndex === point.baselineLineIndex
      );
      if (fallbackBaselineMatch >= 0) {
        return fallbackBaselineMatch;
      }
    }

    return 0;
  }

  private close(): void {
    this.clearRecomputeTimer();
    this.clearDecorations();
    this.disposed = true;
    this.onDidClose(this.session.uri);
  }
}
