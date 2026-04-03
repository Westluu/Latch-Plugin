import * as vscode from "vscode";
import { diffArrays } from "diff";
import {
  DiffLine,
  PendingVerticalDiffBlock,
  VerticalDiffBlock,
  VerticalDiffSession
} from "./types";

const MAX_PREVIEW_WIDTH = 120;
const MAX_GROUP_GAP_LINES = 1;
const FUNCTION_SYMBOL_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor
]);

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

function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

function getLastNonBlankLine(lines: string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!isBlankLine(lines[index])) {
      return lines[index];
    }
  }

  return undefined;
}

function isLikelyFunctionHeader(line: string): boolean {
  const trimmed = line.trim();

  return (
    /^(?:async\s+)?function\s+[A-Za-z_]\w*\s*\([^)]*\)/.test(trimmed) ||
    /^(?:public|private|protected|static|\s)*[A-Za-z_]\w*\s*\([^)]*\)\s*\{$/.test(trimmed) ||
    /^def\s+[A-Za-z_]\w*\s*\(/.test(trimmed) ||
    /^func\s+[A-Za-z_]\w*\s*\(/.test(trimmed)
  );
}

function isLikelyBlockTerminator(line?: string): boolean {
  if (!line) {
    return false;
  }

  const trimmed = line.trim();
  return trimmed === "}" || trimmed === "end";
}

function getSelectedLineRange(
  document: vscode.TextDocument,
  selection: vscode.Selection
): vscode.Range {
  const startLine = selection.start.line;
  const rawEndLine =
    !selection.isEmpty &&
    selection.end.character === 0 &&
    selection.end.line > selection.start.line
      ? selection.end.line - 1
      : selection.end.line;
  const endLine = Math.max(startLine, rawEndLine);

  return new vscode.Range(
    new vscode.Position(startLine, 0),
    new vscode.Position(endLine, document.lineAt(endLine).text.length)
  );
}

function buildDiffLines(
  originalLines: string[],
  proposedLines: string[]
): DiffLine[] {
  const changes = diffArrays(originalLines, proposedLines);
  const result: DiffLine[] = [];

  for (const change of changes) {
    const type = change.added ? "new" : change.removed ? "old" : "same";
    const values = change.value as string[];

    for (const line of values) {
      result.push({ type, line });
    }
  }

  return result;
}

function buildBlocksFromDiffLines(diffLines: DiffLine[]): VerticalDiffBlock[] {
  const blocks: VerticalDiffBlock[] = [];
  let originalLineIndex = 0;
  let currentStartLine: number | undefined;
  let originalLines: string[] = [];
  let proposedLines: string[] = [];
  let changedSequence: string[] = [];
  let pendingMergeBarrier = false;
  let currentMergeBarrier = false;

  const flush = () => {
    if (currentStartLine === undefined) {
      return;
    }

    const numRed = originalLines.length;
    const numGreen = proposedLines.length;
    blocks.push({
      id: `block-${blocks.length}`,
      startLine: currentStartLine,
      numRed,
      numGreen,
      originalLines: [...originalLines],
      proposedLines: [...proposedLines],
      status: "pending",
      mergeBarrierBefore: currentMergeBarrier
    });
    currentStartLine += numGreen;
    currentStartLine = undefined;
    originalLines = [];
    proposedLines = [];
    changedSequence = [];
    currentMergeBarrier = false;
  };

  const shouldSplitBeforeLine = (diffLine: DiffLine): boolean => {
    if (currentStartLine === undefined || changedSequence.length === 0) {
      return false;
    }

    if (isLikelyFunctionHeader(diffLine.line)) {
      const lastNonBlank = getLastNonBlankLine(changedSequence);
      return isLikelyBlockTerminator(lastNonBlank);
    }

    return false;
  };

  for (const diffLine of diffLines) {
    if (diffLine.type === "same") {
      flush();
      originalLineIndex += 1;
      continue;
    }

    if (shouldSplitBeforeLine(diffLine)) {
      flush();
      pendingMergeBarrier = true;
    }

    if (currentStartLine === undefined) {
      currentStartLine = originalLineIndex;
      currentMergeBarrier = pendingMergeBarrier;
      pendingMergeBarrier = false;
    }

    if (diffLine.type === "old") {
      originalLines.push(diffLine.line);
      changedSequence.push(diffLine.line);
      originalLineIndex += 1;
    } else {
      proposedLines.push(diffLine.line);
      changedSequence.push(diffLine.line);
    }
  }

  flush();
  return blocks;
}

async function* streamDiffLines(
  diffLines: DiffLine[],
  signal: AbortSignal
): AsyncGenerator<DiffLine> {
  for (let index = 0; index < diffLines.length; index += 1) {
    if (signal.aborted) {
      return;
    }

    if (index > 0 && index % 20 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    yield diffLines[index];
  }
}

function getBlockEndLine(block: VerticalDiffBlock): number {
  return block.startLine + Math.max(block.numRed, 1) + Math.max(block.numGreen, 0) - 1;
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

export function createVerticalDiffSession(
  editor: vscode.TextEditor,
  proposedText: string,
  range?: vscode.Range
): VerticalDiffSession | undefined {
  const selectedRange = range ?? getSelectedLineRange(editor.document, editor.selection);
  const originalText = editor.document.getText(selectedRange);
  if (originalText === proposedText) {
    return undefined;
  }

  const originalLines = splitLines(originalText);
  const proposedLines = splitLines(proposedText);

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    uri: editor.document.uri,
    languageId: editor.document.languageId,
    originalText,
    proposedText,
    currentText: originalText,
    originalLines,
    proposedLines,
    blocks: [],
    streamState: "streaming",
    selectionStartLine: selectedRange.start.line,
    originalLineCount: selectedRange.end.line - selectedRange.start.line + 1
  };
}

export class VerticalDiffHandler implements vscode.Disposable {
  private applying = false;
  private disposed = false;
  private currentSelectionLineCount: number;
  private currentLineIndex: number;
  private deletionBuffer: string[] = [];
  private insertedInCurrentBlock: string[] = [];
  private readonly fullDiffLines: DiffLine[];
  private symbolCache?: {
    version: number;
    functions: vscode.DocumentSymbol[];
  };
  private readonly removedDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
    border: "1px solid",
    borderColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
    isWholeLine: true
  });
  private readonly insertedDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    isWholeLine: true
  });

  public constructor(
    public readonly session: VerticalDiffSession,
    private readonly abortController: AbortController,
    private readonly notifyChanged: () => void,
    private readonly onDidClose: (uri: vscode.Uri) => void
  ) {
    this.fullDiffLines = buildDiffLines(
      this.session.originalLines,
      this.session.proposedLines
    );
    this.currentSelectionLineCount = this.session.originalLineCount;
    this.currentLineIndex = this.session.selectionStartLine;
  }

  public dispose(): void {
    this.disposed = true;
    this.removedDecoration.dispose();
    this.insertedDecoration.dispose();
  }

  public async streamDiff(): Promise<void> {
    const editor = await this.ensureEditor();
    if (!editor) {
      return;
    }

    editor.selection = new vscode.Selection(
      new vscode.Position(this.session.selectionStartLine, 0),
      new vscode.Position(this.session.selectionStartLine, 0)
    );

    try {
      for await (const diffLine of streamDiffLines(
        this.fullDiffLines,
        this.abortController.signal
      )) {
        if (this.disposed || this.abortController.signal.aborted) {
          return;
        }

        await this.handleStreamedDiffLine(diffLine);
      }

      await this.flushCurrentBlock();

      if (this.disposed || this.abortController.signal.aborted) {
        return;
      }

      this.reconcileBlocks();
      this.session.streamState = "done";
      this.refresh();
    } catch (error) {
      if (this.abortController.signal.aborted || this.disposed) {
        return;
      }

      await this.abort(false);
      void vscode.window.showErrorMessage(
        `Unable to stream inline diff: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  public async abort(showMessage: boolean = true): Promise<void> {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
    }

    if (!this.disposed) {
      await this.restoreOriginalText();
    }

    this.session.streamState = "aborted";
    this.close();

    if (showMessage) {
      void vscode.window.showInformationMessage("Latch inline diff was aborted.");
    }
  }

  public async getPendingViews(
    document: vscode.TextDocument
  ): Promise<PendingVerticalDiffBlock[]> {
    return (await this.getPendingBlockGroups(document)).map((group) => {
      const firstBlock = group[0];
      return {
        block: firstBlock,
        range: this.getGroupRange(group, document),
        previewText: makePreview(
          joinLines(group.flatMap((block) => block.proposedLines))
        )
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
      : this.session.blocks.find((candidate) => candidate.status === "pending");

    const targetRange = block
      ? this.getGroupRange(
          await this.getPendingBlockGroup(block, editor.document),
          editor.document
        )
      : new vscode.Range(
          new vscode.Position(this.session.selectionStartLine, 0),
          new vscode.Position(this.session.selectionStartLine, 0)
        );

    editor.selection = new vscode.Selection(
      targetRange.start,
      targetRange.start
    );
    editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.refresh();
  }

  public async acceptDiff(blockId?: string): Promise<void> {
    if (this.session.streamState !== "done") {
      void vscode.window.showInformationMessage(
        "Wait for the inline diff stream to finish or abort it first."
      );
      return;
    }

    const target = await this.resolveTargetBlock(blockId);
    if (!target) {
      return;
    }

    await this.acceptRejectGroup(true, target);
  }

  public async rejectDiff(blockId?: string): Promise<void> {
    if (this.session.streamState !== "done") {
      void vscode.window.showInformationMessage(
        "Wait for the inline diff stream to finish or abort it first."
      );
      return;
    }

    const target = await this.resolveTargetBlock(blockId);
    if (!target) {
      return;
    }

    await this.acceptRejectGroup(false, target);
  }

  public async acceptAllDiffs(): Promise<void> {
    if (this.session.streamState !== "done") {
      void vscode.window.showInformationMessage(
        "Wait for the inline diff stream to finish or abort it first."
      );
      return;
    }

    for (const block of [...this.session.blocks].reverse()) {
      if (block.status === "pending") {
        await this.acceptRejectBlock(true, block);
      }
    }
  }

  public async rejectAllDiffs(): Promise<void> {
    if (this.session.streamState !== "done") {
      void vscode.window.showInformationMessage(
        "Wait for the inline diff stream to finish or abort it first."
      );
      return;
    }

    for (const block of [...this.session.blocks].reverse()) {
      if (block.status === "pending") {
        await this.acceptRejectBlock(false, block);
      }
    }
  }

  public async previewInlineDiff(blockId?: string): Promise<void> {
    const block = blockId
      ? this.session.blocks.find((item) => item.id === blockId)
      : undefined;

    const document = block
      ? await vscode.workspace.openTextDocument(this.session.uri)
      : undefined;
    const previewBlocks =
      block && document
        ? await this.getPendingBlockGroup(block, document)
        : undefined;
    const originalText = previewBlocks
      ? joinLines(previewBlocks.flatMap((item) => item.originalLines))
      : this.session.originalText;
    const proposedText = previewBlocks
      ? joinLines(previewBlocks.flatMap((item) => item.proposedLines))
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
    event: vscode.TextDocumentChangeEvent
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
      if (block.status !== "pending") {
        continue;
      }

      const removedRange = getRemovedBlockRange(block, editor.document);
      if (removedRange) {
        removedDecorations.push({
          range: removedRange,
          hoverMessage: new vscode.MarkdownString(
            ["**Removed lines**", "```", joinLines(block.originalLines), "```"].join("\n")
          )
        });
      }

      const insertedRange = getInsertedBlockRange(block, editor.document);
      if (insertedRange) {
        insertedDecorations.push({
          range: insertedRange,
          hoverMessage: new vscode.MarkdownString(
            ["**Inserted lines**", "```", joinLines(block.proposedLines), "```"].join("\n")
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

  private reconcileBlocks(): void {
    const reconciled = buildBlocksFromDiffLines(this.fullDiffLines);
    let lineDelta = 0;

    this.session.blocks = reconciled.map((block, index) => {
      const existing = this.session.blocks[index];
      const adjusted = {
        ...block,
        startLine: this.session.selectionStartLine + block.startLine + lineDelta
      };
      lineDelta += adjusted.numGreen;
      return existing
        ? { ...adjusted, status: existing.status }
        : adjusted;
    });
  }

  private async handleStreamedDiffLine(diffLine: DiffLine): Promise<void> {
    switch (diffLine.type) {
      case "same":
        await this.flushCurrentBlock();
        this.currentLineIndex += 1;
        break;
      case "old":
        this.deletionBuffer.push(diffLine.line);
        await this.deleteLinesAt(this.currentLineIndex, 1);
        this.currentSelectionLineCount -= 1;
        break;
      case "new":
        await this.insertLineAboveIndex(this.currentLineIndex, diffLine.line);
        this.insertedInCurrentBlock.push(diffLine.line);
        this.currentLineIndex += 1;
        this.currentSelectionLineCount += 1;
        break;
    }
  }

  private async flushCurrentBlock(): Promise<void> {
    if (this.deletionBuffer.length === 0 && this.insertedInCurrentBlock.length === 0) {
      return;
    }

    const startLine = this.currentLineIndex - this.insertedInCurrentBlock.length;

    if (this.deletionBuffer.length > 0) {
      await this.insertLinesAboveIndex(
        startLine,
        new Array(this.deletionBuffer.length).fill("")
      );
      this.currentLineIndex += this.deletionBuffer.length;
      this.currentSelectionLineCount += this.deletionBuffer.length;
    }

    this.session.blocks.push({
      id: `block-${this.session.blocks.length}`,
      startLine,
      numRed: this.deletionBuffer.length,
      numGreen: this.insertedInCurrentBlock.length,
      originalLines: [...this.deletionBuffer],
      proposedLines: [...this.insertedInCurrentBlock],
      status: "pending"
    });

    this.deletionBuffer = [];
    this.insertedInCurrentBlock = [];
    this.refresh();
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

    this.session.blocks = this.session.blocks.filter((candidate) => candidate.id !== block.id);

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
    const editor = await this.ensureEditor();
    const group = editor
      ? await this.getPendingBlockGroup(block, editor.document)
      : [block];

    for (const candidate of [...group].reverse()) {
      await this.acceptRejectBlock(accept, candidate);
    }
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

  private async getPendingBlockGroups(
    document: vscode.TextDocument
  ): Promise<VerticalDiffBlock[][]> {
    const pendingBlocks = this.session.blocks.filter(
      (block) => block.status === "pending"
    );
    const groups: VerticalDiffBlock[][] = [];
    const functionSymbols = await this.getFunctionSymbols(document);

    for (const block of pendingBlocks) {
      const currentGroup = groups[groups.length - 1];
      if (!currentGroup) {
        groups.push([block]);
        continue;
      }

      const previousBlock = currentGroup[currentGroup.length - 1];
      const gap = block.startLine - getBlockEndLine(previousBlock) - 1;
      const previousFunction = this.getContainingFunctionKey(
        previousBlock,
        functionSymbols
      );
      const currentFunction = this.getContainingFunctionKey(
        block,
        functionSymbols
      );
      const crossesFunctionBoundary =
        previousFunction !== undefined &&
        currentFunction !== undefined &&
        previousFunction !== currentFunction;

      if (
        !block.mergeBarrierBefore &&
        gap <= MAX_GROUP_GAP_LINES &&
        !crossesFunctionBoundary
      ) {
        currentGroup.push(block);
      } else {
        groups.push([block]);
      }
    }

    return groups;
  }

  private async getPendingBlockGroup(
    block: VerticalDiffBlock,
    document: vscode.TextDocument
  ): Promise<VerticalDiffBlock[]> {
    return (
      (await this.getPendingBlockGroups(document)).find((group) =>
        group.some((candidate) => candidate.id === block.id)
      ) ?? [block]
    );
  }

  private getGroupRange(
    group: VerticalDiffBlock[],
    document: vscode.TextDocument
  ): vscode.Range {
    const firstBlock = group[0];
    const lastBlock = group[group.length - 1] ?? firstBlock;

    return new vscode.Range(
      getBlockRange(firstBlock, document).start,
      getBlockRange(lastBlock, document).end
    );
  }

  private async getFunctionSymbols(
    document: vscode.TextDocument
  ): Promise<vscode.DocumentSymbol[]> {
    if (this.symbolCache?.version === document.version) {
      return this.symbolCache.functions;
    }

    const providedSymbols =
      (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        document.uri
      )) ?? [];
    const functions = this.flattenFunctionSymbols(providedSymbols);

    this.symbolCache = {
      version: document.version,
      functions
    };

    return functions;
  }

  private flattenFunctionSymbols(
    symbols: vscode.DocumentSymbol[]
  ): vscode.DocumentSymbol[] {
    const functions: vscode.DocumentSymbol[] = [];

    for (const symbol of symbols) {
      if (FUNCTION_SYMBOL_KINDS.has(symbol.kind)) {
        functions.push(symbol);
      }

      functions.push(...this.flattenFunctionSymbols(symbol.children));
    }

    return functions;
  }

  private getContainingFunctionKey(
    block: VerticalDiffBlock,
    symbols: vscode.DocumentSymbol[]
  ): string | undefined {
    const startLine = block.startLine;
    const endLine = getBlockEndLine(block);

    const containingSymbol = symbols
      .filter(
        (symbol) =>
          symbol.range.start.line <= startLine &&
          symbol.range.end.line >= endLine
      )
      .sort((left, right) => {
        const leftSpan = left.range.end.line - left.range.start.line;
        const rightSpan = right.range.end.line - right.range.start.line;
        return leftSpan - rightSpan;
      })[0];

    if (!containingSymbol) {
      return undefined;
    }

    return [
      containingSymbol.kind,
      containingSymbol.name,
      containingSymbol.range.start.line,
      containingSymbol.range.end.line
    ].join(":");
  }

  private async resolveTargetBlock(
    blockId?: string
  ): Promise<VerticalDiffBlock | undefined> {
    if (blockId) {
      return this.session.blocks.find(
        (candidate) => candidate.id === blockId && candidate.status === "pending"
      );
    }

    const editor = await this.ensureEditor();
    if (!editor) {
      return undefined;
    }

    const cursorLine = editor.selection.active.line;
    return (
      this.session.blocks.find((block) => {
        const blockEnd = getBlockEndLine(block);
        return (
          block.status === "pending" &&
          cursorLine >= block.startLine &&
          cursorLine <= blockEnd
        );
      }) ?? this.session.blocks.find((block) => block.status === "pending")
    );
  }

  private currentSelectionRange(document: vscode.TextDocument): vscode.Range {
    const start = new vscode.Position(this.session.selectionStartLine, 0);
    const endLine = Math.min(
      this.session.selectionStartLine + Math.max(this.currentSelectionLineCount - 1, 0),
      document.lineCount - 1
    );

    return new vscode.Range(
      start,
      new vscode.Position(endLine, document.lineAt(endLine).text.length)
    );
  }

  private async restoreOriginalText(): Promise<void> {
    const editor = await this.ensureEditor();
    if (!editor) {
      return;
    }

    const range = this.currentSelectionRange(editor.document);

    this.applying = true;
    try {
      await editor.edit((builder) => {
        builder.replace(range, this.session.originalText);
      });
      this.currentSelectionLineCount = this.session.originalLineCount;
    } finally {
      this.applying = false;
    }
  }

  private async insertLineAboveIndex(index: number, line: string): Promise<void> {
    await this.insertLinesAboveIndex(index, [line]);
  }

  private async insertLinesAboveIndex(index: number, lines: string[]): Promise<void> {
    const editor = await this.ensureEditor();
    if (!editor || lines.length === 0) {
      return;
    }

    this.applying = true;
    try {
      await editor.edit(
        (builder) => {
          const insertion = `${lines.join("\n")}\n`;
          if (index >= editor.document.lineCount) {
            const lastLine = editor.document.lineCount - 1;
            const lastText = editor.document.lineAt(lastLine).text;
            builder.insert(new vscode.Position(lastLine, lastText.length), `\n${lines.join("\n")}`);
          } else {
            builder.insert(new vscode.Position(index, 0), insertion);
          }
        },
        { undoStopAfter: false, undoStopBefore: false }
      );
    } finally {
      this.applying = false;
    }
  }

  private async deleteLinesAt(index: number, count: number): Promise<void> {
    const editor = await this.ensureEditor();
    if (!editor || count <= 0) {
      return;
    }

    this.applying = true;
    try {
      await editor.edit(
        (builder) => {
          const start = new vscode.Position(index, 0);
          if (index + count >= editor.document.lineCount) {
            const line = editor.document.lineAt(editor.document.lineCount - 1);
            builder.delete(new vscode.Range(start, new vscode.Position(line.lineNumber, line.text.length)));
          } else {
            builder.delete(new vscode.Range(start, new vscode.Position(index + count, 0)));
          }
        },
        { undoStopAfter: false, undoStopBefore: false }
      );
    } finally {
      this.applying = false;
    }
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

    this.applying = true;
    try {
      await editor.edit(
        (builder) => {
          const start = new vscode.Position(index, 0);
          const endLine = Math.min(index + Math.max(count - 1, 0), editor.document.lineCount - 1);
          const end = new vscode.Position(endLine, editor.document.lineAt(endLine).text.length);
          builder.replace(new vscode.Range(start, end), joinLines(lines));
        },
        { undoStopAfter: false, undoStopBefore: false }
      );
    } finally {
      this.applying = false;
    }
  }

  private async ensureEditor(): Promise<vscode.TextEditor | undefined> {
    const visibleEditor = vscode.window.visibleTextEditors.find((editor) =>
      editor.document.uri.toString() === this.session.uri.toString()
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
