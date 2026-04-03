import * as vscode from "vscode";

export type DiffLineType = "new" | "old" | "same";

export interface DiffLine {
  type: DiffLineType;
  line: string;
}

export type VerticalDiffBlockStatus = "pending" | "accepted" | "rejected";
export type VerticalDiffStreamState = "streaming" | "done" | "aborted";

export interface VerticalDiffBlock {
  id: string;
  startLine: number;
  numRed: number;
  numGreen: number;
  originalLines: string[];
  proposedLines: string[];
  status: VerticalDiffBlockStatus;
  mergeBarrierBefore?: boolean;
}

export interface PendingVerticalDiffBlock {
  block: VerticalDiffBlock;
  range: vscode.Range;
  previewText: string;
}

export interface VerticalDiffSession {
  id: string;
  uri: vscode.Uri;
  languageId: string;
  originalText: string;
  proposedText: string;
  currentText: string;
  originalLines: string[];
  proposedLines: string[];
  blocks: VerticalDiffBlock[];
  streamState: VerticalDiffStreamState;
  selectionStartLine: number;
  originalLineCount: number;
}
