import test from 'node:test';
import assert from 'node:assert/strict';
import { validateShellInput } from './supervisor.mjs';
test('official wasmsh syntax preserves plain single-quoted Unicode and ASCII programs', () => {
  assert.doesNotThrow(() => validateShellInput("echo '你你你'"));
  assert.doesNotThrow(() => validateShellInput('python3 -c "print(chr(20320) * 3)"'));
  assert.doesNotThrow(() => validateShellInput("echo '你'\"ascii\"'好'"));
});
test('unsupported Unicode parsing modes fail before shell effects', () => {
  for (const input of ['echo 你', 'echo "你"', "echo $'你'", 'echo $"你"', "echo \\'你", 'echo "$(echo \'你\')"'])
    assert.throws(() => validateShellInput(input), error => error.code === 'unsupported' && /single quotes/.test(error.message));
});
