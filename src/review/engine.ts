import * as vscode from "vscode";
import {
  FileReviewSession,
  ReviewBlock,
  ReviewBlockLine
} from "./types";

type DiffEditType = "equal" | "removed" | "added";
const MAX_INLINE_CONTEXT_LINES = 1;

interface DiffEdit {
  type: DiffEditType;
  content: string;
}

function cloneReviewBlockLine(line: ReviewBlockLine): ReviewBlockLine {
  return { ...line };
}

function normalizeLiveReviewBlockLines(
  lines: ReviewBlockLine[]
): ReviewBlockLine[] {
  const normalizedLines = lines.map(cloneReviewBlockLine);
  let changed = true;

  // Prefer keeping inserted duplicate blank lines visually attached to the
  // changed region instead of leaving an unchanged blank context line in the
  // middle of the block.
  while (changed) {
    changed = false;

    for (let index = 0; index < normalizedLines.length - 1; index += 1) {
      const currentLine = normalizedLines[index];
      const nextLine = normalizedLines[index + 1];

      if (
        currentLine?.type === "context" &&
        nextLine?.type === "added" &&
        currentLine.content === nextLine.content &&
        currentLine.content === ""
      ) {
        normalizedLines[index] = nextLine;
        normalizedLines[index + 1] = currentLine;
        changed = true;
      }
    }
  }

  return normalizedLines;
}

function countBaselineLines(block: ReviewBlock): number {
  return block.lines.filter((line) => line.type !== "added").length;
}

function mergeAdjacentReviewBlocks(
  blocks: ReviewBlock[],
  baselineLines: string[]
): ReviewBlock[] {
  if (blocks.length <= 1) {
    return blocks;
  }

  const mergedBlocks: ReviewBlock[] = [];

  for (const block of blocks) {
    const previousBlock = mergedBlocks[mergedBlocks.length - 1];
    if (!previousBlock) {
      mergedBlocks.push(block);
      continue;
    }

    const previousEndLine = previousBlock.startLine + countBaselineLines(previousBlock);
    const gapLineCount = block.startLine - previousEndLine;

    if (gapLineCount < 0 || gapLineCount > MAX_INLINE_CONTEXT_LINES) {
      mergedBlocks.push(block);
      continue;
    }

    const contextLines = baselineLines
      .slice(previousEndLine, block.startLine)
      .map<ReviewBlockLine>((content) => ({
        type: "context",
        content
      }));

    mergedBlocks[mergedBlocks.length - 1] = createReviewBlock(
      previousBlock.id,
      previousBlock.startLine,
      [
        ...previousBlock.lines.map(cloneReviewBlockLine),
        ...contextLines,
        ...block.lines.map(cloneReviewBlockLine)
      ]
    );
  }

  return mergedBlocks.map((block, index) =>
    createReviewBlock(`block-${index}`, block.startLine, block.lines)
  );
}

export function cloneReviewBlock(block: ReviewBlock): ReviewBlock {
  return {
    ...block,
    originalLines: [...block.originalLines],
    proposedLines: [...block.proposedLines],
    lines: block.lines.map(cloneReviewBlockLine)
  };
}

export function splitReviewLines(text: string): string[] {
  return text.split("\n");
}

export function joinReviewLines(lines: string[]): string {
  return lines.join("\n");
}

export function createReviewBlock(
  id: string,
  startLine: number,
  lines: ReviewBlockLine[]
): ReviewBlock {
  const originalLines = lines
    .filter((line) => line.type !== "added")
    .map((line) => line.content);
  const proposedLines = lines
    .filter((line) => line.type !== "removed")
    .map((line) => line.content);

  return {
    id,
    startLine,
    numRed: lines.filter((line) => line.type === "removed").length,
    numGreen: lines.filter((line) => line.type === "added").length,
    originalLines,
    proposedLines,
    lines: lines.map(cloneReviewBlockLine)
  };
}

export function diffReviewLines(
  baselineText: string,
  workingText: string
): DiffEdit[] {
  const baselineLines = splitReviewLines(baselineText);
  const workingLines = splitReviewLines(workingText);
  const trace: Array<Map<number, number>> = [];
  let frontier = new Map<number, number>([[1, 0]]);
  const maxEdits = baselineLines.length + workingLines.length;

  for (let depth = 0; depth <= maxEdits; depth += 1) {
    trace.push(new Map(frontier));
    const nextFrontier = new Map<number, number>();

    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const downX = frontier.get(diagonal + 1) ?? 0;
      const rightX = frontier.get(diagonal - 1) ?? 0;
      const shouldGoDown =
        diagonal === -depth ||
        (diagonal !== depth && rightX < downX);

      let x = shouldGoDown ? downX : rightX + 1;
      let y = x - diagonal;

      while (
        x < baselineLines.length &&
        y < workingLines.length &&
        baselineLines[x] === workingLines[y]
      ) {
        x += 1;
        y += 1;
      }

      nextFrontier.set(diagonal, x);

      if (x >= baselineLines.length && y >= workingLines.length) {
        trace.push(new Map(nextFrontier));
        return backtrackReviewDiff(trace, baselineLines, workingLines);
      }
    }

    frontier = nextFrontier;
  }

  return [];
}

