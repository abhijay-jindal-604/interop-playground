# shellcheck shell=bash
# Inji state ownership check for scripts/up.sh (G-166, ADR-100). Sourced, no side effects.
#
# The Inji state volumes are named after the compose project, so every checkout on a host shares
# them, while the marker (.generated/state/chain.done) and the Mimoto HSM p12 (certs/esignet/) live
# in the checkout. A second checkout that rebuilt the state leaves the first one's marker matching
# but its p12 foreign to the database: Mimoto crash-loops. So the marker is also written as a label
# on a small project volume (`state-stamp`); a stamp from another checkout means "not our state".
#
#   state_action <state_present 0|1> <have_marker> <want_marker> <stamp>
# prints one of:
#   create  no (complete) state: run the chain
#   wipe    the checkout marker is for another PUBLIC_HOST/CA (or the chain never finished)
#   other   the stamp names another checkout's state (G-166): wipe and rebuild for this one
#   adopt   state and marker match but there is no stamp yet (created before this check): keep it
#           and write the stamp
#   keep    state, marker and stamp all match
state_stamp_of() { # <marker line> -> the label value (sha256 of the marker line)
  printf '%s' "$1" | sha256sum | cut -c1-64
}
state_action() {
  local present="$1" have="$2" want="$3" stamp="$4"
  if [[ "$present" != 1 ]]; then echo create; return; fi
  if [[ "$have" != "$want" ]]; then echo wipe; return; fi
  if [[ -z "$stamp" ]]; then echo adopt; return; fi
  if [[ "$stamp" != "$(state_stamp_of "$want")" ]]; then echo other; return; fi
  echo keep
}
