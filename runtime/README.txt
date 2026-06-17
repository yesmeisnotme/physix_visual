Portable runtime (auto-managed)

  node/              Portable Node.js (auto-downloaded on first launch if missing)
  vcredist/          VC++ 2015-2022 x64 installer cache (auto-downloaded if needed)
  downloads/         Temporary download cache

When copying this project to another PC, include this runtime/ folder if it already
exists so the target machine can run offline without downloading again.

Also copy:
  converter/build/   (physix_convert.exe + PhysX DLLs)
  viewer/node_modules/

Do NOT need third_party/PhysX SDK on the target PC for running (only for rebuilding).
