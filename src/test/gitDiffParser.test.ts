import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitDiff } from '../parser/gitDiffParser';
import { reconstructOriginalText } from '../review/originalContent';
import { buildReviewSessionInputFromDiff } from '../review/sessionInputFactory';

test('parseGitDiff parses multiple files and hunks', () => {
	const files = parseGitDiff([
		'diff --git a/a.txt b/a.txt',
		'--- a/a.txt',
		'+++ b/a.txt',
		'@@ -1,2 +1,2 @@',
		' one',
		'-two',
		'+three',
		'diff --git a/b.txt b/b.txt',
		'--- a/b.txt',
		'+++ b/b.txt',
		'@@ -2,0 +2,2 @@',
		'+x',
		'+y'
	].join('\n'));

	assert.equal(files.length, 2);
	assert.equal(files[0]?.path, 'a.txt');
	assert.equal(files[0]?.hunks[0]?.originalLines.join('\n'), 'one\ntwo');
	assert.equal(files[0]?.hunks[0]?.proposedLines.join('\n'), 'one\nthree');
	assert.equal(files[1]?.hunks[0]?.newLineCount, 2);
});

test('parseGitDiff tracks changed display ranges inside contextual hunks', () => {
	const files = parseGitDiff([
		'diff --git a/example.ts b/example.ts',
		'--- a/example.ts',
		'+++ b/example.ts',
		'@@ -10,4 +10,5 @@',
		' alpha',
		'-beta',
		'+betaChanged',
		'+betaInserted',
		' gamma',
		' delta'
	].join('\n'));

	const hunk = files[0]?.hunks[0];
	assert.ok(hunk);
	assert.equal(hunk.displayOldStart, 11);
	assert.equal(hunk.displayOldLineCount, 1);
	assert.equal(hunk.displayNewStart, 11);
	assert.equal(hunk.displayNewLineCount, 2);
});

test('buildReviewSessionInputFromDiff creates identity metadata for each file and hunk', () => {
	const input = buildReviewSessionInputFromDiff([
		'diff --git a/a.txt b/a.txt',
		'--- a/a.txt',
		'+++ b/a.txt',
		'@@ -1 +1 @@',
		'-before',
		'+after'
	].join('\n'), 'Manual Review');

	assert.equal(input.title, 'Manual Review');
	assert.equal(input.source.kind, 'gitDiff');
	assert.ok(input.sessionId.startsWith('session-'));
	assert.ok(input.identity.files['a.txt']);
	assert.ok(input.identity.files['a.txt']?.fileId.startsWith('file-'));
	assert.equal(input.identity.files['a.txt']?.hunkIds.length, 1);
	assert.ok(input.identity.files['a.txt']?.hunkIds[0]?.startsWith('hunk-'));
});

test('parseGitDiff ignores non-diff text', () => {
	assert.equal(parseGitDiff('hello world').length, 0);
});

test('reconstructOriginalText rebuilds the original file from proposed text and parsed hunks', () => {
	const diffText = [
		'diff --git a/sample.txt b/sample.txt',
		'--- a/sample.txt',
		'+++ b/sample.txt',
		'@@ -1,3 +1,4 @@',
		' one',
		'-two',
		'+three',
		'+four',
		' five'
	].join('\n');
	const [file] = parseGitDiff(diffText);
	assert.ok(file);
	const original = reconstructOriginalText('one\nthree\nfour\nfive', file.hunks);
	assert.equal(original, 'one\ntwo\nfive');
});
