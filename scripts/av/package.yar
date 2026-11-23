// YARA rules the antivirus gate (.github/workflows/av-gate.yml) runs over every file of each extracted VSIX.
// Any match fails the gate. The package holds WebAssembly, JavaScript and data: a native executable has no
// place in it. scripts/av-lib.mjs checks the same formats inside nested archives, which YARA does not open.
// No rules on strings: the package is a detection-engineering tool, and its skills, catalogue and templates
// describe attacker tooling (PowerShell download cradles, miner pools) in plain text. Defender and ClamAV
// judge content; these rules judge format only.

rule native_pe
{
  meta:
    description = "A Windows PE executable or DLL"
  condition:
    filesize > 0x40 and uint16(0) == 0x5A4D and uint32(uint32(0x3C)) == 0x00004550
}

rule native_elf
{
  meta:
    description = "An ELF executable or shared object"
  condition:
    uint32(0) == 0x464C457F
}

rule native_macho
{
  meta:
    description = "A Mach-O executable or dylib"
  condition:
    uint32(0) == 0xFEEDFACE or uint32(0) == 0xFEEDFACF or uint32(0) == 0xCEFAEDFE or uint32(0) == 0xCFFAEDFE
}
