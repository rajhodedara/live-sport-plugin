# SportzX v3 Standalone Decryptor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disassemble `ApiDecoder.decodeV3` from `D:\SportzX_new_3.2v.apk`, document the authentic v3 cipher, and implement a 100% standalone Node.js decryptor in `src/resolver/sportzx/SportzXCrypto.js` that fetches and decrypts `https://in.dotmatrixstream.us/events.json` on the fly.

**Architecture:** Inspect the Dalvik bytecode of `com.sportzx.live.helpers.ApiDecoder` inside `SportzX_unpacked.dex` (unpacked from `D:\SportzX_new_3.2v.apk`). Extract the exact initial state constants (words 0–3), certificate hash derivation (words 4–11), quarter-round shift amounts (`sxrQr`), sponge absorption (`spAbsorb`), and block counter stepping. Implement these directly in `src/resolver/sportzx/SportzXCrypto.js` using Node.js `Uint32Array` and `Buffer`. Build a standalone CLI (`scripts/sportzx-decrypt.js`) to fetch and output clean `events.json`.

**Tech Stack:** Node.js (CommonJS, standard `crypto`, `Buffer`), Python (for Dalvik bytecode parsing), Jest for TDD.

---

## Global Constraints

- **Zero Emulator / Zero Native Dependencies:** Decryption must run entirely in pure JavaScript/Node.js without QEMU, ADB, Frida, or `.so` native execution.
- **No Third-Party Mirrors / No PenguPlay:** The solution must decrypt SportzX's own feed from `https://in.dotmatrixstream.us/events.json`.
- **No Scratch Files:** All reversing must be verified directly against the authentic APK and test suites.
- **Strict 32-bit Arithmetic:** All word additions, XORs, and rotations must enforce `>>> 0` unsigned bounds.

## Review Focus

1. **Protocol Version Byte Check:** Payloads not starting with `0x03` must throw a descriptive error.
2. **URL-Safe Base64 Normalization:** Handle `-`, `_`, and missing `=` padding cleanly before buffer allocation.
3. **State Matrix Invariance:** Words 0–3 (magic constants) and words 4–11 (cert hash words) must match the Dalvik constants byte-for-byte.
4. **Counter & Block Step:** The keystream generator must step the block counter exactly as Dalvik specifies (preventing keystream drift).
5. **Valid JSON Output:** The decrypted output must parse with standard `JSON.parse()` into an array of match fixtures.

---

### Task 1: Disassemble & Document `ApiDecoder.decodeV3` from Dalvik Bytecode

**Files:**
- Source: `SportzX_unpacked.dex` (from `D:\SportzX_new_3.2v.apk`)
- Create: `docs/spec-sportzx-v3-cipher.md`

**Interfaces:**
- Consumes: Bytecode at `com.sportzx.live.helpers.ApiDecoder` (`decodeV3`, `spAbsorb`, `sxrPermute`, `sxrQr`).
- Produces: Precise specification detailing state words 0–15, rotation counts, sponge absorb formulas, and keystream XOR loop.

- [x] **Step 1: Parse and disassemble `ApiDecoder` Dalvik instructions**
  Read the method bytecode from `SportzX_unpacked.dex` and map out all opcodes: register assignments, `const-wide`/`const` words, `and-int`/`or-int`, `ushr-int`/`shl-int`, and method calls.

- [x] **Step 2: Isolate the exact differences from standard ChaCha20**
  Verify the exact 4 rotation counts in `sxrQr`, initial state constants in words 0–3, and counter stepping in word 12.

- [x] **Step 3: Document the formal specification in `docs/spec-sportzx-v3-cipher.md`**
  Record the complete pseudo-code, state layout, and rotation constants.

- [x] **Step 4: Commit**
  ```bash
  git add docs/spec-sportzx-v3-cipher.md
  git commit -m "docs(sportzx): document authentic v3 Dalvik cipher specification"
  ```

---

### Task 2: Implement & Test Standalone `SportzXCrypto.js`

**Files:**
- Modify: `src/resolver/sportzx/SportzXCrypto.js`
- Test: `tests/sportzXCrypto.test.js`

**Interfaces:**
- Consumes: `docs/spec-sportzx-v3-cipher.md`
- Produces: `decodeV3(base64Payload: string): Array<object>|object`

- [x] **Step 1: Write failing test with live payload from `https://in.dotmatrixstream.us/events.json`**
  Add a unit test in `tests/sportzXCrypto.test.js` asserting that calling `decodeV3()` on the real encrypted payload decodes into an array of match objects.

- [x] **Step 2: Run test to verify failure**
  Run: `npm test -- tests/sportzXCrypto.test.js`
  Expected: FAIL (confirms test catches current decryption mismatch).

- [x] **Step 3: Implement the verified cipher in `src/resolver/sportzx/SportzXCrypto.js`**
  Update state initialization, Sponge absorb loop, ChaCha quarter rounds, and output block XORing matching `docs/spec-sportzx-v3-cipher.md`.

- [x] **Step 4: Run test to verify it passes**
  Run: `npm test -- tests/sportzXCrypto.test.js`
  Expected: PASS across all test cases.

- [x] **Step 5: Commit**
  ```bash
  git add src/resolver/sportzx/SportzXCrypto.js tests/sportzXCrypto.test.js
  git commit -m "feat(sportzx): implement authentic standalone v3 payload decryptor"
  ```

---

### Task 3: Build Standalone Event Fetcher CLI & Output `events.json`

**Files:**
- Create: `scripts/sportzx-decrypt.js`
- Output: `events.json`

**Interfaces:**
- Consumes: `src/resolver/sportzx/SportzXCrypto.js:decodeV3`
- Produces: Executable CLI tool saving validated `events.json`.

- [x] **Step 1: Implement `scripts/sportzx-decrypt.js`**
  Write a standalone script that:
  1. Fetches `https://in.dotmatrixstream.us/events.json` (failover to `https://android.onlystream.stream/events.json`).
  2. Decrypts using `decodeV3()`.
  3. Validates the JSON schema.
  4. Writes the formatted result to `events.json` (or stdout).

- [x] **Step 2: Run CLI to produce live `events.json`**
  Run: `node scripts/sportzx-decrypt.js --out events.json`
  Verify `events.json` is generated with valid live matches.

- [x] **Step 3: Syntax check**
  Run: `node --check scripts/sportzx-decrypt.js`

- [x] **Step 4: Commit**
  ```bash
  git add scripts/sportzx-decrypt.js
  git commit -m "feat(sportzx): add standalone live event decryption tool"
  ```
