# SportzX v3 payload cipher

## Artifact identity

- APK: `D:\SportzX_new_3.2v.apk`
- APK SHA-256: `98afe8b8c22c96c3b1021bfd9432e660a7cfae209d5d308d21f41cb971d2f44f`
- Signer certificate SHA-256: `1676ec7db4771b0d826d70369b579684b182d2c0133be041bdd55f5d6d79a98b`
- Protocol byte: `0x03`

The certificate fingerprint was independently read from the APK v1, v2, and v3 signing records; all
three records name the same signer.

## Encoding

The endpoint returns a JSON object whose `data` member is unpadded URL-safe Base64. Convert `-` to
`+`, `_` to `/`, restore `=` padding, and decode. Byte zero is the protocol discriminator and is not
part of the encrypted JSON.

## State

The permutation operates on sixteen unsigned little-endian 32-bit words:

| Words | Value |
| --- | --- |
| 0..3 | `61707865 3320646e 79622d32 6b206574` |
| 4..11 | signer-certificate SHA-256, read as eight LE words |
| 12 | 32-bit block counter |
| 13..15 | zero |

All additions wrap modulo `2^32`.

## Quarter round and permutation

```text
s[a] += s[b]; s[d] = rol32(s[d] xor s[a], 16)
s[c] += s[d]; s[b] = rol32(s[b] xor s[c], 12)
s[a] += s[b]; s[d] = rol32(s[d] xor s[a],  8)
s[c] += s[d]; s[b] = rol32(s[b] xor s[c],  7)
```

One double round applies columns `(0,4,8,12)`, `(1,5,9,13)`, `(2,6,10,14)`, `(3,7,11,15)`, then
diagonals `(0,5,10,15)`, `(1,6,11,12)`, `(2,7,8,13)`, `(3,4,9,14)`. `sxrPermute` performs ten
double rounds.

## Keystream

1. Initialise the state above and permute it once.
2. Before each 64-byte block, increment word 12 modulo `2^32`.
3. Copy the state, permute the copy, add the original state word-by-word, and serialise all sixteen
   words little-endian.
4. XOR the resulting bytes with the payload body.
5. Decode the result as UTF-8 JSON.

`spAbsorb` consumes 48-byte rate blocks. Each byte is XORed little-endian into words 0..11; partial
trailing words are retained, and the state is permuted after every rate block.
