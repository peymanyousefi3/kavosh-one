#!/bin/sh
# Synthetic subprocess framing peer, NOT a Python interpreter or PDF parser.
IFS= read -r task_header
IFS= read -r task_mode
case "$task_mode" in
  '%stall') while :; do :; done ;;
  '%flood') while :; do printf '%s' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; done ;;
  '%badutf8') printf '\377' ;;
  '%duplicate') printf '{}{}' ;;
  *) printf '{}' ;;
esac
