// scripts/build-png-unfilter-wasm.js
// Compiles WAT source into cloudflare-worker/png-unfilter.wasm using wat2wasm.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WAT_SOURCE = `(module
  (memory (export "memory") 1 1024)

  (func $abs (param $v i32) (result i32)
    (select
      (i32.sub (i32.const 0) (local.get $v))
      (local.get $v)
      (i32.lt_s (local.get $v) (i32.const 0))
    )
  )

  (func $paeth (param $a i32) (param $b i32) (param $c i32) (result i32)
    (local $p i32)
    (local $pa i32)
    (local $pb i32)
    (local $pc i32)
    (local.set $p (i32.sub (i32.add (local.get $a) (local.get $b)) (local.get $c)))
    (local.set $pa (call $abs (i32.sub (local.get $p) (local.get $a))))
    (local.set $pb (call $abs (i32.sub (local.get $p) (local.get $b))))
    (local.set $pc (call $abs (i32.sub (local.get $p) (local.get $c))))
    (if (result i32)
      (i32.and (i32.le_s (local.get $pa) (local.get $pb)) (i32.le_s (local.get $pa) (local.get $pc)))
      (then (local.get $a))
      (else
        (if (result i32)
          (i32.le_s (local.get $pb) (local.get $pc))
          (then (local.get $b))
          (else (local.get $c))
        )
      )
    )
  )

  (func (export "unfilter")
    (param $rawPtr i32)
    (param $outPtr i32)
    (param $width i32)
    (param $height i32)
    (param $bpp i32)
    (result i32)

    (local $stride i32)
    (local $y i32)
    (local $x i32)
    (local $rawIdx i32)
    (local $rowOff i32)
    (local $prevOff i32)
    (local $ft i32)
    (local $a i32)
    (local $b i32)
    (local $c i32)

    ;; validate inputs
    (if (i32.or (i32.le_s (local.get $width) (i32.const 0))
         (i32.or (i32.le_s (local.get $height) (i32.const 0))
          (i32.or (i32.le_s (local.get $bpp) (i32.const 0))
                  (i32.gt_s (local.get $bpp) (i32.const 4)))))
      (then (return (i32.const -1)))
    )

    (local.set $stride (i32.mul (local.get $width) (local.get $bpp)))
    (local.set $rawIdx (local.get $rawPtr))
    (local.set $y (i32.const 0))

    (block $break_y
      (loop $loop_y
        ;; if (y >= height) break
        (br_if $break_y (i32.ge_s (local.get $y) (local.get $height)))

        ;; read filter type ft = raw[rawIdx++]
        (local.set $ft (i32.load8_u (local.get $rawIdx)))
        (local.set $rawIdx (i32.add (local.get $rawIdx) (i32.const 1)))

        ;; check filter type range [0, 4]
        (if (i32.gt_u (local.get $ft) (i32.const 4))
          (then (return (i32.const -1)))
        )

        ;; calculate row offsets
        (local.set $rowOff (i32.add (local.get $outPtr) (i32.mul (local.get $y) (local.get $stride))))
        (local.set $prevOff (i32.sub (local.get $rowOff) (local.get $stride)))

        ;; dispatch by ft
        ;; ft == 0 (None)
        (if (i32.eq (local.get $ft) (i32.const 0))
          (then
            (memory.copy (local.get $rowOff) (local.get $rawIdx) (local.get $stride))
          )
        )

        ;; ft == 1 (Sub)
        (if (i32.eq (local.get $ft) (i32.const 1))
          (then
            ;; first bpp bytes: out[rowOff + x] = raw[rawIdx + x]
            (local.set $x (i32.const 0))
            (block $b1_first
              (loop $l1_first
                (br_if $b1_first (i32.ge_s (local.get $x) (local.get $bpp)))
                (br_if $b1_first (i32.ge_s (local.get $x) (local.get $stride)))
                (i32.store8
                  (i32.add (local.get $rowOff) (local.get $x))
                  (i32.load8_u (i32.add (local.get $rawIdx) (local.get $x)))
                )
                (local.set $x (i32.add (local.get $x) (i32.const 1)))
                (br $l1_first)
              )
            )
            ;; remaining bytes: out[rowOff + x] = (raw[rawIdx + x] + out[rowOff + x - bpp])
            (block $b1_rest
              (loop $l1_rest
                (br_if $b1_rest (i32.ge_s (local.get $x) (local.get $stride)))
                (i32.store8
                  (i32.add (local.get $rowOff) (local.get $x))
                  (i32.add
                    (i32.load8_u (i32.add (local.get $rawIdx) (local.get $x)))
                    (i32.load8_u (i32.sub (i32.add (local.get $rowOff) (local.get $x)) (local.get $bpp)))
                  )
                )
                (local.set $x (i32.add (local.get $x) (i32.const 1)))
                (br $l1_rest)
              )
            )
          )
        )

        ;; ft == 2 (Up)
        (if (i32.eq (local.get $ft) (i32.const 2))
          (then
            (if (i32.eq (local.get $y) (i32.const 0))
              (then
                ;; y == 0: out[rowOff + x] = raw[rawIdx + x]
                (memory.copy (local.get $rowOff) (local.get $rawIdx) (local.get $stride))
              )
              (else
                ;; y > 0: out[rowOff + x] = raw[rawIdx + x] + out[prevOff + x]
                (local.set $x (i32.const 0))
                (block $b2_y
                  (loop $l2_y
                    (br_if $b2_y (i32.ge_s (local.get $x) (local.get $stride)))
                    (i32.store8
                      (i32.add (local.get $rowOff) (local.get $x))
                      (i32.add
                        (i32.load8_u (i32.add (local.get $rawIdx) (local.get $x)))
                        (i32.load8_u (i32.add (local.get $prevOff) (local.get $x)))
                      )
                    )
                    (local.set $x (i32.add (local.get $x) (i32.const 1)))
                    (br $l2_y)
                  )
                )
              )
            )
          )
        )

        ;; ft == 3 (Average)
        (if (i32.eq (local.get $ft) (i32.const 3))
          (then
            (if (i32.eq (local.get $y) (i32.const 0))
              (then
                ;; y == 0, x < bpp: raw
                (local.set $x (i32.const 0))
                (block $b3_0_first
                  (loop $l3_0_first
                    (br_if $b3_0_first (i32.ge_s (local.get $x) (local.get $bpp)))
                    (br_if $b3_0_first (i32.ge_s (local.get $x) (local.get $stride)))
                    (i32.store8
                      (i32.add (local.get $rowOff) (local.get $x))
                      (i32.load8_u (i32.add (local.get $rawIdx) (local.get $x)))
                    )
                    (local.set $x (i32.add (local.get $x) (i32.const 1)))
                    (br $l3_0_first)
                  )
                )
                ;; y == 0, x >= bpp: raw + (left >> 1)
                (block $b3_0_rest
                  (loop $l3_0_rest
                    (br_if $b3_0_rest (i32.ge_s (local.get $x) (local.get $stride)))
                    (i32.store8
                      (i32.add (local.get $rowOff) (local.get $x))
                      (i32.add
                        (i32.load8_u (i32.add (local.get $rawIdx) (local.get $x)))
                        (i32.shr_u
                          (i32.load8_u (i32.sub (i32.add (local.get $rowOff) (local.get $x)) (local.get $bpp)))
                          (i32.const 1)
                        )
                      )
                    )
                    (local.set $x (i32.add (local.get $x) (i32.const 1)))
                    (br $l3_0_rest)
                  )
                )
              )
              (else
                ;; y > 0, x < bpp: raw + (up >> 1)
                (local.set $x (i32.const 0))
                (block $b3_y_first
                  (loop $l3_y_first
                    (br_if $b3_y_first (i32.ge_s (local.get $x) (local.get $bpp)))
                    (br_if $b3_y_first (i32.ge_s (local.get $x) (local.get $stride)))
                    (i32.store8
                      (i32.add (local.get $rowOff) (local.get $x))
                      (i32.add
                        (i32.load8_u (i32.add (local.get $rawIdx) (local.get $x)))
                        (i32.shr_u
                          (i32.load8_u (i32.add (local.get $prevOff) (local.get $x)))
                          (i32.const 1)
                        )
                      )
                    )
                    (local.set $x (i32.add (local.get $x) (i32.const 1)))
                    (br $l3_y_first)
                  )
                )
                ;; y > 0, x >= bpp: raw + ((left + up) >> 1)
                (block $b3_y_rest
                  (loop $l3_y_rest
                    (br_if $b3_y_rest (i32.ge_s (local.get $x) (local.get $stride)))
                    (i32.store8
                      (i32.add (local.get $rowOff) (local.get $x))
                      (i32.add
                        (i32.load8_u (i32.add (local.get $rawIdx) (local.get $x)))
                        (i32.shr_u
                          (i32.add
                            (i32.load8_u (i32.sub (i32.add (local.get $rowOff) (local.get $x)) (local.get $bpp)))
                            (i32.load8_u (i32.add (local.get $prevOff) (local.get $x)))
                          )
                          (i32.const 1)
                        )
                      )
                    )
                    (local.set $x (i32.add (local.get $x) (i32.const 1)))
                    (br $l3_y_rest)
                  )
                )
              )
            )
          )
        )

        ;; ft == 4 (Paeth)
        (if (i32.eq (local.get $ft) (i32.const 4))
          (then
            (local.set $x (i32.const 0))
            (block $b4
              (loop $l4
                (br_if $b4 (i32.ge_s (local.get $x) (local.get $stride)))

                ;; a = (x >= bpp) ? out[rowOff + x - bpp] : 0
                (local.set $a
                  (select
                    (i32.load8_u (i32.sub (i32.add (local.get $rowOff) (local.get $x)) (local.get $bpp)))
                    (i32.const 0)
                    (i32.ge_s (local.get $x) (local.get $bpp))
                  )
                )

                ;; b = (y > 0) ? out[prevOff + x] : 0
                (local.set $b
                  (select
                    (i32.load8_u (i32.add (local.get $prevOff) (local.get $x)))
                    (i32.const 0)
                    (i32.gt_s (local.get $y) (i32.const 0))
                  )
                )

                ;; c = (x >= bpp && y > 0) ? out[prevOff + x - bpp] : 0
                (local.set $c
                  (select
                    (i32.load8_u (i32.sub (i32.add (local.get $prevOff) (local.get $x)) (local.get $bpp)))
                    (i32.const 0)
                    (i32.and (i32.ge_s (local.get $x) (local.get $bpp)) (i32.gt_s (local.get $y) (i32.const 0)))
                  )
                )

                (i32.store8
                  (i32.add (local.get $rowOff) (local.get $x))
                  (i32.add
                    (i32.load8_u (i32.add (local.get $rawIdx) (local.get $x)))
                    (call $paeth (local.get $a) (local.get $b) (local.get $c))
                  )
                )

                (local.set $x (i32.add (local.get $x) (i32.const 1)))
                (br $l4)
              )
            )
          )
        )

        ;; advance rawIdx by stride
        (local.set $rawIdx (i32.add (local.get $rawIdx) (local.get $stride)))

        ;; y++
        (local.set $y (i32.add (local.get $y) (i32.const 1)))
        (br $loop_y)
      )
    )

    (return (i32.const 0))
  )

  ;; Fast Adler-32 in WebAssembly (chunked 5552 bytes before modulo)
  (func (export "adler32") (param $ptr i32) (param $len i32) (result i32)
    (local $s1 i32)
    (local $s2 i32)
    (local $end i32)
    (local $chunkEnd i32)
    (local.set $s1 (i32.const 1))
    (local.set $s2 (i32.const 0))
    (local.set $end (i32.add (local.get $ptr) (local.get $len)))

    (block $outer_break
      (loop $outer_loop
        (br_if $outer_break (i32.ge_u (local.get $ptr) (local.get $end)))

        ;; chunkEnd = min(ptr + 5552, end)
        (local.set $chunkEnd (i32.add (local.get $ptr) (i32.const 5552)))
        (if (i32.gt_u (local.get $chunkEnd) (local.get $end))
          (then (local.set $chunkEnd (local.get $end)))
        )

        (block $inner_break
          (loop $inner_loop
            (br_if $inner_break (i32.ge_u (local.get $ptr) (local.get $chunkEnd)))

            ;; s1 += memory[ptr]
            (local.set $s1 (i32.add (local.get $s1) (i32.load8_u (local.get $ptr))))
            ;; s2 += s1
            (local.set $s2 (i32.add (local.get $s2) (local.get $s1)))

            (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
            (br $inner_loop)
          )
        )

        ;; s1 %= 65521
        (local.set $s1 (i32.rem_u (local.get $s1) (i32.const 65521)))
        ;; s2 %= 65521
        (local.set $s2 (i32.rem_u (local.get $s2) (i32.const 65521)))

        (br $outer_loop)
      )
    )

    (return (i32.or (i32.shl (local.get $s2) (i32.const 16)) (local.get $s1)))
  )
)
`;

function build() {
  const rootDir = path.resolve(__dirname, '..');
  const tempWat = path.join(rootDir, 'scripts', 'temp_png_unfilter.wat');
  const outWasm = path.join(rootDir, 'cloudflare-worker', 'png-unfilter.wasm');

  fs.writeFileSync(tempWat, WAT_SOURCE.trim(), 'utf8');

  try {
    const wat2wasmCmd = process.platform === 'win32' ? 'wat2wasm.cmd' : 'wat2wasm';
    execFileSync(wat2wasmCmd, [`"${tempWat}"`, '-o', `"${outWasm}"`], { cwd: rootDir, shell: true, stdio: 'inherit' });
    console.log(`[build-png-unfilter-wasm] Successfully compiled WAT to: ${outWasm}`);
    const bytes = fs.readFileSync(outWasm);
    console.log(`[build-png-unfilter-wasm] Binary size: ${bytes.length} bytes`);

    // Verify it compiles in Node WebAssembly
    const mod = new WebAssembly.Module(bytes);
    console.log(`[build-png-unfilter-wasm] Successfully validated WebAssembly.Module!`);
  } finally {
    if (fs.existsSync(tempWat)) {
      fs.unlinkSync(tempWat);
    }
  }
}

if (require.main === module) {
  build();
}

module.exports = { WAT_SOURCE, build };
