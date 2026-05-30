#!/usr/bin/env bash
# Thin wt wrapper — delegates everything to prx tools wt exec.
# The only shell responsibility is sourcing the directive file back
# into the parent shell (prx can't modify the parent's environment).

prx_args=()
wt_args=()

for arg in "$@"; do
  if [[ "$arg" == "--source" ]]; then
    prx_args+=(--source)
  else
    wt_args+=("$arg")
  fi
done

# Pass the parent shell's PID so prx writes directives to the spool
# path that the zsh precmd hook (_wt_apply_pending_directives) expects:
#   ${WT_STATE_ROOT}/wt/directives/${parent_pid}.zsh
# Without this, $$ is the wrapper's PID — a different process — and the
# precmd hook never finds the directive file.
parent_pid="$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ')"
parent_pid="${parent_pid:-$$}"

directive_file="$(prx tools wt exec "${prx_args[@]}" --parent-pid "$parent_pid" -- "${wt_args[@]}")"
exit_code=$?

exit "$exit_code"
