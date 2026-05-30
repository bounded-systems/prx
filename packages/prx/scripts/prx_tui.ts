#!/usr/bin/env bun
import { runWorkUnitTui } from "../src/pr-state/tui.ts";

const exitCode = await runWorkUnitTui();
process.exit(exitCode);
