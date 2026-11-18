#!/usr/bin/env node
import {Command} from 'commander';
import {publisherCommands} from './src/publish-cli.ts';
import {safeMessage} from './src/local.ts';
const cli=new Command().name('hypeclip').version('0.1.0');
publisherCommands(cli);
try{await cli.parseAsync();}catch(e){console.error(safeMessage(e));process.exitCode=1;}
