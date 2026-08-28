#!/usr/bin/env node
import { runService } from './run.js';

process.exitCode = await runService(process.env);
