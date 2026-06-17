import struct
import re
import os

path = os.path.join(os.path.dirname(__file__), "..", "collision.bin")
with open(path, "rb") as f:
    data = f.read()

print("=== Header fields ===")
magic = data[0:4].decode("ascii")
ver = data[4:8]
platform = data[16:20].decode("ascii", errors="replace")
print(f"Magic: {magic}")
print(f"Version bytes: {ver.hex()}")
ver_u32 = struct.unpack_from("<I", ver)[0]
major = (ver_u32 >> 24) & 0xFF
minor = (ver_u32 >> 16) & 0xFF
bugfix = (ver_u32 >> 8) & 0xFF
print(f"PX_PHYSICS_VERSION: 0x{ver_u32:08x} -> PhysX {major}.{minor}.{bugfix}")
bin_ver = struct.unpack_from("<I", data, 8)[0]
build_no = struct.unpack_from("<I", data, 12)[0]
print(f"PX_BINARY_SERIAL_VERSION: {bin_ver}")
print(f"PX_BUILD_NUMBER: {build_no}")
print(f"Platform tag: {platform!r}")

for off in [0x20, 0x28, 0x30, 0x38, 0x3C]:
    v64 = struct.unpack_from("<Q", data, off)[0]
    v32 = struct.unpack_from("<I", data, off)[0]
    print(f"offset 0x{off:02x}: u32={v32}, u64={v64}")

print("\n=== Possible object table (from 0x40) ===")
off = 0x40
entries = []
while off + 8 <= len(data):
    t = struct.unpack_from("<I", data, off)[0]
    o = struct.unpack_from("<I", data, off + 4)[0]
    if t == 0 and o == 0:
        break
    if o >= len(data):
        break
    entries.append((t, o))
    off += 8
    if len(entries) > 50:
        break

print(f"First {min(len(entries), 20)} entries (type, offset):")
for i, (t, o) in enumerate(entries[:20]):
    print(f"  [{i:2d}] type={t:3d} (0x{t:02x})  offset=0x{o:06x} ({o})")

# parse full object table
off = 0x40
all_entries = []
while off + 8 <= len(data):
    t = struct.unpack_from("<I", data, off)[0]
    o = struct.unpack_from("<I", data, off + 4)[0]
    if t == 0 and o == 0:
        break
    if o >= len(data):
        break
    all_entries.append((t, o))
    off += 8

from collections import Counter

type_counts = Counter(t for t, _ in all_entries)
print(f"\n=== Full object table: {len(all_entries)} entries ===")
print("Type counts (likely PxConcreteType):")
for t, c in sorted(type_counts.items()):
    names = {
        0: "UNDEFINED",
        1: "HEIGHTFIELD",
        2: "CONVEX_MESH",
        3: "TRIANGLE_MESH_BVH33",
        4: "TRIANGLE_MESH_BVH34",
        5: "CLOTH_FABRIC",
        6: "RIGID_DYNAMIC",
        7: "RIGID_STATIC",
        8: "SHAPE",
        9: "MATERIAL",
    }
    print(f"  type {t:2d} ({names.get(t, '?'):>22}): {c}")

strings = re.findall(rb"[\x20-\x7e]{5,}", data)
print(f"\n=== Notable strings (unique, first 50) ===")
seen = set()
for s in strings:
    t = s.decode("ascii")
    if t not in seen:
        seen.add(t)
        if len(seen) <= 50:
            print(repr(t))

print(f"\nFile size: {len(data)} bytes")
print(f"Last 32 bytes: {data[-32:].hex()}")

# float clusters - look for plausible vertex data (many floats in [-10000, 10000])
print("\n=== Scan for float triplets (possible vertices) ===")
count_plausible = 0
for i in range(0, min(len(data) - 12, 200000), 4):
    x, y, z = struct.unpack_from("<fff", data, i)
    if all(-50000 < v < 50000 and abs(v) > 0.001 for v in (x, y, z)):
        if abs(x) + abs(y) + abs(z) > 1.0:
            count_plausible += 1
            if count_plausible <= 5:
                print(f"  offset 0x{i:06x}: ({x:.3f}, {y:.3f}, {z:.3f})")
print(f"Plausible float3 hits in first 200KB: {count_plausible}")