export function buildReviewBlocksFromTexts(
  baselineText: string,
  workingText: string
): ReviewBlock[] {
  const baselineLines = splitReviewLines(baselineText);
  const blocks: ReviewBlock[] = [];
  let nextBlockLines: ReviewBlockLine[] = [];
  let pendingContextLines: ReviewBlockLine[] = [];
  let baselineIndex = 0;
  let blockStartLine = 0;

  const flush = () => {
    if (nextBlockLines.length === 0) {
      return;
    }

    blocks.push(
      createReviewBlock(
        `block-${blocks.length}`,
        blockStartLine,
        nextBlockLines
      )
    );
    nextBlockLines = [];
    pendingContextLines = [];
  };

  for (const edit of diffReviewLines(baselineText, workingText)) {
    if (edit.type === "equal") {
      baselineIndex += 1;

      if (nextBlockLines.length === 0) {
        continue;
      }

      pendingContextLines.push({
        type: "context",
        content: edit.content
      });

      if (pendingContextLines.length > MAX_INLINE_CONTEXT_LINES) {
        flush();
      }

      continue;
    }

    if (nextBlockLines.length === 0) {
      blockStartLine = baselineIndex;
    }

    if (pendingContextLines.length > 0) {
      nextBlockLines.push(...pendingContextLines);
      pendingContextLines = [];
    }

    nextBlockLines.push({
      type: edit.type,
      content: edit.content
    });

    if (edit.type === "removed") {
      baselineIndex += 1;
    }
  }

  flush();
  return mergeAdjacentReviewBlocks(blocks, baselineLines).map((block, index) =>
    createReviewBlock(
      `block-${index}`,
      block.startLine,
      normalizeLiveReviewBlockLines(block.lines)
    )
  );
}

export function buildReviewDocumentText(
  baselineLines: string[],
  blocks: ReviewBlock[]
): string {
  const reviewLines: string[] = [];
  let baselineIndex = 0;

  for (const block of blocks) {
    while (baselineIndex < block.startLine) {
      reviewLines.push(baselineLines[baselineIndex] ?? "");
      baselineIndex += 1;
    }

    for (const line of block.lines) {
      reviewLines.push(line.content);
      if (line.type !== "added") {
        baselineIndex += 1;
      }
    }
  }

  while (baselineIndex < baselineLines.length) {
    reviewLines.push(baselineLines[baselineIndex] ?? "");
    baselineIndex += 1;
  }

  return joinReviewLines(reviewLines);
}

export function getReviewBlockOriginalText(block: ReviewBlock): string {
  return joinReviewLines(
    block.lines
      .filter((line) => line.type !== "added")
      .map((line) => line.content)
  );
}

export function getReviewBlockProposedText(block: ReviewBlock): string {
  return joinReviewLines(
    block.lines
      .filter((line) => line.type !== "removed")
      .map((line) => line.content)
  );
}

function backtrackReviewDiff(
  trace: Array<Map<number, number>>,
  baselineLines: string[],
  workingLines: string[]
): DiffEdit[] {
  const edits: DiffEdit[] = [];
  let x = baselineLines.length;
  let y = workingLines.length;

  for (let depth = trace.length - 1; depth > 0; depth -= 1) {
    const previousFrontier = trace[depth - 1];
    const diagonal = x - y;
    const previousDownX = previousFrontier.get(diagonal + 1) ?? 0;
    const previousRightX = previousFrontier.get(diagonal - 1) ?? 0;
    const shouldGoDown =
      diagonal === -(depth - 1) ||
      (diagonal !== depth - 1 && previousRightX < previousDownX);
    const previousDiagonal = shouldGoDown ? diagonal + 1 : diagonal - 1;
    const previousX = previousFrontier.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      edits.push({
        type: "equal",
        content: baselineLines[x - 1] ?? ""
      });
      x -= 1;
      y -= 1;
    }

    if (shouldGoDown) {
      if (y > 0) {
        edits.push({
          type: "added",
          content: workingLines[y - 1] ?? ""
        });
        y -= 1;
      }
    } else if (x > 0) {
      edits.push({
        type: "removed",
        content: baselineLines[x - 1] ?? ""
      });
      x -= 1;
    }
  }

  while (x > 0 && y > 0) {
    edits.push({
      type: "equal",
      content: baselineLines[x - 1] ?? ""
    });
    x -= 1;
    y -= 1;
  }

  while (x > 0) {
    edits.push({
      type: "removed",
      content: baselineLines[x - 1] ?? ""
    });
    x -= 1;
  }

  while (y > 0) {
    edits.push({
      type: "added",
      content: workingLines[y - 1] ?? ""
    });
    y -= 1;
  }

  return edits.reverse();
}

export function createFileReviewSession(
  editor: vscode.TextEditor,
  workingText: string,
  reviewBlocks: ReviewBlock[]
): FileReviewSession | undefined {
  const baselineText = editor.document.getText();
  if (baselineText === workingText || reviewBlocks.length === 0) {
    return undefined;
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    uri: editor.document.uri,
    languageId: editor.document.languageId,
    baselineText,
    workingText,
    blocks: reviewBlocks.map(cloneReviewBlock),
    selectionStartLine: 0,
    originalLineCount: editor.document.lineCount
  };
}
