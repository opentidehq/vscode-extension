rule r {
  strings:
    $a = "abc"
  condition:
    $a and filesize > 0
}

rule r {
  condition:
    (filesize \ 2 + 1 * 3 - 4 % 5) & 0xFF | 1 ^ 2 << 1 >> 1 == 0o17
}

// prod:base64_modifier valid
rule r {
  strings:
    $a = "abc" base64
    $b = "abcd" base64wide("!@#$%^&*(){}[].,|ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstu")
  condition:
    all of them
}

import "math"

rule r {
  condition:
    uint16(0) == 0x5A4D and math.entropy(0, filesize) > 7.0
}

rule r {
  condition:
    true
}
// line comment
/* block
   comment */

rule r {
  condition:
    filesize >= 10 and "a" icontains "A" and "ab" startswith "a" and "x" iequals "X" and "abc" matches /b/i and 1 != 2
}

rule r {
  condition:
    filesize < 1MB
}

rule r {
  condition:
    entrypoint == 0x400
}

rule r {
  condition:
    filesize > 10KB
}

rule r {
  condition:
    1.5 < 2.25
}

import "pe"

rule r {
  strings:
    $a = "abc"
  condition:
    for any i in (1..#a) : ( @a[i] < 100 ) and for all s in pe.sections : ( s.raw_data_size > 0 ) and for any of ($a) : ( $ at 0 )
}

rule r {
  strings:
    $h = { 4D ( 5A | 5B 00 | ?? ) 90 }
  condition:
    $h
}

rule r {
  strings:
    $h = { 4D [4] 5A [2-8] 90 [-] 00 [3-] 01 }
  condition:
    all of them
}

rule r {
  strings:
    $h = { 4D ~5A ~?0 }
  condition:
    $h
}

rule r {
  strings:
    $h = { 4D 5A 90 00 }
  condition:
    $h
}

import "pe"

rule r {
  condition:
    pe.is_dll()
}

include "other.yar"

rule r {
  condition:
    true
}

import "pe"

rule r {
  condition:
    pe.sections[0].name == ".text"
}

rule r {
  strings:
    $a = "abc"
  condition:
    @a[1] < 10 and !a[1] == 3
}

rule r {
  condition:
    for any i in (1, 2, 3) : ( i == filesize )
}

import "pe"

rule r {
  condition:
    pe.number_of_sections > 1
}

rule r {
  meta:
    score = 70
    enabled = true
    description = "d"
  condition:
    true
}

rule r {
  meta:
    author = "x"
  condition:
    true
}

rule r {
  meta:
    offset = -10
  condition:
    true
}

rule r {
  strings:
    $a = "abc"
  condition:
    not $a and not defined 1
}

rule r {
  strings:
    $a = "a"
    $b1 = "b"
  condition:
    any of them and 2 of ($a, $b*) and none of them in (0..10) and any of ($a) at 0
}

rule r {
  strings:
    $a = "abc"
  condition:
    $a or filesize > 0
}

rule r {
  strings:
    $a = "abc"
  condition:
    ($a or true) and not ($a)
}

rule r {
  condition:
    (filesize + 1) * 2 > 10
}

rule r {
  strings:
    $a = "abc"
  condition:
    50% of them
}

rule r {
  strings:
    $a = "abc"
  condition:
    $a in (0..filesize)
}

rule r {
  strings:
    $r = /ab[cd]+\/e{1,3}/is wide
  condition:
    $r
}

rule r {
  condition:
    true
}

global private rule r {
  condition:
    true
}

private rule base1 { condition: true }
private rule base2 { condition: true }

rule r {
  condition:
    any of (base1, base2)
}

private rule base1 { condition: true }

rule r {
  condition:
    any of (base*)
}

rule r {
  strings:
    $a = "abc"
  condition:
    #a > 2
}

rule r {
  strings:
    $a = "abc"
  condition:
    #a in (0..100) == 1
}

rule r {
  strings:
    $a = "abc"
    $ = "anon"
  condition:
    all of them
}

rule r {
  strings:
    $a = "abc"
  condition:
    !a > 2
}

rule r {
  strings:
    $a = "abc"
  condition:
    $a at 0 or $a in (0..filesize)
}

rule r {
  strings:
    $a = "abc" nocase wide ascii fullword private
  condition:
    $a
}

rule r {
  strings:
    $a = "abc"
  condition:
    @a > 2
}

rule r {
  strings:
    $a = "a"
    $b1 = "b"
  condition:
    all of ($a, $b*)
}

rule r {
  strings:
    $a1 = "x"
  condition:
    any of ($a*)
}

rule r {
  strings:
    $a = "abc"
  condition:
    $a
}

rule r : apt loader {
  condition:
    true
}

rule r {
  condition:
    -1 < ~0
}

rule r {
  strings:
    $a = "abc" xor
    $b = "abc" xor(2)
    $c = "abc" xor(1-255)
  condition:
    all of them
}

