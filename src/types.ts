import * as vscode from 'vscode';

export interface GitDiffReviewSessionInput {
	sessionId: string;
	title?: string;
	source: {
		kind: 'gitDiff';
		diffText: string;
		baseRevision?: string;
	};
	identity: {
		files: Record<string, {
			fileId: string;
			hunkIds: string[];
		}>;
	};
}

export type ReviewHunkKind = 'insert' | 'delete' | 'replace';
export type ReviewHunkState = 'pending' | 'accepted' | 'rejected' | 'conflicted' | 'stale';

export interface ParsedHunk {
	oldStart: number;
	oldLineCount: number;
	newStart: number;
	newLineCount: number;
	displayOldStart: number;
	displayOldLineCount: number;
	displayNewStart: number;
	displayNewLineCount: number;
	displayNewBlockStarts: number[];
	originalLines: string[];
	proposedLines: string[];
	header: string;
}

export interface ParsedDiffFile {
	path: string;
	hunks: ParsedHunk[];
}

export interface ReviewHunk {
	id: string;
	fileId: string;
	filePath: string;
	header: string;
	kind: ReviewHunkKind;
	state: ReviewHunkState;
	oldStart: number;
	oldLineCount: number;
	newStart: number;
	newLineCount: number;
	displayOldStart: number;
	displayOldLineCount: number;
	displayNewStart: number;
	displayNewLineCount: number;
	displayNewBlockStarts: number[];
	originalText: string;
	proposedText: string;
	anchorLine: number;
	contextLine: number;
}

export interface ReviewFile {
	id: string;
	path: string;
	uri: vscode.Uri;
	originalUri: vscode.Uri;
	originalText: string;
	hunks: ReviewHunk[];
	conflicted: boolean;
}

export interface PersistedHunkState {
	id: string;
	state: ReviewHunkState;
}

export interface PersistedReviewSession {
	input: GitDiffReviewSessionInput;
	activeFileId?: string;
	activeHunkId?: string;
	expandedFileIds: string[];
	hunkStates: PersistedHunkState[];
}

export interface ReviewSession {
	sessionId: string;
	title?: string;
	sourceKind: 'gitDiff';
	files: ReviewFile[];
	fileOrder: string[];
	activeFileId?: string;
	activeHunkId?: string;
	expandedFileIds: Set<string>;
}

export interface ReviewCounts {
	pending: number;
	accepted: number;
	rejected: number;
	conflicted: number;
	stale: number;
}

export interface HunkRangeSnapshot {
	startLine: number;
	endLineExclusive: number;
}
