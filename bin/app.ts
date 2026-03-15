#!/usr/bin/env npx tsx

import * as cdk from "aws-cdk-lib";

import { CorrectStack } from "../src/lib/correct-stack.js";
import { WrongStack } from "../src/lib/wrong-stack.js";

const app = new cdk.App();

new WrongStack(app, "WrongStack");
new CorrectStack(app, "CorrectStack");
