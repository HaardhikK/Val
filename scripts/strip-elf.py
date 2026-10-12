"""Drops debug info and other non-loaded sections from 64-bit little-endian ELF files (the llama.cpp Android build
ships "with debug_info, not stripped", ~170 MB; stripped it is ~22 MB). Stdlib only, because the repo has no NDK
and so no llvm-strip. Everything the loader maps (all program-header ranges and every SHF_ALLOC section) is kept
byte for byte; only the section header table and its name table are rewritten at the end of the file.

Usage: python3 -I scripts/strip-elf.py IN OUT
"""

import struct
import sys

SHF_ALLOC = 0x2
SHF_INFO_LINK = 0x40
SHT_NOBITS = 8
SHT_REL, SHT_RELA = 9, 4
SHDR = struct.Struct("<IIQQQQIIQQ")  # name, type, flags, addr, offset, size, link, info, addralign, entsize


def strip(data: bytes) -> bytes:
    if data[:4] != b"\x7fELF" or data[4] != 2 or data[5] != 1:
        raise ValueError("not a 64-bit little-endian ELF")
    phoff, shoff = struct.unpack_from("<QQ", data, 0x20)
    phentsize, phnum, shentsize, shnum, shstrndx = struct.unpack_from("<HHHHH", data, 0x36)
    if shentsize != SHDR.size or shnum == 0:
        raise ValueError("unexpected section header layout")
    secs = [list(SHDR.unpack_from(data, shoff + i * shentsize)) for i in range(shnum)]
    names_at = secs[shstrndx][4]

    def name(s):
        start = names_at + s[0]
        return data[start : data.index(b"\0", start)]

    # The end of everything the loader can read: program-header ranges, the headers, and loaded sections.
    end = max(0x40, phoff + phentsize * phnum)
    for i in range(phnum):
        _, _, p_offset, _, _, p_filesz, _, _ = struct.unpack_from("<IIQQQQQQ", data, phoff + i * phentsize)
        end = max(end, p_offset + p_filesz)
    keep = [0] + [i for i, s in enumerate(secs) if i and s[2] & SHF_ALLOC]
    for i in keep[1:]:
        s = secs[i]
        if s[1] != SHT_NOBITS:
            end = max(end, s[4] + s[5])
    index = {old: new for new, old in enumerate(keep)}

    names = bytearray(b"\0")
    out_secs = []
    for old in keep:
        s = list(secs[old])
        if old:
            n = name(s)
            s[0] = len(names)
            names += n + b"\0"
        s[6] = index.get(s[6], 0)  # sh_link is always a section index
        if s[1] in (SHT_REL, SHT_RELA) or s[2] & SHF_INFO_LINK:
            s[7] = index.get(s[7], 0)  # sh_info is a section index for relocations and INFO_LINK sections
        out_secs.append(s)
    shstr_name = len(names)
    names += b".shstrtab\0"

    out = bytearray(data[:end])
    shstr_off = len(out)
    out += names
    out += b"\0" * (-len(out) % 8)
    new_shoff = len(out)
    out_secs.append([shstr_name, 3, 0, 0, shstr_off, len(names), 0, 0, 1, 0])  # SHT_STRTAB
    for s in out_secs:
        out += SHDR.pack(*s)
    struct.pack_into("<Q", out, 0x28, new_shoff)
    struct.pack_into("<HH", out, 0x3C, len(out_secs), len(out_secs) - 1)
    return bytes(out)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    with open(sys.argv[1], "rb") as f:
        stripped = strip(f.read())
    with open(sys.argv[2], "wb") as f:
        f.write(stripped)
