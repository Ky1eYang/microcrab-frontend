export type DiffRole =
  "diff-file" | "diff-hunk" | "diff-add" | "diff-delete" | "comment";
export type DiffLine = { text: string; role?: DiffRole };

/** Parse display syntax only, never apply a patch or rewrite its evidence.
 * Ranges count payload lines, not newline markers or file metadata. */
export function parseUnifiedDiff(source: string, maxLines: number): DiffLine[] {
  const result: DiffLine[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  let hunks = 0;
  let gitFile = false;
  let metadata = false;
  let oldHeader = false;
  let canNote = false;
  const fail = (reason: string): never => {
    throw new Error(`Unified diff line ${result.length + 1}: ${reason}`);
  };
  const finishHunk = () => {
    if (oldLeft || newLeft)
      fail(`Incomplete hunk: expected ${oldLeft} old and ${newLeft} new lines`);
  };
  for (const match of source.matchAll(/[^\n]*(?:\n|$)/g)) {
    const text = match[0];
    if (!text) continue;
    if (result.length >= maxLines)
      fail("Line count exceeds safe syntax budget");
    const line = text.replace(/\r?\n$/, "");
    let role: DiffRole | undefined;
    if (line === "\\ No newline at end of file") {
      if (!canNote) fail("No-newline marker must follow a hunk payload line");
      canNote = false;
      role = "comment";
    } else if (oldLeft || newLeft) {
      const prefix = line[0];
      if (prefix === " " && oldLeft > 0 && newLeft > 0) {
        oldLeft--;
        newLeft--;
      } else if (prefix === "-" && oldLeft > 0) {
        oldLeft--;
        role = "diff-delete";
      } else if (prefix === "+" && newLeft > 0) {
        newLeft--;
        role = "diff-add";
      } else {
        fail(
          `Expected hunk payload (${oldLeft} old and ${newLeft} new lines remaining)`,
        );
      }
      canNote = true;
    } else {
      canNote = false;
      if (oldHeader && !line.startsWith("+++ "))
        fail("Expected +++ file header after --- file header");
      if (line.startsWith("@@")) {
        const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(
          line,
        );
        if (!range)
          fail("Expected @@ -old[,count] +new[,count] @@ hunk header");
        const startOld = Number(range![1]);
        const startNew = Number(range![3]);
        oldLeft = range![2] === undefined ? 1 : Number(range![2]);
        newLeft = range![4] === undefined ? 1 : Number(range![4]);
        if (
          ![
            startOld,
            startNew,
            oldLeft,
            newLeft,
            startOld + oldLeft,
            startNew + newLeft,
          ].every(Number.isSafeInteger)
        )
          fail("Hunk range exceeds safe integer bounds");
        if ((oldLeft > 0 && startOld === 0) || (newLeft > 0 && startNew === 0))
          fail("Nonempty hunk ranges must start at line 1 or later");
        hunks++;
        role = "diff-hunk";
      } else if (/^diff (?:--git |-u(?:\s|$)|-U\d+(?:\s|$))/.test(line)) {
        gitFile = true;
        role = "diff-file";
      } else if (/^--- .+/.test(line)) {
        oldHeader = true;
        role = "diff-file";
      } else if (/^\+\+\+ .+/.test(line)) {
        if (!oldHeader)
          fail("+++ file header has no preceding --- file header");
        oldHeader = false;
        role = "diff-file";
      } else if (
        gitFile &&
        /^(?:index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files .+ differ$)/.test(
          line,
        )
      ) {
        metadata = true;
        role = "comment";
      } else if (line === "GIT binary patch") {
        fail(
          "Binary patch bodies are not supported by the Unified diff viewer",
        );
      } else if (line !== "") {
        fail("Expected a file header, hunk header or prefixed hunk line");
      }
    }
    result.push({ text, ...(role ? { role } : {}) });
  }
  finishHunk();
  if (oldHeader) fail("Expected +++ file header after --- file header");
  if (!hunks && !(gitFile && metadata))
    fail("Expected a Unified diff hunk or Git change metadata");
  return result;
}
