#!/usr/bin/python3
"""Owned test probe:record actual process tree then wait for cancellation."""
import json
import os
import time

with open(__file__ + ".pid", "x") as marker:
    json.dump({"pid": os.getpid(), "parentPid": os.getppid(), "directory": os.getcwd()}, marker)
time.sleep(60)
