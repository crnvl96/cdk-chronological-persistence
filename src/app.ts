import * as cdk from "aws-cdk-lib";

import { CorrectStack } from "@/lib/correct-stack.js";
import { WrongStack } from "@/lib/wrong-stack.js";

const app = new cdk.App();

new WrongStack(app, "WrongStack");
new CorrectStack(app, "CorrectStack");
