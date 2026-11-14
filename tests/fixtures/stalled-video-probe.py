#!/usr/bin/python3
"""Owned test probe:record actual process tree then wait for cancellation."""
import base64
import os
import resource
import time

# Production native children cannot write regular files on Linux. Observe
# actual PIDs via a metadata-only directory,without relaxing that hard limit.
resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
location = base64.urlsafe_b64encode(os.getcwd().encode()).decode().rstrip("=")
os.mkdir(__file__ + ".pid-" + str(os.getpid()) + "-" + str(os.getppid()) + "-" + location)
time.sleep(60)
