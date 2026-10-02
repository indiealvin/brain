#!/bin/sh
# Prints the body of the CHANGELOG.md section for a version, without its
# heading and without leading or trailing blank lines. Used as the GitHub
# release notes by .github/workflows/release.yml.
#
#   scripts/changelog-section.sh 0.2.0 [CHANGELOG.md]
#
# A section starts at a line "## v<version>" (alone or followed by a space)
# and ends at the next "## " heading. Exits 1 when the section is missing or
# empty.
set -eu

version="${1#v}"
file="${2:-CHANGELOG.md}"

awk -v h="## v$version" '
  !found && index($0, h) == 1 && (length($0) == length(h) || substr($0, length(h) + 1, 1) == " ") { found = 1; next }
  found && /^## / { exit }
  found {
    if ($0 ~ /^[ \t\r]*$/) { if (n > 0) blanks++ ; next }
    for (; blanks > 0; blanks--) lines[++n] = ""
    lines[++n] = $0
  }
  END {
    if (n == 0) exit 1
    for (i = 1; i <= n; i++) print lines[i]
  }
' "$file"
