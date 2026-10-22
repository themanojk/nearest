"""Verify the flash table equals every entry of Shine's original RAM table."""
from pathlib import Path
import math
import re

path = Path(__file__).resolve().parents[1] / 'src/shine/quantize_table.h'
values = [int(n) for n in re.findall(r'\d+', path.read_text().split('{', 1)[1])]
expected = [int(math.sqrt(math.sqrt(i) * i) - 0.0946 + 0.5) for i in range(10000)]
assert values == expected
assert max(values) < 65536
print('All 10,000 flash lookup values match the original formula exactly')
