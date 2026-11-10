#!/usr/bin/env python3
"""Synthetic native-resource failure,never a successful decoder receipt."""
import os
import sys

if "-version" in sys.argv:
    print("ffmpeg version 9.0.2 synthetic --disable-network")
elif "-protocols" in sys.argv:
    print("Supported file protocols:\nInput:\n  file\n  pipe\nOutput:\n  file\n  pipe")
else:
    assert os.environ.get("MALLOC_ARENA_MAX") == "2"
    assert sys.argv[1:3] == ["-cpucount", "2"]
    sys.exit(245)
