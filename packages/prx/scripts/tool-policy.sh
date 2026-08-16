#!/usr/bin/env bash
set -euo pipefail

_safe_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

phase_to_policy_state() {
  local phase="${1:-}"
  case "$phase" in
    ready_to_merge)
      echo "merging"
      ;;
    in_review|waiting_on_ci|changes_requested|blocked)
      echo "validating"
      ;;
    *)
      echo "planning"
      ;;
  esac
}

resolve_policy_state() {
  if [[ -n "${PRX_CAPABILITY_STATE:-}" ]]; then
    echo "${PRX_CAPABILITY_STATE}"
    return 0
  fi

  local phase_json phase phase_state
  if phase_json="$(bun run "${_safe_repo_root}/scripts/pr_state.ts" phase --format json 2>/dev/null)"; then
    phase="$(echo "$phase_json" | sed -n 's/.*"phase"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
    if [[ -n "$phase" ]]; then
      phase_state="$(phase_to_policy_state "$phase")"
      echo "$phase_state"
      return 0
    fi
  fi

  echo "validating"
}

resolve_policy_role() {
  if [[ -n "${PRX_AGENT_ROLE:-}" ]]; then
    echo "${PRX_AGENT_ROLE}"
    return 0
  fi

  echo "executor"
}

_contains_word() {
  local needle="$1"
  shift
  local value
  for value in "$@"; do
    if [[ "$value" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

policy_allowed_for_state() {
  local tool="$1"
  local state="$2"
  local role="$3"
  local subcommand="$4"

  case "$tool:$state:$role" in
    git:planning:planner|git:planning:reviewer|git:planning:tester)
      _contains_word "$subcommand" status diff log show rev-parse branch
      return $?
      ;;
    git:planning:executor)
      _contains_word "$subcommand" status diff log show rev-parse branch worktree fetch
      return $?
      ;;
    git:validating:planner|git:validating:reviewer|git:validating:tester)
      _contains_word "$subcommand" status diff log show rev-parse branch fetch
      return $?
      ;;
    git:validating:executor)
      _contains_word "$subcommand" status diff log show rev-parse branch worktree fetch add commit restore switch checkout merge pull push
      return $?
      ;;
    git:merging:planner|git:merging:reviewer|git:merging:tester)
      _contains_word "$subcommand" status diff log show rev-parse branch fetch
      return $?
      ;;
    git:merging:executor)
      _contains_word "$subcommand" status diff log show rev-parse branch worktree fetch add commit restore switch checkout merge pull push
      return $?
      ;;

    gh:planning:planner|gh:planning:tester|gh:planning:reviewer)
      _contains_word "$subcommand" status list view checks diff
      return $?
      ;;
    gh:planning:executor)
      _contains_word "$subcommand" status list view checks diff comment create edit
      return $?
      ;;
    gh:validating:planner)
      _contains_word "$subcommand" status list view checks diff
      return $?
      ;;
    gh:validating:executor)
      _contains_word "$subcommand" status list view checks diff comment create edit
      return $?
      ;;
    gh:validating:tester)
      _contains_word "$subcommand" status list view checks diff comment
      return $?
      ;;
    gh:validating:reviewer)
      _contains_word "$subcommand" status list view checks diff review
      return $?
      ;;
    gh:merging:planner|gh:merging:tester|gh:merging:reviewer)
      _contains_word "$subcommand" status list view checks diff review
      return $?
      ;;
    gh:merging:executor)
      _contains_word "$subcommand" status list view checks diff comment create edit
      return $?
      ;;

    wt:planning:*|wt:validating:*|wt:merging:*)
      _contains_word "$subcommand" list status switch
      return $?
      ;;

    bd:planning:planner|bd:validating:planner|bd:merging:planner)
      _contains_word "$subcommand" ready list show view create update claim
      return $?
      ;;
    bd:planning:executor|bd:planning:tester|bd:planning:reviewer|bd:validating:executor|bd:validating:tester|bd:validating:reviewer|bd:merging:executor|bd:merging:tester|bd:merging:reviewer)
      _contains_word "$subcommand" ready list show view
      return $?
      ;;

    prx:planning:planner)
      _contains_word "$subcommand" \
        init status contract skills graph runtime-profile overview worktree \
        worktrees repo-status board actions next-action phase snapshot actors model \
        version task spec role session
      return $?
      ;;
    prx:planning:executor|prx:planning:tester|prx:planning:reviewer)
      _contains_word "$subcommand" \
        init status contract skills graph runtime-profile overview worktree \
        worktrees repo-status board actions next-action phase snapshot actors model version task spec role \
        session
      return $?
      ;;

    prx:validating:planner|prx:validating:executor|prx:validating:tester|prx:validating:reviewer)
      _contains_word "$subcommand" \
        status transition event contract skills open-mode graph runtime-profile \
        overview worktree worktrees repo-status remote-ci-check board actions \
        next-action phase snapshot actors model sync-status update version task spec role \
        session
      return $?
      ;;

    prx:merging:planner|prx:merging:executor|prx:merging:tester|prx:merging:reviewer)
      _contains_word "$subcommand" \
        status transition event contract skills open-mode graph runtime-profile \
        overview worktree worktrees repo-status remote-ci-check board actions \
        next-action phase snapshot actors model sync-status update version task spec role \
        session
      return $?
      ;;
  esac

  return 1
}

enforce_policy_or_exit() {
  local tool="$1"
  local subcommand="$2"
  local state
  local role
  state="$(resolve_policy_state)"
  role="$(resolve_policy_role)"

  if ! policy_allowed_for_state "$tool" "$state" "$role" "$subcommand"; then
    echo "${tool}-safe: blocked subcommand '$subcommand' for state '$state' role '$role'" >&2
    exit 1
  fi

  if [[ "${PRX_SAFE_DRY_RUN:-0}" == "1" ]]; then
    echo "${tool}-safe: allow '$subcommand' for state '$state' role '$role'" >&2
    exit 0
  fi
}
